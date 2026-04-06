
/**
 * Servicio de Transacciones
 * Gestiona depósitos, retiros y bonificaciones
 */
const { Transaction, Message } = require('../models');
const jugayganaService = require('./jugayganaService');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

/**
 * Realizar depósito
 */
const deposit = async (data) => {
  const { userId, username, amount, bonus = 0, description, adminId, adminUsername, adminRole } = data;
  
  if (!amount || amount <= 0) {
    return { success: false, error: 'Monto inválido' };
  }
  
  // Realizar depósito base en JUGAYGANA
  const result = await jugayganaService.deposit(username, parseFloat(amount), description);
  
  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Si hay bonus, acreditarlo en JUGAYGANA como individual_bonus en operación separada
  let bonusResult = null;
  if (parseFloat(bonus) > 0) {
    bonusResult = await jugayganaService.bonus(username, parseFloat(bonus), description);
    if (!bonusResult.success) {
      logger.error(`Error al acreditar bonus en JUGAYGANA para ${username}:`, bonusResult.error);
    }
  }
  
  // Registrar transacción de depósito (solo el monto base, sin bonus).
  // Nota: el campo `bonus` se deja en 0 porque el bonus se registra como
  // una transacción separada de tipo 'bonus' más abajo, para que quede
  // reflejado correctamente en el historial y en los totales de bonificaciones.
  const transaction = await Transaction.create({
    id: uuidv4(),
    type: 'deposit',
    amount: parseFloat(amount),
    bonus: 0,
    username,
    userId,
    description: description || 'Depósito realizado',
    adminId,
    adminUsername,
    adminRole,
    transactionId: result.data?.transfer_id,
    status: 'completed'
  });

  // Si hay bonus, registrar una transacción separada de tipo 'bonus' solo si fue acreditada correctamente.
  // La bonificación fue acreditada en JUGAYGANA como individual_bonus en operación separada.
  if (parseFloat(bonus) > 0 && bonusResult?.success) {
    await Transaction.create({
      id: uuidv4(),
      type: 'bonus',
      amount: parseFloat(bonus),
      username,
      userId,
      description: `Bonificación sobre depósito (ref: ${transaction.id})${description ? ' - ' + description : ''}`,
      adminId,
      adminUsername,
      adminRole,
      transactionId: bonusResult.data?.transfer_id,
      status: 'completed'
    });
  }
  
  logger.info(`Depósito realizado: $${amount} para ${username}`);
  
  return {
    success: true,
    transaction,
    newBalance: result.newBalance
  };
};

/**
 * Realizar retiro
 */
const withdraw = async (data) => {
  const { userId, username, amount, description, adminId, adminUsername, adminRole } = data;
  
  if (!amount || amount <= 0) {
    return { success: false, error: 'Monto inválido' };
  }
  
  // Realizar retiro en JUGAYGANA
  const result = await jugayganaService.withdraw(username, amount, description);
  
  if (!result.success) {
    return { success: false, error: result.error };
  }
  
  // Registrar transacción
  const transaction = await Transaction.create({
    id: uuidv4(),
    type: 'withdrawal',
    amount: parseFloat(amount),
    username,
    userId,
    description: description || 'Retiro realizado',
    adminId,
    adminUsername,
    adminRole,
    transactionId: result.data?.transfer_id,
    status: 'completed'
  });
  
  logger.info(`Retiro realizado: $${amount} para ${username}`);
  
  return {
    success: true,
    transaction,
    newBalance: result.newBalance
  };
};

/**
 * Aplicar bonificación
 */
const bonus = async (data) => {
  const { username, amount, description, adminId, adminUsername, adminRole } = data;
  
  if (!amount || amount <= 0) {
    return { success: false, error: 'Monto inválido' };
  }
  
  const bonusAmount = parseFloat(amount);
  
  // Acreditar bonificación
  const result = await jugayganaService.creditBalance(username, bonusAmount, description || 'Bonificación');
  
  if (!result.success) {
    return { success: false, error: result.error };
  }
  
  // Registrar transacción
  const transaction = await Transaction.create({
    id: uuidv4(),
    type: 'bonus',
    amount: bonusAmount,
    username,
    description: description || 'Bonificación otorgada',
    adminId,
    adminUsername,
    adminRole,
    transactionId: result.data?.transfer_id,
    status: 'completed'
  });
  
  logger.info(`Bonificación aplicada: $${bonusAmount} para ${username}`);
  
  return {
    success: true,
    transaction,
    newBalance: result.data?.user_balance_after
  };
};

/**
 * Obtener transacciones con filtros
 */
const getTransactions = async (filters = {}) => {
  const { from, to, type, username, limit = 100 } = filters;
  
  const query = {};
  
  if (from || to) {
    query.timestamp = {};
    if (from) {
      const fromDate = new Date(from);
      fromDate.setHours(0, 0, 0, 0);
      query.timestamp.$gte = fromDate;
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      query.timestamp.$lte = toDate;
    }
  }
  
  if (type && type !== 'all') {
    query.type = type;
  }
  
  if (username) {
    // Escapar caracteres especiales de regex para evitar ReDoS
    const safeUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.username = { $regex: safeUsername, $options: 'i' };
  }
  
  const transactions = await Transaction.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
  
  // Calcular totales
  let deposits = 0;
  let withdrawals = 0;
  let bonuses = 0;
  let refunds = 0;
  
  transactions.forEach(t => {
    const amount = t.amount || 0;
    switch(t.type) {
      case 'deposit': deposits += amount; break;
      case 'withdrawal': withdrawals += amount; break;
      case 'bonus': bonuses += amount; break;
      case 'refund': refunds += amount; break;
    }
  });
  
  return {
    transactions,
    summary: {
      deposits,
      withdrawals,
      bonuses,
      refunds,
      netBalance: deposits - withdrawals,
      totalTransactions: transactions.length
    }
  };
};

/**
 * Obtener totales de hoy
 */
const getTodayTotals = async () => {
  return await Transaction.getTodayTotals();
};

/**
 * Obtener resumen por período
 */
const getSummary = async (startDate, endDate) => {
  return await Transaction.getSummary(startDate, endDate);
};

module.exports = {
  deposit,
  withdraw,
  bonus,
  getTransactions,
  getTodayTotals,
  getSummary
};