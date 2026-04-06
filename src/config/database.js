
/**
 * Configuración de Base de Datos
 * Conexión y configuración de MongoDB
 */
const mongoose = require('mongoose');
const logger = require('../utils/logger');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sala-de-juegos';

/**
 * Conectar a MongoDB
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    logger.info(`MongoDB conectado: ${conn.connection.host}`);
    return true;
  } catch (error) {
    logger.error('Error conectando MongoDB:', error.message);
    return false;
  }
};

/**
 * Desconectar de MongoDB
 */
const disconnectDB = async () => {
  try {
    await mongoose.disconnect();
    logger.info('MongoDB desconectado');
  } catch (error) {
    logger.error('Error desconectando MongoDB:', error.message);
  }
};

/**
 * Verificar estado de conexión
 */
const isConnected = () => {
  return mongoose.connection.readyState === 1;
};

// Eventos de conexión
mongoose.connection.on('error', (err) => {
  logger.error('Error en conexión MongoDB:', err);
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB desconectado');
});

module.exports = {
  connectDB,
  disconnectDB,
  isConnected,
  mongoose
};