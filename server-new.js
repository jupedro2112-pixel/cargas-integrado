
/**
 * ============================================
 * SALA DE JUEGOS - SERVIDOR PRINCIPAL
 * Arquitectura refactorizada con /src
 * ============================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const morgan = require('morgan');

// Configuración
const { connectDB } = require('./src/config/database');
const { initializeSocket } = require('./src/config/socket');
const logger = require('./src/utils/logger');

// Middlewares
const {
  generalLimiter,
  corsMiddleware,
  helmet,
  mongoSanitize,
  xss,
  hpp,
  sanitizeInput
} = require('./src/middlewares/security');
const errorHandler = require('./src/middlewares/errorHandler');

// Rutas
const routes = require('./src/routes');

// Inicializar Express
const app = express();
const server = http.createServer(app);

// Puerto
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARES GLOBALES
// ============================================

// Logging HTTP con Morgan (usa Winston)
app.use(morgan('combined', { stream: logger.stream }));

// Headers de seguridad
app.use(helmet);

// CORS
app.use(corsMiddleware);

// Rate limiting general
app.use(generalLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Sanitización
app.use(mongoSanitize);
app.use(xss);
app.use(hpp);
app.use(sanitizeInput);

// ============================================
// ARCHIVOS ESTÁTICOS
// ============================================
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: false,
  maxAge: '1d'
}));

// ============================================
// RUTAS API
// ============================================
app.use(routes);

// ============================================
// RUTAS ESTÁTICAS (Frontend)
// ============================================

// Página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Panel admin
app.get('/adminprivado2026', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'adminprivado2026', 'index.html'));
});

// ============================================
// MANEJO DE ERRORES
// ============================================

// Ruta no encontrada
app.use((req, res, next) => {
  res.status(404).json({
    status: 'fail',
    errorCode: 'NOT_FOUND',
    message: `Ruta ${req.originalUrl} no encontrada`
  });
});

// Handler de errores global
app.use(errorHandler);

// ============================================
// INICIALIZACIÓN
// ============================================

async function initializeApp() {
  // Conectar a MongoDB
  const dbConnected = await connectDB();
  if (!dbConnected) {
    logger.error('No se pudo conectar a MongoDB. El servidor no puede iniciar.');
    process.exit(1);
  }
  
  // Inicializar WebSocket
  initializeSocket(server);
  logger.info('WebSocket inicializado');
  
  // Iniciar servidor HTTP
  server.listen(PORT, () => {
    logger.info(`
🎮 ============================================
🎮  SALA DE JUEGOS - SERVIDOR INICIADO
🎮 ============================================
🎮  
🎮  🌐 URL: http://localhost:${PORT}
🎮  📦 Modo: ${process.env.NODE_ENV || 'development'}
🎮  
🎮  📊 Endpoints principales:
🎮  • POST /api/auth/login        - Login
🎮  • POST /api/auth/register     - Registro
🎮  • GET  /api/admin/conversations - Conversaciones (admin)
🎮  • GET  /api/messages/:userId  - Mensajes
🎮  
🎮  🔑 Credenciales Admin:
🎮  • Usuario: ignite100
🎮  • Contraseña: pepsi100
🎮  
🎮 ============================================
    `);
  });
}

// Manejo de errores no capturados
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION! 💥 Cerrando servidor...');
  logger.error(err.name, err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logger.error('UNHANDLED REJECTION! 💥');
  logger.error(err.name, err.message);
});

// Iniciar aplicación
initializeApp();

// Exportar para testing
module.exports = { app, server };