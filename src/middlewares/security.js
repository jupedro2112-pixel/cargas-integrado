
/**
 * Middlewares de seguridad
 * Rate limiting, headers de seguridad, validación de inputs
 */
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const cors = require('cors');
const helmet = require('helmet');
const logger = require('../utils/logger');

/**
 * Rate limiting general para todas las rutas
 * 100 requests por IP cada 15 minutos
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: {
    status: 'fail',
    errorCode: 'RATE_LIMIT',
    message: 'Demasiadas solicitudes desde esta IP. Por favor, intenta más tarde.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit excedido para IP: ${req.ip}`, {
      ip: req.ip,
      url: req.originalUrl,
      method: req.method
    });
    res.status(options.statusCode).json(options.message);
  }
});

/**
 * Rate limiting estricto para autenticación
 * 5 intentos por IP cada 15 minutos
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  skipSuccessfulRequests: true, // No contar requests exitosos
  message: {
    status: 'fail',
    errorCode: 'AUTH_RATE_LIMIT',
    message: 'Demasiados intentos de autenticación. Por favor, espera 15 minutos.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn(`Auth rate limit excedido para IP: ${req.ip}`, {
      ip: req.ip,
      username: req.body?.username
    });
    res.status(options.statusCode).json(options.message);
  }
});

/**
 * Rate limiting para API de chat
 * Más permisivo para chat en tiempo real
 */
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 mensajes por minuto
  message: {
    status: 'fail',
    errorCode: 'CHAT_RATE_LIMIT',
    message: 'Estás enviando mensajes muy rápido. Por favor, espera un momento.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Configuración de CORS
 */
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',') 
      : ['http://localhost:3000', 'http://localhost:5173'];
    
    // Permitir requests sin origin (como mobile apps o curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS bloqueado para origen: ${origin}`);
      callback(new Error('No autorizado por CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin'
  ],
  exposedHeaders: ['X-Total-Count', 'X-RateLimit-Remaining']
};

/**
 * Configuración de Helmet para headers de seguridad
 */
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false, // Deshabilitado para compatibilidad
  hsts: {
    maxAge: 31536000, // 1 año
    includeSubDomains: true,
    preload: true
  }
});

/**
 * Sanitización de inputs
 */
const sanitizeInput = (req, res, next) => {
  // Sanitizar body
  if (req.body) {
    Object.keys(req.body).forEach(key => {
      if (typeof req.body[key] === 'string') {
        // Remover caracteres peligrosos
        req.body[key] = req.body[key]
          .replace(/[<>]/g, '')
          .trim()
          .substring(0, 5000); // Límite de 5000 caracteres
      }
    });
  }
  
  // Sanitizar query params
  if (req.query) {
    Object.keys(req.query).forEach(key => {
      if (typeof req.query[key] === 'string') {
        req.query[key] = req.query[key]
          .replace(/[<>]/g, '')
          .trim()
          .substring(0, 1000);
      }
    });
  }
  
  next();
};

/**
 * Validación de username
 */
const validateUsername = (username) => {
  if (!username || typeof username !== 'string') return false;
  const sanitized = username.trim();
  return /^[a-zA-Z0-9_.-]{3,30}$/.test(sanitized);
};

/**
 * Validación de password
 */
const validatePassword = (password) => {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 6 && password.length <= 100;
};

/**
 * Middleware de validación de campos de registro
 */
const validateRegister = (req, res, next) => {
  const { username, password, phone } = req.body;
  const errors = [];

  if (!username) {
    errors.push('El usuario es requerido');
  } else if (!validateUsername(username)) {
    errors.push('El usuario debe tener entre 3 y 30 caracteres alfanuméricos');
  }

  if (!password) {
    errors.push('La contraseña es requerida');
  } else if (!validatePassword(password)) {
    errors.push('La contraseña debe tener al menos 6 caracteres');
  }

  if (!phone) {
    errors.push('El número de teléfono es requerido');
  } else if (phone.trim().length < 8) {
    errors.push('El número de teléfono debe tener al menos 8 dígitos');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      status: 'fail',
      errorCode: 'VALIDATION_ERROR',
      message: 'Error de validación',
      errors
    });
  }

  next();
};

/**
 * Middleware de validación de login
 */
const validateLogin = (req, res, next) => {
  const { username, password } = req.body;
  const errors = [];

  if (!username) {
    errors.push('El usuario es requerido');
  }

  if (!password) {
    errors.push('La contraseña es requerida');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      status: 'fail',
      errorCode: 'VALIDATION_ERROR',
      message: 'Error de validación',
      errors
    });
  }

  next();
};

module.exports = {
  generalLimiter,
  authLimiter,
  chatLimiter,
  corsMiddleware: cors(corsOptions),
  helmet: helmetConfig,
  mongoSanitize: mongoSanitize(),
  xss: xss(),
  hpp: hpp(),
  sanitizeInput,
  validateRegister,
  validateLogin,
  validateUsername,
  validatePassword
};