
/**
 * Servicio de Reembolsos
 * Gestiona reembolsos diarios, semanales y mensuales
 */
const { RefundClaim, Transaction } = require('../models');
const jugayganaService = require('./jugayganaService');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Locks para prevenir reclamos duplicados (primera línea de defensa: evita round-trips a DB)
const refundLocks = new Map();

/**
 * Adquirir lock para reembolso
 */
const acquireLock = (userId, type) => {
  const key = `${userId}-${type}`;
  if (refundLocks.has(key)) return false;
  refundLocks.set(key, Date.now());
  return true;
};

/**
 * Liberar lock
 */
const releaseLock = (userId, type) => {
  const key = `${userId}-${type}`;
  refundLocks.delete(key);
};

/**
 * Limpiar locks expirados
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of refundLocks.entries()) {
    if (now - timestamp > 5 * 60 * 1000) {
      refundLocks.delete(key);
    }
  }
}, 60000);

/**
 * Calcular clave de período para evitar doble reclamo atómico en DB
 */
const getPeriodKey = (type) => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  switch (type) {
    case 'daily':
      return `${y}-${m}-${d}`;
    case 'weekly': {
      // Usar el lunes de la semana actual como clave
      const day = now.getUTCDay(); // 0=Dom, 1=Lun ... 6=Sab
      const monday = new Date(now);
      monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
      const wy = monday.getUTCFullYear();
      const wm = String(monday.getUTCMonth() + 1).padStart(2, '0');
      const wd = String(monday.getUTCDate()).padStart(2, '0');
      return `week-${wy}-${wm}-${wd}`;
    }
    case 'monthly':
      return `${y}-${m}`;
    default:
      return null;
  }
};

/**
 * Calcular reembolso
 */
const calculateRefund = (deposits, withdrawals, percentage) => {
  const netAmount = deposits - withdrawals;
  const refundAmount = netAmount > 0 ? Math.round(netAmount * (percentage / 100)) : 0;
  return { netAmount, refundAmount, percentage };
};

/**
 * Verificar si puede reclamar reembolso diario
 */
const canClaimDaily = async (userId) => {
  return await RefundClaim.canClaim(userId, 'daily');
};

/**
 * Verificar si puede reclamar reembolso semanal
 */
const canClaimWeekly = async (userId) => {
  return await RefundClaim.canClaim(userId, 'weekly');
};

/**
 * Verificar si puede reclamar reembolso mensual
 */
const canClaimMonthly = async (userId) => {
  return await RefundClaim.canClaim(userId, 'monthly');
};

/**
 * Obtener estado completo de reembolsos
 */
const getStatus = async (userId, username) => {
  // Obtener información de JUGAYGANA
  const userInfo = await jugayganaService.getUserInfo(username);
  const currentBalance = userInfo ? userInfo.balance : 0;
  
  // Verificar disponibilidad de cada tipo
  const [dailyStatus, weeklyStatus, monthlyStatus] = await Promise.all([
    canClaimDaily(userId),
    canClaimWeekly(userId),
    canClaimMonthly(userId)
  ]);
  
  // Obtener movimientos (simulados - en producción vendrían de JUGAYGANA)
  const dailyMovements = { totalDeposits: 0, totalWithdraws: 0 };
  const weeklyMovements = { totalDeposits: 0, totalWithdraws: 0 };
  const monthlyMovements = { totalDeposits: 0, totalWithdraws: 0 };
  
  // Calcular montos potenciales
  const dailyCalc = calculateRefund(dailyMovements.totalDeposits, dailyMovements.totalWithdraws, 20);
  const weeklyCalc = calculateRefund(weeklyMovements.totalDeposits, weeklyMovements.totalWithdraws, 10);
  const monthlyCalc = calculateRefund(monthlyMovements.totalDeposits, monthlyMovements.totalWithdraws, 5);
  
  return {
    user: {
      username,
      currentBalance,
      jugayganaLinked: !!userInfo
    },
    daily: {
      ...dailyStatus,
      potentialAmount: dailyCalc.refundAmount,
      netAmount: dailyCalc.netAmount,
      percentage: 20
    },
    weekly: {
      ...weeklyStatus,
      potentialAmount: weeklyCalc.refundAmount,
      netAmount: weeklyCalc.netAmount,
      percentage: 10
    },
    monthly: {
      ...monthlyStatus,
      potentialAmount: monthlyCalc.refundAmount,
      netAmount: monthlyCalc.netAmount,
      percentage: 5
    }
  };
};

/**
 * Reclamar reembolso diario
 */
const claimDaily = async (userId, username) => {
  if (!acquireLock(userId, 'daily')) {
    return {
      success: false,
      message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
      processing: true
    };
  }
  
  try {
    const status = await canClaimDaily(userId);
    if (!status.canClaim) {
      return {
        success: false,
        message: 'Ya reclamaste tu reembolso diario. Vuelve mañana!',
        canClaim: false,
        nextClaim: status.nextClaim
      };
    }
    
    // Obtener movimientos de ayer (simulado)
    const movements = { totalDeposits: 0, totalWithdraws: 0 };
    const calc = calculateRefund(movements.totalDeposits, movements.totalWithdraws, 20);
    
    if (calc.refundAmount <= 0) {
      return {
        success: false,
        message: 'No tienes saldo neto positivo para reclamar reembolso',
        canClaim: true
      };
    }
    
    // Acreditar reembolso
    const depositResult = await jugayganaService.creditBalance(username, calc.refundAmount, 'Reembolso diario');
    
    if (!depositResult.success) {
      return {
        success: false,
        message: 'Error al acreditar el reembolso: ' + depositResult.error,
        canClaim: true
      };
    }
    
    // Guardar reclamo (el índice único {userId, type, periodKey} previene duplicados atómicamente)
    const periodKey = getPeriodKey('daily');
    try {
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'daily',
        amount: calc.refundAmount,
        netAmount: calc.netAmount,
        percentage: 20,
        deposits: movements.totalDeposits,
        withdrawals: movements.totalWithdraws,
        periodKey,
        transactionId: depositResult.data?.transfer_id
      });
    } catch (dbErr) {
      if (dbErr.code === 11000) {
        return {
          success: false,
          message: 'Ya reclamaste tu reembolso diario para hoy.',
          canClaim: false
        };
      }
      throw dbErr;
    }
    
    // Registrar transacción
    await Transaction.create({
      id: uuidv4(),
      type: 'refund',
      amount: calc.refundAmount,
      username,
      description: 'Reembolso diario',
      transactionId: depositResult.data?.transfer_id
    });
    
    return {
      success: true,
      message: `¡Reembolso diario de $${calc.refundAmount} acreditado!`,
      amount: calc.refundAmount,
      nextClaim: new Date(Date.now() + 24 * 60 * 60 * 1000)
    };
  } finally {
    setTimeout(() => releaseLock(userId, 'daily'), 3000);
  }
};

/**
 * Reclamar reembolso semanal
 */
const claimWeekly = async (userId, username) => {
  if (!acquireLock(userId, 'weekly')) {
    return {
      success: false,
      message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
      processing: true
    };
  }
  
  try {
    const status = await canClaimWeekly(userId);
    if (!status.canClaim) {
      return {
        success: false,
        message: 'No puedes reclamar el reembolso semanal aún',
        canClaim: false,
        nextClaim: status.nextClaim
      };
    }
    
    const movements = { totalDeposits: 0, totalWithdraws: 0 };
    const calc = calculateRefund(movements.totalDeposits, movements.totalWithdraws, 10);
    
    if (calc.refundAmount <= 0) {
      return {
        success: false,
        message: 'No tienes saldo neto positivo',
        canClaim: true
      };
    }
    
    const depositResult = await jugayganaService.creditBalance(username, calc.refundAmount, 'Reembolso semanal');
    
    if (!depositResult.success) {
      return {
        success: false,
        message: 'Error al acreditar: ' + depositResult.error,
        canClaim: true
      };
    }
    
    const weeklyPeriodKey = getPeriodKey('weekly');
    try {
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'weekly',
        amount: calc.refundAmount,
        netAmount: calc.netAmount,
        percentage: 10,
        periodKey: weeklyPeriodKey,
        transactionId: depositResult.data?.transfer_id
      });
    } catch (dbErr) {
      if (dbErr.code === 11000) {
        return {
          success: false,
          message: 'Ya reclamaste tu reembolso semanal para esta semana.',
          canClaim: false
        };
      }
      throw dbErr;
    }
    
    await Transaction.create({
      id: uuidv4(),
      type: 'refund',
      amount: calc.refundAmount,
      username,
      description: 'Reembolso semanal',
      transactionId: depositResult.data?.transfer_id
    });
    
    return {
      success: true,
      message: `¡Reembolso semanal de $${calc.refundAmount} acreditado!`,
      amount: calc.refundAmount
    };
  } finally {
    setTimeout(() => releaseLock(userId, 'weekly'), 3000);
  }
};

/**
 * Reclamar reembolso mensual
 */
const claimMonthly = async (userId, username) => {
  if (!acquireLock(userId, 'monthly')) {
    return {
      success: false,
      message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
      processing: true
    };
  }
  
  try {
    const status = await canClaimMonthly(userId);
    if (!status.canClaim) {
      return {
        success: false,
        message: 'No puedes reclamar el reembolso mensual aún',
        canClaim: false,
        nextClaim: status.nextClaim
      };
    }
    
    const movements = { totalDeposits: 0, totalWithdraws: 0 };
    const calc = calculateRefund(movements.totalDeposits, movements.totalWithdraws, 5);
    
    if (calc.refundAmount <= 0) {
      return {
        success: false,
        message: 'No tienes saldo neto positivo',
        canClaim: true
      };
    }
    
    const depositResult2 = await jugayganaService.creditBalance(username, calc.refundAmount, 'Reembolso mensual');
    
    if (!depositResult2.success) {
      return {
        success: false,
        message: 'Error al acreditar: ' + depositResult2.error,
        canClaim: true
      };
    }
    
    const monthlyPeriodKey = getPeriodKey('monthly');
    try {
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'monthly',
        amount: calc.refundAmount,
        netAmount: calc.netAmount,
        percentage: 5,
        periodKey: monthlyPeriodKey,
        transactionId: depositResult2.data?.transfer_id
      });
    } catch (dbErr) {
      if (dbErr.code === 11000) {
        return {
          success: false,
          message: 'Ya reclamaste tu reembolso mensual para este mes.',
          canClaim: false
        };
      }
      throw dbErr;
    }
    
    await Transaction.create({
      id: uuidv4(),
      type: 'refund',
      amount: calc.refundAmount,
      username,
      description: 'Reembolso mensual',
      transactionId: depositResult2.data?.transfer_id
    });
    
    return {
      success: true,
      message: `¡Reembolso mensual de $${calc.refundAmount} acreditado!`,
      amount: calc.refundAmount
    };
  } finally {
    setTimeout(() => releaseLock(userId, 'monthly'), 3000);
  }
};

/**
 * Obtener historial de reembolsos
 */
const getHistory = async (userId, options = {}) => {
  const { limit = 50 } = options;
  return await RefundClaim.getUserHistory(userId, { limit });
};

/**
 * Obtener todos los reembolsos (admin)
 */
const getAll = async () => {
  const refunds = await RefundClaim.find()
    .sort({ claimedAt: -1 })
    .lean();
  
  const summary = {
    dailyCount: refunds.filter(r => r.type === 'daily').length,
    weeklyCount: refunds.filter(r => r.type === 'weekly').length,
    monthlyCount: refunds.filter(r => r.type === 'monthly').length,
    totalAmount: refunds.reduce((sum, r) => sum + (r.amount || 0), 0)
  };
  
  return { refunds, summary };
};

module.exports = {
  calculateRefund,
  canClaimDaily,
  canClaimWeekly,
  canClaimMonthly,
  getStatus,
  claimDaily,
  claimWeekly,
  claimMonthly,
  getHistory,
  getAll
};