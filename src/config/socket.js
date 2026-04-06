
/**
 * Configuración de WebSocket
 * Chat en tiempo real optimizado
 */
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const { Message, User, ChatStatus } = require('../models');
const { JWT_SECRET } = require('../middlewares/auth');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { invalidateChatListCache } = require('../services/chatService');

// Mapas de conexiones
const connectedUsers = new Map();
const connectedAdmins = new Map();

// Rate limiting por usuario para mensajes de socket (máximo 2 por segundo)
const socketMsgTimestamps = new Map(); // userId -> timestamp[]
const SOCKET_RATE_MAX = 2;
const SOCKET_RATE_WINDOW_MS = 1000;

// Limpiar entradas antiguas cada 30 segundos
setInterval(() => {
  const cutoff = Date.now() - SOCKET_RATE_WINDOW_MS * 2;
  for (const [userId, timestamps] of socketMsgTimestamps.entries()) {
    const recent = timestamps.filter(t => t > cutoff);
    if (recent.length === 0) {
      socketMsgTimestamps.delete(userId);
    } else {
      socketMsgTimestamps.set(userId, recent);
    }
  }
}, 30000);

/**
 * Inicializar WebSocket
 */
const initializeSocket = (server) => {
  const io = socketIo(server, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : "*",
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ['websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Middleware de autenticación para sockets
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Token no proporcionado'));
      }
      
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.userId;
      socket.username = decoded.username;
      socket.role = decoded.role;
      
      next();
    } catch (error) {
      logger.error('Error autenticando socket:', error.message);
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    logger.debug(`Nueva conexión socket: ${socket.id} - Usuario: ${socket.username}`);
    
    // Registrar conexión según rol
    const isAdminRole = ['admin', 'depositor', 'withdrawer'].includes(socket.role);
    
    if (isAdminRole) {
      connectedAdmins.set(socket.userId, socket);
      socket.join('admins');
      logger.info(`Admin conectado: ${socket.username} (${socket.role})`);
      
      // Enviar estadísticas
      broadcastStats(io);
    } else {
      connectedUsers.set(socket.userId, socket);
      socket.join(`user_${socket.userId}`);
      logger.info(`Usuario conectado: ${socket.username}`);
      
      // Notificar a admins
      notifyAdmins(io, 'user_connected', {
        userId: socket.userId,
        username: socket.username
      });
    }
    
    // Confirmar autenticación
    socket.emit('authenticated', { 
      success: true, 
      role: socket.role,
      userId: socket.userId 
    });
    
    // === EVENTOS DE CHAT ===
    
    // Enviar mensaje
    socket.on('send_message', async (data) => {
      try {
        const { content, type = 'text', receiverId } = data;
        
        if (!content || content.trim().length === 0) {
          return socket.emit('error', { message: 'Contenido requerido' });
        }

        // Rate limiting por usuario: máximo 2 mensajes por segundo
        const now = Date.now();
        const recentMsgs = (socketMsgTimestamps.get(socket.userId) || []).filter(t => now - t < SOCKET_RATE_WINDOW_MS);
        if (recentMsgs.length >= SOCKET_RATE_MAX) {
          return socket.emit('rate_limited', { message: 'Estás enviando mensajes muy rápido. Espera un momento.' });
        }
        recentMsgs.push(now);
        socketMsgTimestamps.set(socket.userId, recentMsgs);
        
        // Determinar receptor
        const targetReceiverId = isAdminRole ? receiverId : 'admin';
        const targetReceiverRole = isAdminRole ? 'user' : 'admin';
        
        // Crear mensaje en DB
        const message = await Message.create({
          id: uuidv4(),
          senderId: socket.userId,
          senderUsername: socket.username,
          senderRole: socket.role,
          receiverId: targetReceiverId,
          receiverRole: targetReceiverRole,
          content: content.trim(),
          type,
          timestamp: new Date(),
          read: false
        });
        
        // Actualizar ChatStatus
        const targetUserId = isAdminRole ? receiverId : socket.userId;
        const user = await User.findOne({ id: targetUserId });
        
        const updateData = {
          userId: targetUserId,
          username: user ? user.username : socket.username,
          lastMessageAt: new Date()
        };
        
        if (!isAdminRole) {
          updateData.status = 'open';
          updateData.closedAt = null;
          updateData.closedBy = null;
        }
        
        await ChatStatus.findOneAndUpdate(
          { userId: targetUserId },
          updateData,
          { upsert: true }
        );
        
        // Procesar comandos si es usuario
        if (!isAdminRole && content.trim().startsWith('/')) {
          await processCommand(socket, content.trim(), io);
        }
        
        // Emitir mensaje
        if (!isAdminRole) {
          // Usuario -> Admin
          notifyAdmins(io, 'new_message', {
            message,
            userId: socket.userId,
            username: socket.username
          });
          socket.emit('message_sent', message);
          socket.emit('new_message', message);
        } else {
          // Admin -> Usuario
          io.to(`user_${receiverId}`).emit('new_message', message);
          socket.emit('message_sent', message);
          
          // Notificar a otros admins
          notifyAdmins(io, 'admin_message_sent', {
            message,
            receiverId,
            senderId: socket.userId,
            senderUsername: socket.username
          });
        }
        
        // Emitir evento puntual de actualización de chat (diff mínimo)
        // No incluye contenido del mensaje para evitar vectores XSS en el frontend
        notifyAdmins(io, 'chat_updated', {
          userId: targetUserId,
          lastMessageAt: message.timestamp,
          lastMessageRole: socket.role,
          unreadIncrement: !isAdminRole ? 1 : 0
        });
        
        // Invalidar cache de lista de conversaciones
        invalidateChatListCache();
        
        broadcastStats(io);
      } catch (error) {
        logger.error('Error enviando mensaje por socket:', error);
        socket.emit('error', { message: 'Error enviando mensaje' });
      }
    });
    
    // Typing indicator
    socket.on('typing', (data) => {
      if (!isAdminRole) {
        notifyAdmins(io, 'user_typing', {
          userId: socket.userId,
          username: socket.username,
          isTyping: data.isTyping
        });
      } else {
        io.to(`user_${data.receiverId}`).emit('admin_typing', {
          adminId: socket.userId,
          adminName: socket.username,
          isTyping: data.isTyping
        });
      }
    });
    
    // Stop typing
    socket.on('stop_typing', (data) => {
      if (!isAdminRole) {
        notifyAdmins(io, 'user_stop_typing', {
          userId: socket.userId,
          username: socket.username
        });
      } else {
        io.to(`user_${data.receiverId}`).emit('admin_stop_typing', {
          adminId: socket.userId,
          adminName: socket.username
        });
      }
    });
    
    // Unirse a sala de usuario
    socket.on('join_user_room', (data) => {
      if (!isAdminRole && data && data.userId) {
        socket.join(`user_${data.userId}`);
        logger.debug(`Usuario ${socket.username} unido a sala: user_${data.userId}`);
      }
    });
    
    // Desconexión
    socket.on('disconnect', (reason) => {
      logger.debug(`Desconexión: ${socket.id} - Razón: ${reason}`);
      
      if (isAdminRole) {
        connectedAdmins.delete(socket.userId);
        broadcastStats(io);
      } else {
        connectedUsers.delete(socket.userId);
        notifyAdmins(io, 'user_disconnected', {
          userId: socket.userId,
          username: socket.username
        });
      }
    });
  });

  return io;
};

/**
 * Procesar comando
 */
const processCommand = async (socket, content, io) => {
  try {
    const { Command } = require('../models');
    const commandName = content.trim().split(' ')[0].toLowerCase();
    
    const command = await Command.findOne({ name: commandName, isActive: true });
    
    if (command) {
      // Incrementar uso
      await Command.updateOne(
        { name: commandName },
        { $inc: { usageCount: 1 } }
      );
      
      // Crear respuesta
      const responseMessage = await Message.create({
        id: uuidv4(),
        senderId: 'system',
        senderUsername: 'Sistema',
        senderRole: 'system',
        receiverId: socket.userId,
        receiverRole: 'user',
        content: command.response,
        type: 'system',
        timestamp: new Date(),
        read: false
      });
      
      socket.emit('new_message', responseMessage);
      
      notifyAdmins(io, 'command_used', {
        userId: socket.userId,
        username: socket.username,
        command: commandName
      });
    } else {
      const notFoundMessage = await Message.create({
        id: uuidv4(),
        senderId: 'system',
        senderUsername: 'Sistema',
        senderRole: 'system',
        receiverId: socket.userId,
        receiverRole: 'user',
        content: `❓ Comando "${commandName}" no encontrado. Escribe /ayuda para ver los comandos disponibles.`,
        type: 'system',
        timestamp: new Date(),
        read: false
      });
      
      socket.emit('new_message', notFoundMessage);
    }
  } catch (error) {
    logger.error('Error procesando comando:', error);
  }
};

/**
 * Notificar a todos los admins
 */
const notifyAdmins = (io, event, data) => {
  io.to('admins').emit(event, data);
};

/**
 * Broadcast de estadísticas
 */
const broadcastStats = async (io) => {
  try {
    const { User } = require('../models');
    const totalUsers = await User.countDocuments({ role: 'user' });
    
    const onlineCount = connectedUsers.size;
    const stats = {
      connectedUsers: onlineCount,
      onlineUsers: onlineCount, // alias para compatibilidad con HTTP endpoint
      connectedAdmins: connectedAdmins.size,
      totalUsers
    };
    
    io.to('admins').emit('stats', stats);
  } catch (error) {
    logger.error('Error enviando estadísticas:', error);
  }
};

module.exports = {
  initializeSocket,
  connectedUsers,
  connectedAdmins,
  notifyAdmins
};