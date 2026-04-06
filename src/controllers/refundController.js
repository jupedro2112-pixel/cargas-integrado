
/**
 * Controlador de Reembolsos
 * Maneja reembolsos diarios, semanales y mensuales
 */
const refundService = require('../services/refundService');
const asyncHandler = require('../utils/asyncHandler');

/**
 * GET /api/refunds/status
 * Obtener estado de reembolsos del usuario
 */
const getStatus = asyncHandler(async (req, res) => {
  const status = await refundService.getStatus(req.user.userId, req.user.username);
  
  res.json({
    status: 'success',
    data: status
  });
});

/**
 * POST /api/refunds/claim/daily
 * Reclamar reembolso diario
 */
const claimDaily = asyncHandler(async (req, res) => {
  const result = await refundService.claimDaily(req.user.userId, req.user.username);
  
  if (!result.success) {
    return res.status(400).json({
      status: 'fail',
      data: result
    });
  }
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/refunds/claim/weekly
 * Reclamar reembolso semanal
 */
const claimWeekly = asyncHandler(async (req, res) => {
  const result = await refundService.claimWeekly(req.user.userId, req.user.username);
  
  if (!result.success) {
    return res.status(400).json({
      status: 'fail',
      data: result
    });
  }
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/refunds/claim/monthly
 * Reclamar reembolso mensual
 */
const claimMonthly = asyncHandler(async (req, res) => {
  const result = await refundService.claimMonthly(req.user.userId, req.user.username);
  
  if (!result.success) {
    return res.status(400).json({
      status: 'fail',
      data: result
    });
  }
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * GET /api/refunds/history
 * Obtener historial de reembolsos del usuario
 */
const getHistory = asyncHandler(async (req, res) => {
  const { limit } = req.query;
  
  const history = await refundService.getHistory(req.user.userId, { 
    limit: parseInt(limit) || 50 
  });
  
  res.json({
    status: 'success',
    data: { refunds: history }
  });
});

/**
 * GET /api/refunds/all
 * Obtener todos los reembolsos (admin)
 */
const getAll = asyncHandler(async (req, res) => {
  const result = await refundService.getAll();
  
  res.json({
    status: 'success',
    data: result
  });
});

module.exports = {
  getStatus,
  claimDaily,
  claimWeekly,
  claimMonthly,
  getHistory,
  getAll
};