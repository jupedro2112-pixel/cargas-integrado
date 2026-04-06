
/**
 * Rutas de Administración
 */
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const transactionController = require('../controllers/transactionController');
const refundController = require('../controllers/refundController');
const { authenticate, authorize, depositorOnly, withdrawerOnly } = require('../middlewares/auth');

// Gestión de usuarios
// Depositor y withdrawer también pueden ver la lista completa de usuarios y exportar CSV
router.get('/users', authenticate, authorize('admin', 'depositor', 'withdrawer'), adminController.getUsers);
router.get('/users/export/csv', authenticate, authorize('admin', 'depositor', 'withdrawer'), adminController.exportUsersCSV);
router.get('/users/:userId', authenticate, authorize('admin', 'depositor', 'withdrawer'), adminController.getUser);
router.post('/users', authenticate, authorize('admin', 'depositor', 'withdrawer'), adminController.createUser);
router.put('/users/:id', authenticate, authorize('admin'), adminController.updateUser);
router.delete('/users/:id', authenticate, authorize('admin'), adminController.deleteUser);
router.post('/users/:id/reset-password', authenticate, authorize('admin', 'depositor'), adminController.resetPassword);

// Configuración
router.get('/config', authenticate, authorize('admin'), adminController.getConfig);
router.post('/cbu', authenticate, authorize('admin'), adminController.updateCbu);
router.post('/canal-url', authenticate, authorize('admin'), adminController.updateCanalUrl);

// Comandos
router.get('/commands', authenticate, authorize('admin'), adminController.getCommands);
router.post('/commands', authenticate, authorize('admin'), adminController.createCommand);
router.delete('/commands/:name', authenticate, authorize('admin'), adminController.deleteCommand);

// Estadísticas
router.get('/stats', authenticate, authorize('admin'), adminController.getStats);
router.get('/transactions', authenticate, authorize('admin'), adminController.getTransactions);
router.get('/datos', authenticate, authorize('admin'), adminController.getDatos);

// Transacciones (con permisos específicos)
router.post('/deposit', authenticate, depositorOnly, transactionController.deposit);
router.post('/withdrawal', authenticate, withdrawerOnly, transactionController.withdraw);
router.post('/bonus', authenticate, authorize('admin', 'depositor'), transactionController.bonus);

// Reembolsos (admin)
router.get('/refunds/all', authenticate, authorize('admin'), refundController.getAll);

// Cambiar categoría de chat
router.post('/chats/:userId/category', authenticate, authorize('admin', 'depositor', 'withdrawer'), adminController.changeChatCategory);

// Enviar a pagos/abiertos
router.post('/send-to-payments', authenticate, authorize('admin', 'depositor', 'withdrawer'), adminController.sendToPayments);
router.post('/send-to-open', authenticate, authorize('admin', 'depositor'), adminController.sendToOpen);

// Base de datos - exportar a CSV
router.post('/database/verify', authenticate, authorize('admin'), adminController.verifyDatabaseAccess);
router.get('/database/export/csv', authenticate, authorize('admin'), adminController.exportDatabaseCSV);

module.exports = router;