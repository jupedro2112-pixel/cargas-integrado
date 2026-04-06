
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const winston = require('winston');

// ============================================
// LOGGER (Winston)
// ============================================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ============================================
// IMPORTAR MODELOS DE MONGODB
// ============================================
const {
  connectDB,
  User,
  Message,
  Command,
  Config,
  RefundClaim,
  FireStreak,
  ChatStatus,
  Transaction,
  ExternalUser,
  UserActivity,
  getConfig,
  setConfig,
  getAllCommands,
  saveCommand,
  deleteCommand,
  incrementCommandUsage
} = require('./config/database');

// ============================================
// SEGURIDAD - RATE LIMITING
// NOTE: Uses in-memory store per instance. In multi-instance deployments each
// instance counts independently. For consistent distributed rate limiting,
// configure a Redis store (e.g. rate-limit-redis) via REDIS_URL.
// ============================================
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta más tarde.' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de autenticación. Intenta más tarde.' }
});

// ============================================
// SEGURIDAD - HEADERS DE SEGURIDAD
// ============================================
function securityHeaders(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com https://www.google.com https://apis.google.com; script-src-elem 'self' 'unsafe-inline' https://www.gstatic.com https://www.google.com https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://fcm.googleapis.com https://firebaseinstallations.googleapis.com; frame-src 'self' https://*.firebaseapp.com https://*.google.com; manifest-src 'self';");
  next();
}

// ============================================
// SEGURIDAD - VALIDACIÓN DE INPUT
// ============================================
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(/[<>]/g, '')
    .trim()
    .substring(0, 1000);
}

// Escapar caracteres especiales de regex para evitar ReDoS/inyección
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateUsername(username) {
  if (!username || typeof username !== 'string') return false;
  const sanitized = username.trim();
  return /^[a-zA-Z0-9_.-]{3,30}$/.test(sanitized);
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 6 && password.length <= 100;
}

// Integración JUGAYGANA
const jugaygana = require('./jugaygana');
const jugayganaMovements = require('./jugaygana-movements');
const refunds = require('./models/refunds');

// ============================================
// BLOQUEO DE REEMBOLSOS
// ============================================
const refundLocks = new Map();

function acquireRefundLock(userId, type) {
  const key = `${userId}-${type}`;
  if (refundLocks.has(key)) {
    return false;
  }
  refundLocks.set(key, Date.now());
  return true;
}

function releaseRefundLock(userId, type) {
  const key = `${userId}-${type}`;
  refundLocks.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of refundLocks.entries()) {
    if (now - timestamp > 5 * 60 * 1000) {
      refundLocks.delete(key);
    }
  }
}, 60 * 1000);

// ============================================
// RATE LIMITING POR USUARIO (CBU requests)
// Máximo 1 solicitud de CBU cada 10 segundos por usuario
// ============================================
const cbuRequestTimestamps = new Map(); // userId -> timestamp
const CBU_RATE_WINDOW_MS = 10000;

function checkCbuRateLimit(userId) {
  const last = cbuRequestTimestamps.get(userId);
  const now = Date.now();
  if (last && now - last < CBU_RATE_WINDOW_MS) {
    return false; // Bloqueado
  }
  cbuRequestTimestamps.set(userId, now);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - CBU_RATE_WINDOW_MS * 2;
  for (const [userId, ts] of cbuRequestTimestamps.entries()) {
    if (ts < cutoff) cbuRequestTimestamps.delete(userId);
  }
}, 60000);

const app = express();
// Trust the first proxy hop (AWS ALB / Elastic Beanstalk / Cloudflare) so that
// Express sees the real client IP and HTTPS status from X-Forwarded-* headers.
// Without this, req.ip returns the internal LB address and Socket.IO/CORS may
// behave incorrectly when accessed through a custom domain like vipcargas.com.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  // Force WebSocket transport for lower latency and better behavior behind ALB/NLB.
  // Clients in public/app.js already request ['websocket'] so this is consistent.
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000
});

// ============================================
// REDIS ADAPTER FOR SOCKET.IO (horizontal scaling)
// Provide REDIS_URL (e.g. redis://user:pass@host:6379) or individual
// REDIS_HOST / REDIS_PORT / REDIS_USERNAME / REDIS_PASSWORD env vars.
// When none are set the app runs in single-instance (in-memory) mode.
// ============================================
async function setupRedisAdapter() {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;

  if (!redisUrl && !redisHost) {
    logger.warn('Redis not configured (REDIS_URL / REDIS_HOST missing). Socket.IO running in single-instance mode.');
    return;
  }

  try {
    const connectionOptions = redisUrl
      ? { url: redisUrl }
      : {
          socket: {
            host: redisHost,
            port: parseInt(process.env.REDIS_PORT || '6379', 10)
          },
          username: process.env.REDIS_USERNAME || undefined,
          password: process.env.REDIS_PASSWORD || undefined
        };

    const pubClient = createClient(connectionOptions);
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => logger.error(`Redis pub client error: ${err.message}`));
    subClient.on('error', (err) => logger.error(`Redis sub client error: ${err.message}`));

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Socket.IO Redis adapter initialized — multi-instance mode active');
  } catch (err) {
    logger.error(`Failed to initialize Redis adapter: ${err.message}. Falling back to single-instance mode.`);
  }
}

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sala-de-juegos-secret-key-2024';

// ============================================
// MIDDLEWARE DE SEGURIDAD
// ============================================
app.use(securityHeaders);
app.use(generalLimiter);
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true
}));
app.use(express.json({ 
  limit: '150mb',
  verify: (req, res, buf) => {
    const body = buf.toString();
    if (body.length > 150 * 1024 * 1024) {
      throw new Error('Payload too large');
    }
  }
}));

app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: false,
  // Default: cache static assets for 1 day. HTML, JS, CSS and service-worker
  // files override this below so that a redeploy is picked up immediately by
  // installed PWAs and browsers without waiting 24 hours.
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    // Never cache files that change with every deploy so installed PWAs always
    // get fresh code after a redeploy on AWS Elastic Beanstalk.
    const noCache =
      filePath.endsWith('.html') ||
      filePath.endsWith('.js') ||
      filePath.endsWith('.css') ||
      filePath.includes('firebase-messaging-sw') ||
      filePath.includes('user-sw') ||
      filePath.includes('admin-sw') ||
      filePath.includes('manifest.json');
    if (noCache) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    // Serve manifest.json with the correct Content-Type for PWA installability.
    // Chrome requires application/manifest+json (or application/json) to recognise
    // the file as a Web App Manifest. Express static defaults to application/json
    // which Chrome accepts, but setting the canonical type is best practice.
    if (path.basename(filePath) === 'manifest.json') {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
  }
}));

// ============================================
// RUTAS DE NOTIFICACIONES PUSH (FCM)
// ============================================
const notificationRoutes = require('./src/routes/notificationRoutes');
app.use('/api/notifications', notificationRoutes);
notificationRoutes.setIo(io);

// ============================================
// FUNCIONES HELPER PARA MONGODB
// ============================================

// Generar número de cuenta
const generateAccountNumber = () => {
  return 'ACC' + Date.now().toString().slice(-8) + Math.random().toString(36).substr(2, 4).toUpperCase();
};

// Buscar usuario por teléfono
async function findUserByPhone(phone) {
  const user = await User.findOne({ $or: [{ phone }, { whatsapp: phone }] }).lean();
  if (user) {
    return { username: user.username, phone: user.phone, source: 'main' };
  }
  
  const externalUser = await ExternalUser.findOne({ $or: [{ phone }, { whatsapp: phone }] }).lean();
  if (externalUser) {
    return { username: externalUser.username, phone: externalUser.phone, source: 'external' };
  }
  
  return null;
}

// Cambiar contraseña por teléfono
async function changePasswordByPhone(phone, newPassword) {
  const user = await User.findOne({ $or: [{ phone }, { whatsapp: phone }] });
  
  if (!user) {
    return { success: false, error: 'Usuario no encontrado con ese número de teléfono' };
  }
  
  user.password = await bcrypt.hash(newPassword, 10);
  user.passwordChangedAt = new Date();
  await user.save();
  
  return { success: true, username: user.username };
}

// Agregar usuario externo
async function addExternalUser(userData) {
  try {
    const { v4: uuidv4 } = require('uuid');
    await ExternalUser.findOneAndUpdate(
      { username: userData.username },
      {
        username: userData.username,
        phone: userData.phone || null,
        whatsapp: userData.whatsapp || null,
        lastSeen: new Date(),
        $inc: { messageCount: 1 },
        $setOnInsert: { 
          id: uuidv4(),
          firstSeen: new Date() 
        }
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('Error agregando usuario externo:', error);
  }
}

// Registrar actividad de usuario (para fueguito)
async function recordUserActivity(userId, type, amount) {
  try {
    const today = new Date().toDateString();
    
    await UserActivity.findOneAndUpdate(
      { userId, date: today },
      {
        $inc: { [type === 'deposit' ? 'deposits' : 'withdrawals']: amount },
        lastActivity: new Date()
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('Error registrando actividad:', error);
  }
}

// Verificar si tiene actividad hoy
async function hasActivityToday(userId) {
  try {
    const today = new Date().toDateString();
    const activity = await UserActivity.findOne({ userId, date: today });
    
    if (!activity) return false;
    return (activity.deposits > 0 || activity.withdrawals > 0);
  } catch (error) {
    console.error('Error verificando actividad:', error);
    return false;
  }
}

// Funciones para fecha Argentina
function getArgentinaDateString(date = new Date()) {
  const argentinaTime = new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return argentinaTime.toDateString();
}

function getArgentinaYesterday() {
  const now = new Date();
  const argentinaNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  argentinaNow.setDate(argentinaNow.getDate() - 1);
  return argentinaNow.toDateString();
}

// ============================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Buscar usuario por 'id' primero, luego por '_id' como fallback
    let user = await User.findOne({ id: decoded.userId });
    
    if (!user) {
      // Intentar buscar por _id (para usuarios migrados)
      try {
        user = await User.findById(decoded.userId);
      } catch (e) {
        // _id inválido, ignorar
      }
    }
    
    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    
    if (user.tokenVersion && decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ error: 'Sesión expirada. Por favor, vuelve a iniciar sesión.' });
    }
    
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'depositor' && req.user.role !== 'withdrawer') {
    return res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
  next();
};

const depositorMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'depositor') {
    return res.status(403).json({ error: 'Acceso denegado. Solo agentes de carga.' });
  }
  next();
};

const withdrawerMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'withdrawer') {
    return res.status(403).json({ error: 'Acceso denegado. Solo agentes de retiro.' });
  }
  next();
};

// ============================================
// RUTAS DE AUTENTICACIÓN
// ============================================

// Verificar disponibilidad de username
app.get('/api/auth/check-username', async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username || username.length < 3) {
      return res.json({ available: false, message: 'Usuario muy corto' });
    }
    
    // Buscar case-insensitive
    const localExists = await User.findOne({ 
      username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } 
    });
    
    if (localExists) {
      return res.json({ available: false, message: 'Usuario ya registrado' });
    }
    
    try {
      const jgUser = await jugaygana.getUserInfoByName(username);
      if (jgUser) {
        return res.json({ 
          available: false, 
          message: 'Este nombre de usuario ya está en uso en JUGAYGANA. Intenta con otro nombre.',
          existsInJugaygana: true,
          alreadyExists: true
        });
      }
    } catch (jgError) {
      logger.warn(`JUGAYGANA check failed: ${jgError.message}`);
    }
    
    res.json({ 
      available: true, 
      message: 'Usuario disponible',
      existsInJugaygana: false
    });
  } catch (error) {
    console.error('Error verificando username:', error);
    res.status(500).json({ available: false, message: 'Error del servidor' });
  }
});

// Endpoint para enviar CBU al chat
app.post('/api/admin/send-cbu', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const cbuConfig = await getConfig('cbu');
    
    if (!cbuConfig || !cbuConfig.number) {
      return res.status(400).json({ error: 'CBU no configurado' });
    }
    
    const timestamp = new Date();
    
    // 1. Mensaje completo con todos los datos
    const fullMessage = `💳 *Datos para transferir:*\n\n🏦 Banco: ${cbuConfig.bank}\n👤 Titular: ${cbuConfig.titular}\n🔢 CBU: ${cbuConfig.number}\n📱 Alias: ${cbuConfig.alias}\n\n✅ Una vez realizada la transferencia, envianos el comprobante por aquí.`;
    
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: fullMessage,
      type: 'text',
      timestamp: timestamp,
      read: false
    });
    
    // 2. CBU solo para copiar y pegar
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: cbuConfig.number,
      type: 'text',
      timestamp: new Date(Date.now() + 100),
      read: false
    });
    
    // Notificar al usuario por socket si está conectado
    const userSocket = connectedUsers.get(userId);
    if (userSocket) {
      userSocket.emit('new_message', {
        senderId: req.user.userId,
        senderUsername: req.user.username,
        content: fullMessage,
        timestamp: timestamp,
        type: 'text'
      });
      setTimeout(() => {
        userSocket.emit('new_message', {
          senderId: req.user.userId,
          senderUsername: req.user.username,
          content: cbuConfig.number,
          timestamp: new Date(),
          type: 'text'
        });
      }, 100);
    }
    
    res.json({ success: true, message: 'CBU enviado' });
  } catch (error) {
    console.error('Error enviando CBU:', error);
    res.status(500).json({ error: 'Error enviando CBU' });
  }
});

// Registro de usuario
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, password, email, phone } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    if (!phone || phone.trim().length < 8) {
      return res.status(400).json({ error: 'El número de teléfono es obligatorio (mínimo 8 dígitos)' });
    }
    
    // Buscar case-insensitive
    const existingUser = await User.findOne({ 
      username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } 
    });
    
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }
    
    // Crear usuario en JUGAYGANA PRIMERO
    let jgResult = null;
    try {
      jgResult = await jugaygana.syncUserToPlatform({
        username: username,
        password: password
      });
      
      if (!jgResult.success && !jgResult.alreadyExists) {
        return res.status(400).json({ error: 'No se pudo crear el usuario en JUGAYGANA: ' + (jgResult.error || 'Error desconocido') });
      }
      
      logger.info(`User created/linked in JUGAYGANA: ${username}`);
    } catch (jgError) {
      logger.error(`Error creating user in JUGAYGANA: ${jgError.message}`);
      return res.status(400).json({ error: 'Error al crear usuario en la plataforma. Intenta con otro nombre de usuario.' });
    }
    
    // Crear usuario localmente
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    
    const newUser = await User.create({
      id: userId,
      username,
      password: hashedPassword,
      email: email || null,
      phone: phone.trim(),
      role: 'user',
      accountNumber: generateAccountNumber(),
      balance: jgResult.user?.balance || jgResult.user?.user_balance || 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: jgResult.jugayganaUserId || jgResult.user?.user_id,
      jugayganaUsername: jgResult.jugayganaUsername || jgResult.user?.user_name,
      jugayganaSyncStatus: jgResult.alreadyExists ? 'linked' : 'synced'
    });
    
    // CORREGIDO: El mensaje de bienvenida se envía desde el cliente (app.js) con el formato actualizado incluyendo CBU
    // No enviamos mensaje de bienvenida desde el servidor para evitar duplicados y usar el formato correcto
    
    // Crear chat status
    await ChatStatus.create({
      userId: userId,
      username: username,
      status: 'open',
      category: 'cargas',
      lastMessageAt: new Date()
    });
    
    // Generar token con expiración de 90 días
    const token = jwt.sign(
      { userId: newUser.id, username: newUser.username, role: newUser.role },
      JWT_SECRET,
      { expiresIn: '90d' }
    );
    
    res.status(201).json({
      message: 'Usuario creado exitosamente',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        phone: newUser.phone,
        accountNumber: newUser.accountNumber,
        role: newUser.role,
        balance: newUser.balance,
        jugayganaLinked: true,
        needsPasswordChange: false
      }
    });
  } catch (error) {
    logger.error(`Registration error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    logger.debug(`Login attempt for: ${username}`);
    
    // Buscar usuario case-insensitive (para soportar usernames con mayúsculas/minúsculas)
    let user = await User.findOne({ 
      username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } 
    });
    
    // Si no existe localmente, verificar en JUGAYGANA
    if (!user) {
      logger.debug(`User ${username} not found locally, checking JUGAYGANA...`);
      
      const jgUser = await jugaygana.getUserInfoByName(username);
      
      if (jgUser) {
        logger.debug(`User found in JUGAYGANA, creating locally...`);
        
        const hashedPassword = await bcrypt.hash('asd123', 10);
        const userId = uuidv4();
        
        user = await User.create({
          id: userId,
          username: jgUser.username,
          password: hashedPassword,
          email: jgUser.email || null,
          phone: jgUser.phone || null,
          role: 'user',
          accountNumber: generateAccountNumber(),
          balance: jgUser.balance || 0,
          createdAt: new Date(),
          lastLogin: null,
          isActive: true,
          jugayganaUserId: jgUser.id,
          jugayganaUsername: jgUser.username,
          jugayganaSyncStatus: 'linked',
          source: 'jugaygana'
        });
        
        // Crear chat status
        await ChatStatus.create({
          userId: userId,
          username: jgUser.username,
          status: 'open',
          category: 'cargas'
        });
        
        logger.info(`User ${username} auto-created from JUGAYGANA`);
      } else {
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      }
    }
    
    // Convertir a objeto plano para acceder a los campos correctamente
    const userObj = user.toObject ? user.toObject() : user;
    
    // Usar 'id' si existe, sino usar '_id' como fallback
    const userId = userObj.id || userObj._id?.toString();
    
    logger.debug(`User found: ${userObj.username}, ID: ${userId}`);
    
    if (!userId) {
      logger.error(`User ${username} has no valid ID`);
      return res.status(500).json({ error: 'Error de configuración de usuario. Contacta al administrador.' });
    }
    
    if (!userObj.isActive) {
      return res.status(401).json({ error: 'Usuario desactivado' });
    }
    
    // Verificar que el usuario tenga una contraseña válida
    if (!userObj.password) {
      logger.error(`User ${username} has no password configured`);
      return res.status(500).json({ error: 'Error de configuración de usuario. Contacta al administrador.' });
    }
    
    // Verificar si la contraseña almacenada es un hash bcrypt válido
    const isValidBcryptHash = userObj.password.startsWith('$2') || userObj.password.startsWith('$2a$') || userObj.password.startsWith('$2b$');
    if (!isValidBcryptHash) {
      logger.error(`User ${username} has password in invalid format`);
      return res.status(500).json({ error: 'Error de configuración de usuario. Contacta al administrador.' });
    }
    
    // Verificar si el usuario necesita cambiar la contraseña
    // TRUE si: nunca cambió la contraseña (passwordChangedAt es null) Y viene de JUGAYGANA
    // O si la contraseña es la default "asd123"
    const isDefaultPassword = password === 'asd123';
    const needsPasswordChange = (!userObj.passwordChangedAt && userObj.source === 'jugaygana') || isDefaultPassword;
    
    let isValidPassword = false;
    
    try {
      isValidPassword = await bcrypt.compare(password, userObj.password);
    } catch (bcryptError) {
      logger.error(`Error comparing password for ${username}: ${bcryptError.message}`);
    }
    
    // Si la contraseña no coincide y el usuario nunca cambió su contraseña, intentar con 'asd123'
    if (!isValidPassword && !userObj.passwordChangedAt) {
      logger.debug(`Trying default password for ${username}...`);
      const defaultHash = await bcrypt.hash('asd123', 10);
      try {
        isValidPassword = await bcrypt.compare(password, defaultHash);
      } catch (bcryptError) {
        logger.error(`Error comparing default password: ${bcryptError.message}`);
      }
    }
    
    if (!isValidPassword) {
      logger.debug(`Wrong password for ${username}`);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    
    logger.info(`Login successful for ${username}`);
    
    // Actualizar lastLogin usando el modelo de Mongoose
    user.lastLogin = new Date();
    await user.save();
    
    // Token con expiración de 90 días para persistencia de sesión
    const token = jwt.sign(
      { userId: userId, username: userObj.username, role: userObj.role, tokenVersion: userObj.tokenVersion || 0 },
      JWT_SECRET,
      { expiresIn: '90d' }
    );
    
    res.json({
      message: 'Login exitoso',
      token,
      user: {
        id: userId,
        username: userObj.username,
        email: userObj.email,
        accountNumber: userObj.accountNumber,
        role: userObj.role,
        balance: userObj.balance,
        jugayganaLinked: !!userObj.jugayganaUserId,
        needsPasswordChange: needsPasswordChange
      }
    });
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Verificar token
app.get('/api/auth/verify', authMiddleware, async (req, res) => {
  try {
    // Buscar usuario completo
    const user = await User.findOne({ id: req.user.userId }).select('-password').lean();
    
    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({ 
      valid: true, 
      user: {
        userId: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        balance: user.balance
      }
    });
  } catch (error) {
    console.error('Error verificando token:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Obtener información del usuario actual
app.get('/api/users/me', authMiddleware, async (req, res) => {
  try {
    // Buscar por 'id' primero, luego por '_id' como fallback
    let user = await User.findOne({ id: req.user.userId }).select('-password');
    
    if (!user) {
      try {
        user = await User.findById(req.user.userId).select('-password');
      } catch (e) {
        // _id inválido, ignorar
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Cambiar contraseña
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword, whatsapp, closeAllSessions } = req.body;
    
    // Buscar por 'id' primero, luego por '_id' como fallback
    let user = await User.findOne({ id: req.user.userId });
    
    if (!user) {
      try {
        user = await User.findById(req.user.userId);
      } catch (e) {
        // _id inválido, ignorar
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    if (whatsapp && whatsapp.trim().length < 8) {
      return res.status(400).json({ error: 'El número de WhatsApp debe tener al menos 8 dígitos' });
    }
    
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }
    
    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordChangedAt = new Date();
    
    if (whatsapp && whatsapp.trim()) {
      user.whatsapp = whatsapp.trim();
    }
    
    if (closeAllSessions) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    
    await user.save();
    
    res.json({ 
      message: 'Contraseña cambiada exitosamente',
      sessionsClosed: closeAllSessions || false
    });
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS PÚBLICAS - RECUPERACIÓN DE CUENTA
// ============================================

app.post('/api/auth/find-user-by-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone || phone.trim().length < 8) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }
    
    const user = await findUserByPhone(phone.trim());
    
    if (user) {
      res.json({ 
        found: true, 
        username: user.username,
        phone: user.phone,
        message: 'Usuario encontrado'
      });
    } else {
      res.json({ 
        found: false, 
        message: 'No se encontró ningún usuario con ese número de teléfono' 
      });
    }
  } catch (error) {
    console.error('Error buscando usuario por teléfono:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/auth/reset-password-by-phone', async (req, res) => {
  try {
    const { phone, newPassword } = req.body;
    
    if (!phone || phone.trim().length < 8) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }
    
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    const result = await changePasswordByPhone(phone.trim(), newPassword);
    
    if (result.success) {
      res.json({ 
        success: true, 
        username: result.username,
        message: 'Contraseña cambiada exitosamente' 
      });
    } else {
      res.status(404).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error cambiando contraseña por teléfono:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ADMIN - Resetear contraseña de usuario
// ============================================

app.post('/api/admin/users/:id/reset-password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    const user = await User.findOne({ id });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordChangedAt = new Date();
    await user.save();
    
    logger.info(`Admin ${req.user.username} reset password for ${user.username}`);
    
    res.json({ 
      success: true, 
      message: `Contraseña de ${user.username} reseteada exitosamente` 
    });
  } catch (error) {
    console.error('Error reseteando contraseña:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS DE CONFIGURACIÓN PÚBLICA
// ============================================

// Ruta GET para obtener CBU activo (para mensaje de bienvenida y panel usuario)
app.get('/api/config/cbu', authMiddleware, async (req, res) => {
  try {
    const cbuConfig = await getConfig('cbu');
    if (!cbuConfig) {
      return res.status(404).json({ error: 'CBU no configurado' });
    }
    
    res.json({
      number: cbuConfig.number,
      alias: cbuConfig.alias,
      bank: cbuConfig.bank,
      titular: cbuConfig.titular
    });
  } catch (error) {
    console.error('Error obteniendo CBU:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Ruta GET para obtener URL del Canal Informativo (panel usuario)
app.get('/api/config/canal-url', authMiddleware, async (req, res) => {
  try {
    const url = await getConfig('canalInformativoUrl', '');
    res.json({ url: url || '' });
  } catch (error) {
    console.error('Error obteniendo canal URL:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/cbu/request', authMiddleware, async (req, res) => {
  try {
    // Rate limiting por usuario: máximo 1 solicitud de CBU cada 10 segundos
    if (!checkCbuRateLimit(req.user.userId)) {
      return res.status(429).json({
        success: false,
        error: 'Solicitaste CBU muy recientemente. Espera unos segundos antes de volver a intentar.'
      });
    }

    const cbuConfig = await getConfig('cbu');
    if (!cbuConfig) {
      return res.status(404).json({ error: 'CBU no configurado' });
    }
    
    // 1. Mensaje de solicitud del usuario
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'user',
      receiverId: 'admin',
      receiverRole: 'admin',
      content: '💳 Solicito los datos para transferir (CBU)',
      type: 'text',
      timestamp: new Date(),
      read: false
    });
    
    // 2. Mensaje completo con CBU
    const fullMessage = `💳 *Datos para transferir:*\n\n🏦 Banco: ${cbuConfig.bank}\n👤 Titular: ${cbuConfig.titular}\n🔢 CBU: ${cbuConfig.number}\n📱 Alias: ${cbuConfig.alias}\n\n✅ Una vez realizada la transferencia, envianos el comprobante por aquí.`;
    
    await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: req.user.userId,
      receiverRole: 'user',
      content: fullMessage,
      type: 'text',
      timestamp: new Date(),
      read: false
    });
    
    // 3. CBU solo
    await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: req.user.userId,
      receiverRole: 'user',
      content: cbuConfig.number,
      type: 'text',
      timestamp: new Date(),
      read: false
    });
    
    res.json({ 
      success: true, 
      message: 'Solicitud enviada',
      cbu: {
        number: cbuConfig.number,
        alias: cbuConfig.alias,
        bank: cbuConfig.bank,
        titular: cbuConfig.titular
      }
    });
  } catch (error) {
    console.error('Error enviando solicitud CBU:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS DE USUARIOS (ADMIN)
// ============================================

app.get('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').lean();
    res.json(users);
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, email, phone, role = 'user', balance = 0 } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    if (!phone || phone.trim().length < 8) {
      return res.status(400).json({ error: 'El número de teléfono es obligatorio (mínimo 8 dígitos)' });
    }
    
    const validRoles = ['user', 'admin', 'depositor', 'withdrawer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    
    // Buscar case-insensitive
    const existingUser = await User.findOne({ 
      username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } 
    });
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    
    const newUser = await User.create({
      id: userId,
      username,
      password: hashedPassword,
      email,
      phone,
      role,
      accountNumber: generateAccountNumber(),
      balance,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: null,
      jugayganaUsername: null,
      jugayganaSyncStatus: role === 'user' ? 'pending' : 'not_applicable'
    });
    
    // Crear chat status
    await ChatStatus.create({
      userId: userId,
      username: username,
      status: 'open',
      category: 'cargas'
    });
    
    // Sincronizar con JUGAYGANA solo si es usuario normal
    if (role === 'user') {
      jugaygana.syncUserToPlatform({
        username: newUser.username,
        password: password
      }).then(async (result) => {
        if (result.success) {
          await User.updateOne(
            { id: userId },
            {
              jugayganaUserId: result.jugayganaUserId || result.user?.user_id,
              jugayganaUsername: result.jugayganaUsername || result.user?.user_name,
              jugayganaSyncStatus: result.alreadyExists ? 'linked' : 'synced'
            }
          );
        }
      });
    }
    
    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        accountNumber: newUser.accountNumber,
        role: newUser.role,
        balance: newUser.balance
      }
    });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.put('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    if (updates.password) {
      updates.password = await bcrypt.hash(updates.password, 10);
      updates.passwordChangedAt = new Date();
    }
    
    const user = await User.findOneAndUpdate(
      { id },
      updates,
      { new: true }
    ).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({
      message: 'Usuario actualizado',
      user
    });
  } catch (error) {
    console.error('Error actualizando usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Importar módulo de sincronización
const jugayganaSync = require('./jugaygana-sync');

app.post('/api/users/:id/sync-jugaygana', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ id });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    const result = await jugaygana.syncUserToPlatform({
      username: user.username,
      password: 'asd123'
    });
    
    if (result.success) {
      user.jugayganaUserId = result.jugayganaUserId || result.user?.user_id;
      user.jugayganaUsername = result.jugayganaUsername || result.user?.user_name;
      user.jugayganaSyncStatus = result.alreadyExists ? 'linked' : 'synced';
      await user.save();
      
      res.json({
        message: result.alreadyExists ? 'Usuario vinculado con JUGAYGANA' : 'Usuario sincronizado con JUGAYGANA',
        jugayganaUserId: user.jugayganaUserId,
        jugayganaUsername: user.jugayganaUsername
      });
    } else {
      res.status(400).json({ error: result.error || 'Error sincronizando con JUGAYGANA' });
    }
  } catch (error) {
    console.error('Error sincronizando:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Sincronización masiva
app.post('/api/admin/sync-all-jugaygana', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Nota: Esta función necesitaría ser actualizada para usar MongoDB
    // Por ahora, devolvemos un mensaje informativo
    res.json({
      message: 'Sincronización masiva - Función en desarrollo para MongoDB',
      note: 'Esta función se está migrando a MongoDB'
    });
  } catch (error) {
    console.error('Error iniciando sincronización:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/admin/sync-status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const jugayganaUsers = await User.countDocuments({ jugayganaUserId: { $ne: null } });
    const pendingUsers = await User.countDocuments({ jugayganaUserId: null, role: 'user' });
    
    res.json({
      inProgress: false,
      startedAt: null,
      lastSync: null,
      totalSynced: jugayganaUsers,
      lastResult: null,
      localUsers: totalUsers,
      jugayganaUsers,
      pendingUsers
    });
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const userToDelete = await User.findOne({ id });
    if (!userToDelete) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    if (adminRoles.includes(userToDelete.role) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo los administradores pueden eliminar otros administradores' });
    }
    
    await User.deleteOne({ id });
    await ChatStatus.deleteOne({ userId: id });
    
    res.json({ message: 'Usuario eliminado exitosamente' });
  } catch (error) {
    console.error('Error eliminando usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// DEBUG - Ver todos los mensajes
// ============================================

app.get('/api/debug/messages', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const messages = await Message.find().sort({ timestamp: -1 }).limit(20).lean();
    const count = await Message.countDocuments();
    
    res.json({
      count,
      messages
    });
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// SISTEMA DE CHATS ABIERTOS/CERRADOS
// ============================================

app.get('/api/admin/chat-status/all', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const chatStatuses = await ChatStatus.find().lean();
    const result = {};
    chatStatuses.forEach(cs => {
      result[cs.userId] = cs;
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/admin/chats/:status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { status } = req.params;
    
    const chatStatuses = await ChatStatus.find({ 
      status,
      category: { $ne: 'pagos' }
    }).lean();
    
    const userIds = chatStatuses.map(cs => cs.userId);
    
    const messages = await Message.find({
      $or: [
        { senderId: { $in: userIds } },
        { receiverId: { $in: userIds } }
      ]
    }).sort({ timestamp: 1 }).lean();
    
    const users = await User.find({ id: { $in: userIds } }).lean();
    
    const userMessages = {};
    messages.forEach(msg => {
      if (msg.senderRole === 'user') {
        if (!userMessages[msg.senderId]) userMessages[msg.senderId] = [];
        userMessages[msg.senderId].push(msg);
      }
      if (msg.receiverRole === 'user' && msg.senderRole !== 'user') {
        if (!userMessages[msg.receiverId]) userMessages[msg.receiverId] = [];
        userMessages[msg.receiverId].push(msg);
      }
    });
    
    const filteredChats = [];
    
    for (const chatStatus of chatStatuses) {
      const user = users.find(u => u.id === chatStatus.userId);
      if (!user) continue;
      
      const msgs = userMessages[chatStatus.userId] || [];
      if (msgs.length === 0) continue;
      
      const lastMsg = msgs[msgs.length - 1];
      const unreadCount = msgs.filter(m => m.receiverRole === 'admin' && !m.read).length;
      
      filteredChats.push({
        userId: chatStatus.userId,
        username: user.username,
        lastMessage: lastMsg,
        unreadCount,
        assignedTo: chatStatus.assignedTo,
        closedAt: chatStatus.closedAt,
        closedBy: chatStatus.closedBy
      });
    }
    
    filteredChats.sort((a, b) => new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp));
    
    res.json(filteredChats);
  } catch (error) {
    console.error('Error obteniendo chats:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/admin/all-chats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const messages = await Message.find().lean();
    const users = await User.find().lean();
    const chatStatuses = await ChatStatus.find().lean();
    
    const userMessages = {};
    messages.forEach(msg => {
      if (msg.senderRole === 'user') {
        if (!userMessages[msg.senderId]) userMessages[msg.senderId] = [];
        userMessages[msg.senderId].push(msg);
      }
      if (msg.receiverRole === 'user') {
        if (!userMessages[msg.receiverId]) userMessages[msg.receiverId] = [];
        userMessages[msg.receiverId].push(msg);
      }
    });
    
    const allChats = Object.keys(userMessages).map(userId => {
      const user = users.find(u => u.id === userId);
      const statusInfo = chatStatuses.find(cs => cs.userId === userId) || { status: 'open', assignedTo: null };
      const msgs = userMessages[userId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      
      return {
        userId,
        username: user?.username || 'Desconocido',
        status: statusInfo.status,
        messageCount: msgs.length,
        lastMessage: msgs[msgs.length - 1]
      };
    });
    
    res.json(allChats);
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/chats/:userId/close', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    await ChatStatus.findOneAndUpdate(
      { userId },
      {
        status: 'closed',
        closedAt: new Date(),
        closedBy: req.user.username,
        assignedTo: null,
        category: 'cargas'
      },
      { upsert: true }
    );
    
    res.json({ success: true, message: 'Chat cerrado' });
  } catch (error) {
    res.status(500).json({ error: 'Error cerrando chat' });
  }
});

app.post('/api/admin/chats/:userId/reopen', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    await ChatStatus.findOneAndUpdate(
      { userId },
      {
        status: 'open',
        closedAt: null,
        closedBy: null,
        assignedTo: req.user.username
      },
      { upsert: true }
    );
    
    res.json({ success: true, message: 'Chat reabierto' });
  } catch (error) {
    res.status(500).json({ error: 'Error reabriendo chat' });
  }
});

app.post('/api/admin/chats/:userId/assign', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { agent } = req.body;
    
    await ChatStatus.findOneAndUpdate(
      { userId },
      { assignedTo: agent, status: 'open' },
      { upsert: true }
    );
    
    res.json({ success: true, message: 'Chat asignado a ' + agent });
  } catch (error) {
    res.status(500).json({ error: 'Error asignando chat' });
  }
});

app.post('/api/admin/chats/:userId/category', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { category } = req.body;
    
    if (!category || !['cargas', 'pagos'].includes(category)) {
      return res.status(400).json({ error: 'Categoría inválida. Use "cargas" o "pagos"' });
    }
    
    await ChatStatus.findOneAndUpdate(
      { userId },
      { category },
      { upsert: true }
    );
    
    res.json({ success: true, message: `Chat movido a ${category.toUpperCase()}` });
  } catch (error) {
    console.error('Error cambiando categoría:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/admin/chats/category/:category', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    
    const chatStatuses = await ChatStatus.find({ category }).lean();
    const userIds = chatStatuses.map(cs => cs.userId);
    
    const messages = await Message.find({
      $or: [
        { senderId: { $in: userIds } },
        { receiverId: { $in: userIds } }
      ]
    }).sort({ timestamp: 1 }).lean();
    
    const users = await User.find({ id: { $in: userIds } }).lean();
    
    const userMessages = {};
    messages.forEach(msg => {
      if (msg.senderRole === 'user') {
        if (!userMessages[msg.senderId]) userMessages[msg.senderId] = [];
        userMessages[msg.senderId].push(msg);
      }
      if (msg.receiverRole === 'user' && msg.senderRole !== 'user') {
        if (!userMessages[msg.receiverId]) userMessages[msg.receiverId] = [];
        userMessages[msg.receiverId].push(msg);
      }
    });
    
    const filteredChats = [];
    
    for (const chatStatus of chatStatuses) {
      const user = users.find(u => u.id === chatStatus.userId);
      if (!user) continue;
      
      const msgs = userMessages[chatStatus.userId] || [];
      if (msgs.length === 0) continue;
      
      const lastMsg = msgs[msgs.length - 1];
      const unreadCount = msgs.filter(m => m.receiverRole === 'admin' && !m.read).length;
      
      filteredChats.push({
        userId: chatStatus.userId,
        username: user.username,
        lastMessage: lastMsg,
        unreadCount,
        assignedTo: chatStatus.assignedTo,
        status: chatStatus.status
      });
    }
    
    filteredChats.sort((a, b) => new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp));
    res.json(filteredChats);
  } catch (error) {
    console.error('Error obteniendo chats por categoría:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS DE MENSAJES
// ============================================

// OPTIMIZADO: Sin logs, con proyección mínima
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    // Fix #1: Aumentar límite para mostrar todo el historial (500 máx)
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    
    const allowedRoles = ['admin', 'depositor', 'withdrawer'];
    const isAdminRole = allowedRoles.includes(req.user.role);
    if (!isAdminRole && req.user.userId !== userId) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    
    // Fix #3: Filtrar mensajes adminOnly para usuarios normales
    const matchStage = {
      $or: [
        { senderId: userId },
        { receiverId: userId }
      ]
    };
    if (!isAdminRole) {
      matchStage.adminOnly = { $ne: true };
    }
    
    // AGREGACIÓN OPTIMIZADA: Proyección mínima
    const messages = await Message.aggregate([
      { $match: matchStage },
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
          adminOnly: 1,
          timestamp: 1
        }
      }
    ]);
    
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/conversations', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const messages = await Message.find().sort({ timestamp: -1 }).lean();
    const users = await User.find().lean();
    
    const conversations = {};
    
    messages.forEach(msg => {
      let userId = null;
      
      if (msg.senderRole === 'user') {
        userId = msg.senderId;
      } else if (msg.receiverRole === 'user') {
        userId = msg.receiverId;
      }
      
      if (!userId) return;
      
      if (!conversations[userId]) {
        const user = users.find(u => u.id === userId);
        conversations[userId] = {
          userId,
          username: user?.username || 'Desconocido',
          accountNumber: user?.accountNumber || '',
          lastMessage: msg,
          unreadCount: (msg.receiverRole === 'admin' && !msg.read) ? 1 : 0
        };
      } else {
        if (msg.receiverRole === 'admin' && !msg.read) {
          conversations[userId].unreadCount++;
        }
      }
    });
    
    res.json(Object.values(conversations));
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/messages/read/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    await Message.updateMany(
      { senderId: userId, receiverRole: 'admin' },
      { read: true }
    );
    
    // Notificar a todos los admins que los mensajes de este usuario fueron leídos
    notifyAdmins('messages_read', { userId, by: req.user.userId });
    
    res.json({ message: 'Mensajes marcados como leídos' });
  } catch (error) {
    console.error('Error marcando mensajes como leídos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/messages/send', authMiddleware, async (req, res) => {
  try {
    const { content, type = 'text', receiverId } = req.body;
    
    logger.debug(`[API_MESSAGES_SEND] user=${req.user.username} role=${req.user.role} receiverId=${receiverId} type=${type}`);
    
    if (!content) {
      logger.debug('[API_MESSAGES_SEND] ERROR: content required');
      return res.status(400).json({ error: 'Contenido requerido' });
    }
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const isAdminRole = adminRoles.includes(req.user.role);
    
    // Issue #3: Bloquear comandos enviados por usuarios comunes (solo admins pueden procesar comandos)
    if (!isAdminRole && content.trim().startsWith('/')) {
      return res.status(403).json({ error: 'Los usuarios no pueden enviar comandos' });
    }
    
    logger.debug(`[API_MESSAGES_SEND] isAdminRole: ${isAdminRole}`);
    
    const messageData = {
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: req.user.role,
      receiverId: isAdminRole ? (receiverId || 'admin') : 'admin',
      receiverRole: isAdminRole ? 'user' : 'admin',
      content,
      type,
      timestamp: new Date(),
      read: false
    };
    
    logger.debug(`[API_MESSAGES_SEND] Creating message for receiver: ${messageData.receiverId}`);
    
    
    let message;
    try {
      message = await Message.create(messageData);
      logger.debug(`[API_MESSAGES_SEND] Message created: ${message.id}`);
      
      
    } catch (createError) {
      logger.error(`[API_MESSAGES_SEND] Error creating message: ${createError.message}`);
      if (createError.errors) {
        logger.error(`[API_MESSAGES_SEND] Validation errors: ${JSON.stringify(createError.errors)}`);
      }
      throw createError;
    }
    
    // Guardar usuario en base de datos externa
    if (req.user.role === 'user') {
      let user = await User.findOne({ id: req.user.userId });
      
      if (!user) {
        try {
          user = await User.findById(req.user.userId);
        } catch (e) {
          // _id inválido, ignorar
        }
      }
      
      if (user) {
        await addExternalUser({
          username: user.username,
          phone: user.phone,
          whatsapp: user.whatsapp
        });
      }
    }
    
    // Asegurar que el ChatStatus existe y está actualizado
    const targetUserId = req.user.role === 'admin' ? req.body.receiverId : req.user.userId;
    if (targetUserId) {
      const user = await User.findOne({ id: targetUserId });
      await ChatStatus.findOneAndUpdate(
        { userId: targetUserId },
        { 
          userId: targetUserId,
          username: user ? user.username : req.user.username,
          lastMessageAt: new Date()
        },
        { upsert: true }
      );
    }
    
    // Si es usuario enviando mensaje, reabrir chat solo si estaba cerrado (no si está en pagos)
    if (req.user.role === 'user') {
      await ChatStatus.findOneAndUpdate(
        { userId: req.user.userId, status: 'closed' },
        { status: 'open', assignedTo: null, closedAt: null, closedBy: null }
      );
    }
    
    // CORREGIDO: Procesar comandos si el mensaje empieza con /
    if (content.trim().startsWith('/')) {
      const commandName = content.trim().split(' ')[0];
      logger.debug(`[API_COMMAND] Command detected: ${commandName}`);
      
      try {
        const command = await Command.findOne({ name: commandName, isActive: true });
        const commandReceiverId = isAdminRole ? (receiverId || req.body.receiverId) : req.user.userId;
        
        if (command) {
          logger.debug(`[API_COMMAND] Command found: ${command.name}`);
          
          // Incrementar contador de uso
          await Command.updateOne(
            { name: commandName },
            { $inc: { usageCount: 1 }, updatedAt: new Date() }
          );
          
          // Crear mensaje de respuesta del sistema
          const responseMessage = await Message.create({
            id: uuidv4(),
            senderId: 'system',
            senderUsername: 'Sistema',
            senderRole: 'system',
            receiverId: commandReceiverId,
            receiverRole: 'user',
            content: command.response,
            type: 'system',
            timestamp: new Date(),
            read: false
          });
          
          // Emitir respuesta al usuario receptor
          io.to(`user_${commandReceiverId}`).emit('new_message', responseMessage);
          
          // Notificar a admins
          notifyAdmins('new_message', {
            message: responseMessage,
            userId: commandReceiverId,
            username: req.user.username
          });
          
          // Notificar sobre el uso del comando
          notifyAdmins('command_used', {
            userId: req.user.userId,
            username: req.user.username,
            command: commandName
          });
          
          logger.debug(`[API_COMMAND] Response sent for command: ${commandName}`);
          
          // NO emitir el mensaje original del comando, solo la respuesta
          return res.json(responseMessage);
        } else {
          logger.debug(`[API_COMMAND] Command not found: ${commandName}`);
          
          const notFoundMessage = await Message.create({
            id: uuidv4(),
            senderId: 'system',
            senderUsername: 'Sistema',
            senderRole: 'system',
            receiverId: commandReceiverId,
            receiverRole: 'user',
            content: `❓ Comando "${commandName}" no encontrado. Escribe /ayuda para ver los comandos disponibles.`,
            type: 'system',
            timestamp: new Date(),
            read: false
          });
          
          io.to(`user_${commandReceiverId}`).emit('new_message', notFoundMessage);
          return res.json(notFoundMessage);
        }
      } catch (cmdError) {
        logger.error(`[API_COMMAND] Error processing command: ${cmdError.message}`);
      }
    }
    
    // Emitir evento de socket para notificar en tiempo real
    if (req.user.role === 'user') {
      // Notificar a todos los admins sobre el nuevo mensaje
      notifyAdmins('new_message', {
        message,
        userId: req.user.userId,
        username: req.user.username
      });
      // CORREGIDO: También emitir al usuario (para que vea su propio mensaje en tiempo real)
      io.to(`user_${req.user.userId}`).emit('new_message', message);
      io.to(`user_${req.user.userId}`).emit('message_sent', message);
    } else {
      // Admin enviando mensaje - notificar al usuario
      const userSocket = connectedUsers.get(req.body.receiverId);
      if (userSocket) {
        userSocket.emit('new_message', message);
      }
      // También emitir a la sala del usuario
      io.to(`user_${req.body.receiverId}`).emit('new_message', message);
      // CORREGIDO: Emitir a la sala del chat (para admins que están viendo)
      io.to(`chat_${req.body.receiverId}`).emit('new_message', message);
      // Notificar a otros admins
      notifyAdmins('new_message', {
        message,
        userId: req.body.receiverId,
        username: req.user.username
      });
    }
    
    res.json(message);
  } catch (error) {
    logger.error(`Error sending message: ${error.message}`);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: 'Error de validación: ' + Object.values(error.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor: ' + error.message });
  }
});

// ============================================
// REEMBOLSOS (DIARIO, SEMANAL, MENSUAL)
// ============================================

app.get('/api/refunds/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    const userInfo = await jugaygana.getUserInfoByName(username);
    const currentBalance = userInfo ? userInfo.balance : 0;
    
    const [yesterdayMovements, lastWeekMovements, lastMonthMovements] = await Promise.all([
      jugaygana.getUserNetYesterday(username),
      jugaygana.getUserNetLastWeek(username),
      jugaygana.getUserNetLastMonth(username)
    ]);
    
    const dailyStatus = await refunds.canClaimDailyRefund(userId);
    const weeklyStatus = await refunds.canClaimWeeklyRefund(userId);
    const monthlyStatus = await refunds.canClaimMonthlyRefund(userId);
    
    const dailyDeposits = yesterdayMovements.success ? yesterdayMovements.totalDeposits : 0;
    const dailyWithdrawals = yesterdayMovements.success ? yesterdayMovements.totalWithdraws : 0;
    
    const weeklyDeposits = lastWeekMovements.success ? lastWeekMovements.totalDeposits : 0;
    const weeklyWithdrawals = lastWeekMovements.success ? lastWeekMovements.totalWithdraws : 0;
    
    const monthlyDeposits = lastMonthMovements.success ? lastMonthMovements.totalDeposits : 0;
    const monthlyWithdrawals = lastMonthMovements.success ? lastMonthMovements.totalWithdraws : 0;
    
    const dailyCalc = refunds.calculateRefund(dailyDeposits, dailyWithdrawals, 20);
    const weeklyCalc = refunds.calculateRefund(weeklyDeposits, weeklyWithdrawals, 10);
    const monthlyCalc = refunds.calculateRefund(monthlyDeposits, monthlyWithdrawals, 5);
    
    res.json({
      user: {
        username,
        currentBalance,
        jugayganaLinked: !!userInfo
      },
      daily: {
        ...dailyStatus,
        potentialAmount: dailyCalc.refundAmount,
        netAmount: dailyCalc.netAmount,
        percentage: 20,
        period: yesterdayMovements.success ? yesterdayMovements.dateStr : 'ayer',
        deposits: dailyDeposits,
        withdrawals: dailyWithdrawals
      },
      weekly: {
        ...weeklyStatus,
        potentialAmount: weeklyCalc.refundAmount,
        netAmount: weeklyCalc.netAmount,
        percentage: 10,
        period: lastWeekMovements.success ? `${lastWeekMovements.fromDateStr} a ${lastWeekMovements.toDateStr}` : 'semana pasada',
        deposits: weeklyDeposits,
        withdrawals: weeklyWithdrawals
      },
      monthly: {
        ...monthlyStatus,
        potentialAmount: monthlyCalc.refundAmount,
        netAmount: monthlyCalc.netAmount,
        percentage: 5,
        period: lastMonthMovements.success ? `${lastMonthMovements.fromDateStr} a ${lastMonthMovements.toDateStr}` : 'mes pasado',
        deposits: monthlyDeposits,
        withdrawals: monthlyWithdrawals
      }
    });
  } catch (error) {
    console.error('Error obteniendo estado de reembolsos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/refunds/claim/daily', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    if (!acquireRefundLock(userId, 'daily')) {
      return res.json({
        success: false,
        message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
        canClaim: true,
        processing: true
      });
    }
    
    try {
      const status = await refunds.canClaimDailyRefund(userId);
      
      if (!status.canClaim) {
        return res.json({
          success: false,
          message: 'Ya reclamaste tu reembolso diario. Vuelve mañana!',
          canClaim: false,
          nextClaim: status.nextClaim
        });
      }
      
      const yesterdayMovements = await jugaygana.getUserNetYesterday(username);
      
      if (!yesterdayMovements.success) {
        return res.json({
          success: false,
          message: 'No se pudieron obtener tus movimientos. Intenta más tarde.',
          canClaim: true
        });
      }
      
      const deposits = yesterdayMovements.totalDeposits;
      const withdrawals = yesterdayMovements.totalWithdraws;
      
      const calc = refunds.calculateRefund(deposits, withdrawals, 20);
      
      if (calc.refundAmount <= 0) {
        return res.json({
          success: false,
          message: `No tienes saldo neto positivo para reclamar reembolso. Depósitos: $${deposits}, Retiros: $${withdrawals}`,
          canClaim: true,
          netAmount: calc.netAmount
        });
      }
      
      const depositResult = await jugaygana.creditUserBalance(username, calc.refundAmount);
      
      if (!depositResult.success) {
        return res.json({
          success: false,
          message: 'Error al acreditar el reembolso: ' + depositResult.error,
          canClaim: true
        });
      }
      
      // Guardar reclamo en MongoDB
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'daily',
        amount: calc.refundAmount,
        netAmount: calc.netAmount,
        percentage: 20,
        deposits,
        withdrawals,
        period: yesterdayMovements.dateStr,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        claimedAt: new Date()
      });
      
      // Guardar transacción para el dashboard
      await Transaction.create({
        id: uuidv4(),
        type: 'refund',
        amount: calc.refundAmount,
        username,
        description: `Reembolso diario (${yesterdayMovements.dateStr})`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        timestamp: new Date()
      });
      
      res.json({
        success: true,
        message: `¡Reembolso diario de $${calc.refundAmount} acreditado!`,
        amount: calc.refundAmount,
        percentage: 20,
        netAmount: calc.netAmount,
        nextClaim: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
    } finally {
      setTimeout(() => releaseRefundLock(userId, 'daily'), 3000);
    }
  } catch (error) {
    console.error('Error reclamando reembolso diario:', error);
    res.json({ success: false, message: 'Error del servidor', canClaim: true });
  }
});

app.post('/api/refunds/claim/weekly', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    if (!acquireRefundLock(userId, 'weekly')) {
      return res.json({
        success: false,
        message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
        canClaim: true,
        processing: true
      });
    }
    
    try {
      const status = await refunds.canClaimWeeklyRefund(userId);
      
      if (!status.canClaim) {
        return res.json({
          success: false,
          message: `No puedes reclamar el reembolso semanal. Disponible: ${status.availableDays}`,
          canClaim: false,
          nextClaim: status.nextClaim,
          availableDays: status.availableDays
        });
      }
      
      const lastWeekMovements = await jugaygana.getUserNetLastWeek(username);
      
      if (!lastWeekMovements.success) {
        return res.json({
          success: false,
          message: 'No se pudieron obtener tus movimientos. Intenta más tarde.',
          canClaim: true
        });
      }
      
      const deposits = lastWeekMovements.totalDeposits;
      const withdrawals = lastWeekMovements.totalWithdraws;
      
      const calc = refunds.calculateRefund(deposits, withdrawals, 10);
      
      if (calc.refundAmount <= 0) {
        return res.json({
          success: false,
          message: `No tienes saldo neto positivo. Depósitos: $${deposits}, Retiros: $${withdrawals}`,
          canClaim: true,
          netAmount: calc.netAmount
        });
      }
      
      const depositResult = await jugaygana.creditUserBalance(username, calc.refundAmount);
      
      if (!depositResult.success) {
        return res.json({
          success: false,
          message: 'Error al acreditar el reembolso: ' + depositResult.error,
          canClaim: true
        });
      }
      
      // Guardar reclamo en MongoDB
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'weekly',
        amount: calc.refundAmount,
        netAmount: calc.netAmount,
        percentage: 10,
        deposits,
        withdrawals,
        period: `${lastWeekMovements.fromDateStr} a ${lastWeekMovements.toDateStr}`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        claimedAt: new Date()
      });
      
      // Guardar transacción para el dashboard
      await Transaction.create({
        id: uuidv4(),
        type: 'refund',
        amount: calc.refundAmount,
        username,
        description: `Reembolso semanal (${lastWeekMovements.fromDateStr} a ${lastWeekMovements.toDateStr})`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        timestamp: new Date()
      });
      
      res.json({
        success: true,
        message: `¡Reembolso semanal de $${calc.refundAmount} acreditado!`,
        amount: calc.refundAmount,
        percentage: 10,
        netAmount: calc.netAmount,
        nextClaim: status.nextClaim
      });
    } finally {
      setTimeout(() => releaseRefundLock(userId, 'weekly'), 3000);
    }
  } catch (error) {
    console.error('Error reclamando reembolso semanal:', error);
    res.json({ success: false, message: 'Error del servidor', canClaim: true });
  }
});

app.post('/api/refunds/claim/monthly', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    if (!acquireRefundLock(userId, 'monthly')) {
      return res.json({
        success: false,
        message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
        canClaim: true,
        processing: true
      });
    }
    
    try {
      const status = await refunds.canClaimMonthlyRefund(userId);
      
      if (!status.canClaim) {
        return res.json({
          success: false,
          message: `No puedes reclamar el reembolso mensual. Disponible: ${status.availableFrom}`,
          canClaim: false,
          nextClaim: status.nextClaim,
          availableFrom: status.availableFrom
        });
      }
      
      const lastMonthMovements = await jugaygana.getUserNetLastMonth(username);
      
      if (!lastMonthMovements.success) {
        return res.json({
          success: false,
          message: 'No se pudieron obtener tus movimientos. Intenta más tarde.',
          canClaim: true
        });
      }
      
      const deposits = lastMonthMovements.totalDeposits;
      const withdrawals = lastMonthMovements.totalWithdraws;
      
      const calc = refunds.calculateRefund(deposits, withdrawals, 5);
      
      if (calc.refundAmount <= 0) {
        return res.json({
          success: false,
          message: `No tienes saldo neto positivo. Depósitos: $${deposits}, Retiros: $${withdrawals}`,
          canClaim: true,
          netAmount: calc.netAmount
        });
      }
      
      const depositResult = await jugaygana.creditUserBalance(username, calc.refundAmount);
      
      if (!depositResult.success) {
        return res.json({
          success: false,
          message: 'Error al acreditar el reembolso: ' + depositResult.error,
          canClaim: true
        });
      }
      
      // Guardar reclamo en MongoDB
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'monthly',
        amount: calc.refundAmount,
        netAmount: calc.netAmount,
        percentage: 5,
        deposits,
        withdrawals,
        period: `${lastMonthMovements.fromDateStr} a ${lastMonthMovements.toDateStr}`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        claimedAt: new Date()
      });
      
      // Guardar transacción para el dashboard
      await Transaction.create({
        id: uuidv4(),
        type: 'refund',
        amount: calc.refundAmount,
        username,
        description: `Reembolso mensual (${lastMonthMovements.fromDateStr} a ${lastMonthMovements.toDateStr})`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        timestamp: new Date()
      });
      
      res.json({
        success: true,
        message: `¡Reembolso mensual de $${calc.refundAmount} acreditado!`,
        amount: calc.refundAmount,
        percentage: 5,
        netAmount: calc.netAmount,
        nextClaim: status.nextClaim
      });
    } finally {
      setTimeout(() => releaseRefundLock(userId, 'monthly'), 3000);
    }
  } catch (error) {
    console.error('Error reclamando reembolso mensual:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/refunds/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userRefunds = await RefundClaim.find({ userId }).sort({ claimedAt: -1 }).lean();
    
    res.json({ refunds: userRefunds });
  } catch (error) {
    console.error('Error obteniendo historial de reembolsos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/refunds/all', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const allRefunds = await RefundClaim.find().sort({ claimedAt: -1 }).lean();
    
    const summary = {
      dailyCount: 0,
      weeklyCount: 0,
      monthlyCount: 0,
      totalAmount: 0
    };
    
    allRefunds.forEach(r => {
      summary.totalAmount += r.amount || 0;
      if (r.type === 'daily') summary.dailyCount++;
      else if (r.type === 'weekly') summary.weeklyCount++;
      else if (r.type === 'monthly') summary.monthlyCount++;
    });
    
    res.json({
      refunds: allRefunds,
      summary
    });
  } catch (error) {
    console.error('Error obteniendo todos los reembolsos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// MOVIMIENTOS DE SALDO
// ============================================

app.get('/api/balance', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const result = await jugayganaMovements.getUserBalance(username);
    
    if (result.success) {
      res.json({
        balance: result.balance,
        username: result.username
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error obteniendo balance:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/balance/live', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const result = await jugayganaMovements.getUserBalance(username);
    
    if (result.success) {
      await User.updateOne(
        { username },
        { balance: result.balance }
      );
      
      res.json({
        balance: result.balance,
        username: result.username,
        updatedAt: new Date().toISOString()
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error obteniendo balance en tiempo real:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/movements', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const { startDate, endDate, page = 1 } = req.query;
    
    const result = await jugayganaMovements.getUserMovements(username, {
      startDate,
      endDate,
      page: parseInt(page),
      pageSize: 50
    });
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error obteniendo movimientos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/deposit', authMiddleware, depositorMiddleware, async (req, res) => {
  try {
    const { userId, username, amount, bonus = 0, description } = req.body;
    
    // Buscar usuario por ID o username
    let user;
    if (userId) {
      user = await User.findOne({ id: userId });
    } else if (username) {
      user = await User.findOne({ username });
    }
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    
    const result = await jugaygana.depositToUser(user.username, parseFloat(amount), description);
    
    if (result.success) {
      // Si hay bonus, acreditarlo en JUGAYGANA como individual_bonus en operación separada
      let bonusJgResult = null;
      if (parseFloat(bonus) > 0) {
        bonusJgResult = await jugaygana.creditUserBalance(user.username, parseFloat(bonus));
        if (!bonusJgResult.success) {
          console.error('Error al acreditar bonus en JUGAYGANA:', bonusJgResult.error);
        }
      }

      await recordUserActivity(user.id, 'deposit', parseFloat(amount));
      
      // Obtener saldo actualizado del usuario
      const balanceResult = await jugayganaMovements.getUserBalance(user.username);
      const newBalance = balanceResult.success ? balanceResult.balance : (result.data?.user_balance_after || 0);
      
      // Crear mensaje de sistema para el usuario
      const depositCmdName = parseFloat(bonus) > 0 ? '/sys_deposit_bonus' : '/sys_deposit';
      const depositCmd = await Command.findOne({ name: depositCmdName, isActive: true });
      let messageContent;
      if (depositCmd && depositCmd.response) {
        messageContent = depositCmd.response
          .replace(/\{amount\}/g, amount)
          .replace(/\{bonus\}/g, bonus)
          .replace(/\{balance\}/g, newBalance);
      } else if (bonus > 0) {
        messageContent = `🔒💰 Depósito de $${amount} (incluye $${bonus} de bonificación) acreditado con éxito. ✅ \n💸 Tu nuevo saldo es $${newBalance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥`;
      } else {
        messageContent = `🔒💰 Depósito de $${amount} acreditado con éxito. ✅ \n💸 Tu nuevo saldo es $${newBalance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥`;
      }
      
      const systemMessage = await Message.create({
        id: uuidv4(),
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: messageContent,
        type: 'system',
        timestamp: new Date(),
        read: false
      });
      
      // CORREGIDO: Emitir a todos los que están viendo este chat (usuario y admins)
      const messageData = {
        id: systemMessage.id,
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: messageContent,
        timestamp: new Date(),
        type: 'system'
      };
      
      // Emitir a la sala del usuario
      io.to(`user_${user.id}`).emit('new_message', messageData);
      
      // Emitir a la sala del chat (para admins que están viendo)
      io.to(`chat_${user.id}`).emit('new_message', messageData);
      
      // Notificar a todos los admins
      notifyAdmins('new_message', {
        message: messageData,
        userId: user.id,
        username: user.username
      });

      // Segundo mensaje recordatorio
      const reminderCmd = await Command.findOne({ name: '/sys_reminder', isActive: true });
      const reminderContent = (reminderCmd && reminderCmd.response)
        ? reminderCmd.response
            .replace(/\{amount\}/g, amount)
            .replace(/\{balance\}/g, newBalance)
        : `🎮 ¡Recuerda!\nPara cargar o cobrar, ingresa a 🌐 www.vipcargas.com.\n🔥 ¡Ya tienes el acceso guardado, así que te queda más fácil y rápido cada vez que entres!  \n🕹️ ¡No olvides guardarla y mantenerla a mano!\n\nwww.vipcargas.com`;
      const reminderMessage = await Message.create({
        id: uuidv4(),
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: reminderContent,
        type: 'system',
        timestamp: new Date(),
        read: false
      });
      const reminderData = {
        id: reminderMessage.id,
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: reminderContent,
        timestamp: new Date(),
        type: 'system'
      };
      io.to(`user_${user.id}`).emit('new_message', reminderData);
      io.to(`chat_${user.id}`).emit('new_message', reminderData);
      notifyAdmins('new_message', { message: reminderData, userId: user.id, username: user.username });
      
      // Notificar al usuario específico si está conectado
      const userSocket = connectedUsers.get(user.id);
      if (userSocket) {
        userSocket.emit('balance_updated', { balance: newBalance });
      }
      
      await Transaction.create({
        id: uuidv4(),
        type: 'deposit',
        amount: parseFloat(amount),
        bonus: parseFloat(bonus),
        username: user.username,
        userId: user.id,
        description: description || 'Depósito realizado',
        adminId: req.user?.userId,
        adminUsername: req.user?.username,
        adminRole: req.user?.role || 'admin',
        transactionId: result.data?.transfer_id || result.data?.transferId,
        timestamp: new Date()
      });

      // Registrar bonificación como transacción separada solo si fue acreditada correctamente en JUGAYGANA
      if (parseFloat(bonus) > 0 && bonusJgResult?.success) {
        await Transaction.create({
          id: uuidv4(),
          type: 'bonus',
          amount: parseFloat(bonus),
          username: user.username,
          userId: user.id,
          description: `Bonificación incluida en depósito de $${amount}`,
          adminId: req.user?.userId,
          adminUsername: req.user?.username,
          adminRole: req.user?.role || 'admin',
          transactionId: bonusJgResult.data?.transfer_id,
          timestamp: new Date()
        });
      }
      
      res.json({
        success: true,
        message: 'Depósito realizado correctamente',
        newBalance: newBalance,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error realizando depósito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/admin/balance/:username', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username } = req.params;
    const result = await jugayganaMovements.getUserBalance(username);
    
    if (result.success) {
      res.json({ balance: result.balance });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error obteniendo balance:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/withdrawal', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    const { userId, username, amount, description } = req.body;
    
    // Buscar usuario por ID o username
    let user;
    if (userId) {
      user = await User.findOne({ id: userId });
    } else if (username) {
      user = await User.findOne({ username });
    }
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    
    const result = await jugaygana.withdrawFromUser(user.username, amount, description);
    
    if (result.success) {
      await recordUserActivity(user.id, 'withdrawal', amount);
      
      // Obtener saldo actualizado del usuario
      const balanceResult = await jugayganaMovements.getUserBalance(user.username);
      const newBalance = balanceResult.success ? balanceResult.balance : (result.data?.user_balance_after || 0);
      
      // Crear mensaje de sistema para el usuario
      const withdrawalCmd = await Command.findOne({ name: '/sys_withdrawal', isActive: true });
      const messageContent = (withdrawalCmd && withdrawalCmd.response)
        ? withdrawalCmd.response
            .replace(/\{amount\}/g, amount)
            .replace(/\{balance\}/g, newBalance)
        : `🔒💸 Retiro de $${amount} realizado correctamente. \n💸 Tu nuevo saldo es $${newBalance} 💸\nSu pago se está procesando. Por favor, aguarde un momento.`;
      
      const systemMessage = await Message.create({
        id: uuidv4(),
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: messageContent,
        type: 'system',
        timestamp: new Date(),
        read: false
      });
      
      // CORREGIDO: Emitir a todos los que están viendo este chat (usuario y admins)
      const messageData = {
        id: systemMessage.id,
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: messageContent,
        timestamp: new Date(),
        type: 'system'
      };
      
      // Emitir a la sala del usuario
      io.to(`user_${user.id}`).emit('new_message', messageData);
      
      // Emitir a la sala del chat (para admins que están viendo)
      io.to(`chat_${user.id}`).emit('new_message', messageData);
      
      // Notificar a todos los admins
      notifyAdmins('new_message', {
        message: messageData,
        userId: user.id,
        username: user.username
      });
      
      // Notificar al usuario específico si está conectado
      const userSocket = connectedUsers.get(user.id);
      if (userSocket) {
        userSocket.emit('balance_updated', { balance: newBalance });
      }
      
      await Transaction.create({
        id: uuidv4(),
        type: 'withdrawal',
        amount: parseFloat(amount),
        username: user.username,
        userId: user.id,
        description: description || 'Retiro realizado',
        adminId: req.user?.userId,
        adminUsername: req.user?.username,
        adminRole: req.user?.role || 'admin',
        transactionId: result.data?.transfer_id || result.data?.transferId,
        timestamp: new Date()
      });
      
      res.json({
        success: true,
        message: 'Retiro realizado correctamente',
        newBalance: newBalance,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error realizando retiro:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/bonus', authMiddleware, depositorMiddleware, async (req, res) => {
  try {
    const { username: rawUsername, userId: rawUserId, amount } = req.body;

    // Resolver username: puede venir como username directo o como userId
    // Rechazar cualquier userId que no sea string primitivo (previene inyección NoSQL)
    let resolvedUsername = rawUsername && typeof rawUsername === 'string' ? rawUsername.trim() : null;
    if (!resolvedUsername && rawUserId) {
      if (typeof rawUserId !== 'string') {
        return res.status(400).json({ error: 'userId inválido' });
      }
      const safeUserId = rawUserId.trim();
      const user = await User.findOne({ id: safeUserId });
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      resolvedUsername = user.username;
    }

    if (!resolvedUsername || !amount) {
      return res.status(400).json({ error: 'Usuario y monto requeridos' });
    }
    
    const bonusAmount = parseFloat(amount);
    if (isNaN(bonusAmount) || bonusAmount <= 0) {
      return res.status(400).json({ error: 'Monto de bonificación inválido' });
    }
    
    const depositResult = await jugaygana.creditUserBalance(resolvedUsername, bonusAmount);
    
    if (depositResult.success) {
      // Buscar usuario para obtener su id (necesario para el mensaje)
      const bonusUser = await User.findOne({ username: resolvedUsername });

      await Transaction.create({
        id: uuidv4(),
        type: 'bonus',
        amount: bonusAmount,
        username: resolvedUsername,
        description: 'Bonificación otorgada',
        adminId: req.user?.userId,
        adminUsername: req.user?.username,
        adminRole: req.user?.role || 'admin',
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        timestamp: new Date()
      });

      // Obtener saldo actualizado para incluirlo en el mensaje
      const balanceResult = await jugayganaMovements.getUserBalance(resolvedUsername);
      const newBalance = balanceResult.success ? balanceResult.balance : null;

      // Enviar mensaje automático al usuario con el monto acreditado y el saldo actual
      if (bonusUser) {
        try {
          const bonusCmd = await Command.findOne({ name: '/sys_bonus', isActive: true });
          let bonusMsg;
          if (bonusCmd && bonusCmd.response) {
            bonusMsg = bonusCmd.response
              .replace(/\$\{amount\}/g, bonusAmount)
              .replace(/\$\{balance\}/g, newBalance !== null ? newBalance : '—');
          } else {
            bonusMsg = `🎁 ¡Bonificación de $${bonusAmount} acreditada en tu cuenta! ✅\n💸 Tu saldo actual es $${newBalance !== null ? newBalance : '—'} 💸\n\nPuedes verificarlo en: https://www.jugaygana44.bet`;
          }
          await Message.create({
            id: uuidv4(),
            senderId: 'system',
            senderUsername: req.user?.username,
            senderRole: 'admin',
            receiverId: bonusUser.id,
            receiverRole: 'user',
            content: bonusMsg,
            type: 'system',
            timestamp: new Date(),
            read: false
          });
        } catch (msgErr) {
          console.error('No se pudo enviar mensaje de bonus al usuario:', msgErr);
        }
      }

      res.json({
        success: true,
        message: `Bonificación de $${bonusAmount.toLocaleString()} realizada correctamente`,
        newBalance: newBalance !== null ? newBalance : depositResult.data?.user_balance_after,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId
      });
    } else {
      res.status(400).json({ error: depositResult.error || 'Error al aplicar bonificación' });
    }
  } catch (error) {
    console.error('Error realizando bonificación:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// SOCKET.IO - CHAT EN TIEMPO REAL
// ============================================

const connectedUsers = new Map();
const connectedAdmins = new Map();

io.on('connection', (socket) => {
  logger.debug(`New socket connection: ${socket.id}`);
  
  socket.on('authenticate', (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.userId;
      socket.username = decoded.username;
      socket.role = decoded.role;
      
      if (['admin', 'depositor', 'withdrawer'].includes(decoded.role)) {
        connectedAdmins.set(decoded.userId, socket);
        socket.join('admins'); // Unir a sala de admins
        logger.info(`Admin connected: ${decoded.username} (${decoded.role}) socket=${socket.id}`);
        broadcastStats();
      } else {
        connectedUsers.set(decoded.userId, socket);
        socket.join(`user_${decoded.userId}`); // Unir a sala personal del usuario
        logger.info(`User connected: ${decoded.username} id=${decoded.userId} socket=${socket.id}`);
        notifyAdmins('user_connected', {
          userId: decoded.userId,
          username: decoded.username
        });
      }
      
      socket.emit('authenticated', { success: true, role: decoded.role });
    } catch (error) {
      logger.error(`Socket auth error: ${error.message}`);
      socket.emit('authenticated', { success: false, error: 'Token inválido' });
    }
  });
  
  // Unirse a sala de admins (admin, depositor, withdrawer)
  socket.on('join_admin_room', () => {
    if (['admin', 'depositor', 'withdrawer'].includes(socket.role)) {
      socket.join('admins');
      logger.debug(`Admin ${socket.username} (${socket.role}) joined admin room`);
    }
  });
  
  // Unirse a sala personal del usuario
  socket.on('join_user_room', (data) => {
    if (socket.role === 'user' && data && data.userId) {
      socket.join(`user_${data.userId}`);
      logger.debug(`User ${socket.username} joined personal room: user_${data.userId}`);
    }
  });
  
  // CORREGIDO: Unirse a sala de chat específica (para admins)
  socket.on('join_chat_room', (data) => {
    if (['admin', 'depositor', 'withdrawer'].includes(socket.role) && data && data.userId) {
      socket.join(`chat_${data.userId}`);
      logger.debug(`Admin ${socket.username} joined chat room: chat_${data.userId}`);
    }
  });
  
  // CORREGIDO: Salir de sala de chat
  socket.on('leave_chat_room', (data) => {
    if (data && data.userId) {
      socket.leave(`chat_${data.userId}`);
      logger.debug(`${socket.username} left chat room: chat_${data.userId}`);
    }
  });
  
  socket.on('send_message', async (data) => {
    try {
      const { content, type = 'text', receiverId } = data;
      
      logger.debug(`[SEND_MESSAGE] user=${socket.userId} role=${socket.role} receiverId=${receiverId}`);
      
      if (!socket.userId) {
        logger.debug('[SEND_MESSAGE] ERROR: not authenticated');
        return socket.emit('error', { message: 'No autenticado' });
      }
      
      // Determinar el receptor correcto
      const isAdminRole = ['admin', 'depositor', 'withdrawer'].includes(socket.role);
      const targetReceiverId = isAdminRole ? receiverId : 'admin';
      const targetReceiverRole = isAdminRole ? 'user' : 'admin';
      
      logger.debug(`[SEND_MESSAGE] isAdminRole=${isAdminRole} targetReceiverId=${targetReceiverId}`);

      // Issue #3: Bloquear comandos enviados por usuarios comunes
      if (!isAdminRole && content && content.trim().startsWith('/')) {
        return socket.emit('error', { message: 'Los usuarios no pueden enviar comandos' });
      }
      
      // CORREGIDO: PROCESAR COMANDOS ANTES de guardar el mensaje
      // Si el mensaje empieza con /, es un comando - NO guardar el mensaje del comando
      if (content.trim().startsWith('/')) {
        const commandName = content.trim().split(' ')[0];
        logger.debug(`[COMMAND] Command detected: ${commandName}`);
        
        try {
          const command = await Command.findOne({ name: commandName, isActive: true });
          
          // Determinar el receptor del comando
          const commandReceiverId = isAdminRole ? receiverId : socket.userId;
          
          if (command) {
            logger.debug(`[COMMAND] Command found: ${command.name}`);
            
            // Incrementar contador de uso
            await Command.updateOne(
              { name: commandName },
              { $inc: { usageCount: 1 }, updatedAt: new Date() }
            );
            
            // Crear mensaje de respuesta del sistema (SOLO la respuesta, NO el comando)
            const responseMessage = await Message.create({
              id: uuidv4(),
              senderId: 'system',
              senderUsername: 'Sistema',
              senderRole: 'system',
              receiverId: commandReceiverId,
              receiverRole: 'user',
              content: command.response,
              type: 'system',
              timestamp: new Date(),
              read: false
            });
            
            // Enviar respuesta al usuario receptor
            io.to(`user_${commandReceiverId}`).emit('new_message', responseMessage);
            io.to(`chat_${commandReceiverId}`).emit('new_message', responseMessage);
            
            // Notificar a admins
            notifyAdmins('new_message', {
              message: responseMessage,
              userId: commandReceiverId,
              username: socket.username
            });
            
            // Notificar sobre el uso del comando
            notifyAdmins('command_used', {
              userId: socket.userId,
              username: socket.username,
              command: commandName
            });
            
            logger.debug(`[COMMAND] Response sent for command: ${commandName}`);
            
            // IMPORTANTE: NO guardar el mensaje del comando (/cbu), solo la respuesta
            // Salir aquí - el mensaje del comando NO se guarda ni se emite
            return;
          } else {
            logger.debug(`[COMMAND] Command not found: ${commandName}`);
            
            const notFoundMessage = await Message.create({
              id: uuidv4(),
              senderId: 'system',
              senderUsername: 'Sistema',
              senderRole: 'system',
              receiverId: commandReceiverId,
              receiverRole: 'user',
              content: `❓ Comando "${commandName}" no encontrado.`,
              type: 'system',
              timestamp: new Date(),
              read: false
            });
            
            io.to(`user_${commandReceiverId}`).emit('new_message', notFoundMessage);
            io.to(`chat_${commandReceiverId}`).emit('new_message', notFoundMessage);
            
            // NO guardar el mensaje del comando
            return;
          }
        } catch (cmdError) {
          logger.error(`[COMMAND] Error processing command: ${cmdError.message}`);
          return;
        }
      }
      
      // Si llegamos aquí, NO es un comando - guardar el mensaje normalmente
      const messageData = {
        id: uuidv4(),
        senderId: socket.userId,
        senderUsername: socket.username,
        senderRole: socket.role,
        receiverId: targetReceiverId,
        receiverRole: targetReceiverRole,
        content,
        type,
        timestamp: new Date(),
        read: false
      };
      
      // Crear el mensaje
      let message;
      try {
        message = await Message.create(messageData);
        logger.debug(`[SEND_MESSAGE] Message saved: ${message.id}`);
      } catch (createError) {
        logger.error(`[SEND_MESSAGE] Error saving message: ${createError.message}`);
        throw createError;
      }
      
      // Asegurar que el ChatStatus existe
      const targetUserId = isAdminRole ? receiverId : socket.userId;
      if (targetUserId) {
        const user = await User.findOne({ id: targetUserId });
        
        const updateData = {
          userId: targetUserId,
          username: user ? user.username : socket.username,
          lastMessageAt: new Date()
        };
        
        await ChatStatus.findOneAndUpdate(
          { userId: targetUserId },
          updateData,
          { upsert: true }
        );
        
        // Solo los mensajes del usuario reabren el chat si estaba cerrado (no si está en pagos)
        if (!isAdminRole) {
          await ChatStatus.findOneAndUpdate(
            { userId: targetUserId, status: 'closed' },
            { status: 'open', closedAt: null, closedBy: null }
          );
        }
      }
      
      if (!isAdminRole) {
        // Usuario enviando mensaje - notificar a todos los admins
        logger.debug(`[SOCKET] User ${socket.username} sent message`);
        
        // Emitir a todos los admins conectados (envuelto para facilitar extracción)
        io.to('admins').emit('new_message', {
          message,
          userId: socket.userId,
          username: socket.username
        });
        
        // Emitir a la sala del chat específico (para admins que están viendo este chat)
        io.to(`chat_${socket.userId}`).emit('new_message', message);
        
        // Confirmar al usuario y entregar el mensaje via sala (evitar duplicado)
        socket.emit('message_sent', message);
        io.to(`user_${socket.userId}`).emit('new_message', message);
      } else {
        // Admin/depositor/withdrawer enviando mensaje - notificar al usuario específico
        logger.debug(`[SEND_MESSAGE] Looking up socket for user ${receiverId}`);
        
        // CORREGIDO: Múltiples canales de entrega para asegurar que llegue
        let delivered = false;
        
        // Canal 1: Socket directo
        const userSocket = connectedUsers.get(receiverId);
        if (userSocket) {
          userSocket.emit('new_message', message);
          delivered = true;
          logger.debug(`Message delivered to user ${receiverId} via direct socket`);
        }
        
        // Canal 2: Sala del usuario (por si está conectado en otra pestaña/dispositivo)
        io.to(`user_${receiverId}`).emit('new_message', message);
        
        // Canal 3: Sala del chat (por si hay admins viendo)
        io.to(`chat_${receiverId}`).emit('new_message', message);
        
        // CORREGIDO: También notificar a otros admins que están viendo este chat
        notifyAdmins('new_message', {
          message,
          userId: receiverId,
          username: socket.username
        });
        
        // Confirmar al admin
        socket.emit('message_sent', message);
        
        logger.debug(`Message ${message.id} delivered: ${delivered ? 'YES (direct)' : 'NO (user offline, used rooms)'}`);
      }
      
      broadcastStats();
    } catch (error) {
      logger.error(`Error sending message via socket: ${error.message}`);
      if (error.name === 'ValidationError') {
        socket.emit('error', { message: 'Error de validación: ' + Object.values(error.errors).map(e => e.message).join(', ') });
      } else {
        socket.emit('error', { message: 'Error enviando mensaje: ' + error.message });
      }
    }
  });
  
  socket.on('typing', (data) => {
    if (socket.role === 'user') {
      notifyAdmins('user_typing', {
        userId: socket.userId,
        username: socket.username,
        isTyping: data.isTyping
      });
    } else {
      const userSocket = connectedUsers.get(data.receiverId);
      if (userSocket) {
        userSocket.emit('admin_typing', {
          adminId: socket.userId,
          adminName: socket.username,
          isTyping: data.isTyping
        });
      }
    }
  });
  
  socket.on('stop_typing', (data) => {
    if (socket.role === 'user') {
      notifyAdmins('user_stop_typing', {
        userId: socket.userId,
        username: socket.username
      });
    } else {
      const userSocket = connectedUsers.get(data.receiverId);
      if (userSocket) {
        userSocket.emit('admin_stop_typing', {
          adminId: socket.userId,
          adminName: socket.username
        });
      }
    }
  });
  
  socket.on('disconnect', () => {
    logger.debug(`Socket disconnected: ${socket.id}`);
    
    if (socket.role === 'admin') {
      connectedAdmins.delete(socket.userId);
      broadcastStats();
    } else {
      connectedUsers.delete(socket.userId);
      notifyAdmins('user_disconnected', {
        userId: socket.userId,
        username: socket.username
      });
    }
  });
});

function notifyAdmins(event, data) {
  // Usar la sala de admins para notificaciones más eficientes
  io.to('admins').emit(event, data);
}

async function broadcastStats() {
  const totalUsers = await User.countDocuments({ role: 'user' });
  
  const stats = {
    connectedUsers: connectedUsers.size,
    connectedAdmins: connectedAdmins.size,
    totalUsers
  };
  
  connectedAdmins.forEach((socket) => {
    socket.emit('stats', stats);
  });
}

// ============================================
// NOTIFICACIONES PUSH
// ============================================

// Almacenar suscripciones de push (en producción usar MongoDB)
const pushSubscriptions = new Map();

// Endpoint para suscribirse a notificaciones push
app.post('/api/notifications/subscribe', authMiddleware, async (req, res) => {
  try {
    const { subscription } = req.body;
    const userId = req.user.userId;
    
    if (!subscription) {
      return res.status(400).json({ error: 'Subscription requerida' });
    }
    
    // Guardar suscripción
    pushSubscriptions.set(userId, {
      subscription,
      userId,
      username: req.user.username,
      role: req.user.role,
      createdAt: new Date()
    });
    
    console.log(`✅ Usuario ${req.user.username} suscrito a notificaciones push`);
    res.json({ success: true, message: 'Suscripción guardada' });
  } catch (error) {
    console.error('Error en subscribe:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Endpoint para desuscribirse
app.post('/api/notifications/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    pushSubscriptions.delete(userId);
    console.log(`❌ Usuario ${req.user.username} desuscrito de notificaciones push`);
    res.json({ success: true, message: 'Suscripción eliminada' });
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Endpoint para enviar notificación (usado por admin)
app.post('/api/admin/send-notification', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, title, body, icon, badge, tag, requireInteraction, data } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId requerido' });
    }
    
    // Enviar notificación vía Socket.IO al usuario
    const userSocket = connectedUsers.get(userId);
    if (userSocket) {
      userSocket.emit('push_notification', {
        title: title || 'Nueva notificación',
        body: body || '',
        icon: icon || '/icons/icon-192x192.png',
        badge: badge || '/icons/icon-72x72.png',
        tag: tag || 'default',
        requireInteraction: requireInteraction || false,
        data: data || {}
      });
    }
    
    // También enviar a la sala del usuario (por si está en otra pestaña)
    io.to(`user_${userId}`).emit('push_notification', {
      title: title || 'Nueva notificación',
      body: body || '',
      icon: icon || '/icons/icon-192x192.png',
      badge: badge || '/icons/icon-72x72.png',
      tag: tag || 'default',
      requireInteraction: requireInteraction || false,
      data: data || {}
    });
    
    console.log(`📱 Notificación enviada a usuario ${userId}: ${title}`);
    res.json({ success: true, message: 'Notificación enviada' });
  } catch (error) {
    console.error('Error enviando notificación:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS ESTÁTICAS
// ============================================

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Error leyendo archivo ${filePath}:`, error.message);
    return null;
  }
}

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const content = readFileSafe(indexPath);
  if (content) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(content);
  } else {
    res.status(500).send('Error loading page');
  }
});

app.get('/adminprivado2026', (req, res) => {
  const adminPath = path.join(__dirname, 'public', 'adminprivado2026', 'index.html');
  const content = readFileSafe(adminPath);
  if (content) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(content);
  } else {
    res.status(500).send('Error loading admin page');
  }
});

app.get('/adminprivado2026/admin.css', (req, res) => {
  const cssPath = path.join(__dirname, 'public', 'adminprivado2026', 'admin.css');
  const content = readFileSafe(cssPath);
  if (content) {
    res.setHeader('Content-Type', 'text/css');
    res.send(content);
  } else {
    res.status(404).send('CSS not found');
  }
});

app.get('/adminprivado2026/admin.js', (req, res) => {
  const jsPath = path.join(__dirname, 'public', 'adminprivado2026', 'admin.js');
  const content = readFileSafe(jsPath);
  if (content) {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(content);
  } else {
    res.status(404).send('JS not found');
  }
});

// ============================================
// INICIALIZAR DATOS DE PRUEBA
// ============================================

async function initializeData() {
  // Conectar a MongoDB
  const dbConnected = await connectDB();
  if (!dbConnected) {
    console.error('❌ No se pudo conectar a MongoDB');
    return;
  }
  
  if (process.env.PROXY_URL) {
    console.log('🔍 Verificando IP pública...');
    await jugaygana.logProxyIP();
  }
  
  console.log('🔑 Probando conexión con JUGAYGANA...');
  const sessionOk = await jugaygana.ensureSession();
  if (sessionOk) {
    console.log('✅ Conexión con JUGAYGANA establecida');
  } else {
    console.log('⚠️ No se pudo conectar con JUGAYGANA');
  }
  
  // Verificar/crear admin ignite100
  let adminExists = await User.findOne({ username: 'ignite100' });
  if (!adminExists) {
    const adminPassword = await bcrypt.hash('pepsi100', 10);
    await User.create({
      id: uuidv4(),
      username: 'ignite100',
      password: adminPassword,
      email: 'admin@saladejuegos.com',
      phone: null,
      role: 'admin',
      accountNumber: 'ADMIN001',
      balance: 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: null,
      jugayganaUsername: null,
      jugayganaSyncStatus: 'not_applicable'
    });
    console.log('✅ Admin creado: ignite100 / pepsi100');
  } else {
    adminExists.password = await bcrypt.hash('pepsi100', 10);
    adminExists.role = 'admin';
    adminExists.isActive = true;
    await adminExists.save();
    console.log('✅ Admin actualizado: ignite100 / pepsi100');
  }
  
  // Verificar/crear admin respaldo
  let oldAdmin = await User.findOne({ username: 'admin' });
  if (!oldAdmin) {
    const adminPassword = await bcrypt.hash('admin123', 10);
    await User.create({
      id: uuidv4(),
      username: 'admin',
      password: adminPassword,
      email: 'admin@saladejuegos.com',
      phone: null,
      role: 'admin',
      accountNumber: 'ADMIN002',
      balance: 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: null,
      jugayganaUsername: null,
      jugayganaSyncStatus: 'not_applicable'
    });
    console.log('✅ Admin respaldo creado: admin / admin123');
  } else {
    oldAdmin.password = await bcrypt.hash('admin123', 10);
    oldAdmin.role = 'admin';
    oldAdmin.isActive = true;
    await oldAdmin.save();
    console.log('✅ Admin respaldo actualizado: admin / admin123');
  }
  
  // Verificar/crear configuración CBU por defecto
  const cbuConfig = await getConfig('cbu');
  if (!cbuConfig) {
    await setConfig('cbu', {
      number: '0000000000000000000000',
      alias: 'mi.alias.cbu',
      bank: 'Banco Ejemplo',
      titular: 'Sala de Juegos'
    });
    console.log('✅ Configuración CBU por defecto creada');
  }

  // Verificar/crear comandos de sistema (mensajes automáticos editables desde COMANDOS)
  const systemCmds = [
    {
      name: '/sys_deposit',
      description: 'Mensaje automático al realizar un depósito sin bonus. Variables disponibles: ${amount}, ${balance}',
      type: 'message',
      response: '🔒💰 Depósito de ${amount} acreditado con éxito. ✅ \n💸 Tu nuevo saldo es ${balance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥'
    },
    {
      name: '/sys_deposit_bonus',
      description: 'Mensaje automático al realizar un depósito con bonus. Variables disponibles: ${amount}, ${bonus}, ${balance}',
      type: 'message',
      response: '🔒💰 Depósito de ${amount} (incluye ${bonus} de bonificación) acreditado con éxito. ✅ \n💸 Tu nuevo saldo es ${balance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥'
    },
    {
      name: '/sys_bonus',
      description: 'Mensaje automático al aplicar una bonificación. Variables disponibles: ${amount}, ${balance}',
      type: 'message',
      response: '🎁 ¡Bonificación de ${amount} acreditada en tu cuenta! ✅\n💸 Tu saldo actual es ${balance} 💸\n\nPuedes verificarlo en: https://www.jugaygana44.bet'
    },
    {
      name: '/sys_withdrawal',
      description: 'Mensaje automático al realizar un retiro. Variables disponibles: ${amount}, ${balance}',
      type: 'message',
      response: '🔒💸 Retiro de ${amount} realizado correctamente. \n💸 Tu nuevo saldo es ${balance} 💸\nSu pago se está procesando. Por favor, aguarde un momento.'
    },
    {
      name: '/sys_reminder',
      description: 'Mensaje recordatorio enviado después de cada depósito (sin variables de monto por defecto).',
      type: 'message',
      response: '🎮 ¡Recuerda!\nPara cargar o cobrar, ingresa a 🌐 www.vipcargas.com.\n🔥 ¡Ya tienes el acceso guardado, así que te queda más fácil y rápido cada vez que entres!  \n🕹️ ¡No olvides guardarla y mantenerla a mano!\n\nwww.vipcargas.com'
    }
  ];
  for (const cmd of systemCmds) {
    await Command.findOneAndUpdate(
      { name: cmd.name },
      {
        $set: { isSystem: true },
        $setOnInsert: {
          name: cmd.name,
          description: cmd.description,
          type: cmd.type,
          response: cmd.response,
          isActive: true,
          usageCount: 0
        }
      },
      { upsert: true }
    );
  }
  console.log('✅ Comandos de sistema verificados');

  console.log('✅ Datos inicializados correctamente');
}

// ============================================
// ENDPOINTS DE MOVIMIENTOS (DEPÓSITOS/RETIROS)
// ============================================

app.post('/api/movements/deposit', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const username = req.user.username;
    
    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Monto mínimo $100' });
    }
    
    const result = await jugaygana.depositToUser(
      username, 
      amount, 
      `Depósito desde Sala de Juegos - ${new Date().toLocaleString('es-AR')}`
    );
    
    if (result.success) {
      await recordUserActivity(req.user.userId, 'deposit', amount);
      
      res.json({
        success: true,
        message: `Depósito de $${amount} realizado correctamente`,
        newBalance: result.data?.user_balance_after,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
      res.status(400).json({ error: result.error || 'Error al realizar depósito' });
    }
  } catch (error) {
    console.error('Error en depósito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/movements/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const username = req.user.username;
    
    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Monto mínimo $100' });
    }
    
    const result = await jugaygana.withdrawFromUser(
      username, 
      amount, 
      `Retiro desde Sala de Juegos - ${new Date().toLocaleString('es-AR')}`
    );
    
    if (result.success) {
      await recordUserActivity(req.user.userId, 'withdrawal', amount);
      
      res.json({
        success: true,
        message: `Retiro de $${amount} realizado correctamente`,
        newBalance: result.data?.user_balance_after,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
      res.status(400).json({ error: result.error || 'Error al realizar retiro' });
    }
  } catch (error) {
    console.error('Error en retiro:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/movements/balance', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const result = await jugayganaMovements.getUserBalance(username);
    
    if (result.success) {
      res.json({ balance: result.balance });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// SISTEMA DE FUEGUITO (RACHA DIARIA)
// ============================================

app.get('/api/fire/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    let fireStreak = await FireStreak.findOne({ userId }).lean();
    
    if (!fireStreak) {
      fireStreak = { streak: 0, lastClaim: null, totalClaimed: 0 };
    }
    
    const todayArgentina = getArgentinaDateString();
    const lastClaim = fireStreak.lastClaim ? getArgentinaDateString(new Date(fireStreak.lastClaim)) : null;
    
    const canClaim = lastClaim !== todayArgentina;
    
    const yesterdayArgentina = getArgentinaYesterday();
    
    if (lastClaim !== yesterdayArgentina && lastClaim !== todayArgentina && fireStreak.streak > 0) {
      await FireStreak.updateOne(
        { userId },
        { streak: 0, lastReset: new Date() },
        { upsert: true }
      );
      fireStreak.streak = 0;
    }
    
    res.json({
      streak: fireStreak.streak || 0,
      lastClaim: fireStreak.lastClaim,
      totalClaimed: fireStreak.totalClaimed || 0,
      canClaim: canClaim,
      hasActivityToday: true,
      nextReward: fireStreak.streak >= 9 ? 10000 : 0
    });
  } catch (error) {
    console.error('Error obteniendo estado del fueguito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/fire/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    let fireStreak = await FireStreak.findOne({ userId });
    
    if (!fireStreak) {
      fireStreak = new FireStreak({ userId, username, streak: 0, totalClaimed: 0 });
    }
    
    const todayArgentina = getArgentinaDateString();
    const lastClaim = fireStreak.lastClaim ? getArgentinaDateString(new Date(fireStreak.lastClaim)) : null;
    
    if (lastClaim === todayArgentina) {
      return res.status(400).json({ error: 'Ya reclamaste tu fueguito hoy' });
    }
    
    const yesterdayArgentina = getArgentinaYesterday();
    
    if (lastClaim !== yesterdayArgentina && fireStreak.streak > 0) {
      fireStreak.streak = 0;
      fireStreak.lastReset = new Date();
    }
    
    fireStreak.streak += 1;
    fireStreak.lastClaim = new Date();
    
    let reward = 0;
    let message = `Día ${fireStreak.streak} de racha!`;
    
    if (fireStreak.streak === 10) {
      reward = 10000;
      fireStreak.totalClaimed += reward;
      
      const bonusResult = await jugayganaMovements.makeBonus(
        username,
        reward,
        `Recompensa racha 10 días - Sala de Juegos`
      );
      
      if (!bonusResult.success) {
        return res.status(400).json({ 
          error: 'Error al acreditar recompensa: ' + bonusResult.error 
        });
      }
      
      message = `¡Felicidades! 10 días de racha! Recompensa: $${reward.toLocaleString()}`;
    }
    
    fireStreak.history = fireStreak.history || [];
    fireStreak.history.push({
      date: new Date(),
      reward,
      streakDay: fireStreak.streak
    });
    
    await fireStreak.save();
    
    res.json({
      success: true,
      streak: fireStreak.streak,
      reward,
      message,
      totalClaimed: fireStreak.totalClaimed
    });
  } catch (error) {
    console.error('Error reclamando fueguito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// CONFIGURACIÓN DEL SISTEMA (CBU, COMANDOS)
// ============================================

app.get('/api/admin/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cbuConfig = await getConfig('cbu');
    const welcomeMessage = await getConfig('welcomeMessage');
    const depositMessage = await getConfig('depositMessage');
    const canalInformativoUrl = await getConfig('canalInformativoUrl', '');
    
    res.json({
      cbu: cbuConfig || {},
      welcomeMessage: welcomeMessage || '🎉 ¡Bienvenido a la Sala de Juegos!',
      depositMessage: depositMessage || '💰 ¡Fichas cargadas!',
      canalInformativoUrl: canalInformativoUrl || ''
    });
  } catch (error) {
    console.error('Error obteniendo configuración:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/canal-url', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    const safeUrl = (url || '').trim();
    if (safeUrl) {
      try {
        const parsed = new URL(safeUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return res.status(400).json({ error: 'URL inválida. Debe comenzar con http:// o https://' });
        }
      } catch {
        return res.status(400).json({ error: 'URL inválida. Verificá que sea una URL completa y válida.' });
      }
    }
    await setConfig('canalInformativoUrl', safeUrl);
    res.json({ success: true, message: 'URL del Canal Informativo actualizada correctamente' });
  } catch (error) {
    console.error('Error guardando canal URL:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.put('/api/admin/config/cbu', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const currentCbu = await getConfig('cbu') || {};
    const newCbu = { ...currentCbu, ...req.body };
    
    await setConfig('cbu', newCbu);
    
    res.json({ success: true, message: 'CBU actualizado', cbu: newCbu });
  } catch (error) {
    console.error('Error actualizando CBU:', error);
    res.status(500).json({ error: 'Error actualizando CBU' });
  }
});

// ============================================
// BASE DE DATOS - SOLO ADMIN PRINCIPAL
// ============================================

app.get('/api/admin/database', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado. Solo el administrador principal puede acceder.' });
    }
    
    const users = await User.find().select('-password').lean();
    const messages = await Message.find().lean();
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const totalAdmins = users.filter(u => adminRoles.includes(u.role)).length;
    
    res.json({
      users,
      totalUsers: users.length,
      totalAdmins,
      totalMessages: messages.length
    });
  } catch (error) {
    console.error('Error obteniendo base de datos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// TRANSACCIONES
// ============================================

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { from, to, type } = req.query;
    
    let query = {};
    
    // Manejo de fechas — las fechas recibidas (YYYY-MM-DD) se interpretan en
    // horario argentino (ART = UTC-3, sin DST).
    // 00:00 ART = 03:00 UTC del mismo día.
    // 23:59:59 ART = 02:59:59 UTC del día siguiente.
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (from || to) {
      query.timestamp = {};
      if (from) {
        if (!DATE_RE.test(from)) return res.status(400).json({ error: 'Formato de fecha inválido para "from" (esperado YYYY-MM-DD)' });
        // Inicio del día en Argentina: 00:00 ART = 03:00 UTC
        const fromDate = new Date(from + 'T03:00:00.000Z');
        query.timestamp.$gte = fromDate;
      }
      if (to) {
        if (!DATE_RE.test(to)) return res.status(400).json({ error: 'Formato de fecha inválido para "to" (esperado YYYY-MM-DD)' });
        // Fin del día en Argentina: 23:59:59.999 ART = inicio del día siguiente 03:00 UTC - 1ms
        const toDate = new Date(to + 'T03:00:00.000Z');
        toDate.setTime(toDate.getTime() + 24 * 60 * 60 * 1000 - 1);
        query.timestamp.$lte = toDate;
      }
    }
    
    if (type && type !== 'all') {
      query.type = type;
    }
    
    // Obtener todas las transacciones sin límite para el cierre
    const transactions = await Transaction.find(query)
      .sort({ timestamp: -1 })
      .lean();
    
    // Calcular totales
    let deposits = 0;
    let withdrawals = 0;
    let bonuses = 0;
    let refunds = 0;
    
    transactions.forEach(t => {
      const amount = t.amount || 0;
      switch(t.type) {
        case 'deposit':
          deposits += amount;
          break;
        case 'withdrawal':
          withdrawals += amount;
          break;
        case 'bonus':
          bonuses += amount;
          break;
        case 'refund':
          refunds += amount;
          break;
      }
    });
    
    // Saldo neto = depósitos - retiros (bonos y reembolsos no afectan)
    const netBalance = deposits - withdrawals;
    
    // Resumen completo
    const summary = {
      deposits,
      withdrawals,
      bonuses,
      refunds,
      netBalance,
      totalTransactions: transactions.length
    };
    
    res.json({
      transactions,
      summary,
      dateRange: { from, to }
    });
  } catch (error) {
    console.error('Error obteniendo transacciones:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ESTADÍSTICAS
// ============================================

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const onlineUsers = await User.countDocuments({ lastLogin: { $gte: new Date(Date.now() - 5 * 60 * 1000) } });
    const totalMessages = await Message.countDocuments();
    const totalTransactions = await Transaction.countDocuments();
    
    // Transacciones de hoy
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTransactions = await Transaction.find({ timestamp: { $gte: today } }).lean();
    
    let todayDeposits = 0;
    let todayWithdrawals = 0;
    todayTransactions.forEach(t => {
      if (t.type === 'deposit') todayDeposits += t.amount;
      if (t.type === 'withdrawal') todayWithdrawals += t.amount;
    });
    
    res.json({
      totalUsers,
      onlineUsers,
      totalMessages,
      totalTransactions,
      todayDeposits,
      todayWithdrawals
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// DATOS - Métricas de adquisición, actividad y recurrencia
// ============================================

app.get('/api/admin/datos', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Argentina es UTC-3 todo el año
    const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

    let startUTC, endUTC, periodLabel, isSingleDay = true;

    if (req.query.date) {
      // Fecha exacta YYYY-MM-DD en ART
      const [year, month, day] = req.query.date.split('-').map(Number);
      if (!year || !month || !day) {
        return res.status(400).json({ error: 'Formato de fecha inválido. Use YYYY-MM-DD.' });
      }
      startUTC = new Date(Date.UTC(year, month - 1, day, 3, 0, 0, 0)); // ART 00:00 = UTC 03:00
      endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
      periodLabel = req.query.date;
    } else {
      const period = req.query.period || 'today';
      const nowUTC = Date.now();
      const todayART = new Date(nowUTC - ART_OFFSET_MS);
      todayART.setUTCHours(0, 0, 0, 0);
      const todayStartUTC = new Date(todayART.getTime() + ART_OFFSET_MS);

      if (period === 'yesterday') {
        startUTC    = new Date(todayStartUTC.getTime() - 24 * 60 * 60 * 1000);
        endUTC      = new Date(todayStartUTC.getTime() - 1);
        periodLabel = 'Ayer';
      } else if (period === 'last7') {
        startUTC    = new Date(todayStartUTC.getTime() - 6 * 24 * 60 * 60 * 1000);
        endUTC      = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
        periodLabel = 'Últimos 7 días';
        isSingleDay = false;
      } else if (period === 'last30') {
        startUTC    = new Date(todayStartUTC.getTime() - 29 * 24 * 60 * 60 * 1000);
        endUTC      = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
        periodLabel = 'Últimos 30 días';
        isSingleDay = false;
      } else {
        // today (default)
        startUTC    = todayStartUTC;
        endUTC      = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
        periodLabel = 'Hoy';
      }
    }

    // Consultas paralelas
    const [registeredCount, depositStats, neverDepositedResult] = await Promise.all([

      // Bloque A: usuarios role:'user' creados en el período
      User.countDocuments({ createdAt: { $gte: startUTC, $lte: endUTC }, role: 'user' }),

      // Bloques B + C + D: análisis completo de depósitos
      Transaction.aggregate([
        // 1. Depósitos del período
        { $match: { type: 'deposit', timestamp: { $gte: startUTC, $lte: endUTC } } },

        // 2. Agrupar por usuario: operaciones y monto en el período
        { $group: {
          _id: '$username',
          periodDepositCount:  { $sum: 1 },
          periodDepositAmount: { $sum: '$amount' }
        }},

        // 3. Buscar si el usuario tuvo depósitos ANTERIORES al período
        { $lookup: {
          from: 'transactions',
          let: { uname: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$type', 'deposit'] },
              { $eq: ['$username', '$$uname'] },
              { $lt: ['$timestamp', startUTC] }
            ]}}}
          ],
          as: 'priorDeposits'
        }},

        // 4. Clasificar: ¿primera vez o recurrente? ¿depositó 2+ veces en el período?
        { $addFields: {
          isFirstTime: { $eq: [{ $size: '$priorDeposits' }, 0] },
          hasMultiple: { $gte: ['$periodDepositCount', 2] }
        }},

        // 5. Totales
        { $group: {
          _id:                  null,
          totalDeposits:        { $sum: '$periodDepositCount' },
          totalAmount:          { $sum: '$periodDepositAmount' },
          uniqueDepositors:     { $sum: 1 },
          firstTimeDeposits:    { $sum: { $cond: ['$isFirstTime', '$periodDepositCount', 0] } },
          firstTimeAmount:      { $sum: { $cond: ['$isFirstTime', '$periodDepositAmount', 0] } },
          firstTimeUsers:       { $sum: { $cond: ['$isFirstTime', 1, 0] } },
          returningDeposits:    { $sum: { $cond: ['$isFirstTime', 0, '$periodDepositCount'] } },
          returningAmount:      { $sum: { $cond: ['$isFirstTime', 0, '$periodDepositAmount'] } },
          returningUsers:       { $sum: { $cond: ['$isFirstTime', 0, 1] } },
          multipleDepositUsers: { $sum: { $cond: ['$hasMultiple', 1, 0] } }
        }}
      ]),

      // Bloque A: usuarios registrados en el período que NUNCA han depositado
      User.aggregate([
        { $match: { createdAt: { $gte: startUTC, $lte: endUTC }, role: 'user' } },
        { $lookup: {
          from: 'transactions',
          let: { uname: '$username' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$type', 'deposit'] },
              { $eq: ['$username', '$$uname'] }
            ]}}}
          ],
          as: 'allDeposits'
        }},
        { $match: { allDeposits: { $size: 0 } } },
        { $count: 'total' }
      ])
    ]);

    const ds = depositStats[0] || {
      totalDeposits: 0, totalAmount: 0, uniqueDepositors: 0,
      firstTimeDeposits: 0, firstTimeAmount: 0, firstTimeUsers: 0,
      returningDeposits: 0, returningAmount: 0, returningUsers: 0,
      multipleDepositUsers: 0
    };
    const neverDeposited = neverDepositedResult[0] ? neverDepositedResult[0].total : 0;

    // Métricas derivadas (null si sin datos suficientes)
    const conversionRate     = registeredCount > 0       ? Math.round((ds.firstTimeUsers  / registeredCount)      * 1000) / 10 : null;
    const depositFrequency   = ds.uniqueDepositors > 0   ? Math.round((ds.totalDeposits   / ds.uniqueDepositors)  * 100)  / 100 : null;
    const avgTicket          = ds.totalDeposits > 0      ? Math.round( ds.totalAmount      / ds.totalDeposits)              : null;
    const avgPerDepositor    = ds.uniqueDepositors > 0   ? Math.round( ds.totalAmount      / ds.uniqueDepositors)           : null;
    const returningPct       = ds.uniqueDepositors > 0   ? Math.round((ds.returningUsers   / ds.uniqueDepositors)  * 1000) / 10 : null;
    const repeatRate         = ds.uniqueDepositors > 0   ? Math.round((ds.multipleDepositUsers / ds.uniqueDepositors) * 1000) / 10 : null;

    res.json({
      status: 'success',
      data: {
        period: { label: periodLabel, startUTC, endUTC, isSingleDay },

        // Bloque A — Adquisición
        acquisition: {
          registeredUsers:          registeredCount,
          firstDepositUsers:        ds.firstTimeUsers,
          conversionRate,
          registeredNeverDeposited: neverDeposited
        },

        // Bloque B — Actividad de depósitos
        depositActivity: {
          totalDeposits:          ds.totalDeposits,
          uniqueDepositors:       ds.uniqueDepositors,
          firstTimeDeposits:      ds.firstTimeDeposits,
          firstTimeDepositUsers:  ds.firstTimeUsers,
          returningDeposits:      ds.returningDeposits,
          returningDepositUsers:  ds.returningUsers,
          depositFrequency
        },

        // Bloque C — Calidad económica
        economicQuality: {
          totalAmount:      ds.totalAmount,
          avgTicket,
          avgPerDepositor,
          firstTimeAmount:  ds.firstTimeAmount,
          returningAmount:  ds.returningAmount
        },

        // Bloque D — Recurrencia
        recurrence: {
          activeReturningUsers: ds.returningUsers,
          returningPct,
          multipleDepositUsers: ds.multipleDepositUsers,
          repeatRate
        }
      }
    });
  } catch (error) {
    console.error('Error obteniendo datos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// NUEVO PANEL DE ADMIN - ENDPOINTS ADICIONALES
// ============================================

// Cambiar contraseña de usuario (admin) - CON PERMISOS POR ROL
app.post('/api/admin/change-password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    const adminRole = req.user.role;
    
    if (!userId || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Datos inválidos. La contraseña debe tener al menos 6 caracteres.' });
    }
    
    const user = await User.findOne({ id: userId });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    // PERMISOS POR ROL:
    // - Admin general: puede cambiar contraseña de TODOS incluyendo admins
    // - Admin depositor: puede cambiar contraseña de usuarios pero NO de admins
    // - Admin withdrawer: NO puede cambiar contraseñas
    
    if (adminRole === 'withdrawer') {
      return res.status(403).json({ error: 'No tienes permiso para cambiar contraseñas' });
    }
    
    if (adminRole === 'depositor' && user.role !== 'user') {
      return res.status(403).json({ error: 'Solo puedes cambiar contraseñas de usuarios, no de administradores' });
    }
    
    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordChangedAt = new Date();
    await user.save();
    
    // Enviar mensaje al usuario
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: `🔑 Tu contraseña ha sido cambiada por un administrador.\n\nTu nueva contraseña es: ${newPassword}\n\nPor seguridad, te recomendamos cambiarla después de iniciar sesión.`,
      type: 'text',
      timestamp: new Date(),
      read: false
    });
    
    // Notificar por socket
    const userSocket = connectedUsers.get(userId);
    if (userSocket) {
      userSocket.emit('new_message', {
        senderId: req.user.userId,
        senderUsername: req.user.username,
        content: 'Tu contraseña ha sido cambiada por un administrador.',
        timestamp: new Date()
      });
    }
    
    res.json({ success: true, message: 'Contraseña cambiada correctamente' });
  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Enviar chat a cargas (antes "pagos")
app.post('/api/admin/send-to-payments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Usuario no especificado' });
    }
    
    // Todos los admins (admin, depositor, withdrawer) pueden enviar a cargas
    
    // Actualizar estado del chat a CARGAS (antes "payments")
    await ChatStatus.findOneAndUpdate(
      { userId },
      { 
        status: 'payments',
        category: 'payments',
        assignedTo: null,
        updatedAt: new Date()
      },
      { upsert: true }
    );
    
    // Enviar mensaje al usuario
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: '💳 Tu chat ha sido transferido al departamento de PAGOS. Un agente especializado te atenderá pronto.\n\nPor favor para agilizar el tiempo envie monto a retirar y cvu por favor!',
      type: 'text',
      timestamp: new Date(),
      read: false
    });
    
    // Notificar a admins
    notifyAdmins('chat_moved', { userId, to: 'payments', by: req.user.username });
    
    res.json({ success: true, message: 'Chat enviado a cargas' });
  } catch (error) {
    console.error('Error enviando a cargas:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Enviar chat de vuelta a Abiertos (desde Pagos o Cerrados)
app.post('/api/admin/send-to-open', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Usuario no especificado' });
    }

    // Withdrawer no puede enviar a abiertos
    if (req.user.role === 'withdrawer') {
      return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    }

    // Al mover a Abiertos: resetear categoría a 'cargas' (pool general)
    // y liberar asignación para que cualquier agente pueda tomar el chat
    await ChatStatus.findOneAndUpdate(
      { userId },
      {
        status: 'open',
        category: 'cargas',
        assignedTo: null,
        closedAt: null,
        closedBy: null,
        updatedAt: new Date()
      },
      { upsert: true }
    );

    notifyAdmins('chat_moved', { userId, to: 'open', by: req.user.username });

    res.json({ success: true, message: 'Chat enviado a abiertos' });
  } catch (error) {
    console.error('Error enviando a abiertos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Cerrar chat - SOLO INTERNO (no notifica al cliente)
app.post('/api/admin/close-chat', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, notifyClient = false, isPaymentsTab = false } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Usuario no especificado' });
    }
    
    // Actualizar estado del chat
    await ChatStatus.findOneAndUpdate(
      { userId },
      { 
        status: 'closed',
        assignedTo: null,
        closedAt: new Date(),
        closedBy: req.user.userId,
        updatedAt: new Date()
      },
      { upsert: true }
    );
    
    // Fix #3: Crear mensaje de sistema interno (solo visible para admins, persiste en historial)
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: req.user.role || 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: `Chat cerrado por: ${req.user.username}. Puedes seguir respondiendo si el usuario escribe. El chat se reabrirá automáticamente si el cliente envía un mensaje.`,
      type: 'system',
      adminOnly: true,
      read: true,
      timestamp: new Date()
    });
    
    // Notificar a admins (siempre, es interno)
    notifyAdmins('chat_closed', { userId, by: req.user.username, adminId: req.user.userId, isPaymentsTab });
    
    res.json({ success: true, message: 'Chat cerrado correctamente', closedBy: req.user.username });
  } catch (error) {
    console.error('Error cerrando chat:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Obtener conversaciones para el nuevo panel
// OPTIMIZADO: Una sola query con agregación
app.get('/api/admin/conversations', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let { status = 'open' } = req.query;
    
    const userRole = req.user.role;
    
    if (userRole === 'depositor' && status === 'payments') {
      return res.status(403).json({ error: 'Acceso denegado. Los depositores no pueden ver chats de pagos.' });
    }
    
    if (userRole === 'withdrawer' && status !== 'payments') {
      return res.status(403).json({ error: 'Acceso denegado. Los withdrawers solo pueden ver chats de pagos.' });
    }
    
    // AGREGACIÓN OPTIMIZADA: Todo en una sola query
    const pipeline = [
      { $match: { status } },
      { $sort: { lastMessageAt: -1 } },
      { $limit: 100 },
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
            { $match: { $expr: { $and: [
              { $eq: ['$receiverId', 'admin'] },
              { $eq: ['$senderId', '$$uid'] },
              { $eq: ['$read', false] }
            ]}}},
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
            { $match: { $expr: { $or: [
              { $eq: ['$senderId', '$$uid'] },
              { $eq: ['$receiverId', '$$uid'] }
            ]}}},
            { $sort: { timestamp: -1 } },
            { $limit: 1 },
            { $project: { content: 1, timestamp: 1 } }
          ],
          as: 'lastMsg'
        }
      },
      {
        $project: {
          userId: 1,
          username: '$user.username',
          balance: { $ifNull: ['$user.balance', 0] },
          online: { $gt: [{ $ifNull: ['$user.lastLogin', new Date(0)] }, { $subtract: [new Date(), 300000] }] },
          unread: { $ifNull: [{ $arrayElemAt: ['$unread.count', 0] }, 0] },
          lastMessage: { $arrayElemAt: ['$lastMsg.content', 0] },
          lastMessageAt: { $ifNull: ['$lastMessageAt', '$updatedAt', new Date()] },
          status: 1
        }
      }
    ];
    
    const conversations = await ChatStatus.aggregate(pipeline);
    
    res.json({ conversations });
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Obtener información de usuario específico
app.get('/api/users/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findOne({ id: userId }).select('-password').lean();
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({ user });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// GESTIÓN DE CBU
// ============================================

// Obtener CBU actual
app.get('/api/admin/cbu', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cbuConfig = await getConfig('cbu');
    res.json(cbuConfig || { bank: '', titular: '', number: '', alias: '' });
  } catch (error) {
    console.error('Error obteniendo CBU:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Actualizar CBU
app.post('/api/admin/cbu', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { bank, titular, number, alias } = req.body;
    
    if (!number || number.length < 10) {
      return res.status(400).json({ error: 'CBU inválido' });
    }
    
    await setConfig('cbu', { bank, titular, number, alias });
    res.json({ success: true, message: 'CBU actualizado correctamente' });
  } catch (error) {
    console.error('Error actualizando CBU:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// GESTIÓN DE USUARIOS (ADMIN)
// ============================================

// Obtener todos los usuarios
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userRole = req.user.role;
    
    // Construir query según rol
    let query = {};
    if (userRole !== 'admin') {
      // Depositor y withdrawer solo ven usuarios (no admins)
      query.role = 'user';
    }
    // Admin general ve TODOS (usuarios y admins)
    
    const users = await User.find(query).select('-password').sort({ role: 1, username: 1 }).lean();
    res.json({ users });
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Crear usuario o admin
app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, email, phone, role = 'user' } = req.body;
    const adminRole = req.user.role;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    // Validar rol
    const validRoles = ['user', 'admin', 'depositor', 'withdrawer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    
    // Restricciones de rol para crear usuarios
    if (adminRole !== 'admin' && role !== 'user') {
      return res.status(403).json({ error: 'Solo el administrador general puede crear otros administradores' });
    }
    
    // Verificar si el usuario ya existe
    const existingUser = await User.findOne({ username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } });
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    
    const newUser = await User.create({
      id: userId,
      username,
      password: hashedPassword,
      email: email || null,
      phone: phone || null,
      role,
      accountNumber: generateAccountNumber(),
      balance: 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: null,
      jugayganaUsername: null,
      jugayganaSyncStatus: role === 'user' ? 'pending' : 'not_applicable'
    });
    
    // Si es usuario normal, crear chat status
    if (role === 'user') {
      await ChatStatus.create({
        userId: userId,
        username: username,
        status: 'open',
        category: 'cargas'
      });
    }
    
    res.status(201).json({
      success: true,
      message: role === 'user' ? 'Usuario creado correctamente' : 'Administrador creado correctamente',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role
      }
    });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// GESTIÓN DE COMANDOS
// ============================================

// Obtener todos los comandos
app.get('/api/admin/commands', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const commands = await Command.find().lean();
    res.json({ commands });
  } catch (error) {
    console.error('Error obteniendo comandos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Crear comando
app.post('/api/admin/commands', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, description, response } = req.body;
    
    if (!name || !name.startsWith('/')) {
      return res.status(400).json({ error: 'El comando debe empezar con /' });
    }
    
    await Command.findOneAndUpdate(
      { name },
      { 
        name,
        description: description || '',
        response: response || '',
        isActive: true,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );
    
    res.json({ success: true, message: 'Comando guardado correctamente' });
  } catch (error) {
    console.error('Error guardando comando:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Eliminar comando
app.delete('/api/admin/commands/:name', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cmd = await Command.findOne({ name: req.params.name });
    if (cmd && cmd.isSystem) {
      return res.status(403).json({ error: 'No se puede eliminar un comando del sistema' });
    }
    await Command.deleteOne({ name: req.params.name });
    res.json({ success: true, message: 'Comando eliminado correctamente' });
  } catch (error) {
    console.error('Error eliminando comando:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// BASE DE DATOS - PROTEGIDA CON CONTRASEÑA
// ============================================

const DB_PASSWORD = process.env.DB_PASSWORD || 'P4pelito2026';

// Middleware para verificar contraseña de base de datos
function dbPasswordMiddleware(req, res, next) {
  const { dbPassword } = req.body || req.query;
  
  if (dbPassword !== DB_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  
  next();
}

// Verificar acceso a base de datos
app.post('/api/admin/database/verify', authMiddleware, adminMiddleware, dbPasswordMiddleware, (req, res) => {
  res.json({ success: true, message: 'Acceso concedido' });
});

// Obtener todos los usuarios y admins para base de datos
// CORREGIDO: Usar la misma lógica que /api/admin/users para consistencia
app.get('/api/admin/database/users', authMiddleware, adminMiddleware, dbPasswordMiddleware, async (req, res) => {
  try {
    const userRole = req.user.role;
    
    // Construir query según rol (igual que en /api/admin/users)
    let query = {};
    if (userRole !== 'admin') {
      // Depositor y withdrawer solo ven usuarios (no admins)
      query.role = 'user';
    }
    // Admin general ve TODOS (usuarios y admins)
    
    const users = await User.find(query).select('-password').sort({ role: 1, username: 1 }).lean();
    res.json({ users, total: users.length });
  } catch (error) {
    console.error('Error obteniendo usuarios de base de datos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Exportar base de datos a CSV
app.get('/api/admin/database/export/csv', authMiddleware, adminMiddleware, dbPasswordMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 }).lean();
    
    // Crear CSV con todos los campos
    let csv = 'ID,Usuario,Email,Teléfono,Rol,Balance,AccountNumber,Estado,Último Login,Creado,JugayganaUserId,JugayganaUsername,JugayganaSyncStatus\n';
    
    users.forEach(user => {
      csv += `"${user.id}","${user.username}","${user.email || ''}","${user.phone || ''}","${user.role}","${user.balance || 0}","${user.accountNumber || ''}","${user.isActive ? 'Activo' : 'Inactivo'}","${user.lastLogin || 'Nunca'}","${user.createdAt || ''}","${user.jugayganaUserId || ''}","${user.jugayganaUsername || ''}","${user.jugayganaSyncStatus || ''}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=base_de_datos_completa.csv');
    res.send('\uFEFF' + csv); // BOM para Excel
  } catch (error) {
    console.error('Error exportando base de datos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// EXPORTAR USUARIOS A CSV
// ============================================

app.get('/api/admin/users/export/csv', authMiddleware, async (req, res) => {
  // Solo el admin general puede exportar usuarios
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado. Solo el admin general puede exportar usuarios.' });
  }
  try {
    const users = await User.find().select('username phone email balance lastLogin').lean();
    
    // Crear CSV
    let csv = 'Usuario,Teléfono,Email,Balance,Último Login\n';
    users.forEach(user => {
      csv += `"${user.username}","${user.phone || ''}","${user.email || ''}","${user.balance || 0}","${user.lastLogin || 'Nunca'}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=usuarios.csv');
    res.send(csv);
  } catch (error) {
    console.error('Error exportando usuarios:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ENDPOINT DE DIAGNÓSTICO PÚBLICO - TEST CREAR MENSAJE
// ============================================

app.get('/api/diagnostic/public', async (req, res) => {
  try {
    console.log('[DIAGNOSTIC_PUBLIC] ============================================');
    console.log('[DIAGNOSTIC_PUBLIC] Probando conexión y creación de mensaje');
    
    // Verificar conexión a MongoDB
    const mongoState = mongoose.connection.readyState;
    console.log('[DIAGNOSTIC_PUBLIC] Estado de conexión MongoDB:', mongoState);
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    
    if (mongoState !== 1) {
      return res.status(500).json({
        success: false,
        error: 'MongoDB no está conectado',
        mongodbState: mongoState
      });
    }
    
    const testMessageData = {
      id: uuidv4(),
      senderId: 'diagnostic-test',
      senderUsername: 'diagnostic',
      senderRole: 'admin',
      receiverId: 'test-user',
      receiverRole: 'user',
      content: 'Test message - ' + new Date().toISOString(),
      type: 'text',
      timestamp: new Date(),
      read: false
    };
    
    console.log('[DIAGNOSTIC_PUBLIC] Intentando crear mensaje...');
    
    let createdMessage;
    try {
      createdMessage = await Message.create(testMessageData);
      console.log('[DIAGNOSTIC_PUBLIC] ✅ Mensaje CREADO - ID:', createdMessage.id);
    } catch (err) {
      console.error('[DIAGNOSTIC_PUBLIC] ❌ ERROR al crear:', err.message);
      console.error('[DIAGNOSTIC_PUBLIC] Error name:', err.name);
      console.error('[DIAGNOSTIC_PUBLIC] Error code:', err.code);
      return res.status(500).json({
        success: false,
        error: err.message,
        errorName: err.name,
        errorCode: err.code,
        mongodbState: mongoState
      });
    }
    
    // Verificar que se guardó
    const verifyMessage = await Message.findOne({ id: createdMessage.id }).lean();
    console.log('[DIAGNOSTIC_PUBLIC] Verificación - mensaje encontrado:', !!verifyMessage);
    
    // Contar mensajes totales
    const totalMessages = await Message.countDocuments();
    
    res.json({
      success: true,
      message: 'Diagnóstico completado',
      mongodbState: mongoState,
      mongodbConnected: true,
      totalMessages: totalMessages,
      testMessageCreated: {
        id: createdMessage.id,
        content: createdMessage.content,
        timestamp: createdMessage.timestamp
      },
      verified: !!verifyMessage
    });
  } catch (error) {
    console.error('[DIAGNOSTIC_PUBLIC] ❌ ERROR:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      errorName: error.name,
      mongodbState: mongoose.connection.readyState
    });
  }
});

// ============================================
// ENDPOINT DE DIAGNÓSTICO - TEST CREAR MENSAJE (con auth)
// ============================================

app.post('/api/diagnostic/test-message', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    console.log('[DIAGNOSTIC_TEST] ============================================');
    console.log('[DIAGNOSTIC_TEST] Probando creación de mensaje');
    
    // Verificar conexión a MongoDB
    console.log('[DIAGNOSTIC_TEST] Estado de conexión MongoDB:', mongoose.connection.readyState);
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    
    const testMessageData = {
      id: uuidv4(),
      senderId: 'test-admin-id',
      senderUsername: 'test-admin',
      senderRole: 'admin',
      receiverId: 'test-user-id',
      receiverRole: 'user',
      content: 'Mensaje de prueba - ' + new Date().toISOString(),
      type: 'text',
      timestamp: new Date(),
      read: false
    };
    
    console.log('[DIAGNOSTIC_TEST] Datos de prueba:', JSON.stringify(testMessageData, null, 2));
    console.log('[DIAGNOSTIC_TEST] Modelo Message definido:', !!Message);
    console.log('[DIAGNOSTIC_TEST] Modelo Message collection:', Message.collection.name);
    
    let createdMessage;
    try {
      createdMessage = await Message.create(testMessageData);
      console.log('[DIAGNOSTIC_TEST] ✅ Mensaje de prueba CREADO');
      console.log('[DIAGNOSTIC_TEST] ID:', createdMessage.id);
      console.log('[DIAGNOSTIC_TEST] _id:', createdMessage._id);
    } catch (err) {
      console.error('[DIAGNOSTIC_TEST] ❌ ERROR al crear:', err.message);
      console.error('[DIAGNOSTIC_TEST] Error name:', err.name);
      console.error('[DIAGNOSTIC_TEST] Error code:', err.code);
      throw err;
    }
    
    // Verificar que se guardó
    const verifyMessage = await Message.findOne({ id: createdMessage.id }).lean();
    console.log('[DIAGNOSTIC_TEST] Verificación - mensaje encontrado:', !!verifyMessage);
    
    res.json({
      success: true,
      message: 'Mensaje de prueba creado',
      createdMessage: {
        id: createdMessage.id,
        content: createdMessage.content,
        timestamp: createdMessage.timestamp
      },
      verified: !!verifyMessage,
      mongodbState: mongoose.connection.readyState
    });
  } catch (error) {
    console.error('[DIAGNOSTIC_TEST] ❌ ERROR:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      errorName: error.name,
      errorCode: error.code,
      mongodbState: mongoose.connection.readyState
    });
  }
});

// ============================================
// ENDPOINT DE DIAGNÓSTICO
// ============================================

app.get('/api/diagnostic/messages', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalMessages = await Message.countDocuments();
    const recentMessages = await Message.find().sort({ timestamp: -1 }).limit(5).lean();
    const messageStats = await Message.aggregate([
      { $group: { _id: '$senderRole', count: { $sum: 1 } } }
    ]);
    
    res.json({
      totalMessages,
      recentMessages: recentMessages.map(m => ({
        id: m.id,
        senderId: m.senderId,
        senderRole: m.senderRole,
        receiverId: m.receiverId,
        content: m.content.substring(0, 50),
        timestamp: m.timestamp
      })),
      statsByRole: messageStats,
      mongodbConnected: mongoose.connection.readyState === 1,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[DIAGNOSTIC] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================

if (process.env.VERCEL) {
  initializeData().then(() => {
    logger.info('Data initialized for Vercel');
  });
  
  module.exports = app;
} else {
  initializeData().then(async () => {
    await setupRedisAdapter();
    server.listen(PORT, () => {
      logger.info(`Server started on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    });
  });
}