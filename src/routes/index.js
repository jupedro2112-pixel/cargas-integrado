
/**
 * Índice de Rutas
 * Exporta todas las rutas de la aplicación
 */
const express = require('express');
const router = express.Router();

const authRoutes = require('./authRoutes');
const chatRoutes = require('./chatRoutes');
const adminRoutes = require('./adminRoutes');
const userRoutes = require('./userRoutes');

// Prefijos de rutas
router.use('/api/auth', authRoutes);
router.use('/api', chatRoutes);
router.use('/api/admin', adminRoutes);
router.use('/api/users', userRoutes);

// Ruta de salud
router.get('/health', (req, res) => {
  res.json({
    status: 'success',
    message: 'API funcionando correctamente',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

module.exports = router;