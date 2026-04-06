
/**
 * Modelo de Usuario
 * Gestiona usuarios, admins y roles
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  id: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  username: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  password: { 
    type: String, 
    required: true,
    minlength: 6
  },
  email: { 
    type: String, 
    default: null,
    lowercase: true,
    trim: true
  },
  phone: { 
    type: String, 
    default: null,
    trim: true
  },
  whatsapp: { 
    type: String, 
    default: null,
    trim: true
  },
  role: { 
    type: String, 
    enum: ['user', 'admin', 'depositor', 'withdrawer'], 
    default: 'user',
    index: true
  },
  accountNumber: { 
    type: String, 
    unique: true,
    sparse: true
  },
  balance: { 
    type: Number, 
    default: 0,
    min: 0
  },
  isActive: { 
    type: Boolean, 
    default: true 
  },
  lastLogin: { 
    type: Date, 
    default: null 
  },
  createdAt: { 
    type: Date, 
    default: Date.now,
    immutable: true
  },
  passwordChangedAt: { 
    type: Date, 
    default: null 
  },
  tokenVersion: { 
    type: Number, 
    default: 0 
  },
  
  // Campos JUGAYGANA
  jugayganaUserId: { 
    type: Number, 
    default: null,
    index: true
  },
  jugayganaUsername: { 
    type: String, 
    default: null 
  },
  jugayganaSyncStatus: { 
    type: String, 
    enum: ['pending', 'synced', 'linked', 'error', 'imported', 'not_applicable', 'na'], 
    default: 'pending',
    index: true
  },
  jugayganaSyncError: { 
    type: String, 
    default: null 
  },
  source: { 
    type: String, 
    enum: ['local', 'jugaygana'], 
    default: 'local' 
  },
  
  // Token FCM para notificaciones push
  fcmToken: { 
    type: String, 
    default: null,
    index: true
  },
  fcmTokenUpdatedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices compuestos
userSchema.index({ jugayganaUserId: 1 });
userSchema.index({ jugayganaSyncStatus: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ isActive: 1, role: 1 });

// Virtual para verificar si es admin
userSchema.virtual('isAdmin').get(function() {
  return this.role === 'admin';
});

// Virtual para verificar si es agente
userSchema.virtual('isAgent').get(function() {
  return ['admin', 'depositor', 'withdrawer'].includes(this.role);
});

// Método para comparar contraseña
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Método para cambiar contraseña
userSchema.methods.changePassword = async function(newPassword) {
  this.password = await bcrypt.hash(newPassword, 12);
  this.passwordChangedAt = new Date();
  this.tokenVersion += 1;
  await this.save();
};

// Método para verificar si cambió contraseña después de cierta fecha
userSchema.methods.changedPasswordAfter = function(JWTTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(this.passwordChangedAt.getTime() / 1000, 10);
    return JWTTimestamp < changedTimestamp;
  }
  return false;
};

// Método estático para buscar por username (case-insensitive)
userSchema.statics.findByUsername = function(username) {
  return this.findOne({ 
    username: { $regex: new RegExp('^' + username + '$', 'i') } 
  });
};

// Método estático para buscar por teléfono
userSchema.statics.findByPhone = function(phone) {
  return this.findOne({ 
    $or: [{ phone }, { whatsapp: phone }] 
  });
};

// Middleware pre-save para hashear contraseña
userSchema.pre('save', async function(next) {
  // Solo hashear si la contraseña fue modificada
  if (!this.isModified('password')) return next();
  
  // Hashear con costo 12
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Middleware pre-save para generar accountNumber si no existe
userSchema.pre('save', async function(next) {
  if (!this.accountNumber && this.isNew) {
    this.accountNumber = 'ACC' + Date.now().toString().slice(-8) + 
      Math.random().toString(36).substr(2, 4).toUpperCase();
  }
  next();
});

module.exports = mongoose.model('User', userSchema);