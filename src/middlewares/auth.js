
/**
 * Middleware de autenticación JWT mejorado
 * Soporta access tokens y refresh tokens
 */
const jwt = require('jsonwebtoken');
const { AppError, ErrorCodes } = require('../utils/AppError');
const logger = require('../utils/logger');

// Claves secretas (deberían estar en variables de entorno)
const JWT_SECRET = process.env.JWT_SECRET || 'sala-de-juegos-secret-key-2024';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'sala-de-juegos-refresh-secret-2024';

// Tiempos de expiración
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || '15m';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';

// Lista negra de tokens revocados (en producción usar Redis)
const tokenBlacklist = new Set();

/**
 * Generar access token
 */
const generateAccessToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
};

/**
 * Generar refresh token
 */
const generateRefreshToken = (payload) => {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
};

/**
 * Generar par de tokens (access + refresh)
 */
const generateTokenPair = (user) => {
  const accessPayload = {
    userId: user.id || user._id?.toString(),
    username: user.username,
    role: user.role,
    type: 'access'
  };

  const refreshPayload = {
    userId: user.id || user._id?.toString(),
    username: user.username,
    type: 'refresh'
  };

  return {
    accessToken: generateAccessToken(accessPayload),
    refreshToken: generateRefreshToken(refreshPayload),
    expiresIn: 900 // 15 minutos en segundos
  };
};

/**
 * Verificar access token
 */
const verifyAccessToken = (token) => {
  try {
    if (tokenBlacklist.has(token)) {
      throw new Error('Token revocado');
    }
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw error;
  }
};

/**
 * Verificar refresh token
 */
const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (error) {
    throw error;
  }
};

/**
 * Revocar token (logout)
 */
const revokeToken = (token) => {
  tokenBlacklist.add(token);
  logger.info('Token revocado', { tokenPreview: token.substring(0, 20) + '...' });
};

/**
 * Middleware de autenticación
 * Verifica el token JWT en el header Authorization
 */
const authenticate = async (req, res, next) => {
  try {
    // Obtener token del header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError(
        'No se proporcionó token de autenticación',
        401,
        ErrorCodes.AUTH_UNAUTHORIZED
      ));
    }

    const token = authHeader.split(' ')[1];

    // Verificar token
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return next(new AppError(
          ErrorMessages[ErrorCodes.AUTH_TOKEN_EXPIRED],
          401,
          ErrorCodes.AUTH_TOKEN_EXPIRED
        ));
      }
      return next(new AppError(
        ErrorMessages[ErrorCodes.AUTH_TOKEN_INVALID],
        401,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    // Verificar que sea un access token
    if (decoded.type !== 'access') {
      return next(new AppError(
        'Tipo de token inválido',
        401,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    // Adjuntar usuario al request
    req.user = decoded;
    req.token = token;

    next();
  } catch (error) {
    logger.error('Error en autenticación:', error);
    next(new AppError(
      ErrorMessages[ErrorCodes.AUTH_UNAUTHORIZED],
      401,
      ErrorCodes.AUTH_UNAUTHORIZED
    ));
  }
};

/**
 * Middleware de autorización por roles
 * @param {...string} roles - Roles permitidos
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError(
        'No autenticado',
        401,
        ErrorCodes.AUTH_UNAUTHORIZED
      ));
    }

    if (!roles.includes(req.user.role)) {
      logger.warn(`Acceso denegado para usuario ${req.user.username} con rol ${req.user.role}`, {
        userId: req.user.userId,
        requiredRoles: roles,
        actualRole: req.user.role
      });

      return next(new AppError(
        'No tienes permiso para realizar esta acción',
        403,
        ErrorCodes.AUTH_FORBIDDEN
      ));
    }

    next();
  };
};

/**
 * Middleware específico para agentes de depósito
 */
const depositorOnly = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('No autenticado', 401, ErrorCodes.AUTH_UNAUTHORIZED));
  }

  const allowedRoles = ['admin', 'depositor'];
  if (!allowedRoles.includes(req.user.role)) {
    return next(new AppError(
      'Solo agentes de carga pueden realizar esta acción',
      403,
      ErrorCodes.AUTH_FORBIDDEN
    ));
  }

  next();
};

/**
 * Middleware específico para agentes de retiro
 */
const withdrawerOnly = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('No autenticado', 401, ErrorCodes.AUTH_UNAUTHORIZED));
  }

  const allowedRoles = ['admin', 'withdrawer'];
  if (!allowedRoles.includes(req.user.role)) {
    return next(new AppError(
      'Solo agentes de retiro pueden realizar esta acción',
      403,
      ErrorCodes.AUTH_FORBIDDEN
    ));
  }

  next();
};

/**
 * Middleware para verificar si el usuario es admin o el propietario del recurso
 */
const ownerOrAdmin = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('No autenticado', 401, ErrorCodes.AUTH_UNAUTHORIZED));
  }

  const resourceUserId = req.params.userId || req.body.userId;
  
  if (req.user.role === 'admin' || req.user.userId === resourceUserId) {
    return next();
  }

  return next(new AppError(
    'No tienes permiso para acceder a este recurso',
    403,
    ErrorCodes.AUTH_FORBIDDEN
  ));
};

/**
 * Endpoint para refrescar tokens
 */
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return next(new AppError(
        'Refresh token requerido',
        400,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(token);
    } catch (error) {
      return next(new AppError(
        'Refresh token inválido o expirado',
        401,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    // Verificar que sea un refresh token
    if (decoded.type !== 'refresh') {
      return next(new AppError(
        'Tipo de token inválido',
        401,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    // Aquí deberías verificar en la base de datos que el usuario aún existe y está activo
    // Por ahora, generamos nuevos tokens directamente

    const tokens = generateTokenPair({
      id: decoded.userId,
      username: decoded.username,
      role: decoded.role || 'user'
    });

    res.json({
      status: 'success',
      data: tokens
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  authenticate,
  authorize,
  depositorOnly,
  withdrawerOnly,
  ownerOrAdmin,
  generateTokenPair,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  revokeToken,
  refreshToken,
  JWT_SECRET,
  JWT_REFRESH_SECRET
};