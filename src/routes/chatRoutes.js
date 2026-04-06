
/**
 * Rutas de Chat
 */
const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticate, authorize } = require('../middlewares/auth');
const { chatLimiter } = require('../middlewares/security');

// Rutas de mensajes (usuarios y admins)
router.get('/messages/:userId', authenticate, chatController.getMessages);
router.post('/messages/send', authenticate, chatLimiter, chatController.sendMessage);
router.post('/messages/read/:userId', authenticate, chatController.markAsRead);

// Rutas de admin para conversaciones
router.get('/admin/conversations', authenticate, authorize('admin', 'depositor', 'withdrawer'), chatController.getConversations);
router.get('/admin/chats/:userId', authenticate, authorize('admin', 'depositor', 'withdrawer'), chatController.getChatInfo);
router.post('/admin/chats/:userId/close', authenticate, authorize('admin', 'depositor', 'withdrawer'), chatController.closeChat);
router.post('/admin/chats/:userId/reopen', authenticate, authorize('admin', 'depositor', 'withdrawer'), chatController.reopenChat);
router.post('/admin/chats/:userId/assign', authenticate, authorize('admin', 'depositor', 'withdrawer'), chatController.assignChat);
router.post('/admin/chats/:userId/category', authenticate, authorize('admin', 'depositor', 'withdrawer'), chatController.changeCategory);

module.exports = router;