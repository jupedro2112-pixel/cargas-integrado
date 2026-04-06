
/**
 * Servicio de Autenticación
 * Gestiona login, registro, tokens y sesiones
 */
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { User, ChatStatus } = require('../models');
const { generateTokenPair, revokeToken } = require('../middlewares/auth');
const { AppError, ErrorCodes, ErrorMessages } = require('../utils/AppError');
const logger = require('../utils/logger');

// Importar servicio de JUGAYGANA
const jugayganaService = require('./jugayganaService');

/**
 * Generar número de cuenta único
 */
const generateAccountNumber = () => {
  return 'ACC' + Date.now().toString().slice(-8) + 
    Math.random().toString(36).substr(2, 4).toUpperCase();
};

/**
 * Registrar nuevo usuario
 */
const register = async (userData) => {
  const { username, password, email, phone } = userData;
  
  logger.info(`Intentando registro de usuario: ${username}`);
  
  // Verificar si el usuario ya existe localmente
  const existingUser = await User.findByUsername(username);
  if (existingUser) {
    throw new AppError(
      ErrorMessages[ErrorCodes.USER_ALREADY_EXISTS],
      400,
      ErrorCodes.USER_ALREADY_EXISTS
    );
  }
  
  // Crear usuario en JUGAYGANA PRIMERO
  let jgResult;
  try {
    jgResult = await jugayganaService.syncUser({
      username: username,
      password: password
    });
    
    if (!jgResult.success && !jgResult.alreadyExists) {
      throw new AppError(
        `No se pudo crear el usuario en JUGAYGANA: ${jgResult.error || 'Error desconocido'}`,
        400,
        'JUGAYGANA_ERROR'
      );
    }
    
    logger.info(`Usuario creado/vinculado en JUGAYGANA: ${username}`);
  } catch (error) {
    logger.error('Error creando en JUGAYGANA:', error);
    throw new AppError(
      'Error al crear usuario en la plataforma. Intenta con otro nombre de usuario.',
      400,
      'JUGAYGANA_ERROR'
    );
  }
  
  // Crear usuario localmente
  const userId = uuidv4();
  
  const newUser = await User.create({
    id: userId,
    username: username.toLowerCase().trim(),
    password, // Se hashea automáticamente en el pre-save
    email: email || null,
    phone: phone ? phone.trim() : null,
    role: 'user',
    accountNumber: generateAccountNumber(),
    balance: jgResult.user?.balance || jgResult.user?.user_balance || 0,
    isActive: true,
    jugayganaUserId: jgResult.jugayganaUserId || jgResult.user?.user_id,
    jugayganaUsername: jgResult.jugayganaUsername || jgResult.user?.user_name,
    jugayganaSyncStatus: jgResult.alreadyExists ? 'linked' : 'synced'
  });
  
  // Crear chat status para el usuario
  await ChatStatus.create({
    userId: userId,
    username: newUser.username,
    status: 'open',
    category: 'cargas',
    lastMessageAt: new Date()
  });
  
  logger.info(`Usuario registrado exitosamente: ${username}`);
  
  // Generar tokens
  const tokens = generateTokenPair(newUser);
  
  return {
    user: {
      id: newUser.id,
      username: newUser.username,
      email: newUser.email,
      phone: newUser.phone,
      accountNumber: newUser.accountNumber,
      role: newUser.role,
      balance: newUser.balance,
      jugayganaLinked: !!newUser.jugayganaUserId
    },
    tokens
  };
};

/**
 * Iniciar sesión
 */
const login = async (credentials) => {
  const { username, password } = credentials;
  
  logger.info(`Intentando login para: ${username}`);
  
  // Buscar usuario (case-insensitive)
  let user = await User.findByUsername(username);
  
  // Si no existe localmente, verificar en JUGAYGANA
  if (!user) {
    logger.info(`Usuario ${username} no encontrado localmente, verificando en JUGAYGANA...`);
    
    const jgUser = await jugayganaService.getUserInfo(username);
    
    if (jgUser) {
      logger.info(`Usuario encontrado en JUGAYGANA, creando localmente...`);
      
      const userId = uuidv4();
      user = await User.create({
        id: userId,
        username: jgUser.username.toLowerCase(),
        password: await bcrypt.hash('asd123', 12),
        email: jgUser.email || null,
        phone: jgUser.phone || null,
        role: 'user',
        accountNumber: generateAccountNumber(),
        balance: jgUser.balance || 0,
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
      
      logger.info(`Usuario ${username} creado automáticamente desde JUGAYGANA`);
    } else {
      throw new AppError(
        ErrorMessages[ErrorCodes.AUTH_INVALID_CREDENTIALS],
        401,
        ErrorCodes.AUTH_INVALID_CREDENTIALS
      );
    }
  }
  
  // Verificar si el usuario está activo
  if (!user.isActive) {
    throw new AppError(
      ErrorMessages[ErrorCodes.USER_INACTIVE],
      401,
      ErrorCodes.USER_INACTIVE
    );
  }
  
  // Verificar contraseña
  const isValidPassword = await user.comparePassword(password);
  
  // Si no coincide y el usuario nunca cambió su contraseña, intentar con 'asd123'
  if (!isValidPassword && !user.passwordChangedAt && user.source === 'jugaygana') {
    const defaultHash = await bcrypt.hash('asd123', 12);
    const isDefaultPassword = await bcrypt.compare(password, defaultHash);
    
    if (!isDefaultPassword) {
      throw new AppError(
        ErrorMessages[ErrorCodes.AUTH_INVALID_CREDENTIALS],
        401,
        ErrorCodes.AUTH_INVALID_CREDENTIALS
      );
    }
  } else if (!isValidPassword) {
    throw new AppError(
      ErrorMessages[ErrorCodes.AUTH_INVALID_CREDENTIALS],
      401,
      ErrorCodes.AUTH_INVALID_CREDENTIALS
    );
  }
  
  // Actualizar último login
  user.lastLogin = new Date();
  await user.save();
  
  logger.info(`Login exitoso para: ${username}`);
  
  // Generar tokens
  const tokens = generateTokenPair(user);
  
  // Determinar si necesita cambiar contraseña
  const needsPasswordChange = (!user.passwordChangedAt && user.source === 'jugaygana') || 
    password === 'asd123';
  
  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      phone: user.phone,
      accountNumber: user.accountNumber,
      role: user.role,
      balance: user.balance,
      jugayganaLinked: !!user.jugayganaUserId,
      needsPasswordChange
    },
    tokens
  };
};

/**
 * Cambiar contraseña
 */
const changePassword = async (userId, currentPassword, newPassword, options = {}) => {
  const { closeAllSessions = false } = options;
  
  const user = await User.findOne({ id: userId });
  
  if (!user) {
    throw new AppError(
      ErrorMessages[ErrorCodes.USER_NOT_FOUND],
      404,
      ErrorCodes.USER_NOT_FOUND
    );
  }
  
  // Verificar contraseña actual
  const isValidPassword = await user.comparePassword(currentPassword);
  if (!isValidPassword) {
    throw new AppError(
      'Contraseña actual incorrecta',
      401,
      ErrorCodes.AUTH_INVALID_CREDENTIALS
    );
  }
  
  // Cambiar contraseña
  await user.changePassword(newPassword);
  
  logger.info(`Contraseña cambiada para usuario: ${user.username}`);
  
  return {
    success: true,
    sessionsClosed: closeAllSessions
  };
};

/**
 * Cerrar sesión (revocar token)
 */
const logout = (token) => {
  if (token) {
    revokeToken(token);
    logger.info('Token revocado en logout');
  }
  return { success: true };
};

/**
 * Obtener información del usuario actual
 */
const getCurrentUser = async (userId) => {
  const user = await User.findOne({ id: userId }).select('-password');
  
  if (!user) {
    throw new AppError(
      ErrorMessages[ErrorCodes.USER_NOT_FOUND],
      404,
      ErrorCodes.USER_NOT_FOUND
    );
  }
  
  return user;
};

/**
 * Buscar usuario por teléfono
 */
const findUserByPhone = async (phone) => {
  const user = await User.findByPhone(phone);
  
  if (!user) {
    return null;
  }
  
  return {
    username: user.username,
    phone: user.phone
  };
};

/**
 * Resetear contraseña por teléfono
 */
const resetPasswordByPhone = async (phone, newPassword) => {
  const user = await User.findByPhone(phone);
  
  if (!user) {
    throw new AppError(
      'No se encontró ningún usuario con ese número de teléfono',
      404,
      ErrorCodes.USER_NOT_FOUND
    );
  }
  
  await user.changePassword(newPassword);
  
  logger.info(`Contraseña reseteada por teléfono para: ${user.username}`);
  
  return {
    success: true,
    username: user.username
  };
};

module.exports = {
  register,
  login,
  changePassword,
  logout,
  getCurrentUser,
  findUserByPhone,
  resetPasswordByPhone
};