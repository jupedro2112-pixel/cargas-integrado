
/**
 * Controlador de Autenticación
 * Maneja endpoints de login, registro y gestión de sesiones
 */
const authService = require('../services/authService');
const asyncHandler = require('../utils/asyncHandler');
const { AppError, ErrorCodes } = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * POST /api/auth/register
 * Registrar nuevo usuario
 */
const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  
  res.status(201).json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/auth/login
 * Iniciar sesión
 */
const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/auth/logout
 * Cerrar sesión
 */
const logout = asyncHandler(async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  await authService.logout(token);
  
  res.json({
    status: 'success',
    message: 'Sesión cerrada exitosamente'
  });
});

/**
 * GET /api/auth/verify
 * Verificar token y obtener información del usuario
 */
const verify = asyncHandler(async (req, res) => {
  const user = await authService.getCurrentUser(req.user.userId);
  
  res.json({
    status: 'success',
    data: { user }
  });
});

/**
 * POST /api/auth/change-password
 * Cambiar contraseña
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword, closeAllSessions } = req.body;
  
  const result = await authService.changePassword(
    req.user.userId,
    currentPassword,
    newPassword,
    { closeAllSessions }
  );
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/auth/refresh-token
 * Refrescar tokens
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    throw new AppError('Refresh token requerido', 400, ErrorCodes.AUTH_TOKEN_INVALID);
  }
  
  // Implementar lógica de refresh token
  // Por ahora, generamos nuevos tokens
  const { generateTokenPair } = require('../middlewares/auth');
  const { User } = require('../models');
  
  const user = await User.findOne({ id: req.user?.userId });
  if (!user) {
    throw new AppError('Usuario no encontrado', 404, ErrorCodes.USER_NOT_FOUND);
  }
  
  const tokens = generateTokenPair(user);
  
  res.json({
    status: 'success',
    data: tokens
  });
});

/**
 * POST /api/auth/find-user-by-phone
 * Buscar usuario por teléfono (recuperación de cuenta)
 */
const findUserByPhone = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  
  if (!phone || phone.trim().length < 8) {
    throw new AppError('Número de teléfono inválido', 400, ErrorCodes.VALIDATION_ERROR);
  }
  
  const user = await authService.findUserByPhone(phone.trim());
  
  res.json({
    status: 'success',
    data: {
      found: !!user,
      ...(user && { username: user.username, phone: user.phone })
    }
  });
});

/**
 * POST /api/auth/reset-password-by-phone
 * Resetear contraseña por teléfono
 */
const resetPasswordByPhone = asyncHandler(async (req, res) => {
  const { phone, newPassword } = req.body;
  
  if (!newPassword || newPassword.length < 6) {
    throw new AppError('La contraseña debe tener al menos 6 caracteres', 400, ErrorCodes.VALIDATION_ERROR);
  }
  
  const result = await authService.resetPasswordByPhone(phone.trim(), newPassword);
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * GET /api/auth/check-username
 * Verificar disponibilidad de username
 */
const checkUsername = asyncHandler(async (req, res) => {
  const { username } = req.query;
  
  if (!username || username.length < 3) {
    return res.json({
      status: 'success',
      data: { available: false, message: 'Usuario muy corto' }
    });
  }
  
  const { User } = require('../models');
  const { jugayganaService } = require('../services');
  
  // Verificar localmente
  const localExists = await User.findByUsername(username);
  if (localExists) {
    return res.json({
      status: 'success',
      data: { available: false, message: 'Usuario ya registrado' }
    });
  }
  
  // Verificar en JUGAYGANA
  try {
    const jgUser = await jugayganaService.getUserInfo(username);
    if (jgUser) {
      return res.json({
        status: 'success',
        data: {
          available: false,
          message: 'Este nombre de usuario ya está en uso en JUGAYGANA',
          existsInJugaygana: true
        }
      });
    }
  } catch (error) {
    logger.warn('No se pudo verificar en JUGAYGANA:', error.message);
  }
  
  res.json({
    status: 'success',
    data: { available: true, message: 'Usuario disponible' }
  });
});

module.exports = {
  register,
  login,
  logout,
  verify,
  changePassword,
  refreshToken,
  findUserByPhone,
  resetPasswordByPhone,
  checkUsername
};