
/**
 * Manejador de errores centralizado
 * Captura todos los errores y responde con formato consistente
 */
const logger = require('../utils/logger');
const { AppError, ErrorMessages } = require('../utils/AppError');

/**
 * Manejar errores de MongoDB duplicados
 */
const handleDuplicateFieldsDB = (err) => {
  const field = Object.keys(err.keyValue)[0];
  const value = err.keyValue[field];
  const message = `El valor '${value}' ya existe para el campo '${field}'`;
  return new AppError(message, 400, 'DB_DUPLICATE');
};

/**
 * Manejar errores de validación de MongoDB
 */
const handleValidationErrorDB = (err) => {
  const errors = Object.values(err.errors).map(el => el.message);
  const message = `Datos inválidos: ${errors.join('. ')}`;
  return new AppError(message, 400, 'VALIDATION_ERROR');
};

/**
 * Manejar errores de JWT
 */
const handleJWTError = () => {
  return new AppError(
    ErrorMessages.AUTH_TOKEN_INVALID || 'Token inválido',
    401,
    'AUTH_TOKEN_INVALID'
  );
};

/**
 * Manejar errores de JWT expirado
 */
const handleJWTExpiredError = () => {
  return new AppError(
    ErrorMessages.AUTH_TOKEN_EXPIRED || 'Token expirado',
    401,
    'AUTH_TOKEN_EXPIRED'
  );
};

/**
 * Manejar errores de Cast de MongoDB (ID inválido)
 */
const handleCastErrorDB = (err) => {
  const message = `Valor inválido: ${err.value} para el campo ${err.path}`;
  return new AppError(message, 400, 'INVALID_ID');
};

/**
 * Enviar error en desarrollo (con detalles completos)
 */
const sendErrorDev = (err, req, res) => {
  // Log del error
  logger.error('Error en desarrollo:', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    user: req.user?.userId
  });

  return res.status(err.statusCode || 500).json({
    status: err.status || 'error',
    errorCode: err.errorCode || 'UNKNOWN',
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
    path: req.originalUrl
  });
};

/**
 * Enviar error en producción (sin detalles sensibles)
 */
const sendErrorProd = (err, req, res) => {
  // Error operacional: enviar mensaje al cliente
  if (err.isOperational) {
    logger.warn('Error operacional:', {
      message: err.message,
      errorCode: err.errorCode,
      url: req.originalUrl,
      method: req.method,
      user: req.user?.userId
    });

    return res.status(err.statusCode).json({
      status: err.status,
      errorCode: err.errorCode,
      message: err.message,
      timestamp: err.timestamp || new Date().toISOString()
    });
  }

  // Error de programación: no filtrar detalles
  logger.error('Error de programación:', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    user: req.user?.userId
  });

  // Respuesta genérica para errores no operacionales
  return res.status(500).json({
    status: 'error',
    errorCode: 'SERVER_ERROR',
    message: 'Algo salió mal. Por favor, intenta más tarde.',
    timestamp: new Date().toISOString()
  });
};

/**
 * Middleware principal de manejo de errores
 */
module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (process.env.NODE_ENV === 'development') {
    sendErrorDev(err, req, res);
  } else {
    let error = { ...err, message: err.message };

    // Manejar tipos específicos de errores
    if (err.name === 'CastError') error = handleCastErrorDB(err);
    if (err.code === 11000) error = handleDuplicateFieldsDB(err);
    if (err.name === 'ValidationError') error = handleValidationErrorDB(err);
    if (err.name === 'JsonWebTokenError') error = handleJWTError();
    if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();

    sendErrorProd(error, req, res);
  }
};