
// ============================================
// CONFIGURACIÓN MONGODB - PARA 100K+ USUARIOS
// ============================================

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sala-de-juegos';

// ============================================
// SCHEMA DE USUARIO
// ============================================
const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },
  email: { type: String, default: null },
  phone: { type: String, default: null },
  whatsapp: { type: String, default: null },
  role: { type: String, enum: ['user', 'admin', 'depositor', 'withdrawer'], default: 'user' },
  accountNumber: { type: String, unique: true },
  balance: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  lastLogin: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  passwordChangedAt: { type: Date, default: null },
  tokenVersion: { type: Number, default: 0 },
  
  // Campos JUGAYGANA
  jugayganaUserId: { type: Number, default: null },
  jugayganaUsername: { type: String, default: null },
  jugayganaSyncStatus: { 
    type: String, 
    enum: ['pending', 'synced', 'linked', 'error', 'imported', 'not_applicable', 'na'], 
    default: 'pending' 
  },
  jugayganaSyncError: { type: String, default: null },
  source: { type: String, enum: ['local', 'jugaygana'], default: 'local' },
  
  // Campos FCM (Firebase Cloud Messaging) para notificaciones push
  fcmToken: { type: String, default: null },
  fcmTokenUpdatedAt: { type: Date, default: null }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE MENSAJES
// ============================================
const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  senderId: { type: String, required: true, index: true },
  senderUsername: { type: String, required: true },
  senderRole: { type: String, enum: ['user', 'admin', 'depositor', 'withdrawer', 'system'], required: true },
  receiverId: { type: String, required: true, index: true },
  receiverRole: { type: String, enum: ['user', 'admin'], required: true },
  content: { type: String, required: true },
  type: { type: String, enum: ['text', 'image', 'video', 'system'], default: 'text' },
  read: { type: Boolean, default: false },
  // Solo visible para admins (ej. mensaje de cierre de chat)
  adminOnly: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE COMANDOS PERSONALIZADOS
// ============================================
const commandSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, index: true },
  description: { type: String, default: '' },
  type: { type: String, enum: ['bonus', 'message', 'action'], default: 'message' },
  bonusPercent: { type: Number, default: 0 },
  response: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: false },
  usageCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE CONFIGURACIÓN DEL SISTEMA (CBU)
// ============================================
const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE RECLAMOS DE REEMBOLSO
// ============================================
const refundClaimSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, required: true, index: true },
  type: { type: String, enum: ['daily', 'weekly', 'monthly'], required: true },
  amount: { type: Number, required: true },
  netAmount: { type: Number, required: true },
  percentage: { type: Number, required: true },
  deposits: { type: Number, default: 0 },
  withdrawals: { type: Number, default: 0 },
  period: { type: String, default: '' },
  transactionId: { type: String, default: null },
  claimedAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE FUEGUITOS (RACHA DIARIA)
// ============================================
const fireStreakSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true },
  streak: { type: Number, default: 0 },
  lastClaim: { type: Date, default: null },
  totalClaimed: { type: Number, default: 0 },
  lastReset: { type: Date, default: null },
  history: [{
    date: { type: Date },
    reward: { type: Number, default: 0 },
    streakDay: { type: Number }
  }]
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE ESTADO DE CHATS
// ============================================
const chatStatusSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  category: { type: String, enum: ['cargas', 'pagos'], default: 'cargas' },
  assignedTo: { type: String, default: null },
  closedAt: { type: Date, default: null },
  closedBy: { type: String, default: null },
  lastMessageAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE TRANSACCIONES
// ============================================
const transactionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  type: { type: String, enum: ['deposit', 'withdrawal', 'bonus', 'refund'], required: true },
  amount: { type: Number, required: true },
  username: { type: String, required: true, index: true },
  userId: { type: String, default: null },
  description: { type: String, default: '' },
  adminId: { type: String, default: null },
  adminUsername: { type: String, default: null },
  adminRole: { type: String, default: null },
  transactionId: { type: String, default: null },
  timestamp: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE USUARIOS EXTERNOS (BASE EXTERNA)
// ============================================
const externalUserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, sparse: true },
  username: { type: String, required: true, unique: true, index: true },
  phone: { type: String, default: null },
  whatsapp: { type: String, default: null },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  messageCount: { type: Number, default: 0 }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE ACTIVIDAD DE USUARIOS (PARA FUEGUITO)
// ============================================
const userActivitySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  date: { type: String, required: true, index: true },
  deposits: { type: Number, default: 0 },
  withdrawals: { type: Number, default: 0 },
  lastActivity: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// ============================================
// ÍNDICES ADICIONALES - OPTIMIZADOS PARA VELOCIDAD
// ============================================
userSchema.index({ jugayganaUserId: 1 });
userSchema.index({ jugayganaSyncStatus: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ role: 1 });

// ÍNDICES CRÍTICOS PARA CHAT RÁPIDO
messageSchema.index({ senderId: 1, receiverId: 1, timestamp: -1 });
messageSchema.index({ senderId: 1, timestamp: -1 });
messageSchema.index({ receiverId: 1, timestamp: -1 });
messageSchema.index({ receiverId: 1, read: 1, timestamp: -1 });
messageSchema.index({ timestamp: -1 });

refundClaimSchema.index({ userId: 1, type: 1 });
refundClaimSchema.index({ claimedAt: -1 });

// ÍNDICES PARA CHAT STATUS
chatStatusSchema.index({ status: 1, lastMessageAt: -1 });
chatStatusSchema.index({ category: 1, lastMessageAt: -1 });
chatStatusSchema.index({ assignedTo: 1 });
chatStatusSchema.index({ userId: 1 }, { unique: true });

transactionSchema.index({ type: 1 });
transactionSchema.index({ timestamp: -1 });
transactionSchema.index({ username: 1, timestamp: -1 });

userActivitySchema.index({ userId: 1, date: 1 }, { unique: true });

// ============================================
// CREAR MODELOS
// ============================================
const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Command = mongoose.model('Command', commandSchema);
const Config = mongoose.model('Config', configSchema);
const RefundClaim = mongoose.model('RefundClaim', refundClaimSchema);
const FireStreak = mongoose.model('FireStreak', fireStreakSchema);
const ChatStatus = mongoose.model('ChatStatus', chatStatusSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const ExternalUser = mongoose.model('ExternalUser', externalUserSchema);
const UserActivity = mongoose.model('UserActivity', userActivitySchema);

// ============================================
// CONEXIÓN A MONGODB
// ============================================
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

// ============================================
// DESCONECTAR
// ============================================
async function disconnectDB() {
  await mongoose.disconnect();
  console.log('MongoDB desconectado');
}

// ============================================
// FUNCIONES HELPER PARA CONFIGURACIÓN
// ============================================

// Obtener configuración por clave
async function getConfig(key, defaultValue = null) {
  try {
    const config = await Config.findOne({ key });
    return config ? config.value : defaultValue;
  } catch (error) {
    console.error(`Error obteniendo config ${key}:`, error);
    return defaultValue;
  }
}

// Guardar configuración
async function setConfig(key, value) {
  try {
    await Config.findOneAndUpdate(
      { key },
      { key, value, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    return true;
  } catch (error) {
    console.error(`Error guardando config ${key}:`, error);
    return false;
  }
}

// ============================================
// FUNCIONES HELPER PARA COMANDOS
// ============================================

// Obtener todos los comandos
async function getAllCommands() {
  try {
    const commands = await Command.find({ isActive: true }).lean();
    const result = {};
    commands.forEach(cmd => {
      result[cmd.name] = cmd;
    });
    return result;
  } catch (error) {
    console.error('Error obteniendo comandos:', error);
    return {};
  }
}

// Obtener comando por nombre
async function getCommand(name) {
  try {
    return await Command.findOne({ name, isActive: true });
  } catch (error) {
    console.error(`Error obteniendo comando ${name}:`, error);
    return null;
  }
}

// Guardar comando
async function saveCommand(name, data) {
  try {
    await Command.findOneAndUpdate(
      { name },
      { ...data, name, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    return true;
  } catch (error) {
    console.error(`Error guardando comando ${name}:`, error);
    return false;
  }
}

// Eliminar comando
async function deleteCommand(name) {
  try {
    await Command.deleteOne({ name });
    return true;
  } catch (error) {
    console.error(`Error eliminando comando ${name}:`, error);
    return false;
  }
}

// Incrementar uso de comando
async function incrementCommandUsage(name) {
  try {
    await Command.updateOne({ name }, { $inc: { usageCount: 1 } });
    return true;
  } catch (error) {
    console.error(`Error incrementando uso de comando ${name}:`, error);
    return false;
  }
}

// ============================================
// EXPORTAR
// ============================================
module.exports = {
  connectDB,
  disconnectDB,
  User,
  Message,
  Command,
  Config,
  RefundClaim,
  FireStreak,
  ChatStatus,
  Transaction,
  ExternalUser,
  UserActivity,
  // Helpers
  getConfig,
  setConfig,
  getAllCommands,
  getCommand,
  saveCommand,
  deleteCommand,
  incrementCommandUsage
};