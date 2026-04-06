
/**
 * Modelo de Comandos Personalizados
 * Gestiona comandos tipo /ayuda, /bonus, etc.
 */
const mongoose = require('mongoose');

const commandSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true,
    trim: true,
    lowercase: true,
    match: /^\/[a-z0-9_]+$/
  },
  description: { 
    type: String, 
    default: '',
    trim: true
  },
  type: { 
    type: String, 
    enum: ['bonus', 'message', 'action', 'info'], 
    default: 'message' 
  },
  bonusPercent: { 
    type: Number, 
    default: 0,
    min: 0,
    max: 100
  },
  response: { 
    type: String, 
    default: '',
    trim: true
  },
  isActive: { 
    type: Boolean, 
    default: true,
    index: true
  },
  usageCount: { 
    type: Number, 
    default: 0,
    min: 0
  },
  createdBy: {
    type: String,
    default: null
  },
  updatedBy: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Índice para búsqueda por tipo
commandSchema.index({ type: 1, isActive: 1 });

// Método estático para obtener comando activo
commandSchema.statics.getActive = function(name) {
  return this.findOne({ name: name.toLowerCase(), isActive: true });
};

// Método estático para obtener todos los comandos activos
commandSchema.statics.getAllActive = function() {
  return this.find({ isActive: true }).sort({ name: 1 }).lean();
};

// Método de instancia para incrementar uso
commandSchema.methods.incrementUsage = async function() {
  this.usageCount += 1;
  await this.save();
  return this;
};

module.exports = mongoose.model('Command', commandSchema);