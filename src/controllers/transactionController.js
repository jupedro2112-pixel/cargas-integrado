
/**
 * Controlador de Transacciones
 * Maneja depósitos, retiros y bonificaciones
 */
const { transactionService, jugayganaService } = require('../services');
const { User, Message } = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const { AppError, ErrorCodes } = require('../utils/AppError');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * GET /api/balance
 * Obtener balance del usuario
 */
const getBalance = asyncHandler(async (req, res) => {
  const result = await jugayganaService.getBalance(req.user.username);
  
  if (!result.success) {
    throw new AppError(result.error, 400, ErrorCodes.TX_FAILED);
  }
  
  res.json({
    status: 'success',
    data: {
      balance: result.balance,
      username: result.username
    }
  });
});

/**
 * POST /api/admin/deposit
 * Realizar depósito (admin)
 */
const deposit = asyncHandler(async (req, res) => {
  const { userId, username, amount, bonus = 0, description } = req.body;
  
  // Buscar usuario
  let user;
  if (userId) {
    user = await User.findOne({ id: userId });
  } else if (username) {
    user = await User.findOne({ username });
  }
  
  if (!user) {
    throw new AppError('Usuario no encontrado', 404, ErrorCodes.USER_NOT_FOUND);
  }
  
  const result = await transactionService.deposit({
    userId: user.id,
    username: user.username,
    amount: parseFloat(amount),
    bonus: parseFloat(bonus),
    description,
    adminId: req.user.userId,
    adminUsername: req.user.username,
    adminRole: req.user.role
  });
  
  if (!result.success) {
    throw new AppError(result.error, 400, ErrorCodes.TX_FAILED);
  }
  
  // Crear mensajes de sistema (2 mensajes)
  let messageContent;
  if (bonus > 0) {
    messageContent = `🔒💰 Depósito de $${amount} (incluye $${bonus} de bonificación) acreditado con éxito. ✅ \n💸 Tu nuevo saldo es $${result.newBalance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥`;
  } else {
    messageContent = `🔒💰 Depósito de $${amount} acreditado con éxito. ✅ \n💸 Tu nuevo saldo es $${result.newBalance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥`;
  }
  await Message.create({
    id: uuidv4(),
    senderId: 'system',
    senderUsername: req.user.username,
    senderRole: 'admin',
    receiverId: user.id,
    receiverRole: 'user',
    content: messageContent,
    type: 'system',
    timestamp: new Date(),
    read: false
  });
  await Message.create({
    id: uuidv4(),
    senderId: 'system',
    senderUsername: req.user.username,
    senderRole: 'admin',
    receiverId: user.id,
    receiverRole: 'user',
    content: `🎮 ¡Recuerda!\nPara cargar o cobrar, ingresa a 🌐 www.vipcargas.com.\n🔥 ¡Ya tienes el acceso guardado, así que te queda más fácil y rápido cada vez que entres!  \n🕹️ ¡No olvides guardarla y mantenerla a mano!\n\nwww.vipcargas.com`,
    type: 'system',
    timestamp: new Date(),
    read: false
  });
  
  res.json({
    status: 'success',
    data: {
      message: 'Depósito realizado correctamente',
      newBalance: result.newBalance,
      transactionId: result.transaction.transactionId
    }
  });
});

/**
 * POST /api/admin/withdrawal
 * Realizar retiro (admin)
 */
const withdraw = asyncHandler(async (req, res) => {
  const { userId, username, amount, description } = req.body;
  
  // Buscar usuario
  let user;
  if (userId) {
    user = await User.findOne({ id: userId });
  } else if (username) {
    user = await User.findOne({ username });
  }
  
  if (!user) {
    throw new AppError('Usuario no encontrado', 404, ErrorCodes.USER_NOT_FOUND);
  }
  
  const result = await transactionService.withdraw({
    userId: user.id,
    username: user.username,
    amount: parseFloat(amount),
    description,
    adminId: req.user.userId,
    adminUsername: req.user.username,
    adminRole: req.user.role
  });
  
  if (!result.success) {
    throw new AppError(result.error, 400, ErrorCodes.TX_FAILED);
  }
  
  // Crear mensaje de sistema
  await Message.create({
    id: uuidv4(),
    senderId: 'system',
    senderUsername: req.user.username,
    senderRole: 'admin',
    receiverId: user.id,
    receiverRole: 'user',
    content: `🔒💸 Retiro de $${amount} realizado correctamente. \n💸 Tu nuevo saldo es $${result.newBalance} 💸\nSu pago se está procesando. Por favor, aguarde un momento.`,
    type: 'system',
    timestamp: new Date(),
    read: false
  });
  
  res.json({
    status: 'success',
    data: {
      message: 'Retiro realizado correctamente',
      newBalance: result.newBalance,
      transactionId: result.transaction.transactionId
    }
  });
});

/**
 * POST /api/admin/bonus
 * Aplicar bonificación (admin)
 */
const bonus = asyncHandler(async (req, res) => {
  const { username, userId, amount, description } = req.body;

  // Validar que userId y username sean strings para evitar inyección NoSQL
  const safeUserId = typeof userId === 'string' ? userId : undefined;
  const safeUsername = typeof username === 'string' ? username : undefined;
  
  // Resolver usuario desde userId o username
  let resolvedUser;
  if (safeUserId) {
    resolvedUser = await User.findOne({ id: safeUserId });
    if (!resolvedUser) throw new AppError('Usuario no encontrado', 404, ErrorCodes.USER_NOT_FOUND);
  } else if (safeUsername) {
    resolvedUser = await User.findOne({ username: safeUsername });
    if (!resolvedUser) throw new AppError('Usuario no encontrado', 404, ErrorCodes.USER_NOT_FOUND);
  }
  
  if (!resolvedUser || !amount) {
    throw new AppError('Usuario y monto requeridos', 400, ErrorCodes.VALIDATION_ERROR);
  }

  const parsedAmount = parseFloat(amount);
  
  const result = await transactionService.bonus({
    username: resolvedUser.username,
    amount: parsedAmount,
    description,
    adminId: req.user.userId,
    adminUsername: req.user.username,
    adminRole: req.user.role
  });
  
  if (!result.success) {
    throw new AppError(result.error, 400, ErrorCodes.TX_FAILED);
  }

  // Enviar mensaje automático al usuario después de acreditar el bonus
  try {
    await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: req.user.username,
      senderRole: 'admin',
      receiverId: resolvedUser.id,
      receiverRole: 'user',
      content: `$${parsedAmount} Acreditado en tu cuenta!\nPodes corroborarlo en www.jugaygana44.bet\nTu usuario es: ${resolvedUser.username}`,
      type: 'system',
      timestamp: new Date(),
      read: false
    });
  } catch (msgErr) {
    logger.error('No se pudo enviar mensaje de bonus al usuario:', msgErr);
  }
  
  res.json({
    status: 'success',
    data: {
      message: `Bonificación de $${parsedAmount} realizada correctamente`,
      newBalance: result.newBalance,
      transactionId: result.transaction.transactionId
    }
  });
});

module.exports = {
  getBalance,
  deposit,
  withdraw,
  bonus
};