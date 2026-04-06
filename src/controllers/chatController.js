
/**
 * Controlador de Chat
 * Maneja mensajes y conversaciones
 */
const chatService = require('../services/chatService');
const asyncHandler = require('../utils/asyncHandler');
const { AppError, ErrorCodes } = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * GET /api/messages/:userId
 * Obtener mensajes de una conversación
 */
const getMessages = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { limit, before } = req.query;
  
  // Verificar permisos
  const allowedRoles = ['admin', 'depositor', 'withdrawer'];
  if (!allowedRoles.includes(req.user.role) && req.user.userId !== userId) {
    throw new AppError('Acceso denegado', 403, ErrorCodes.AUTH_FORBIDDEN);
  }
  
  const messages = await chatService.getMessages(userId, {
    limit: parseInt(limit) || 50,
    before,
    useCache: true
  });
  
  res.json({
    status: 'success',
    data: { messages }
  });
});

/**
 * POST /api/messages/send
 * Enviar mensaje
 */
const sendMessage = asyncHandler(async (req, res) => {
  const { content, type = 'text', receiverId } = req.body;
  
  if (!content || content.trim().length === 0) {
    throw new AppError('Contenido requerido', 400, ErrorCodes.VALIDATION_ERROR);
  }
  
  const message = await chatService.sendMessage({
    senderId: req.user.userId,
    senderUsername: req.user.username,
    senderRole: req.user.role,
    receiverId,
    content: content.trim(),
    type
  });
  
  res.json({
    status: 'success',
    data: { message }
  });
});

/**
 * POST /api/messages/read/:userId
 * Marcar mensajes como leídos
 */
const markAsRead = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  
  const result = await chatService.markAsRead(userId, req.user.userId);
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * GET /api/admin/conversations
 * Obtener conversaciones para el panel admin
 */
const getConversations = asyncHandler(async (req, res) => {
  const { status = 'open', limit, cursor } = req.query;
  
  const conversations = await chatService.getConversations(status, req.user.role, {
    limit: parseInt(limit, 10) > 0 ? parseInt(limit, 10) : 50,
    cursor: cursor || null
  });
  
  res.json({
    status: 'success',
    data: { conversations }
  });
});

/**
 * GET /api/admin/chats/:userId
 * Obtener información de un chat específico
 */
const getChatInfo = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  
  const chatInfo = await chatService.getChatInfo(userId);
  
  res.json({
    status: 'success',
    data: chatInfo
  });
});

/**
 * POST /api/admin/chats/:userId/close
 * Cerrar chat
 */
const closeChat = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { notifyClient } = req.body;
  
  const result = await chatService.closeChat(userId, req.user.username, { notifyClient });
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/admin/chats/:userId/reopen
 * Reabrir chat
 */
const reopenChat = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  
  const result = await chatService.reopenChat(userId, req.user.username);
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/admin/chats/:userId/assign
 * Asignar chat a agente
 */
const assignChat = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { agentId } = req.body;
  
  const result = await chatService.assignChat(userId, agentId || req.user.userId);
  
  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/admin/chats/:userId/category
 * Cambiar categoría del chat
 */
const changeCategory = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { category } = req.body;
  
  const result = await chatService.changeCategory(userId, category);
  
  res.json({
    status: 'success',
    data: result
  });
});

module.exports = {
  getMessages,
  sendMessage,
  markAsRead,
  getConversations,
  getChatInfo,
  closeChat,
  reopenChat,
  assignChat,
  changeCategory
};