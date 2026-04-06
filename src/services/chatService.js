
/**
 * Servicio de Chat
 * Gestiona mensajes, conversaciones y estado de chats
 * Optimizado para alto rendimiento y tiempo real
 */
const { v4: uuidv4 } = require('uuid');
const { Message, ChatStatus, User, ExternalUser } = require('../models');
const { AppError, ErrorCodes } = require('../utils/AppError');
const logger = require('../utils/logger');

// Cache en memoria para conversaciones activas
const conversationCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Cache de listas de conversaciones por status (TTL corto para actualizaciones rápidas)
const chatListCache = new Map();
const CHAT_LIST_CACHE_TTL = 10 * 1000; // 10 segundos

/**
 * Obtener mensajes de una conversación (optimizado)
 */
const getMessages = async (userId, options = {}) => {
  const { limit = 50, before = null, useCache = true } = options;
  
  // Intentar obtener del cache
  const cacheKey = `${userId}:${before || 'latest'}`;
  if (useCache && conversationCache.has(cacheKey)) {
    const cached = conversationCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
    conversationCache.delete(cacheKey);
  }
  
  // Consulta optimizada con agregación
  const messages = await Message.aggregate([
    {
      $match: {
        $or: [
          { senderId: userId },
          { receiverId: userId }
        ],
        ...(before && { timestamp: { $lt: new Date(before) } })
      }
    },
    { $sort: { timestamp: -1 } },
    { $limit: limit },
    { $sort: { timestamp: 1 } },
    {
      $project: {
        _id: 0,
        id: 1,
        senderId: 1,
        senderUsername: 1,
        senderRole: 1,
        receiverId: 1,
        receiverRole: 1,
        content: 1,
        type: 1,
        read: 1,
        timestamp: 1
      }
    }
  ]);
  
  // Guardar en cache
  if (useCache) {
    conversationCache.set(cacheKey, {
      data: messages,
      timestamp: Date.now()
    });
  }
  
  return messages;
};

/**
 * Enviar mensaje
 */
const sendMessage = async (messageData) => {
  const { senderId, senderUsername, senderRole, receiverId, content, type = 'text' } = messageData;
  
  // Determinar receptor correcto
  const isAdminRole = ['admin', 'depositor', 'withdrawer'].includes(senderRole);
  const targetReceiverId = isAdminRole ? receiverId : 'admin';
  const targetReceiverRole = isAdminRole ? 'user' : 'admin';
  
  // Crear mensaje
  const message = await Message.create({
    id: uuidv4(),
    senderId,
    senderUsername,
    senderRole,
    receiverId: targetReceiverId,
    receiverRole: targetReceiverRole,
    content,
    type,
    timestamp: new Date(),
    read: false
  });
  
  // Actualizar ChatStatus
  const targetUserId = isAdminRole ? receiverId : senderId;
  const user = await User.findOne({ id: targetUserId });
  
  const updateData = {
    userId: targetUserId,
    username: user ? user.username : senderUsername,
    lastMessageAt: new Date()
  };
  
  // Solo mensajes de usuario reabren el chat
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
  
  // Guardar usuario externo si es necesario
  if (senderRole === 'user') {
    await saveExternalUser({
      username: senderUsername,
      phone: user?.phone,
      whatsapp: user?.whatsapp
    });
  }
  
  // Invalidar cache de mensajes de conversación y lista de chats
  invalidateCache(targetUserId);
  invalidateChatListCache();
  
  logger.debug(`Mensaje enviado: ${message.id} de ${senderUsername}`);
  
  return message;
};

/**
 * Marcar mensajes como leídos
 */
const markAsRead = async (userId, readerId) => {
  const count = await Message.markAsRead(userId, readerId);
  
  logger.debug(`${count} mensajes marcados como leídos para usuario ${userId}`);
  
  return { markedCount: count };
};

/**
 * Obtener conversaciones para el panel admin (optimizado)
 */
const getConversations = async (status = 'open', userRole = 'admin', options = {}) => {
  const { limit = 50, cursor = null } = options;

  // Validar permisos según rol
  if (userRole === 'depositor' && status === 'payments') {
    throw new AppError(
      'Los depositores no pueden ver chats de pagos',
      403,
      ErrorCodes.AUTH_FORBIDDEN
    );
  }
  
  if (userRole === 'withdrawer' && status !== 'payments') {
    throw new AppError(
      'Los withdrawers solo pueden ver chats de pagos',
      403,
      ErrorCodes.AUTH_FORBIDDEN
    );
  }

  // Cache sólo para primera página (sin cursor)
  const cacheKey = `${status}:${limit}`;
  if (!cursor && chatListCache.has(cacheKey)) {
    const cached = chatListCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CHAT_LIST_CACHE_TTL) {
      return cached.data;
    }
    chatListCache.delete(cacheKey);
  }
  
  // Agregación optimizada: todo en una sola query
  const pipeline = [
    {
      $match: {
        status,
        ...(cursor && !isNaN(new Date(cursor).getTime())
          ? { lastMessageAt: { $lt: new Date(cursor) } }
          : {})
      }
    },
    { $sort: { lastMessageAt: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: 'id',
        as: 'user'
      }
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: false } },
    {
      $lookup: {
        from: 'messages',
        let: { uid: '$userId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$receiverId', 'admin'] },
                  { $eq: ['$senderId', '$$uid'] },
                  { $eq: ['$read', false] }
                ]
              }
            }
          },
          { $count: 'count' }
        ],
        as: 'unread'
      }
    },
    {
      $lookup: {
        from: 'messages',
        let: { uid: '$userId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ['$senderId', '$$uid'] },
                  { $eq: ['$receiverId', '$$uid'] }
                ]
              }
            }
          },
          { $sort: { timestamp: -1 } },
          { $limit: 1 },
          { $project: { content: 1, timestamp: 1, senderRole: 1 } }
        ],
        as: 'lastMsg'
      }
    },
    {
      $project: {
        userId: 1,
        username: '$user.username',
        balance: { $ifNull: ['$user.balance', 0] },
        online: {
          $gt: [
            { $ifNull: ['$user.lastLogin', new Date(0)] },
            { $subtract: [new Date(), 300000] }
          ]
        },
        unread: { $ifNull: [{ $arrayElemAt: ['$unread.count', 0] }, 0] },
        lastMessage: { $arrayElemAt: ['$lastMsg.content', 0] },
        lastMessageAt: { $ifNull: ['$lastMessageAt', '$updatedAt', new Date()] },
        lastMessageRole: { $arrayElemAt: ['$lastMsg.senderRole', 0] },
        status: 1,
        category: 1,
        assignedTo: 1
      }
    }
  ];
  
  const conversations = await ChatStatus.aggregate(pipeline);

  // Guardar en cache la primera página
  if (!cursor) {
    chatListCache.set(cacheKey, {
      data: conversations,
      timestamp: Date.now()
    });
  }
  
  return conversations;
};

/**
 * Obtener información de un chat específico
 */
const getChatInfo = async (userId) => {
  const [chatStatus, user] = await Promise.all([
    ChatStatus.findOne({ userId }).lean(),
    User.findOne({ id: userId }).select('-password').lean()
  ]);
  
  if (!user) {
    throw new AppError('Usuario no encontrado', 404, ErrorCodes.USER_NOT_FOUND);
  }
  
  // Contar mensajes no leídos
  const unreadCount = await Message.countDocuments({
    senderId: userId,
    receiverId: 'admin',
    read: false
  });
  
  return {
    user,
    chatStatus: chatStatus || { status: 'open', category: 'cargas' },
    unreadCount
  };
};

/**
 * Cerrar chat
 */
const closeChat = async (userId, closedBy, options = {}) => {
  const { notifyClient = false } = options;
  
  await ChatStatus.findOneAndUpdate(
    { userId },
    {
      status: 'closed',
      closedAt: new Date(),
      closedBy,
      assignedTo: null
    },
    { upsert: true }
  );
  
  logger.info(`Chat cerrado para usuario ${userId} por ${closedBy}`);
  
  invalidateChatListCache();
  
  return { success: true };
};

/**
 * Reabrir chat
 */
const reopenChat = async (userId, assignedTo) => {
  await ChatStatus.findOneAndUpdate(
    { userId },
    {
      status: 'open',
      closedAt: null,
      closedBy: null,
      assignedTo
    },
    { upsert: true }
  );
  
  logger.info(`Chat reabierto para usuario ${userId}`);
  
  invalidateChatListCache();
  
  return { success: true };
};

/**
 * Asignar chat a agente
 */
const assignChat = async (userId, agentId) => {
  await ChatStatus.findOneAndUpdate(
    { userId },
    {
      assignedTo: agentId,
      status: 'open'
    },
    { upsert: true }
  );
  
  logger.info(`Chat ${userId} asignado a ${agentId}`);
  
  invalidateChatListCache();
  
  return { success: true };
};

/**
 * Cambiar categoría del chat
 */
const changeCategory = async (userId, category) => {
  if (!['cargas', 'pagos'].includes(category)) {
    throw new AppError('Categoría inválida', 400, ErrorCodes.VALIDATION_ERROR);
  }
  
  await ChatStatus.findOneAndUpdate(
    { userId },
    { category },
    { upsert: true }
  );
  
  invalidateChatListCache();
  
  return { success: true, category };
};

/**
 * Guardar usuario externo
 */
const saveExternalUser = async (userData) => {
  try {
    await ExternalUser.findOneAndUpdate(
      { username: userData.username },
      {
        username: userData.username,
        phone: userData.phone || null,
        whatsapp: userData.whatsapp || null,
        lastSeen: new Date(),
        $inc: { messageCount: 1 },
        $setOnInsert: { firstSeen: new Date() }
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    logger.error('Error guardando usuario externo:', error);
  }
};

/**
 * Invalidar cache de conversación
 */
const invalidateCache = (userId) => {
  for (const key of conversationCache.keys()) {
    if (key.startsWith(`${userId}:`)) {
      conversationCache.delete(key);
    }
  }
};

/**
 * Invalidar cache de listas de conversaciones por status
 */
const invalidateChatListCache = () => {
  chatListCache.clear();
};

/**
 * Limpiar cache expirado
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of conversationCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      conversationCache.delete(key);
    }
  }
  for (const [key, value] of chatListCache.entries()) {
    if (now - value.timestamp > CHAT_LIST_CACHE_TTL) {
      chatListCache.delete(key);
    }
  }
}, 60000); // Limpiar cada minuto

module.exports = {
  getMessages,
  sendMessage,
  markAsRead,
  getConversations,
  getChatInfo,
  closeChat,
  reopenChat,
  assignChat,
  changeCategory,
  saveExternalUser,
  invalidateCache,
  invalidateChatListCache
};