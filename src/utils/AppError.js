
/**
 * Clase de error personalizada para la aplicación
 * Extiende Error nativo de JavaScript
 */
class AppError extends Error {
  constructor(message, statusCode, errorCode = null, isOperational = true) {
    super(message);
    
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = isOperational;
    this.errorCode = errorCode;
    this.timestamp = new Date().toISOString();
    
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Códigos de error predefinidos
 */
const ErrorCodes = {
  // Errores de autenticación (1xx)
  AUTH_INVALID_CREDENTIALS: 'AUTH_001',
  AUTH_TOKEN_EXPIRED: 'AUTH_002',
  AUTH_TOKEN_INVALID: 'AUTH_003',
  AUTH_UNAUTHORIZED: 'AUTH_004',
  AUTH_FORBIDDEN: 'AUTH_005',
  AUTH_RATE_LIMIT: 'AUTH_006',
  
  // Errores de usuario (2xx)
  USER_NOT_FOUND: 'USER_001',
  USER_ALREADY_EXISTS: 'USER_002',
  USER_INVALID_DATA: 'USER_003',
  USER_INACTIVE: 'USER_004',
  
  // Errores de validación (3xx)
  VALIDATION_ERROR: 'VAL_001',
  VALIDATION_REQUIRED_FIELD: 'VAL_002',
  VALIDATION_INVALID_FORMAT: 'VAL_003',
  
  // Errores de base de datos (4xx)
  DB_CONNECTION_ERROR: 'DB_001',
  DB_QUERY_ERROR: 'DB_002',
  DB_NOT_FOUND: 'DB_003',
  
  // Errores de chat (5xx)
  CHAT_NOT_FOUND: 'CHAT_001',
  CHAT_SEND_ERROR: 'CHAT_002',
  
  // Errores de transacciones (6xx)
  TX_INSUFFICIENT_FUNDS: 'TX_001',
  TX_FAILED: 'TX_002',
  TX_INVALID_AMOUNT: 'TX_003',
  
  // Errores del servidor (9xx)
  SERVER_ERROR: 'SRV_001',
  SERVER_TIMEOUT: 'SRV_002',
  SERVER_MAINTENANCE: 'SRV_003'
};

/**
 * Mensajes de error predefinidos
 */
const ErrorMessages = {
  [ErrorCodes.AUTH_INVALID_CREDENTIALS]: 'Usuario o contraseña incorrectos',
  [ErrorCodes.AUTH_TOKEN_EXPIRED]: 'Tu sesión ha expirado. Por favor, inicia sesión nuevamente',
  [ErrorCodes.AUTH_TOKEN_INVALID]: 'Token de autenticación inválido',
  [ErrorCodes.AUTH_UNAUTHORIZED]: 'No estás autorizado para realizar esta acción',
  [ErrorCodes.AUTH_FORBIDDEN]: 'Acceso denegado',
  [ErrorCodes.AUTH_RATE_LIMIT]: 'Demasiados intentos. Por favor, espera un momento',
  
  [ErrorCodes.USER_NOT_FOUND]: 'Usuario no encontrado',
  [ErrorCodes.USER_ALREADY_EXISTS]: 'El usuario ya existe',
  [ErrorCodes.USER_INVALID_DATA]: 'Datos de usuario inválidos',
  [ErrorCodes.USER_INACTIVE]: 'Usuario desactivado',
  
  [ErrorCodes.VALIDATION_ERROR]: 'Error de validación',
  [ErrorCodes.VALIDATION_REQUIRED_FIELD]: 'Campo requerido faltante',
  [ErrorCodes.VALIDATION_INVALID_FORMAT]: 'Formato inválido',
  
  [ErrorCodes.DB_CONNECTION_ERROR]: 'Error de conexión con la base de datos',
  [ErrorCodes.DB_QUERY_ERROR]: 'Error en la consulta',
  [ErrorCodes.DB_NOT_FOUND]: 'Recurso no encontrado',
  
  [ErrorCodes.CHAT_NOT_FOUND]: 'Chat no encontrado',
  [ErrorCodes.CHAT_SEND_ERROR]: 'Error al enviar mensaje',
  
  [ErrorCodes.TX_INSUFFICIENT_FUNDS]: 'Saldo insuficiente',
  [ErrorCodes.TX_FAILED]: 'Transacción fallida',
  [ErrorCodes.TX_INVALID_AMOUNT]: 'Monto inválido',
  
  [ErrorCodes.SERVER_ERROR]: 'Error del servidor',
  [ErrorCodes.SERVER_TIMEOUT]: 'Tiempo de espera agotado',
  [ErrorCodes.SERVER_MAINTENANCE]: 'Servidor en mantenimiento'
};

module.exports = {
  AppError,
  ErrorCodes,
  ErrorMessages
};