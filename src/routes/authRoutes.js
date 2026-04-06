
/**
 * Rutas de Autenticación
 */
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middlewares/auth');
const { authLimiter, validateRegister, validateLogin } = require('../middlewares/security');

// Públicas
router.post('/register', validateRegister, authController.register);
router.post('/login', authLimiter, validateLogin, authController.login);
router.get('/check-username', authController.checkUsername);
router.post('/find-user-by-phone', authController.findUserByPhone);
router.post('/reset-password-by-phone', authController.resetPasswordByPhone);

// Protegidas
router.post('/logout', authenticate, authController.logout);
router.get('/verify', authenticate, authController.verify);
router.post('/change-password', authenticate, authController.changePassword);
router.post('/refresh-token', authenticate, authController.refreshToken);

module.exports = router;