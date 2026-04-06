
/**
 * Índice de Modelos
 * Exporta todos los modelos de Mongoose
 */
const mongoose = require('mongoose');

// Importar modelos
const User = require('./User');
const Message = require('./Message');
const ChatStatus = require('./ChatStatus');
const Transaction = require('./Transaction');
const RefundClaim = require('./RefundClaim');
const FireStreak = require('./FireStreak');
const Command = require('./Command');
const Config = require('./Config');

// Configuración de conexión
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sala-de-juegos';

/**
 * Conectar a MongoDB
 */
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ MongoDB conectado');
    return true;
  } catch (error) {
    console.error('❌ Error conectando MongoDB:', error.message);
    return false;
  }
}

/**
 * Desconectar de MongoDB
 */
async function disconnectDB() {
  await mongoose.disconnect();
  console.log('MongoDB desconectado');
}

// Exportar modelos y funciones
module.exports = {
  // Modelos
  User,
  Message,
  ChatStatus,
  Transaction,
  RefundClaim,
  FireStreak,
  Command,
  Config,
  
  // Funciones de conexión
  connectDB,
  disconnectDB,
  
  // Utilidad para verificar conexión
  isConnected: () => mongoose.connection.readyState === 1,
  
  // Exportar mongoose para acceso directo si es necesario
  mongoose
};