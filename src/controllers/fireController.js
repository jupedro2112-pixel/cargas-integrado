
/**
 * Controlador de Fueguito (Racha Diaria)
 * Maneja el sistema de rachas diarias
 */
const { FireStreak, Transaction } = require('../models');
const { jugayganaService } = require('../services');
const asyncHandler = require('../utils/asyncHandler');
const { AppError, ErrorCodes } = require('../utils/AppError');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// Funciones helper para fechas Argentina
const getArgentinaDateString = (date = new Date()) => {
  const argentinaTime = new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return argentinaTime.toDateString();
};

const getArgentinaYesterday = () => {
  const now = new Date();
  const argentinaNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  argentinaNow.setDate(argentinaNow.getDate() - 1);
  return argentinaNow.toDateString();
};

/**
 * Obtener total de depósitos del usuario en los últimos N días
 * Usa la colección Transaction que registra depósitos acreditados
 */
const getDepositsInPeriod = async (username, daysBack) => {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  try {
    const result = await Transaction.aggregate([
      { $match: { username, type: 'deposit', createdAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    return result[0]?.total || 0;
  } catch (err) {
    logger.error(`Error calculando depósitos de ${username} en los últimos ${daysBack} días:`, err.message);
    return 0;
  }
};

// Mínimo de depósitos para acceder a recompensas Fueguito (interno, no exponer al cliente)
const MIN_MONTHLY_DEPOSITS = 20000;

// Configuración de hitos/milestones del Fueguito
const FIRE_MILESTONES = [
  { day: 10, label: '10 días', reward: 10000, type: 'cash', requireDeposits: 0, depositDays: 0 },
  { day: 15, label: '15 días', reward: 0, type: 'next_load_bonus', requireDeposits: 0, depositDays: 0 },
  { day: 20, label: '20 días', reward: 50000, type: 'cash', requireDeposits: 100000, depositDays: 30 },
  { day: 30, label: '30 días', reward: 200000, type: 'cash', requireDeposits: 300000, depositDays: 45 }
];

/**
 * GET /api/fire/status
 * Obtener estado del fueguito
 */
const getStatus = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const username = req.user.username;
  
  let fireStreak = await FireStreak.findOne({ userId }).lean();
  
  if (!fireStreak) {
    fireStreak = { streak: 0, lastClaim: null, totalClaimed: 0, pendingNextLoadBonus: false };
  }
  
  const todayArgentina = getArgentinaDateString();
  const lastClaim = fireStreak.lastClaim ? getArgentinaDateString(new Date(fireStreak.lastClaim)) : null;
  
  const canClaim = lastClaim !== todayArgentina;
  
  // Verificar si la racha está activa
  const yesterdayArgentina = getArgentinaYesterday();
  const isStreakActive = lastClaim === yesterdayArgentina || lastClaim === todayArgentina;
  
  // Resetear racha si se perdió
  if (!isStreakActive && fireStreak.streak > 0 && lastClaim !== todayArgentina) {
    await FireStreak.updateOne(
      { userId },
      { streak: 0, lastReset: new Date() },
      { upsert: true }
    );
    fireStreak.streak = 0;
  }

  // Determinar el siguiente hito
  const currentStreak = fireStreak.streak || 0;
  const nextMilestone = FIRE_MILESTONES.find(m => m.day > currentStreak) || null;

  // Construir lista de milestones con estado para la UI
  const milestones = FIRE_MILESTONES.map(m => ({
    day: m.day,
    label: m.label,
    type: m.type,
    // No exponer reward exacto aquí para type === 'next_load_bonus',
    // pero sí exponer el monto para los de cash
    reward: m.type === 'cash' ? m.reward : null,
    hasDepositRequirement: m.requireDeposits > 0,
    // No exponer monto exacto de depósito requerido al cliente
    status: currentStreak >= m.day ? 'completed' : currentStreak === m.day - 1 ? 'next' : 'locked'
  }));
  
  res.json({
    status: 'success',
    data: {
      streak: currentStreak,
      lastClaim: fireStreak.lastClaim,
      totalClaimed: fireStreak.totalClaimed || 0,
      canClaim,
      nextMilestoneDay: nextMilestone ? nextMilestone.day : null,
      pendingNextLoadBonus: fireStreak.pendingNextLoadBonus || false,
      milestones,
      // Condición general visible al usuario (sin revelar monto exacto)
      monthlyActivityRequired: true
    }
  });
});

/**
 * POST /api/fire/claim
 * Reclamar fueguito del día
 */
const claim = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const username = req.user.username;
  
  let fireStreak = await FireStreak.findOne({ userId });
  
  if (!fireStreak) {
    fireStreak = new FireStreak({ userId, username, streak: 0, totalClaimed: 0 });
  }
  
  const todayArgentina = getArgentinaDateString();
  const lastClaim = fireStreak.lastClaim ? getArgentinaDateString(new Date(fireStreak.lastClaim)) : null;
  
  // Verificar si ya reclamó hoy
  if (lastClaim === todayArgentina) {
    throw new AppError('Ya reclamaste tu fueguito hoy', 400, ErrorCodes.VALIDATION_ERROR);
  }

  // Validar condición de depósitos del mes actual (mínimo MIN_MONTHLY_DEPOSITS)
  const monthlyDeposits = await getDepositsInPeriod(username, 30);
  if (monthlyDeposits < MIN_MONTHLY_DEPOSITS) {
    throw new AppError(
      'Para acceder al Fueguito diario necesitás tener movimientos de cargas durante el mes.',
      400,
      ErrorCodes.VALIDATION_ERROR
    );
  }
  
  // Verificar si la racha continúa o se reinicia
  const yesterdayArgentina = getArgentinaYesterday();
  if (lastClaim !== yesterdayArgentina && fireStreak.streak > 0) {
    fireStreak.streak = 0;
    fireStreak.lastReset = new Date();
  }
  
  // Incrementar racha
  fireStreak.streak += 1;
  fireStreak.lastClaim = new Date();
  
  // Calcular recompensa según hito
  let reward = 0;
  let rewardType = 'none';
  let message = `¡Día ${fireStreak.streak} de racha! Seguí así 🔥`;
  
  if (fireStreak.streak === 10) {
    // Hito día 10: $10.000
    reward = 10000;
    rewardType = 'cash';
    fireStreak.totalClaimed += reward;
    
    const bonusResult = await jugayganaService.creditBalance(
      username,
      reward,
      'Recompensa racha 10 días - Sala de Juegos'
    );
    
    if (!bonusResult.success) {
      throw new AppError('Error al acreditar recompensa: ' + bonusResult.error, 400, ErrorCodes.TX_FAILED);
    }
    
    await Transaction.create({
      id: uuidv4(),
      type: 'bonus',
      amount: reward,
      username,
      description: 'Recompensa Fueguito 10 días'
    }).catch(() => {});
    
    message = `🔥🔥🔥 ¡10 días de racha! Recompensa: $${reward.toLocaleString('es-AR')}`;
  } else if (fireStreak.streak === 15) {
    // Hito día 15: 100% en próxima carga (beneficio pendiente)
    rewardType = 'next_load_bonus';
    fireStreak.pendingNextLoadBonus = true;
    message = '🎉 ¡15 días de racha! Tenés 100% en tu próxima carga. Un operador te lo aplicará cuando quieras reclamar.';
  } else if (fireStreak.streak === 20) {
    // Hito día 20: $50.000 (requiere mínimo $100.000 en depósitos en 30 días)
    const deposits30 = await getDepositsInPeriod(username, 30);
    if (deposits30 < 100000) {
      // No cumple requisito de depósito - continuar racha sin premio
      message = `🔥 ¡20 días de racha! Recompensa disponible cuando cumplas el requisito de actividad del mes.`;
    } else {
      reward = 50000;
      rewardType = 'cash';
      fireStreak.totalClaimed += reward;
      
      const bonusResult20 = await jugayganaService.creditBalance(
        username,
        reward,
        'Recompensa racha 20 días - Sala de Juegos'
      );
      
      if (!bonusResult20.success) {
        throw new AppError('Error al acreditar recompensa: ' + bonusResult20.error, 400, ErrorCodes.TX_FAILED);
      }
      
      await Transaction.create({
        id: uuidv4(),
        type: 'bonus',
        amount: reward,
        username,
        description: 'Recompensa Fueguito 20 días'
      }).catch(() => {});
      
      message = `🏆 ¡20 días de racha! Recompensa: $${reward.toLocaleString('es-AR')}`;
    }
  } else if (fireStreak.streak === 30) {
    // Hito día 30: $200.000 (requiere mínimo $300.000 en depósitos en 45 días)
    const deposits45 = await getDepositsInPeriod(username, 45);
    if (deposits45 < 300000) {
      message = `🔥 ¡30 días de racha! Recompensa disponible cuando cumplas el requisito de actividad del mes.`;
    } else {
      reward = 200000;
      rewardType = 'cash';
      fireStreak.totalClaimed += reward;
      
      const bonusResult30 = await jugayganaService.creditBalance(
        username,
        reward,
        'Recompensa racha 30 días - Sala de Juegos'
      );
      
      if (!bonusResult30.success) {
        throw new AppError('Error al acreditar recompensa: ' + bonusResult30.error, 400, ErrorCodes.TX_FAILED);
      }
      
      await Transaction.create({
        id: uuidv4(),
        type: 'bonus',
        amount: reward,
        username,
        description: 'Recompensa Fueguito 30 días'
      }).catch(() => {});
      
      message = `👑 ¡30 días de racha! Recompensa: $${reward.toLocaleString('es-AR')}`;
    }
  }
  
  // Agregar al historial
  fireStreak.history = fireStreak.history || [];
  fireStreak.history.push({
    date: new Date(),
    reward,
    streakDay: fireStreak.streak
  });
  
  await fireStreak.save();
  
  logger.info(`Fueguito reclamado: ${username} - Día ${fireStreak.streak} - Premio: ${reward}`);
  
  res.json({
    status: 'success',
    data: {
      streak: fireStreak.streak,
      reward,
      rewardType,
      message,
      totalClaimed: fireStreak.totalClaimed,
      pendingNextLoadBonus: fireStreak.pendingNextLoadBonus || false
    }
  });
});

module.exports = {
  getStatus,
  claim
};