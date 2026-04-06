
/**
 * Rutas de Usuario
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middlewares/auth');
const transactionController = require('../controllers/transactionController');
const refundController = require('../controllers/refundController');
const fireController = require('../controllers/fireController');
const adminController = require('../controllers/adminController');

// Perfil de usuario
router.get('/me', authenticate, adminController.getUser);

// Balance
router.get('/balance', authenticate, transactionController.getBalance);

// Reembolsos
router.get('/refunds/status', authenticate, refundController.getStatus);
router.get('/refunds/history', authenticate, refundController.getHistory);
router.post('/refunds/claim/daily', authenticate, refundController.claimDaily);
router.post('/refunds/claim/weekly', authenticate, refundController.claimWeekly);
router.post('/refunds/claim/monthly', authenticate, refundController.claimMonthly);

// Fueguito
router.get('/fire/status', authenticate, fireController.getStatus);
router.post('/fire/claim', authenticate, fireController.claim);

module.exports = router;