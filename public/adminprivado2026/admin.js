
/**
 * ADMIN PANEL - Sala de Juegos
 * Ultra-fast real-time chat with Socket.IO
 * Professional, clean, no lag
 */

// ============================================
// CONFIGURATION
// ============================================
const API_URL = '';
const SOCKET_OPTIONS = {
    // Allow both WebSocket and HTTP long-polling so the connection works even when
    // WebSocket is blocked (e.g. Cloudflare without WebSocket enabled) when
    // accessing via the custom domain vipcargas.com.  WebSocket is tried first
    // (faster), polling is used as fallback.
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
};

// ============================================
// STATE
// ============================================
let socket = null;
let currentToken = localStorage.getItem('adminToken');
let currentAdmin = null;
let selectedUserId = null;
let selectedUsername = null;
let conversations = [];
let currentTab = 'open';
let typingTimeout = null;
let messageCache = new Map();
let lastSentMessageContent = null; // Para evitar duplicados de mensajes propios
let lastSentMessageTime = 0;
let availableCommands = []; // Comandos disponibles para sugerencias
let commandSuggestions = [];
let selectedCommandIndex = -1;
let processedMessageIds = new Set(); // CORREGIDO: Para evitar mensajes duplicados
let isLoadingMessages = false; // Para evitar cargas múltiples simultáneas
let activeConversationId = null; // Identificador estable del chat activo (race condition fix)
let activeFetchController = null; // AbortController para cancelar fetches de mensajes anteriores

// PWA - Instalación de App
let deferredInstallPrompt = null;
let isAppInstalled = false;

// Notificaciones Push
let pushSubscription = null;

// ============================================
// DOM ELEMENTS
// ============================================
const elements = {
    loginScreen: document.getElementById('loginScreen'),
    app: document.getElementById('app'),
    loginForm: document.getElementById('loginForm'),
    loginError: document.getElementById('loginError'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    adminName: document.getElementById('adminName'),
    logoutBtn: document.getElementById('logoutBtn'),
    
    // Stats
    statUsers: document.getElementById('statUsers'),
    statOnline: document.getElementById('statOnline'),
    statMessages: document.getElementById('statMessages'),
    statUnread: document.getElementById('statUnread'),
    unreadBadge: document.getElementById('unreadBadge'),
    
    // Navigation
    navItems: document.querySelectorAll('.nav-item'),
    sections: document.querySelectorAll('.section'),
    
    // Chats
    conversationsList: document.getElementById('conversationsList'),
    searchUser: document.getElementById('searchUser'),
    refreshChats: document.getElementById('refreshChats'),
    tabBtns: document.querySelectorAll('.tab-btn'),
    
    // Chat panel
    chatHeader: document.getElementById('chatHeader'),
    chatMessages: document.getElementById('chatMessages'),
    chatInputArea: document.getElementById('chatInputArea'),
    chatUsername: document.getElementById('chatUsername'),
    chatStatus: document.getElementById('chatStatus'),
    chatAppStatus: document.getElementById('chatAppStatus'),
    chatBalance: document.getElementById('chatBalance'),
    messageInput: document.getElementById('messageInput'),
    sendMessage: document.getElementById('sendMessage'),
    typingIndicator: document.getElementById('typingIndicator'),
    
    // Action buttons
    btnCBU: document.getElementById('btnCBU'),
    btnDeposit: document.getElementById('btnDeposit'),
    btnBonus: document.getElementById('btnBonus'),
    btnWithdraw: document.getElementById('btnWithdraw'),
    btnPassword: document.getElementById('btnPassword'),
    btnPayments: document.getElementById('btnPayments'),
    btnClose: document.getElementById('btnClose'),
    
    // Modals
    depositModal: document.getElementById('depositModal'),
    withdrawModal: document.getElementById('withdrawModal'),
    passwordModal: document.getElementById('passwordModal'),
    
    // Toast
    toastContainer: document.getElementById('toastContainer')
};

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    if (currentToken) {
        validateToken();
    } else {
        showLogin();
    }
    
    setupEventListeners();
});

function setupEventListeners() {
    // Login
    elements.loginForm.addEventListener('submit', handleLogin);
    
    // Logout
    elements.logoutBtn.addEventListener('click', handleLogout);
    
    // Navigation
    elements.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const section = item.dataset.section;
            switchSection(section);
        });
    });
    
    // Tabs - INSTANTÁNEO: mostrar inmediatamente sin delay
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            elements.tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;
            // Limpiar selección de chat al cambiar de pestaña
            if (selectedUserId) {
                if (socket) socket.emit('leave_chat_room', { userId: selectedUserId });
                selectedUserId = null;
                elements.chatHeader.classList.add('hidden');
                elements.chatInputArea.classList.add('hidden');
                elements.chatMessages.innerHTML = `
                    <div class="empty-state">
                        <span class="icon icon-comment-dots"></span>
                        <p>Selecciona una conversación para ver los mensajes</p>
                    </div>
                `;
            }
            // Mostrar datos cacheados de la pestaña al instante (sin pantalla en blanco)
            const tabCache = conversationsCacheByTab.get(currentTab);
            if (tabCache && tabCache.data.length > 0) {
                conversations = tabCache.data;
                renderConversations();
            } else {
                elements.conversationsList.innerHTML = `
                    <div class="empty-state">
                        <span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span>
                        <p>Cargando...</p>
                    </div>
                `;
            }
            // Refrescar datos en background (actualiza lista suavemente)
            loadConversations(false);
            // Actualizar botón según la pestaña
            updateActionButtonsByTab();
        });
    });
    
    // Search
    elements.searchUser.addEventListener('input', debounce((e) => {
        searchConversations(e.target.value);
    }, 300));
    
    // Refresh
    elements.refreshChats.addEventListener('click', loadConversations);
    
    // Chat input
    elements.messageInput.addEventListener('keydown', (e) => {
        // CORREGIDO: Manejar navegación y selección de comandos ANTES de enviar mensaje
        if (commandSuggestions.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedCommandIndex = (selectedCommandIndex + 1) % commandSuggestions.length;
                updateCommandSelection();
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedCommandIndex = (selectedCommandIndex - 1 + commandSuggestions.length) % commandSuggestions.length;
                updateCommandSelection();
                return;
            } else if (e.key === 'Enter' && selectedCommandIndex >= 0) {
                e.preventDefault();
                insertCommand(commandSuggestions[selectedCommandIndex].name);
                return;
            } else if (e.key === 'Tab') {
                e.preventDefault();
                const idx = selectedCommandIndex >= 0 ? selectedCommandIndex : 0;
                insertCommand(commandSuggestions[idx].name);
                return;
            } else if (e.key === 'Escape') {
                hideCommandSuggestions();
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
        handleTyping();
    });
    
    // COMANDOS: Detectar cuando se escribe "/" para mostrar sugerencias
    elements.messageInput.addEventListener('input', (e) => {
        const value = e.target.value;
        if (value.startsWith('/')) {
            showCommandSuggestions(value);
        } else {
            hideCommandSuggestions();
        }
        handleTyping();
    });
    
    elements.sendMessage.addEventListener('click', sendMessage);
    
    // CORREGIDO: Botón adjuntar imagen
    const attachImageBtn = document.getElementById('attachImageBtn');
    const imageInput = document.getElementById('imageInput');
    if (attachImageBtn && imageInput) {
        attachImageBtn.addEventListener('click', () => {
            imageInput.click();
        });
        imageInput.addEventListener('change', handleImageSelect);
    }

    // Pegar imagen con Ctrl+V desde portapapeles (escritorio)
    if (elements.messageInput) {
        elements.messageInput.addEventListener('paste', handleAdminPaste);
    }
    
    // Action buttons
    elements.btnCBU.addEventListener('click', sendCBU);
    elements.btnDeposit.addEventListener('click', () => showModal('depositModal'));
    if (elements.btnBonus) {
        elements.btnBonus.addEventListener('click', () => showModal('bonusModal'));
    }
    elements.btnWithdraw.addEventListener('click', () => showModal('withdrawModal'));
    elements.btnPassword.addEventListener('click', () => showModal('passwordModal'));
    elements.btnPayments.addEventListener('click', sendToPayments);
    elements.btnClose.addEventListener('click', closeChat);
    
    // Modal close buttons
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal');
            hideModal(modal.id);
        });
    });
    
    // Quick amounts - ACUMULATIVO
    document.querySelectorAll('.quick-amounts button').forEach(btn => {
        btn.addEventListener('click', () => {
            const amount = parseInt(btn.dataset.amount);
            const modal = btn.closest('.modal');
            if (modal.id === 'depositModal') {
                const currentAmount = parseInt(document.getElementById('depositAmount').value) || 0;
                document.getElementById('depositAmount').value = currentAmount + amount;
                calculateBonus();
            } else if (modal.id === 'withdrawModal') {
                const currentAmount = parseInt(document.getElementById('withdrawAmount').value) || 0;
                const newAmount = currentAmount + amount;
                document.getElementById('withdrawAmount').value = newAmount;
                updateWithdrawTotal();
            }
        });
    });
    
    // Bonus options
    document.querySelectorAll('.bonus-options button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.bonus-options button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            calculateBonus();
        });
    });
    
    // Deposit amount change
    document.getElementById('depositAmount').addEventListener('input', calculateBonus);
    
    // Withdraw amount change - update total
    document.getElementById('withdrawAmount').addEventListener('input', updateWithdrawTotal);
    
    // Confirm buttons
    document.getElementById('confirmDeposit').addEventListener('click', handleDeposit);
    document.getElementById('confirmWithdraw').addEventListener('click', handleWithdraw);
    document.getElementById('confirmPassword').addEventListener('click', handlePasswordChange);
    const confirmBonusBtn = document.getElementById('confirmBonus');
    if (confirmBonusBtn) {
        confirmBonusBtn.addEventListener('click', handleDirectBonus);
    }
    
    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideModal(modal.id);
            }
        });
    });
    
    // CORREGIDO: Tecla Escape para cerrar chat seleccionado (deseleccionar)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && selectedUserId) {
            // Si hay un modal abierto, cerrarlo primero
            const openModal = document.querySelector('.modal.active');
            if (openModal) {
                hideModal(openModal.id);
                return;
            }
            // Si no hay modal, deseleccionar el chat
            deselectChat();
        }
    });
}

// ============================================
// AUTHENTICATION
// ============================================
async function handleLogin(e) {
    e.preventDefault();
    
    const username = elements.username.value.trim();
    const password = elements.password.value;
    
    if (!username || !password) {
        showLoginError('Completa todos los campos');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.token) {
            currentToken = data.token;
            currentAdmin = data.user;
            localStorage.setItem('adminToken', currentToken);
            localStorage.setItem('adminUser', JSON.stringify(currentAdmin));
            
            // Configurar UI según el rol
            setupRoleBasedUI();
            
            // Verificar si necesita cambiar contraseña
            if (data.user.needsPasswordChange) {
                showPasswordChangeModal();
                return;
            }
            
            // Primero mostrar el panel
            showApp();
            
            // CORREGIDO: Solicitar permiso para notificaciones del navegador
            requestNotificationPermission();
            
            // Send FCM token to backend now that we have an auth token
            const pendingFcmToken = localStorage.getItem('adminFcmToken');
            if (pendingFcmToken) {
                fetch(`${API_URL}/api/notifications/register-token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentToken}`
                    },
                    body: JSON.stringify({ fcmToken: pendingFcmToken })
                }).then(r => r.json()).then(d => {
                    if (d.success) console.log('[FCM Admin] ✅ Token registrado post-login');
                }).catch(() => {});
            }
            
            // Luego intentar cargar datos (con manejo de errores)
            try {
                initSocket();
            } catch (e) {
                console.log('Socket no disponible:', e);
            }
            
            try {
                loadConversations();
            } catch (e) {
                console.log('Error cargando conversaciones:', e);
            }
            
            try {
                loadStats();
            } catch (e) {
                console.log('Error cargando stats:', e);
            }

            startConversationReconciliation();
            
            showToast('Login exitoso', 'success');
        } else {
            showLoginError(data.message || data.error || 'Credenciales inválidas');
        }
    } catch (error) {
        console.error('Login error:', error);
        showLoginError('Error de conexión');
    }
}

async function validateToken() {
    try {
        const response = await fetch(`${API_URL}/api/auth/verify`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            currentAdmin = data.user || JSON.parse(localStorage.getItem('adminUser'));
            showApp();
            initSocket();
            // Solicitar permiso para notificaciones al iniciar
            requestNotificationPermission();
            loadConversations();
            loadStats();
            // Cargar comandos al iniciar para las sugerencias
            loadCommands();
            // Iniciar reconciliación periódica de conversaciones
            startConversationReconciliation();
        } else {
            localStorage.removeItem('adminToken');
            localStorage.removeItem('adminUser');
            showLogin();
        }
    } catch (error) {
        console.error('Token validation error:', error);
        showLogin();
    }
}

function handleLogout() {
    if (socket) {
        socket.disconnect();
    }
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminUser');
    currentToken = null;
    currentAdmin = null;
    selectedUserId = null;
    showLogin();
}

function showLogin() {
    elements.loginScreen.classList.remove('hidden');
    elements.app.classList.add('hidden');
    elements.username.value = '';
    elements.password.value = '';
    elements.loginError.textContent = '';
}

function showLoginError(message) {
    elements.loginError.textContent = message;
}

function showApp() {
    elements.loginScreen.classList.add('hidden');
    elements.app.classList.remove('hidden');
    elements.adminName.textContent = currentAdmin?.username || 'Admin';
}

function showPasswordChangeModal() {
    showModal('passwordModal');
    // Deshabilitar el botón de cerrar modal
    const closeBtn = document.querySelector('#passwordModal .close-modal');
    if (closeBtn) {
        closeBtn.style.display = 'none';
    }
    // Cambiar el botón de cancelar para que no funcione
    const cancelBtn = document.querySelector('#passwordModal .btn-secondary');
    if (cancelBtn) {
        cancelBtn.style.display = 'none';
    }
    // Agregar mensaje obligatorio
    const modalHeader = document.querySelector('#passwordModal .modal-header h3');
    if (modalHeader) {
        modalHeader.innerHTML = '<span class="icon icon-key"></span> Cambio de Contraseña Obligatorio';
    }
}

function setupRoleBasedUI() {
    const role = currentAdmin?.role;
    
    // Configurar pestañas visibles según el rol
    const tabOpen = document.querySelector('[data-tab="open"]');
    const tabClosed = document.querySelector('[data-tab="closed"]');
    const tabPayments = document.querySelector('[data-tab="payments"]');
    
    if (role === 'withdrawer') {
        // Withdrawer solo ve PAGOS
        if (tabOpen) tabOpen.style.display = 'none';
        if (tabClosed) tabClosed.style.display = 'none';
        if (tabPayments) tabPayments.style.display = 'flex';
        currentTab = 'payments';
    } else if (role === 'depositor') {
        // Depositer no ve PAGOS
        if (tabPayments) tabPayments.style.display = 'none';
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        currentTab = 'open';
    } else {
        // Admin general ve todo
        if (tabOpen) tabOpen.style.display = 'flex';
        if (tabClosed) tabClosed.style.display = 'flex';
        if (tabPayments) tabPayments.style.display = 'flex';
    }
    
    // Depositor y withdrawer pueden ver "Usuarios" pero NO pueden exportar CSV
    const usersNavItem = document.querySelector('.nav-item[data-section="users"]');
    if (usersNavItem) {
        usersNavItem.style.display = ['admin', 'depositor', 'withdrawer'].includes(role) ? '' : 'none';
    }
    // Solo el admin general puede exportar usuarios
    const exportCsvBtn = document.getElementById('exportUsersCSVBtn');
    if (exportCsvBtn) {
        exportCsvBtn.style.display = role === 'admin' ? '' : 'none';
    }

    // Bonus directo: visible para admin y depositor
    const btnBonus = elements.btnBonus;
    if (btnBonus) {
        btnBonus.style.display = ['admin', 'depositor'].includes(role) ? '' : 'none';
    }
    
    // Actualizar botones según la pestaña actual
    updateActionButtonsByTab();
}

// Actualizar botones de acción según la pestaña actual
function updateActionButtonsByTab() {
    const btnPayments = elements.btnPayments;
    if (!btnPayments) return;
    
    const role = currentAdmin?.role;
    
    if (currentTab === 'payments') {
        // En pestaña Pagos: mostrar "Enviar a Abiertos" solo para admin general (no para withdrawer)
        if (role === 'withdrawer') {
            btnPayments.style.display = 'none';
        } else {
            btnPayments.style.display = '';
            btnPayments.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Abiertos';
            btnPayments.onclick = sendToOpen;
        }
    } else {
        btnPayments.style.display = '';
        // En otras pestañas: mostrar "Enviar a Pagos"
        btnPayments.innerHTML = '<span class="icon icon-exchange"></span> Enviar a Pagos';
        btnPayments.onclick = sendToPayments;
    }
}

// ============================================
// SOCKET.IO - ULTRA FAST
// ============================================
function initSocket() {
    if (socket) {
        socket.disconnect();
    }
    
    socket = io(SOCKET_OPTIONS);
    
    socket.on('connect', () => {
        console.log('✅ Socket connected');
        socket.emit('authenticate', currentToken);
    });
    
    socket.on('authenticated', (data) => {
        if (data.success) {
            console.log('✅ Socket authenticated');
            joinAdminRoom();
        } else {
            console.error('❌ Socket authentication failed');
        }
    });
    
    // NEW MESSAGE - INSTANT
    socket.on('new_message', (data) => {
        console.log('📨 NEW_MESSAGE event received:', data);
        console.log('📨 Message content:', data.message?.content || data.content);
        console.log('📨 Sender role:', data.message?.senderRole || data.senderRole);
        console.log('📨 Sender ID:', data.message?.senderId || data.senderId);
        handleNewMessage(data);
    });
    
    // MESSAGE SENT CONFIRMATION
    socket.on('message_sent', (data) => {
        console.log('✅ Message sent:', data);
        // Update temp message with real one instead of adding duplicate
        const tempEl = document.querySelector('[data-messageid^="temp-"]');
        if (tempEl) {
            tempEl.dataset.messageid = data.id;
        }
    });
    
    // CHAT CLOSED - Mantener chat abierto para seguir respondiendo
    socket.on('chat_closed', (data) => {
        console.log('🔒 Chat cerrado:', data);
        if (data.userId === selectedUserId) {
            showToast('Chat movido a Cerrados. Puedes seguir respondiendo.', 'info');
            // Fix #3: Recargar mensajes para mostrar el mensaje de cierre desde DB
            messageCache.delete(selectedUserId);
            loadMessages(selectedUserId);
        }
        // Invalidar cache de las pestañas afectadas y recargar
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        loadConversations(true);
    });
    
    // CONVERSATION_UPDATED (para compatibilidad con versiones anteriores del backend)
    socket.on('conversation_updated', (data) => {
        console.log('🔄 Conversation updated:', data);
        if (data.userId !== selectedUserId) {
            incrementUnreadCount();
            playNotificationSound();
        }
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
    });
    
    // CHAT MOVED TO PAYMENTS
    socket.on('chat_moved', (data) => {
        console.log('💳 Chat moved to payments:', data);
        if (data.userId === selectedUserId) {
            selectedUserId = null;
            activeConversationId = null; // RACE CONDITION FIX
            elements.chatHeader.classList.add('hidden');
            elements.chatInputArea.classList.add('hidden');
            elements.chatMessages.innerHTML = `
                <div class="empty-state">
                    <span class="icon icon-comment-dots"></span>
                    <p>Chat enviado a pagos. Selecciona otra conversación.</p>
                </div>
            `;
        }
        // Invalidar cache de pestañas afectadas
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('payments');
        loadConversations(true);
        showToast('Chat enviado a pagos', 'info');
    });
    
    // USER TYPING
    socket.on('user_typing', (data) => {
        if (data.userId === selectedUserId) {
            showTypingIndicator();
        }
    });
    
    socket.on('user_stop_typing', (data) => {
        if (data.userId === selectedUserId) {
            hideTypingIndicator();
        }
    });
    
    // STATS UPDATE
    socket.on('stats', (data) => {
        updateStats(data);
    });
    
    // USER ONLINE/OFFLINE
    socket.on('user_connected', (data) => {
        updateUserStatus(data.userId, true);
        // Si el usuario conectado es el chat activo, actualizar info (incl. estado de app)
        if (data.userId === selectedUserId) {
            loadUserInfo(data.userId);
        }
    });
    
    socket.on('user_disconnected', (data) => {
        updateUserStatus(data.userId, false);
    });
    
    // Actualizar estado de app de notificaciones en tiempo real
    socket.on('user_app_status', (data) => {
        if (data.userId === selectedUserId && elements.chatAppStatus) {
            if (data.appInstalled) {
                elements.chatAppStatus.textContent = '📱 app instalada';
                elements.chatAppStatus.style.color = '#00ff88';
            } else {
                elements.chatAppStatus.textContent = '📵 app borrada';
                elements.chatAppStatus.style.color = '#aaa';
            }
        }
    });
    
    // CHAT UPDATED - Actualizar lista lateral en tiempo real cuando llega un mensaje
    socket.on('chat_updated', (data) => {
        const convIndex = conversations.findIndex(c => c.userId === data.userId);
        if (convIndex === -1) {
            // Conversación nueva o no visible: invalidar cache y recargar
            conversationsCacheByTab.delete(currentTab);
            loadConversations(true);
            return;
        }
        const conv = conversations[convIndex];
        conv.lastMessageAt = data.lastMessageAt || new Date();
        if (data.unreadIncrement > 0 && data.userId !== selectedUserId) {
            conv.unread = (conv.unread || 0) + data.unreadIncrement;
        }
        // Mover al tope de la lista
        conversations.splice(convIndex, 1);
        conversations.unshift(conv);
        // Actualizar cache
        conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
        renderConversations();
    });

    // MESSAGES READ - Sincronizar estado leído/no leído entre admins
    socket.on('messages_read', (data) => {
        const convIndex = conversations.findIndex(c => c.userId === data.userId);
        if (convIndex !== -1) {
            conversations[convIndex].unread = 0;
            conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
            renderConversations();
        }
        loadStats();
    });

    // ADMIN MESSAGE SENT - Actualizar lista cuando otro admin envía un mensaje
    socket.on('admin_message_sent', (data) => {
        const message = data.message;
        if (!message) return;
        const chatUserId = data.receiverId;
        const currentAdminId = currentAdmin && (currentAdmin.userId || currentAdmin.id);
        // Si otro admin envió al chat activo, mostrar el mensaje
        if (chatUserId === selectedUserId && data.senderId !== currentAdminId) {
            if (!processedMessageIds.has(message.id)) {
                processedMessageIds.add(message.id);
                addMessageToChat(message, true);
                scrollToBottom();
            }
        }
        // Actualizar conversación en la lista
        updateConversationInList(message);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('🔌 Socket disconnected');
    });

    // RECONNECT - Re-fetch conversations to recover any missed events
    socket.on('reconnect', () => {
        console.log('🔄 Socket reconnected — re-fetching conversations');
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
    });
    
    // ERROR
    socket.on('error', (data) => {
        console.error('❌ Socket error:', data);
        showToast(data.message || 'Error de conexión', 'error');
    });
}

// Reconciliación periódica: cada 60 segundos invalidar cache y recargar
// conversaciones para recuperar cualquier evento perdido por reconexión u otro motivo.
let reconciliationInterval = null;
function startConversationReconciliation() {
    if (reconciliationInterval) clearInterval(reconciliationInterval);
    reconciliationInterval = setInterval(() => {
        conversationsCacheByTab.delete(currentTab);
        loadConversations(false);
    }, 60000);
}

function joinAdminRoom() {
    socket.emit('join_admin_room');
}

function handleNewMessage(data) {
    const message = data.message || data;
    const senderId = message.senderId;
    const receiverId = message.receiverId;
    
    console.log('📨 handleNewMessage:', message.id, 'from:', senderId, 'to:', receiverId, 'selected:', selectedUserId);
    
    // CORREGIDO: Verificar si el mensaje ya fue procesado (evitar duplicados del socket)
    if (message.id) {
        if (processedMessageIds.has(message.id)) {
            console.log('⚠️ Mensaje ya procesado (ID en cache), ignorando:', message.id);
            return;
        }
        processedMessageIds.add(message.id);
    }
    
    // Verificar si el mensaje ya existe en el DOM
    if (message.id && elements.chatMessages.querySelector(`[data-messageid="${message.id}"]`)) {
        console.log('⚠️ Mensaje ya existe en DOM, ignorando');
        return;
    }
    
    // CORREGIDO: Verificar mensajes temporales con mismo contenido (evitar duplicados del optimistic UI)
    if (message.content) {
        const tempElements = elements.chatMessages.querySelectorAll('[data-messageid^="temp-"]');
        for (const tempEl of tempElements) {
            const tempContent = tempEl.querySelector('.message-content')?.textContent?.trim();
            if (tempContent === message.content.trim()) {
                // Actualizar el ID temporal al real en lugar de crear duplicado
                tempEl.dataset.messageid = message.id;
                console.log('✅ Mensaje temporal actualizado con ID real:', message.id);
                return;
            }
        }
    }
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const isFromAdmin = adminRoles.includes(message.senderRole);
    const isSystemMessage = message.type === 'system' || senderId === 'admin' || senderId === 'system';
    
    // Determinar el userId del chat al que pertenece este mensaje
    const chatUserId = isFromAdmin || isSystemMessage ? receiverId : senderId;
    
    // Si hay un chat seleccionado y este mensaje pertenece a ese chat, mostrarlo
    if (selectedUserId && chatUserId === selectedUserId) {
        addMessageToChat(message, isFromAdmin || isSystemMessage);
        markMessagesAsRead(selectedUserId);
        playNotificationSound();
        scrollToBottom();
        setTimeout(scrollToBottom, 100);
        // También actualizar conversación en la lista (mover al tope y actualizar preview)
        updateConversationInList(message);
    } else {
        // Mensaje de otro chat - actualizar lista y mostrar notificación
        incrementUnreadCount();
        playNotificationSound();
        // Mostrar notificación del navegador
        const senderName = message.senderUsername || 'Usuario';
        const messagePreview = message.type === 'image' ? '📸 Imagen' : message.type === 'video' ? '🎥 Video' : (message.content?.substring(0, 50) + '...');
        showBrowserNotification(
            `💬 Nuevo mensaje de ${senderName}`,
            messagePreview,
            '/favicon.ico'
        );
        // Actualizar conversación en la lista en tiempo real (sin HTTP call)
        updateConversationInList(message);
    }
}

// ============================================
// CONVERSATIONS
// ============================================
// Cache por pestaña: clave = tab ('open'|'closed'|'payments'), valor = { data: [], timestamp: 0 }
let conversationsCacheByTab = new Map();
const CONVERSATIONS_CACHE_TIME = 30000; // 30 segundos (actualizamos en tiempo real vía WebSocket)

/**
 * Actualización inteligente de una conversación en la lista (sin HTTP call).
 * Se llama cuando llega un mensaje nuevo de otro chat.
 */
function updateConversationInList(message) {
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const isFromAdmin = adminRoles.includes(message.senderRole);
    const chatUserId = isFromAdmin ? message.receiverId : message.senderId;
    
    // Actualizar en el array conversations actual
    const convIndex = conversations.findIndex(c => c.userId === chatUserId);
    if (convIndex === -1) {
        // Conversación nueva o no visible: invalidar cache y recargar
        conversationsCacheByTab.delete(currentTab);
        loadConversations(true);
        return;
    }
    
    const conv = conversations[convIndex];
    if (message.type === 'video') {
        conv.lastMessage = '🎥 Video';
    } else if (message.type !== 'image') {
        conv.lastMessage = message.content;
    } else {
        conv.lastMessage = '📸 Imagen';
    }
    conv.lastMessageAt = message.timestamp || new Date();
    if (!isFromAdmin) {
        conv.unread = (conv.unread || 0) + 1;
    }
    
    // Mover la conversación al top de la lista
    conversations.splice(convIndex, 1);
    conversations.unshift(conv);
    
    // Actualizar cache de la pestaña actual
    conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
    
    // Re-renderizar la lista de forma instantánea
    renderConversations();
}

// Cargar conversaciones con cache por pestaña
async function loadConversations(forceRefresh = false) {
    const now = Date.now();
    const tabCache = conversationsCacheByTab.get(currentTab);
    
    // Usar cache si está disponible, no es forzado y no expiró
    if (!forceRefresh && tabCache && (now - tabCache.timestamp) < CONVERSATIONS_CACHE_TIME) {
        conversations = tabCache.data;
        renderConversations();
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/conversations?status=${currentTab}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load conversations');
        
        const data = await response.json();
        conversations = data.conversations || [];
        
        // Guardar en cache por pestaña
        conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
        
        renderConversations();
        
        // PREFETCH: Cargar mensajes de los primeros 3 chats en background
        prefetchMessages(conversations.slice(0, 3));
    } catch (error) {
        console.error('Error loading conversations:', error);
    }
}

// PREFETCH: Cargar mensajes silenciosamente
async function prefetchMessages(convs) {
    for (const conv of convs) {
        if (!messageCache.has(conv.userId)) {
            fetch(`${API_URL}/api/messages/${conv.userId}?limit=50`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            })
            .then(r => r.json())
            .then(data => {
                if (data.messages) {
                    messageCache.set(conv.userId, data.messages);
                }
            })
            .catch(() => {});
        }
    }
}

function renderConversations() {
    if (conversations.length === 0) {
        elements.conversationsList.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comments"></span>
                <p>No hay conversaciones</p>
            </div>
        `;
        return;
    }
    
    elements.conversationsList.innerHTML = conversations.map(conv => `
        <div class="conversation-item ${conv.unread > 0 ? 'unread' : ''} ${conv.userId === selectedUserId ? 'active' : ''}" 
             data-userid="${conv.userId}" 
             data-username="${conv.username}">
            <div class="conv-avatar">
                <span class="icon icon-user"></span>
            </div>
            <div class="conv-info">
                <span class="conv-name">${escapeHtml(conv.username)}</span>
                <span class="conv-preview">${escapeHtml(conv.lastMessage || 'Sin mensajes')}</span>
            </div>
            <div class="conv-meta">
                <span class="conv-time">${formatTime(conv.lastMessageAt)}</span>
                ${conv.unread > 0 ? `<span class="conv-badge">${conv.unread}</span>` : ''}
            </div>
        </div>
    `).join('');
    
    // Add click handlers
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => {
            const userId = item.dataset.userid;
            const username = item.dataset.username;
            selectConversation(userId, username);
        });
    });
}

function searchConversations(query) {
    const items = document.querySelectorAll('.conversation-item');
    const lowerQuery = query.toLowerCase();
    
    items.forEach(item => {
        const name = item.querySelector('.conv-name').textContent.toLowerCase();
        item.style.display = name.includes(lowerQuery) ? 'flex' : 'none';
    });
}

// CORREGIDO: Optimizado para eliminar lag al seleccionar conversación
async function selectConversation(userId, username) {
    // CORREGIDO: Salir de la sala anterior si existe
    if (selectedUserId && socket) {
        socket.emit('leave_chat_room', { userId: selectedUserId });
    }
    
    selectedUserId = userId;
    selectedUsername = username;
    activeConversationId = userId; // Identificador estable para verificar respuestas tardías
    
    // Update UI inmediatamente
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.toggle('active', item.dataset.userid === userId);
    });
    
    // Fix #2: Marcar como leído de forma instantánea en la UI (antes de la llamada API)
    const convItem = document.querySelector(`.conversation-item[data-userid="${userId}"]`);
    if (convItem) {
        convItem.classList.remove('unread');
        const badge = convItem.querySelector('.conv-badge');
        if (badge) badge.remove();
    }
    const conv = conversations.find(c => c.userId === userId);
    if (conv && conv.unread > 0) {
        const currentBadgeCount = parseInt(elements.unreadBadge.textContent) || 0;
        const newCount = Math.max(0, currentBadgeCount - conv.unread);
        if (newCount <= 0) {
            elements.unreadBadge.classList.add('hidden');
            elements.unreadBadge.textContent = '0';
        } else {
            elements.unreadBadge.textContent = String(newCount);
        }
        conv.unread = 0;
    }
    
    // Show chat panel inmediatamente
    elements.chatHeader.classList.remove('hidden');
    elements.chatInputArea.classList.remove('hidden');
    elements.chatUsername.textContent = username;
    
    // CORREGIDO: Mostrar mensajes cacheados inmediatamente (sin esperar)
    const cachedMessages = messageCache.get(userId);
    if (cachedMessages && cachedMessages.length > 0) {
        renderMessages(cachedMessages);
    } else {
        // Mostrar loading mientras se cargan los mensajes
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span>
                <p>Cargando mensajes...</p>
            </div>
        `;
    }
    
    // CORREGIDO: Unirse a la sala de chat del usuario
    if (socket) {
        socket.emit('join_chat_room', { userId });
    }
    
    // CORREGIDO: Cargar mensajes en paralelo (no await) para eliminar lag
    loadMessages(userId).then(() => {
        // Mark as read después de cargar (confirma en DB)
        // RACE CONDITION FIX: Solo marcar leído si este chat sigue activo
        if (userId === activeConversationId) {
            markMessagesAsRead(userId);
        }
    });
    
    // Load user info en paralelo
    loadUserInfo(userId);
}

// Solicitar permiso para notificaciones del navegador
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            console.log('🔔 Permiso de notificación:', permission);
        });
    }
}

// CORREGIDO: Mostrar notificación del navegador
function showBrowserNotification(title, body, icon = '/favicon.ico') {
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            const notification = new Notification(title, {
                body: body,
                icon: icon,
                badge: icon,
                tag: 'new-message',
                requireInteraction: false,
                silent: false
            });
            
            notification.onclick = () => {
                window.focus();
                notification.close();
            };
            
            // Cerrar automáticamente después de 5 segundos
            setTimeout(() => notification.close(), 5000);
        } catch (e) {
            console.log('No se pudo mostrar notificación:', e);
        }
    }
}

async function loadMessages(userId) {
    // RACE CONDITION FIX: Crear un nuevo AbortController para este fetch
    if (activeFetchController) {
        activeFetchController.abort();
    }
    const controller = new AbortController();
    activeFetchController = controller;

    isLoadingMessages = true;
    
    try {
        // Mostrar mensajes cacheados inmediatamente si existen
        const cachedMessages = messageCache.get(userId);
        if (cachedMessages && cachedMessages.length > 0) {
            // Verificar que siga siendo el chat activo antes de renderizar cache
            if (userId === activeConversationId) {
                renderMessages(cachedMessages);
            }
        } else {
            // Solo mostrar loading si no hay cache y sigue activo
            if (userId === activeConversationId) {
                elements.chatMessages.innerHTML = '<div class="empty-state"><span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span><p>Cargando mensajes...</p></div>';
            }
        }
        
        // Cargar últimos 50 mensajes previos (límite del panel de admin)
        const response = await fetch(`${API_URL}/api/messages/${userId}?limit=50`, {
            headers: { 'Authorization': `Bearer ${currentToken}` },
            signal: controller.signal
        });
        
        if (!response.ok) throw new Error('Failed to load messages');
        
        const data = await response.json();
        const messages = data.messages || [];
        
        // RACE CONDITION FIX: Ignorar respuesta si ya no es el chat activo
        if (userId !== activeConversationId) {
            console.log('⚠️ Respuesta de chat antiguo ignorada:', userId, '!= activo:', activeConversationId);
            return;
        }
        
        // Cache messages
        messageCache.set(userId, messages);
        
        // Solo re-renderizar si hay cambios
        renderMessages(messages);
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('🚫 Fetch de mensajes cancelado para:', userId);
            return;
        }
        console.error('Error loading messages:', error);
        // Solo mostrar error si sigue siendo el chat activo y no hay cache
        if (userId === activeConversationId && !messageCache.get(userId)) {
            elements.chatMessages.innerHTML = '<div class="empty-state"><span class="icon icon-times-circle"></span><p>Error cargando mensajes</p></div>';
        }
    } finally {
        // Limpiar controller solo si sigue siendo el activo
        if (activeFetchController === controller) {
            activeFetchController = null;
        }
        isLoadingMessages = false;
    }
}

function renderMessages(messages) {
    // Si no hay mensajes en absoluto, mostrar empty state
    if (messages.length === 0) {
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comment-dots"></span>
                <p>No hay mensajes aún</p>
            </div>
        `;
        return;
    }
    
    // Usar DocumentFragment para mínimo reflow DOM
    const fragment = document.createDocumentFragment();
    processedMessageIds.clear();
    
    messages.forEach(msg => {
        if (msg.id) {
            processedMessageIds.add(msg.id);
        }
        const msgDiv = createMessageElement(msg);
        fragment.appendChild(msgDiv);
    });
    
    elements.chatMessages.innerHTML = '';
    elements.chatMessages.appendChild(fragment);
    
    // Scroll instantáneo al final
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function formatMessageContent(msg) {
    if (msg.type === 'image') {
        return `<img src="${escapeHtml(msg.content)}" class="message-image" onclick="openLightbox('${escapeHtml(msg.content)}')" alt="Imagen" loading="lazy">`;
    }
    
    if (msg.type === 'video') {
        return `<video src="${escapeHtml(msg.content)}" class="message-video" controls preload="metadata" style="max-width:100%;max-height:300px;border-radius:8px;"></video>`;
    }
    
    // CORREGIDO: Convertir URLs en links clickeables
    let content = escapeHtml(msg.content);
    
    // Detectar y convertir URLs en links
    const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,;:!?])/g;
    content = content.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');
    
    // Preservar saltos de línea
    content = content.replace(/\n/g, '<br>');
    
    return content;
}

function openLightbox(imageSrc) {
    const lightbox = document.getElementById('imageLightbox');
    const img = document.getElementById('lightboxImage');
    img.src = imageSrc;
    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeLightbox(event) {
    // Close if clicked on background or close button
    if (event.target.id === 'imageLightbox' || event.target.classList.contains('lightbox-close')) {
        const lightbox = document.getElementById('imageLightbox');
        lightbox.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function addMessageToChat(message, isOutgoing = false) {
    // CORREGIDO: Verificar si el mensaje ya existe en el DOM (evitar duplicados)
    if (message.id) {
        const existingById = elements.chatMessages.querySelector(`[data-messageid="${message.id}"]`);
        if (existingById) {
            console.log('⚠️ Mensaje ya existe por ID, ignorando:', message.id);
            return;
        }
        // Verificar si existe un mensaje temporal con el mismo contenido
        const tempElements = elements.chatMessages.querySelectorAll('[data-messageid^="temp-"]');
        for (const tempEl of tempElements) {
            const tempContent = tempEl.querySelector('.message-content')?.textContent?.trim();
            const tempTime = tempEl.querySelector('.message-time')?.textContent;
            if (tempContent === message.content && tempTime) {
                // Actualizar el ID temporal al real
                tempEl.dataset.messageid = message.id;
                console.log('✅ Mensaje temporal actualizado con ID real:', message.id);
                // CORREGIDO: Scroll después de actualizar
                scrollToBottom();
                setTimeout(scrollToBottom, 100);
                return;
            }
        }
    }
    
    // CORREGIDO: Agregar a mensajes procesados
    if (message.id) {
        processedMessageIds.add(message.id);
        // Limpiar Set si crece demasiado
        if (processedMessageIds.size > 100) {
            const iterator = processedMessageIds.values();
            processedMessageIds.delete(iterator.next().value);
        }
    }
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    msgDiv.dataset.messageid = message.id;
    msgDiv.innerHTML = `
        <div class="message-header">
            <span class="icon icon-user"></span>
            <span>${escapeHtml(message.senderUsername)}</span>
        </div>
        <div class="message-content">${formatMessageContent(message)}</div>
        <div class="message-time">${formatDateTime(message.timestamp || new Date())}</div>
    `;
    
    // Remove empty state if exists
    const emptyState = elements.chatMessages.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    elements.chatMessages.appendChild(msgDiv);
    
    // CORREGIDO: Scroll automático con múltiples intentos
    requestAnimationFrame(() => {
        scrollToBottom();
        setTimeout(scrollToBottom, 50);
        setTimeout(scrollToBottom, 150);
        setTimeout(scrollToBottom, 300);
    });
}

function getMessageType(msg) {
    if (msg.type === 'system') return 'system';
    // CORREGIDO: Incluir depositor y withdrawer como roles de admin
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    if (adminRoles.includes(msg.senderRole)) return 'outgoing';
    return 'incoming';
}

// ============================================
// MESSAGING
// ============================================
async function sendMessage() {
    const content = elements.messageInput.value.trim();
    if (!content || !selectedUserId) return;

    // Issue #3: Si el admin escribe un comando (/...), enviar solo la respuesta del comando
    let messageToSend = content;
    if (content.startsWith('/')) {
        const cmdName = content.split(' ')[0];
        const cmd = availableCommands.find(c => c.name === cmdName);
        if (cmd && cmd.response) {
            messageToSend = cmd.response;
        } else if (cmd) {
            showToast('Este comando no tiene respuesta configurada', 'error');
            elements.messageInput.value = '';
            elements.messageInput.style.height = 'auto';
            hideCommandSuggestions();
            return;
        } else {
            showToast('Comando no encontrado', 'error');
            elements.messageInput.value = '';
            elements.messageInput.style.height = 'auto';
            hideCommandSuggestions();
            return;
        }
        hideCommandSuggestions();
    }
    
    // CORREGIDO: Verificar si ya existe un mensaje con el mismo contenido en los últimos 3 segundos
    const recentMessages = elements.chatMessages.querySelectorAll('.message');
    const now = Date.now();
    for (const msg of recentMessages) {
        const msgContent = msg.querySelector('.message-content')?.textContent?.trim();
        const msgTime = msg.querySelector('.message-time')?.textContent;
        if (msgContent === messageToSend && msgTime) {
            // Verificar si el mensaje fue enviado hace menos de 3 segundos
            const msgTimestamp = new Date(msgTime).getTime();
            if (now - msgTimestamp < 3000) {
                console.log('⚠️ Mensaje duplicado detectado (enviado hace menos de 3s), ignorando');
                elements.messageInput.value = '';
                elements.messageInput.style.height = 'auto';
                return;
            }
        }
    }
    
    // CORREGIDO: Verificar si ya se envió este contenido recientemente
    if (lastSentMessageContent === messageToSend && (now - lastSentMessageTime) < 5000) {
        console.log('⚠️ Mensaje duplicado detectado (mismo contenido reciente), ignorando');
        elements.messageInput.value = '';
        elements.messageInput.style.height = 'auto';
        return;
    }
    
    // Clear input immediately for better UX
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';
    
    // CORREGIDO: Guardar el contenido del mensaje enviado para evitar duplicados
    lastSentMessageContent = messageToSend;
    lastSentMessageTime = Date.now();
    
    // Optimistic UI - show message immediately
    const tempMessage = {
        id: 'temp-' + now,
        senderId: currentAdmin.userId,
        senderUsername: currentAdmin.username,
        senderRole: 'admin',
        content: messageToSend,
        timestamp: new Date(),
        type: 'text'
    };
    
    addMessageToChat(tempMessage, true);
    
    // CORREGIDO: Actualizar lista de conversaciones en tiempo real (optimistic)
    updateConversationInList({ ...tempMessage, receiverId: selectedUserId, senderId: currentAdmin.userId || currentAdmin.id, senderRole: 'admin' });
    scrollToBottom();
    setTimeout(scrollToBottom, 100);
    setTimeout(scrollToBottom, 300);
    
    // Send via socket (fastest)
    if (socket && socket.connected) {
        socket.emit('send_message', {
            content: messageToSend,
            receiverId: selectedUserId,
            type: 'text'
        });
        
        // CORREGIDO: Enviar notificación push al usuario
        sendPushNotification(selectedUserId, {
            type: 'text',
            content: messageToSend
        });
    } else {
        // Fallback to REST API
        try {
            const response = await fetch(`${API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({
                    content: messageToSend,
                    receiverId: selectedUserId,
                    type: 'text'
                })
            });
            
            if (!response.ok) throw new Error('Failed to send message');
            
            const data = await response.json();
            
            // Update temp message with real one
            const tempEl = document.querySelector(`[data-messageid="${tempMessage.id}"]`);
            if (tempEl) {
                tempEl.dataset.messageid = data.id;
            }
            
            // CORREGIDO: Scroll después de confirmar
            scrollToBottom();
            
            // CORREGIDO: Enviar notificación push al usuario
            sendPushNotification(selectedUserId, {
                type: 'text',
                content: messageToSend
            });
            
        } catch (error) {
            console.error('Error sending message:', error);
            showToast('Error al enviar mensaje', 'error');
        }
    }
    
    // Stop typing
    socket.emit('stop_typing', { receiverId: selectedUserId });
}

// Manejar selección de imagen o video
async function handleImageSelect(e) {
    const file = e.target.files[0];
    if (!file || !selectedUserId) return;
    
    // Validar tipo de archivo: imágenes y videos
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
        showToast('❌ Solo se permiten imágenes o videos', 'error');
        return;
    }
    
    // Límite de 100 MB para imágenes y videos
    if (file.size > 100 * 1024 * 1024) {
        showToast('❌ El archivo es demasiado grande (máx 100 MB)', 'error');
        return;
    }
    
    // Mostrar indicador de envío
    const sendingIndicator = document.getElementById('sendingIndicator');
    if (sendingIndicator) {
        sendingIndicator.classList.remove('hidden');
    }
    
    const fileType = isVideo ? 'video' : 'image';
    const fileLabel = isVideo ? '🎥 Video' : '📸 Imagen';

    try {
        // Convertir a base64
        const base64File = await fileToBase64(file);
        
        // Enviar vía socket
        if (socket && socket.connected) {
            socket.emit('send_message', {
                content: base64File,
                receiverId: selectedUserId,
                type: fileType
            });
            
            // Mostrar inmediatamente (optimistic UI)
            const tempMessage = {
                id: 'temp-' + fileType + '-' + Date.now(),
                senderId: currentAdmin.userId,
                senderUsername: currentAdmin.username,
                senderRole: 'admin',
                content: base64File,
                timestamp: new Date(),
                type: fileType
            };
            addMessageToChat(tempMessage, true);
            scrollToBottom();
            
            sendPushNotification(selectedUserId, {
                type: fileType,
                content: fileLabel
            });
            
            showToast(`✅ ${fileLabel} enviada`, 'success');
        } else {
            // Fallback a REST API
            const response = await fetch(`${API_URL}/api/messages/send`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({
                    content: base64File,
                    receiverId: selectedUserId,
                    type: fileType
                })
            });
            
            if (!response.ok) throw new Error('Failed to send file');
            
            showToast(`✅ ${fileLabel} enviada`, 'success');
            loadMessages(selectedUserId, true);
        }
    } catch (error) {
        console.error('Error sending file:', error);
        showToast('❌ Error al enviar archivo', 'error');
    } finally {
        // Ocultar indicador de envío
        if (sendingIndicator) {
            sendingIndicator.classList.add('hidden');
        }
        // Limpiar input
        e.target.value = '';
    }
}

// CORREGIDO: Convertir archivo a base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Pegar imagen con Ctrl+V desde portapapeles (escritorio)
async function handleAdminPaste(e) {
    if (!selectedUserId) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (!file) continue;

            if (file.size > 5 * 1024 * 1024) {
                showToast('❌ La imagen es demasiado grande (máx 5MB)', 'error');
                return;
            }

            const sendingIndicator = document.getElementById('sendingIndicator');
            if (sendingIndicator) sendingIndicator.classList.remove('hidden');

            try {
                const base64Image = await fileToBase64(file);

                if (socket && socket.connected) {
                    socket.emit('send_message', {
                        content: base64Image,
                        receiverId: selectedUserId,
                        type: 'image'
                    });

                    const tempMessage = {
                        id: 'temp-image-' + Date.now(),
                        senderId: currentAdmin.userId,
                        senderUsername: currentAdmin.username,
                        senderRole: 'admin',
                        content: base64Image,
                        timestamp: new Date(),
                        type: 'image'
                    };
                    addMessageToChat(tempMessage, true);
                    scrollToBottom();

                    sendPushNotification(selectedUserId, { type: 'image', content: '📸 Imagen' });
                    showToast('✅ Imagen enviada', 'success');
                } else {
                    const response = await fetch(`${API_URL}/api/messages/send`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${currentToken}`
                        },
                        body: JSON.stringify({ content: base64Image, receiverId: selectedUserId, type: 'image' })
                    });
                    if (!response.ok) throw new Error('Failed to send image');
                    showToast('✅ Imagen enviada', 'success');
                    loadMessages(selectedUserId, true);
                }
            } catch (error) {
                console.error('Error sending pasted image:', error);
                showToast('❌ Error al enviar imagen', 'error');
            } finally {
                if (sendingIndicator) sendingIndicator.classList.add('hidden');
            }
            break; // Solo procesar la primera imagen
        }
    }
}


function handleTyping() {
    if (!selectedUserId) return;
    
    socket.emit('typing', { receiverId: selectedUserId });
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('stop_typing', { receiverId: selectedUserId });
    }, 2000);
}

function showTypingIndicator() {
    elements.typingIndicator.classList.remove('hidden');
}

function hideTypingIndicator() {
    elements.typingIndicator.classList.add('hidden');
}

// COMANDOS: Mostrar sugerencias de comandos
function showCommandSuggestions(inputValue) {
    const searchTerm = inputValue.slice(1).toLowerCase();
    
    // Filtrar comandos que coincidan
    commandSuggestions = availableCommands.filter(cmd => 
        cmd.name.toLowerCase().includes(searchTerm) || 
        (cmd.description && cmd.description.toLowerCase().includes(searchTerm))
    );
    
    if (commandSuggestions.length === 0) {
        hideCommandSuggestions();
        return;
    }
    
    // Crear o actualizar el contenedor de sugerencias
    let suggestionsContainer = document.getElementById('commandSuggestions');
    if (!suggestionsContainer) {
        suggestionsContainer = document.createElement('div');
        suggestionsContainer.id = 'commandSuggestions';
        suggestionsContainer.className = 'command-suggestions';
        suggestionsContainer.style.cssText = `
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            background: white;
            border: 1px solid #ddd;
            border-radius: 8px 8px 0 0;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 -4px 12px rgba(0,0,0,0.15);
            z-index: 1000;
        `;
        elements.messageInput.parentElement.style.position = 'relative';
        elements.messageInput.parentElement.appendChild(suggestionsContainer);
    }
    
    // Renderizar sugerencias
    suggestionsContainer.innerHTML = commandSuggestions.map((cmd, index) => `
        <div class="command-suggestion-item ${index === selectedCommandIndex ? 'selected' : ''}" 
             data-index="${index}"
             style="padding: 10px 15px; cursor: pointer; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 10px;">
            <span style="font-weight: bold; color: #25d366;">${cmd.name}</span>
            <span style="color: #666; font-size: 0.85em;">${cmd.description || ''}</span>
        </div>
    `).join('');
    
    // Agregar event listeners a cada sugerencia
    suggestionsContainer.querySelectorAll('.command-suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
            const index = parseInt(item.dataset.index);
            insertCommand(commandSuggestions[index].name);
        });
        item.addEventListener('mouseenter', () => {
            selectedCommandIndex = parseInt(item.dataset.index);
            updateCommandSelection();
        });
    });
    
    suggestionsContainer.style.display = 'block';
}

// COMANDOS: Ocultar sugerencias
function hideCommandSuggestions() {
    const suggestionsContainer = document.getElementById('commandSuggestions');
    if (suggestionsContainer) {
        suggestionsContainer.style.display = 'none';
    }
    commandSuggestions = [];
    selectedCommandIndex = -1;
}

// COMANDOS: Actualizar selección visual
function updateCommandSelection() {
    const suggestionsContainer = document.getElementById('commandSuggestions');
    if (!suggestionsContainer) return;
    
    suggestionsContainer.querySelectorAll('.command-suggestion-item').forEach((item, index) => {
        if (index === selectedCommandIndex) {
            item.style.background = '#f0f0f0';
            item.classList.add('selected');
        } else {
            item.style.background = 'white';
            item.classList.remove('selected');
        }
    });
}

// COMANDOS: Insertar comando seleccionado
function insertCommand(commandName) {
    elements.messageInput.value = commandName + ' ';
    elements.messageInput.focus();
    hideCommandSuggestions();
}

// COMANDOS: Manejar teclas de navegación
function handleCommandKeydown(e) {
    if (commandSuggestions.length === 0) return;
    
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedCommandIndex = (selectedCommandIndex + 1) % commandSuggestions.length;
        updateCommandSelection();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedCommandIndex = (selectedCommandIndex - 1 + commandSuggestions.length) % commandSuggestions.length;
        updateCommandSelection();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
        if (selectedCommandIndex >= 0) {
            e.preventDefault();
            insertCommand(commandSuggestions[selectedCommandIndex].name);
        }
    } else if (e.key === 'Escape') {
        hideCommandSuggestions();
    }
}

async function markMessagesAsRead(userId) {
    try {
        await fetch(`${API_URL}/api/messages/read/${userId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        // Actualizar conteo local de no leídos inmediatamente (optimistic update)
        const convIndex = conversations.findIndex(c => c.userId === userId);
        if (convIndex !== -1) {
            conversations[convIndex].unread = 0;
            conversationsCacheByTab.set(currentTab, { data: [...conversations], timestamp: Date.now() });
            renderConversations();
        }

        // Update unread count
        loadStats();
    } catch (error) {
        console.error('Error marking messages as read:', error);
    }
}

// ============================================
// USER ACTIONS
// ============================================
async function loadUserInfo(userId) {
    try {
        const response = await fetch(`${API_URL}/api/users/${userId}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load user info');
        
        const data = await response.json();
        const user = data.user;
        
        // RACE CONDITION FIX: Ignorar respuesta si ya no es el chat activo
        if (userId !== activeConversationId) {
            console.log('⚠️ Respuesta de userInfo de chat antiguo ignorada:', userId);
            return;
        }
        
        elements.chatBalance.textContent = formatMoney(user.balance);
        elements.chatStatus.textContent = user.online ? 'En línea' : 'Desconectado';
        elements.chatStatus.className = user.online ? 'status online' : 'status';
        
        // Mostrar estado de la app de notificaciones
        if (elements.chatAppStatus) {
            if (user.fcmToken) {
                elements.chatAppStatus.textContent = '📱 app instalada';
                elements.chatAppStatus.style.color = '#00ff88';
            } else {
                elements.chatAppStatus.textContent = '📵 app borrada';
                elements.chatAppStatus.style.color = '#aaa';
            }
        }
    } catch (error) {
        console.error('Error loading user info:', error);
    }
}

async function sendCBU() {
    if (!selectedUserId) return;
    
    const btnCBU = elements.btnCBU;
    setButtonLoading(btnCBU, true, 'Enviando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-cbu`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: selectedUserId })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar CBU');
        }
        
        showToast('CBU enviado correctamente', 'success');
        
        // Reload messages to show the CBU message
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error sending CBU:', error);
        showToast(error.message || 'Error al enviar CBU', 'error');
    } finally {
        setButtonLoading(btnCBU, false, '<span class="icon icon-credit-card"></span> Enviar CBU');
    }
}

async function handleDeposit() {
    const amount = parseFloat(document.getElementById('depositAmount').value);
    const bonus = parseFloat(document.getElementById('depositBonus').value) || 0;
    const description = document.getElementById('depositDesc').value;
    const confirmBtn = document.getElementById('confirmDeposit');
    
    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Procesando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/deposit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                bonus,
                description
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Error al realizar depósito');
        }
        
        showToast(`Depósito de ${formatMoney(amount + bonus)} realizado`, 'success');
        hideModal('depositModal');
        
        // Reset deposit form
        document.getElementById('depositAmount').value = '';
        document.getElementById('depositBonus').value = '';
        document.getElementById('depositDesc').value = '';
        document.querySelectorAll('.bonus-options button').forEach(b => b.classList.remove('active'));
        const noBonusBtn = document.querySelector('.bonus-options button[data-bonus="0"]');
        if (noBonusBtn) noBonusBtn.classList.add('active');
        
        // Update balance display
        loadUserInfo(selectedUserId);
        
        // Reload messages to show deposit notification
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error depositing:', error);
        showToast(error.message || 'Error al realizar depósito', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Depósito');
    }
}

async function handleWithdraw() {
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    const description = document.getElementById('withdrawDesc').value;
    const confirmBtn = document.getElementById('confirmWithdraw');
    
    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Procesando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/withdrawal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                description
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || data.message || 'Error al realizar retiro');
        }
        
        showToast(`Retiro de ${formatMoney(amount)} realizado`, 'success');
        hideModal('withdrawModal');
        
        // Reset withdrawal form
        document.getElementById('withdrawAmount').value = '';
        document.getElementById('withdrawDesc').value = '';
        
        // Update balance display
        loadUserInfo(selectedUserId);
        
        // Reload messages to show withdrawal notification
        loadMessages(selectedUserId);
        
    } catch (error) {
        console.error('Error withdrawing:', error);
        showToast(error.message || 'Error al realizar retiro', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Retiro');
    }
}

async function handleDirectBonus() {
    const amount = parseFloat(document.getElementById('bonusAmount').value);
    const description = document.getElementById('bonusDesc').value;
    const confirmBtn = document.getElementById('confirmBonus');

    if (!amount || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }

    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }

    setButtonLoading(confirmBtn, true, 'Procesando...');

    try {
        const response = await fetch(`${API_URL}/api/admin/bonus`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                amount,
                description
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Error al aplicar bonus');
        }

        showToast(`Bonus de ${formatMoney(amount)} aplicado`, 'success');
        hideModal('bonusModal');
        document.getElementById('bonusAmount').value = '';
        document.getElementById('bonusDesc').value = '';

        loadUserInfo(selectedUserId);
        loadMessages(selectedUserId);

    } catch (error) {
        console.error('Error applying bonus:', error);
        showToast(error.message || 'Error al aplicar bonus', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Confirmar Bonus');
    }
}

async function handlePasswordChange() {
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const confirmBtn = document.getElementById('confirmPassword');
    
    if (!newPassword || newPassword.length < 6) {
        showToast('La contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showToast('Las contraseñas no coinciden', 'error');
        return;
    }
    
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    // Verificar permisos según rol
    const adminRole = currentAdmin?.role;
    const targetUser = conversations.find(c => c.userId === selectedUserId);
    const targetUserRole = targetUser?.role || 'user';
    
    // Admin general puede cambiar contraseña de TODOS incluyendo admins
    // Admin depositer puede cambiar contraseña de usuarios pero NO de admins
    // Admin withdrawer NO puede cambiar contraseñas
    if (adminRole === 'withdrawer') {
        showToast('No tienes permiso para cambiar contraseñas', 'error');
        return;
    }
    
    if (adminRole === 'depositor' && targetUserRole !== 'user') {
        showToast('Solo puedes cambiar contraseñas de usuarios, no de administradores', 'error');
        return;
    }
    
    // Loading state
    setButtonLoading(confirmBtn, true, 'Cambiando...');
    
    try {
        const response = await fetch(`${API_URL}/api/admin/change-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: selectedUserId,
                newPassword
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Error al cambiar contraseña');
        }
        
        showToast('Contraseña cambiada correctamente', 'success');
        hideModal('passwordModal');
        
        // Clear inputs
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';
        
    } catch (error) {
        console.error('Error changing password:', error);
        showToast(error.message || 'Error al cambiar contraseña', 'error');
    } finally {
        setButtonLoading(confirmBtn, false, 'Cambiar Contraseña');
    }
}

async function sendToPayments() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnPayments = elements.btnPayments;
    setButtonLoading(btnPayments, true, 'Enviando...');
    
    // Optimistic UI - clear chat panel immediately
    const userIdToRemove = selectedUserId;
    selectedUserId = null;
    activeConversationId = null; // RACE CONDITION FIX
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Chat enviado a pagos...</p>
        </div>
    `;
    
    // Remove from conversations list immediately
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToRemove}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
        convItem.style.pointerEvents = 'none';
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-to-payments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: userIdToRemove })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar a pagos');
        }
        
        showToast('Chat enviado a pagos correctamente', 'success');
        
        // Remove from list immediately
        if (convItem) {
            convItem.remove();
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        conversationsCacheByTab.delete('payments');
        loadConversations();
        
    } catch (error) {
        console.error('Error sending to payments:', error);
        showToast(error.message || 'Error al enviar a cargas', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
            convItem.style.pointerEvents = 'auto';
        }
    } finally {
        setButtonLoading(btnPayments, false, '<span class="icon icon-exchange"></span> Enviar a Pagos');
    }
}

// Enviar a Abiertos (nueva función para cuando está en Pagos)
async function sendToOpen() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnPayments = elements.btnPayments;
    setButtonLoading(btnPayments, true, 'Enviando...');
    
    // Optimistic UI - clear chat panel immediately
    const userIdToRemove = selectedUserId;
    selectedUserId = null;
    activeConversationId = null; // RACE CONDITION FIX
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Chat enviado a abiertos...</p>
        </div>
    `;
    
    // Remove from conversations list immediately
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToRemove}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
        convItem.style.pointerEvents = 'none';
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/send-to-open`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ userId: userIdToRemove })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al enviar a abiertos');
        }
        
        showToast('Chat enviado a abiertos correctamente', 'success');
        
        // Remove from list immediately
        if (convItem) {
            convItem.remove();
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        conversationsCacheByTab.delete('payments');
        loadConversations();
        
    } catch (error) {
        console.error('Error sending to open:', error);
        showToast(error.message || 'Error al enviar a abiertos', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
            convItem.style.pointerEvents = 'auto';
        }
    } finally {
        setButtonLoading(btnPayments, false, '<span class="icon icon-exchange"></span> Enviar a Abiertos');
    }
}

// Función para deseleccionar el chat (sin cerrarlo)
function deselectChat() {
    if (!selectedUserId) return;
    
    // RACE CONDITION FIX: Cancelar fetch en curso y limpiar id activo
    if (activeFetchController) {
        activeFetchController.abort();
        activeFetchController = null;
    }
    activeConversationId = null;

    // Salir de la sala de chat
    if (socket) {
        socket.emit('leave_chat_room', { userId: selectedUserId });
    }
    
    // Limpiar selección visual
    document.querySelectorAll('.conversation-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Ocultar panel de chat
    selectedUserId = null;
    selectedUsername = null;
    elements.chatHeader.classList.add('hidden');
    elements.chatInputArea.classList.add('hidden');
    if (elements.chatAppStatus) {
        elements.chatAppStatus.textContent = '';
    }
    elements.chatMessages.innerHTML = `
        <div class="empty-state">
            <span class="icon icon-comment-dots"></span>
            <p>Selecciona una conversación para ver los mensajes</p>
        </div>
    `;
    
    console.log('👋 Chat deseleccionado');
}

async function closeChat() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    const btnClose = elements.btnClose;
    setButtonLoading(btnClose, true, 'Cerrando...');
    
    // Optimistic UI - update immediately
    const userIdToClose = selectedUserId;
    
    // Move conversation to closed tab visually
    const convItem = document.querySelector(`.conversation-item[data-userid="${userIdToClose}"]`);
    if (convItem) {
        convItem.style.opacity = '0.5';
    }
    
    // COMPORTAMIENTO DIFERENTE SEGÚN LA PESTAÑA:
    // - En "Abiertos": Mantener chat abierto para seguir respondiendo
    // - En "Pagos": Cerrar el chat completamente
    const isPaymentsTab = currentTab === 'payments';
    
    if (isPaymentsTab) {
        // En pagos: cerrar completamente
        selectedUserId = null;
        elements.chatHeader.classList.add('hidden');
        elements.chatInputArea.classList.add('hidden');
        elements.chatMessages.innerHTML = `
            <div class="empty-state">
                <span class="icon icon-comment-dots"></span>
                <p>Chat cerrado. Selecciona otra conversación.</p>
            </div>
        `;
    }
    // Fix #3: No insertar mensaje de cierre en el DOM manualmente; el backend lo guarda
    // en la DB como adminOnly y se muestra al recargar mensajes.
    
    try {
        const response = await fetch(`${API_URL}/api/admin/close-chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ 
                userId: userIdToClose,
                notifyClient: false, // No notificar al cliente, solo interno
                isPaymentsTab: isPaymentsTab
            })
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Error al cerrar chat');
        }
        
        showToast('Chat cerrado correctamente', 'success');
        
        // If on open tab, remove from list
        if (currentTab === 'open' && convItem) {
            convItem.remove();
        }
        
        // Fix #3: Recargar mensajes para mostrar el mensaje de cierre guardado en DB
        if (!isPaymentsTab && selectedUserId === userIdToClose) {
            messageCache.delete(userIdToClose);
            loadMessages(userIdToClose);
        }
        
        // Invalidar cache y recargar en background
        conversationsCacheByTab.delete('open');
        conversationsCacheByTab.delete('closed');
        loadConversations();
        
    } catch (error) {
        console.error('Error closing chat:', error);
        showToast(error.message || 'Error al cerrar chat', 'error');
        // Restore UI on error
        if (convItem) {
            convItem.style.opacity = '1';
        }
    } finally {
        setButtonLoading(btnClose, false, '<span class="icon icon-lock"></span> Cerrar Chat');
    }
}

// ============================================
// DATOS (métricas de adquisición, actividad y recurrencia)
// ============================================
let datosPeriod = 'today';

function setDatosPeriod(period) {
    datosPeriod = period;
    // Limpiar fecha exacta
    const fechaInput = document.getElementById('datosFecha');
    if (fechaInput) fechaInput.value = '';
    // Resaltar botón activo
    document.querySelectorAll('.datos-period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });
    loadDatos();
}

function setDatosDate(date) {
    if (!date) return;
    datosPeriod = null;
    document.querySelectorAll('.datos-period-btn').forEach(btn => btn.classList.remove('active'));
    loadDatos();
}

async function loadDatos() {
    try {
        const fechaInput = document.getElementById('datosFecha');
        const fecha = fechaInput ? fechaInput.value : '';
        const url = fecha
            ? `${API_URL}/api/admin/datos?date=${encodeURIComponent(fecha)}`
            : `${API_URL}/api/admin/datos?period=${datosPeriod || 'today'}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!response.ok) throw new Error('Failed to load datos');
        const json = await response.json();
        const d = json.data || {};

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null) ? val : '—';
        };
        const setAmt = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null)
                ? '$\u202F' + Number(val).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                : '—';
        };
        const setPct = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null) ? val + '%' : '—';
        };

        // Período activo
        const periodLabel = document.getElementById('datosPeriodLabel');
        if (periodLabel && d.period) periodLabel.textContent = '— ' + d.period.label;

        const a = d.acquisition      || {};
        const b = d.depositActivity  || {};
        const c = d.economicQuality  || {};
        const r = d.recurrence       || {};

        // Bloque A — Adquisición
        set('datosRegisteredUsers',  a.registeredUsers);
        set('datosFirstDepositUsers', a.firstDepositUsers);
        setPct('datosConversionRate', a.conversionRate);
        set('datosNeverDeposited',   a.registeredNeverDeposited);

        // Bloque B — Actividad de depósitos
        set('datosTotalDeposits',          b.totalDeposits);
        set('datosUniqueDepositors',       b.uniqueDepositors);
        set('datosFirstTimeDeposits',      b.firstTimeDeposits);
        set('datosFirstTimeDepositUsers',  b.firstTimeDepositUsers);
        set('datosReturningDeposits',      b.returningDeposits);
        set('datosReturningUsers',         b.returningDepositUsers);
        set('datosFrequency',              b.depositFrequency);

        // Bloque C — Calidad económica
        setAmt('datosTotalAmount',       c.totalAmount);
        setAmt('datosAvgTicket',         c.avgTicket);
        setAmt('datosAvgPerDepositor',   c.avgPerDepositor);
        setAmt('datosFirstTimeAmount',   c.firstTimeAmount);
        setAmt('datosReturningAmount',   c.returningAmount);

        // Bloque D — Recurrencia
        set('datosActiveReturning',  r.activeReturningUsers);
        setPct('datosReturningPct',  r.returningPct);
        set('datosMultipleUsers',    r.multipleDepositUsers);
        setPct('datosRepeatRate',    r.repeatRate);

    } catch (error) {
        console.error('Error loading datos:', error);
    }
}

// ============================================
// STATS
// ============================================
async function loadStats() {
    try {
        const response = await fetch(`${API_URL}/api/admin/stats`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load stats');
        
        const json = await response.json();
        // CORREGIDO: extraer data.data si existe (respuesta envuelta)
        const data = json.data || json;
        updateStats(data);
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

function updateStats(data) {
    elements.statUsers.textContent = data.totalUsers || 0;
    // CORREGIDO: usar connectedUsers (socket) o onlineUsers (HTTP)
    elements.statOnline.textContent = data.connectedUsers !== undefined ? data.connectedUsers : (data.onlineUsers || 0);
    elements.statMessages.textContent = data.totalMessages || 0;
    elements.statUnread.textContent = data.unreadMessages || 0;
    
    // Update badge
    if (data.unreadMessages > 0) {
        elements.unreadBadge.textContent = data.unreadMessages;
        elements.unreadBadge.classList.remove('hidden');
    } else {
        elements.unreadBadge.classList.add('hidden');
    }
}

function incrementUnreadCount() {
    const current = parseInt(elements.statUnread.textContent) || 0;
    elements.statUnread.textContent = current + 1;
    elements.unreadBadge.textContent = current + 1;
    elements.unreadBadge.classList.remove('hidden');
}

// ============================================
// USERS SECTION
// ============================================
async function loadUsers() {
    try {
        const response = await fetch(`${API_URL}/api/admin/users`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load users');
        
        const data = await response.json();
        renderUsers(data.users || []);
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

// Exportar todos los usuarios a CSV (solo admin general)
async function exportUsersCSV() {
    if (currentAdmin?.role !== 'admin') {
        showToast('No tienes permiso para exportar usuarios', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/users/export/csv`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to export users');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `usuarios_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Usuarios exportados correctamente', 'success');
    } catch (error) {
        console.error('Error exporting users:', error);
        showToast('Error al exportar usuarios', 'error');
    }
}

function renderUsers(users) {
    const tbody = document.getElementById('usersTableBody');
    
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No hay usuarios</td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map(user => `
        <tr class="${user.role !== 'user' ? 'admin-row' : ''}">
            <td>${escapeHtml(user.username)}</td>
            <td>${user.accountId || '-'}</td>
            <td>${user.email || '-'}</td>
            <td>${user.phone || '-'}</td>
            <td><span class="role-badge ${user.role}">${getRoleLabel(user.role)}</span></td>
            <td>${formatMoney(user.balance)}</td>
            <td><span class="status-badge ${user.status}">${user.status}</span></td>
            <td>${formatDate(user.lastLogin)}</td>
            <td>
                <button class="action-btn-small" onclick="viewUser('${user.id}')">
                    <span class="icon icon-eye"></span>
                </button>
                <button class="action-btn-small" onclick="chatUser('${user.id}')">
                    <span class="icon icon-comment"></span>
                </button>
            </td>
        </tr>
    `).join('');
}

// ============================================
// UI HELPERS
// ============================================
function switchSection(section) {
    // CORREGIDO: Solo admin general puede acceder a "Usuarios"
    if (section === 'users' && currentAdmin?.role !== 'admin') {
        showToast('No tienes permiso para acceder a esta sección', 'error');
        return;
    }
    
    // Update nav
    elements.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.section === section);
    });
    
    // Update sections
    elements.sections.forEach(sec => {
        sec.classList.toggle('active', sec.id === `${section}Section`);
    });
    
    // Load section data
    if (section === 'users') loadUsers();
    if (section === 'transactions') loadTransactions();
    if (section === 'commands') loadCommands();
    if (section === 'datos') loadDatos();
    if (section === 'notifications') loadNotificationsPanel();
    if (section === 'database') {
        if (!dbAccessGranted) {
            showDatabasePasswordModal();
        } else {
            loadDatabaseUsers();
        }
    }
}

function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }
}

function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function calculateBonus() {
    const amount = parseFloat(document.getElementById('depositAmount').value) || 0;
    const activeBonus = document.querySelector('.bonus-options button.active');
    const bonusPercent = activeBonus ? parseFloat(activeBonus.dataset.bonus) : 0;
    
    const bonusAmount = Math.floor(amount * (bonusPercent / 100));
    document.getElementById('depositBonus').value = bonusAmount;
}

function scrollToBottom() {
    // CORREGIDO: Scroll suave al final del contenedor
    if (elements.chatMessages) {
        elements.chatMessages.scrollTo({
            top: elements.chatMessages.scrollHeight,
            behavior: 'smooth'
        });
        // Asegurar que llegue al final
        elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    }
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconClass = type === 'success' ? 'icon-check' : type === 'error' ? 'icon-times-circle' : type === 'warning' ? 'icon-exclamation' : 'icon-info';
    toast.innerHTML = `
        <span class="icon ${iconClass}"></span>
        <span>${message}</span>
    `;
    
    elements.toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function playNotificationSound() {
    // Sonido de notificación para nuevos mensajes
    try {
        // Crear un beep simple usando Web Audio API
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
        console.log('No se pudo reproducir sonido:', e);
    }
}

function updateUserStatus(userId, online) {
    if (userId === selectedUserId) {
        elements.chatStatus.textContent = online ? 'En línea' : 'Desconectado';
        elements.chatStatus.className = online ? 'status online' : 'status';
    }
}

// ============================================
// UTILITIES
// ============================================
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatMoney(amount) {
    if (amount === undefined || amount === null) return '$0';
    return '$' + parseFloat(amount).toLocaleString('es-AR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
}

function formatDate(date) {
    if (!date) return 'Nunca';
    const d = new Date(date);
    return d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function formatTime(date) {
    if (!date) return '';
    const d = new Date(date);
    const now = new Date();
    const diff = now - d;
    
    if (diff < 60000) return 'Ahora';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
}

function formatDateTime(date) {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ============================================
// WITHDRAW TOTAL UPDATE
// ============================================
function updateWithdrawTotal() {
    const amount = parseInt(document.getElementById('withdrawAmount').value) || 0;
    const totalDisplay = document.getElementById('withdrawTotal');
    if (totalDisplay) {
        totalDisplay.textContent = formatMoney(amount);
    }
}

// Seleccionar todo el saldo del usuario
async function selectAllBalance() {
    if (!selectedUserId) {
        showToast('Selecciona un usuario primero', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/balance/${selectedUsername}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            const balance = data.balance || 0;
            document.getElementById('withdrawAmount').value = balance;
            updateWithdrawTotal();
            showToast(`Saldo seleccionado: ${formatMoney(balance)}`, 'success');
        } else {
            showToast('No se pudo obtener el saldo del usuario', 'error');
        }
    } catch (error) {
        console.error('Error obteniendo saldo:', error);
        showToast('Error al obtener el saldo', 'error');
    }
}

// ============================================
// BUTTON LOADING STATE
// ============================================
function setButtonLoading(button, isLoading, loadingText = 'Cargando...') {
    if (!button) return;
    
    if (isLoading) {
        button.dataset.originalText = button.innerHTML;
        button.innerHTML = `<span class="icon icon-sync" style="animation: spin 1s linear infinite;"></span> ${loadingText}`;
        button.disabled = true;
        button.style.opacity = '0.7';
        button.style.cursor = 'not-allowed';
    } else {
        button.innerHTML = button.dataset.originalText || loadingText;
        button.disabled = false;
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
    }
}

// ============================================
// TRANSACTIONS DASHBOARD
// ============================================
let transactionsData = [];
let transactionsFilter = 'all';
let transactionDateFrom = '';
let transactionDateTo = '';
let transactionUsernameFilter = '';

async function loadTransactions() {
    try {
        let url = `${API_URL}/api/admin/transactions`;
        const params = [];
        
        if (transactionDateFrom) {
            params.push(`from=${transactionDateFrom}`);
        }
        if (transactionDateTo) {
            params.push(`to=${transactionDateTo}`);
        }
        if (transactionUsernameFilter) {
            params.push(`username=${encodeURIComponent(transactionUsernameFilter)}`);
        }
        
        if (params.length > 0) {
            url += '?' + params.join('&');
        }
        
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load transactions');
        
        const data = await response.json();
        transactionsData = data.transactions || [];
        renderTransactions(transactionsData);
        renderTransactionStats(data.summary || {});
    } catch (error) {
        console.error('Error loading transactions:', error);
    }
}

function renderTransactionStats(summary) {
    const statsContainer = document.getElementById('transactionStats');
    if (statsContainer) {
        const netBalance = (summary.deposits || 0) - (summary.withdrawals || 0);
        const netBalanceClass = netBalance >= 0 ? '' : 'negative';
        
        statsContainer.innerHTML = `
            <div class="stat-card deposit">
                <span class="icon icon-plus-circle"></span>
                <span class="stat-number">${formatMoney(summary.deposits || 0)}</span>
                <span class="stat-label">Depósitos</span>
            </div>
            <div class="stat-card withdrawal">
                <span class="icon icon-minus-circle"></span>
                <span class="stat-number">${formatMoney(summary.withdrawals || 0)}</span>
                <span class="stat-label">Retiros</span>
            </div>
            <div class="stat-card bonus">
                <span class="icon icon-gift"></span>
                <span class="stat-number">${formatMoney(summary.bonuses || 0)}</span>
                <span class="stat-label">Bonificaciones</span>
            </div>
            <div class="stat-card refund">
                <span class="icon icon-undo"></span>
                <span class="stat-number">${formatMoney(summary.refunds || 0)}</span>
                <span class="stat-label">Reembolsos</span>
            </div>
            <div class="stat-card net-balance ${netBalanceClass}">
                <span class="icon icon-balance"></span>
                <span class="stat-number">${formatMoney(netBalance)}</span>
                <span class="stat-label">Saldo Neto</span>
            </div>
            <div class="stat-card total">
                <span class="icon icon-list"></span>
                <span class="stat-number">${summary.totalTransactions || 0}</span>
                <span class="stat-label">Total Transacciones</span>
            </div>
        `;
    }
    
    // CORREGIDO: Actualizar comisión con el total de depósitos y retiros
    window.currentDepositsTotal = summary.deposits || 0;
    window.currentWithdrawalsTotal = summary.withdrawals || 0;
    updateCommissionDisplay();
}

// CORREGIDO: Función para actualizar la visualización de comisión
// Issue #5: La comisión total se resta al saldo neto para reflejar el valor real
function updateCommissionDisplay() {
    const commissionRateInput = document.getElementById('commissionRate');
    const commissionAmountEl = document.getElementById('commissionAmount');
    const commissionBaseEl = document.getElementById('commissionBaseAmount');
    const netAfterCommissionEl = document.getElementById('netAfterCommission');
    
    if (!commissionRateInput || !commissionAmountEl) return;
    
    const rate = parseFloat(commissionRateInput.value) || 0;
    const baseAmount = window.currentDepositsTotal || 0;
    const withdrawals = window.currentWithdrawalsTotal || 0;
    const commissionAmount = baseAmount * (rate / 100);
    // Saldo neto = (depósitos - retiros) - comisión
    const netBeforeCommission = baseAmount - withdrawals;
    const netAfterCommission = netBeforeCommission - commissionAmount;
    
    commissionAmountEl.textContent = formatMoney(commissionAmount);
    if (commissionBaseEl) commissionBaseEl.textContent = formatMoney(baseAmount);
    if (netAfterCommissionEl) netAfterCommissionEl.textContent = formatMoney(netAfterCommission);

    // Issue #5: Actualizar también la tarjeta "Saldo Neto" en el dashboard
    const netBalanceEl = document.querySelector('.stat-card.net-balance .stat-number');
    if (netBalanceEl) {
        netBalanceEl.textContent = formatMoney(netAfterCommission);
        const netBalanceCard = netBalanceEl.closest('.stat-card');
        if (netBalanceCard) {
            netBalanceCard.classList.toggle('negative', netAfterCommission < 0);
        }
    }
}

function applyTransactionDateFilter() {
    transactionDateFrom = document.getElementById('dateFrom').value;
    transactionDateTo = document.getElementById('dateTo').value;
    loadTransactions();
}

function clearTransactionDateFilter() {
    transactionDateFrom = '';
    transactionDateTo = '';
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';
    loadTransactions();
}

function applyTxUserFilter() {
    const input = document.getElementById('txUserFilter');
    transactionUsernameFilter = input ? input.value.trim() : '';
    loadTransactions();
}

function clearTxUserFilter() {
    transactionUsernameFilter = '';
    const input = document.getElementById('txUserFilter');
    if (input) input.value = '';
    loadTransactions();
}

// Devuelve la fecha actual en Argentina (UTC-3, sin DST) como "YYYY-MM-DD"
function getArgentinaDateStr(date) {
    // Argentina es UTC-3 todo el año (no usa horario de verano desde 2009)
    const offset = -3 * 60; // -180 minutos
    const local = new Date(date.getTime() + offset * 60 * 1000);
    return local.toISOString().split('T')[0];
}

function setTodayFilter() {
    const today = getArgentinaDateStr(new Date());
    document.getElementById('dateFrom').value = today;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function setYesterdayFilter() {
    const yesterday = getArgentinaDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
    document.getElementById('dateFrom').value = yesterday;
    document.getElementById('dateTo').value = yesterday;
    applyTransactionDateFilter();
}

function setWeekFilter() {
    const today = getArgentinaDateStr(new Date());
    const weekAgo = getArgentinaDateStr(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    document.getElementById('dateFrom').value = weekAgo;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function setMonthFilter() {
    const now = new Date();
    const today = getArgentinaDateStr(now);
    const monthAgo = getArgentinaDateStr(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()));
    document.getElementById('dateFrom').value = monthAgo;
    document.getElementById('dateTo').value = today;
    applyTransactionDateFilter();
}

function renderTransactions(transactions) {
    const tbody = document.getElementById('transactionsTableBody');
    
    // Filtrar transacciones
    let filtered = transactions;
    if (transactionsFilter !== 'all') {
        filtered = transactions.filter(t => t.type === transactionsFilter);
    }
    
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No hay transacciones</td></tr>';
        return;
    }
    
    tbody.innerHTML = filtered.map(t => `
        <tr>
            <td>${formatDateTime(t.timestamp || t.createdAt)}</td>
            <td>${escapeHtml(t.username)}</td>
            <td><span class="type-badge ${t.type}">${getTransactionTypeLabel(t.type)}</span></td>
            <td>${formatMoney(t.amount)}</td>
            <td>${escapeHtml(t.description || '-')}</td>
            <td>${t.adminUsername || '-'}</td>
        </tr>
    `).join('');
}

function getTransactionTypeLabel(type) {
    const labels = {
        deposit: 'Depósito',
        withdrawal: 'Retiro',
        bonus: 'Bonificación',
        refund: 'Reembolso'
    };
    return labels[type] || type;
}

function filterTransactions(type) {
    transactionsFilter = type;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === type);
    });
    renderTransactions(transactionsData);
}

// ============================================
// DATABASE SECTION
// ============================================
let dbAccessGranted = false;
let dbStoredPassword = ''; // Issue #2: Almacenar contraseña para reuso sin requerir re-entrada

function showDatabasePasswordModal() {
    showModal('databasePasswordModal');
}

async function verifyDatabaseAccess() {
    const password = document.getElementById('dbPassword').value;
    
    if (!password) {
        showToast('Ingresa la contraseña', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/database/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (response.ok) {
            dbAccessGranted = true;
            dbStoredPassword = password; // Issue #2: guardar para reuso
            hideModal('databasePasswordModal');
            document.getElementById('databasePasswordInput').classList.add('hidden');
            document.getElementById('databaseContent').classList.remove('hidden');
            loadDatabaseUsers();
            showToast('Acceso concedido', 'success');
        } else {
            showToast('Contraseña incorrecta', 'error');
        }
    } catch (error) {
        console.error('Error verifying database access:', error);
        showToast('Error al verificar acceso', 'error');
    }
}

async function loadDatabaseUsers() {
    if (!dbAccessGranted) return;
    
    try {
        // Issue #2: Usar contraseña almacenada para evitar pérdida del valor del campo
        const password = dbStoredPassword || document.getElementById('dbPassword').value;
        if (!password) {
            console.warn('[DB] Contraseña no disponible, se requiere re-verificación');
            dbAccessGranted = false;
            switchSection('database');
            return;
        }
        const response = await fetch(`${API_URL}/api/admin/database/users?dbPassword=${encodeURIComponent(password)}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load database users');
        
        const data = await response.json();
        renderDatabaseUsers(data.users || []);
    } catch (error) {
        console.error('Error loading database users:', error);
    }
}

function renderDatabaseUsers(users) {
    const tbody = document.getElementById('databaseTableBody');
    
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No hay usuarios en la base de datos</td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map(user => `
        <tr class="${user.role !== 'user' ? 'admin-row' : ''}">
            <td>${escapeHtml(user.username)}</td>
            <td>${user.email || '-'}</td>
            <td>${user.phone || '-'}</td>
            <td><span class="role-badge ${user.role}">${getRoleLabel(user.role)}</span></td>
            <td>${formatMoney(user.balance)}</td>
            <td>${user.isActive ? 'Activo' : 'Inactivo'}</td>
            <td>${formatDate(user.lastLogin)}</td>
            <td>${formatDate(user.createdAt)}</td>
        </tr>
    `).join('');
    
    // Update count
    document.getElementById('dbTotalUsers').textContent = users.length;
    document.getElementById('dbTotalAdmins').textContent = users.filter(u => u.role !== 'user').length;
}

function getRoleLabel(role) {
    const labels = {
        user: 'Usuario',
        admin: 'Admin General',
        depositor: 'Admin Depositor',
        withdrawer: 'Admin Withdrawer'
    };
    return labels[role] || role;
}

async function exportDatabaseCSV() {
    if (!dbAccessGranted) return;
    
    try {
        // Issue #2: Usar contraseña almacenada para exportar todos los usuarios
        const password = dbStoredPassword || document.getElementById('dbPassword').value;
        if (!password) {
            console.warn('[DB] Contraseña no disponible para exportar, se requiere re-verificación');
            dbAccessGranted = false;
            switchSection('database');
            return;
        }
        const response = await fetch(`${API_URL}/api/admin/database/export/csv?dbPassword=${encodeURIComponent(password)}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to export database');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `base_de_datos_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        showToast('Base de datos exportada correctamente', 'success');
    } catch (error) {
        console.error('Error exporting database:', error);
        showToast('Error al exportar base de datos', 'error');
    }
}

async function verifyDatabaseAccessFromModal() {
    const password = document.getElementById('dbPasswordInput').value;
    document.getElementById('dbPassword').value = password;
    
    try {
        const response = await fetch(`${API_URL}/api/admin/database/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ dbPassword: password })
        });
        
        if (response.ok) {
            dbAccessGranted = true;
            dbStoredPassword = password; // Issue #2: guardar para reuso
            hideModal('databasePasswordModal');
            document.getElementById('databasePasswordInput').classList.add('hidden');
            document.getElementById('databaseContent').classList.remove('hidden');
            loadDatabaseUsers();
            showToast('Acceso concedido', 'success');
        } else {
            showToast('Contraseña incorrecta', 'error');
        }
    } catch (error) {
        console.error('Error verifying database access:', error);
        showToast('Error al verificar acceso', 'error');
    }
}

// ============================================
// CREATE USER / ADMIN
// ============================================
function showCreateUserModal() {
    showModal('createUserModal');
}

async function handleCreateUser() {
    const username = document.getElementById('newUserUsername').value.trim();
    const password = document.getElementById('newUserPassword').value;
    const email = document.getElementById('newUserEmail').value.trim();
    const phone = document.getElementById('newUserPhone').value.trim();
    const role = document.getElementById('newUserRole').value;
    
    if (!username || !password) {
        showToast('Usuario y contraseña son requeridos', 'error');
        return;
    }
    
    if (password.length < 6) {
        showToast('La contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/users`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ username, password, email, phone, role })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast(data.message, 'success');
            hideModal('createUserModal');
            loadUsers();
            // Limpiar formulario
            document.getElementById('newUserUsername').value = '';
            document.getElementById('newUserPassword').value = '';
            document.getElementById('newUserEmail').value = '';
            document.getElementById('newUserPhone').value = '';
            document.getElementById('newUserRole').value = 'user';
        } else {
            showToast(data.error || 'Error al crear usuario', 'error');
        }
    } catch (error) {
        console.error('Error creating user:', error);
        showToast('Error al crear usuario', 'error');
    }
}

// ============================================
// COMMANDS MANAGEMENT
// ============================================
let commandsData = [];

async function loadCommands() {
    try {
        const response = await fetch(`${API_URL}/api/admin/commands`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load commands');
        
        const data = await response.json();
        commandsData = data.commands || [];
        // CORREGIDO: Actualizar availableCommands para las sugerencias
        availableCommands = commandsData.filter(cmd => cmd.isActive !== false);
        renderCommands(commandsData);
        
        // Cargar CBU
        loadCBUConfig();
    } catch (error) {
        console.error('Error loading commands:', error);
    }
}

function renderCommands(commands) {
    const container = document.getElementById('commandsList');
    
    if (!commands.length) {
        container.innerHTML = '<div class="empty-state">No hay comandos personalizados</div>';
        return;
    }
    
    container.innerHTML = commands.map(cmd => `
        <div class="command-card">
            <div class="command-info">
                <code class="command-name">${escapeHtml(cmd.name)}${cmd.isSystem ? ' 🔒' : ''}</code>
                <p class="command-desc">${escapeHtml(cmd.description || 'Sin descripción')}</p>
                <p class="command-response">${escapeHtml(cmd.response || 'Sin respuesta')}</p>
            </div>
            <div class="command-actions">
                <button class="btn-small" onclick="editCommand('${cmd.name}')">
                    <span class="icon icon-edit"></span>
                </button>
                ${cmd.isSystem ? '' : `<button class="btn-small btn-danger" onclick="deleteCommand('${cmd.name}')">
                    <span class="icon icon-trash"></span>
                </button>`}
            </div>
        </div>
    `).join('');
}

async function loadCBUConfig() {
    try {
        const response = await fetch(`${API_URL}/api/admin/cbu`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const data = await response.json();
            document.getElementById('cbuBank').value = data.bank || '';
            document.getElementById('cbuTitular').value = data.titular || '';
            document.getElementById('cbuNumber').value = data.number || '';
            document.getElementById('cbuAlias').value = data.alias || '';
        }
    } catch (error) {
        console.error('Error loading CBU:', error);
    }
    
    // Cargar también la URL del Canal Informativo
    loadCanalUrlConfig();
}

async function saveCBUConfig() {
    const bank = document.getElementById('cbuBank').value.trim();
    const titular = document.getElementById('cbuTitular').value.trim();
    const number = document.getElementById('cbuNumber').value.trim();
    const alias = document.getElementById('cbuAlias').value.trim();
    
    if (!number) {
        showToast('El CBU es requerido', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/admin/cbu`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ bank, titular, number, alias })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('CBU guardado correctamente', 'success');
        } else {
            showToast(data.error || 'Error al guardar CBU', 'error');
        }
    } catch (error) {
        console.error('Error saving CBU:', error);
        showToast('Error al guardar CBU', 'error');
    }
}

async function loadCanalUrlConfig() {
    try {
        const response = await fetch(`${API_URL}/api/admin/config`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (response.ok) {
            const data = await response.json();
            const urlInput = document.getElementById('canalInformativoUrl');
            if (urlInput) {
                urlInput.value = data.canalInformativoUrl || '';
            }
        }
    } catch (error) {
        console.error('Error loading canal URL:', error);
    }
}

async function saveCanalUrl() {
    const urlInput = document.getElementById('canalInformativoUrl');
    const url = urlInput ? urlInput.value.trim() : '';
    
    try {
        const response = await fetch(`${API_URL}/api/admin/canal-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ url })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast('URL del Canal Informativo guardada correctamente', 'success');
        } else {
            showToast(data.error || data.message || 'Error al guardar URL', 'error');
        }
    } catch (error) {
        console.error('Error saving canal URL:', error);
        showToast('Error al guardar URL', 'error');
    }
}

function showCreateCommandModal() {
    document.getElementById('commandName').value = '/';
    document.getElementById('commandDesc').value = '';
    document.getElementById('commandResponse').value = '';
    document.getElementById('commandModalTitle').textContent = 'Nuevo Comando';
    document.getElementById('commandModalAction').onclick = handleCreateCommand;
    showModal('commandModal');
}

function editCommand(name) {
    const cmd = commandsData.find(c => c.name === name);
    if (!cmd) return;
    
    document.getElementById('commandName').value = cmd.name;
    document.getElementById('commandDesc').value = cmd.description || '';
    document.getElementById('commandResponse').value = cmd.response || '';
    document.getElementById('commandModalTitle').textContent = 'Editar Comando';
    document.getElementById('commandModalAction').onclick = handleUpdateCommand;
    showModal('commandModal');
}

async function handleCreateCommand() {
    const name = document.getElementById('commandName').value.trim();
    const description = document.getElementById('commandDesc').value.trim();
    const response = document.getElementById('commandResponse').value.trim();
    
    if (!name || !name.startsWith('/')) {
        showToast('El comando debe empezar con /', 'error');
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/api/admin/commands`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ name, description, response })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            showToast('Comando creado correctamente', 'success');
            hideModal('commandModal');
            loadCommands();
        } else {
            showToast(data.error || 'Error al crear comando', 'error');
        }
    } catch (error) {
        console.error('Error creating command:', error);
        showToast('Error al crear comando', 'error');
    }
}

async function handleUpdateCommand() {
    await handleCreateCommand(); // El endpoint es el mismo para crear/actualizar
}

async function deleteCommand(name) {
    if (!confirm(`¿Estás seguro de eliminar el comando ${name}?`)) return;
    
    try {
        const response = await fetch(`${API_URL}/api/admin/commands/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            showToast('Comando eliminado correctamente', 'success');
            loadCommands();
        } else {
            const data = await response.json();
            showToast(data.error || 'Error al eliminar comando', 'error');
        }
    } catch (error) {
        console.error('Error deleting command:', error);
        showToast('Error al eliminar comando', 'error');
    }
}

// Global functions for inline handlers
window.viewUser = function(userId) {
    console.log('View user:', userId);
};

window.chatUser = function(userId) {
    selectConversation(userId, 'Usuario');
    switchSection('chats');
};

window.editCommand = editCommand;
window.deleteCommand = deleteCommand;

// ============================================
// PWA - INSTALACIÓN DE APP EN ANDROID
// ============================================

// Detectar si la app ya está instalada
function checkAppInstalled() {
    if (window.matchMedia('(display-mode: standalone)').matches || 
        window.navigator.standalone === true) {
        isAppInstalled = true;
        console.log('✅ App ya instalada (standalone mode)');
        return true;
    }
    return false;
}

// Inicializar PWA - Escuchar evento beforeinstallprompt
function initPWA() {
    console.log('🚀 Inicializando PWA...');
    
    // Verificar si ya está instalada
    if (checkAppInstalled()) {
        hideInstallButton();
        return;
    }
    
    // Escuchar evento beforeinstallprompt
    window.addEventListener('beforeinstallprompt', (e) => {
        console.log('📱 beforeinstallprompt event recibido');
        // Prevenir que el navegador muestre el prompt automático
        e.preventDefault();
        // Guardar el evento para usarlo después
        deferredInstallPrompt = e;
        // Mostrar el botón de instalación
        showInstallButton();
    });
    
    // Escuchar cuando la app es instalada
    window.addEventListener('appinstalled', (e) => {
        console.log('✅ App instalada exitosamente');
        isAppInstalled = true;
        hideInstallButton();
        deferredInstallPrompt = null;
        showToast('✅ App instalada correctamente', 'success');
    });
    
    // Verificar periódicamente si el botón debe mostrarse
    setTimeout(() => {
        if (!isAppInstalled && deferredInstallPrompt) {
            showInstallButton();
        }
    }, 2000);
}

// Mostrar botón de instalación
function showInstallButton() {
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn && !isAppInstalled) {
        installBtn.classList.remove('hidden');
        console.log('📱 Botón de instalación visible');
    }
}

// Ocultar botón de instalación
function hideInstallButton() {
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn) {
        installBtn.classList.add('hidden');
    }
}

// Manejar click en botón de instalación
async function handleInstallApp() {
    console.log('📱 Click en botón de instalación');
    
    if (!deferredInstallPrompt) {
        console.log('⚠️ No hay prompt de instalación disponible');
        showToast('La instalación no está disponible en este momento', 'info');
        return;
    }
    
    // Mostrar el prompt de instalación
    deferredInstallPrompt.prompt();
    
    // Esperar la respuesta del usuario
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log('📱 Resultado de instalación:', outcome);
    
    if (outcome === 'accepted') {
        console.log('✅ Usuario aceptó instalar');
        isAppInstalled = true;
        hideInstallButton();
    } else {
        console.log('❌ Usuario rechazó instalar');
    }
    
    // Limpiar el prompt guardado
    deferredInstallPrompt = null;
}

// ============================================
// NOTIFICACIONES PUSH - SERVICE WORKER
// ============================================

// Registrar Service Worker para notificaciones push
async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        console.log('⚠️ Service Worker no soportado');
        return false;
    }
    
    try {
        const registration = await navigator.serviceWorker.register('/admin-sw.js');
        console.log('✅ Service Worker registrado:', registration.scope);
        
        // Escuchar mensajes del service worker
        navigator.serviceWorker.addEventListener('message', (event) => {
            console.log('📨 Mensaje del SW:', event.data);
            if (event.data.type === 'NEW_MESSAGE') {
                // Mostrar notificación local si la app está abierta
                showBrowserNotification(
                    event.data.title,
                    event.data.body,
                    event.data.icon
                );
            }
        });
        
        return registration;
    } catch (error) {
        console.error('❌ Error registrando Service Worker:', error);
        return false;
    }
}

// Solicitar permiso para notificaciones
async function requestPushPermission() {
    if (!('Notification' in window)) {
        console.log('⚠️ Notificaciones no soportadas');
        return false;
    }
    
    const permission = await Notification.requestPermission();
    console.log('🔔 Permiso de notificaciones:', permission);
    
    if (permission === 'granted') {
        await registerServiceWorker();
        return true;
    }
    return false;
}

// Enviar notificación push cuando el admin envía mensaje
async function sendPushNotification(userId, message) {
    try {
        const response = await fetch(`${API_URL}/api/admin/send-notification`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                userId: userId,
                title: '💬 Nuevo mensaje del soporte',
                body: message.type === 'image' ? '📸 Imagen' : message.content.substring(0, 100),
                icon: '/icons/icon-192x192.png',
                badge: '/icons/icon-72x72.png',
                tag: `chat-${userId}`,
                requireInteraction: false,
                data: {
                    url: '/',
                    userId: userId
                }
            })
        });
        
        if (response.ok) {
            console.log('✅ Notificación push enviada');
        }
    } catch (error) {
        console.error('❌ Error enviando notificación push:', error);
    }
}

// ============================================
// CHAT ULTRA-RÁPIDO - OPTIMIZACIONES
// ============================================

// Precargar mensajes de conversaciones frecuentes
async function prefetchFrequentConversations() {
    const frequentUsers = conversations.slice(0, 5); // Top 5 conversaciones
    
    for (const conv of frequentUsers) {
        if (!messageCache.has(conv.userId)) {
            fetch(`${API_URL}/api/messages/${conv.userId}?limit=50`, {
                headers: { 'Authorization': `Bearer ${currentToken}` }
            })
            .then(r => r.json())
            .then(data => {
                if (data.messages) {
                    messageCache.set(conv.userId, data.messages);
                    console.log('✅ Prefetch completado para:', conv.username);
                }
            })
            .catch(() => {});
        }
    }
}

// Renderizado ultra-rápido de mensajes
function renderMessagesUltraFast(messages) {
    // Usar DocumentFragment para minimizar reflows
    const fragment = document.createDocumentFragment();
    
    messages.forEach(msg => {
        if (msg.id && processedMessageIds.has(msg.id)) return;
        
        const msgDiv = createMessageElement(msg);
        fragment.appendChild(msgDiv);
        
        if (msg.id) {
            processedMessageIds.add(msg.id);
        }
    });
    
    // Limpiar y agregar todo de una vez
    elements.chatMessages.innerHTML = '';
    elements.chatMessages.appendChild(fragment);
    
    // Scroll inmediato sin animación para máxima velocidad
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// Crear elemento de mensaje optimizado
function createMessageElement(message) {
    // Fix #3: Mensajes de sistema (ej. cierre de chat) con estilo propio
    if (message.type === 'system') {
        const div = document.createElement('div');
        div.className = 'message system';
        div.dataset.messageid = message.id || '';
        div.innerHTML = `<span class="icon icon-lock"></span> <span>${escapeHtml(message.content)}</span>`;
        return div;
    }
    
    const isOutgoing = getMessageType(message) === 'outgoing';
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isOutgoing ? 'outgoing' : 'incoming'}`;
    msgDiv.dataset.messageid = message.id;
    
    const time = formatDateTime(message.timestamp || new Date());
    const content = formatMessageContent(message);
    
    msgDiv.innerHTML = `
        <div class="message-header">
            <span class="icon icon-user"></span>
            <span>${escapeHtml(message.senderUsername || 'Usuario')}</span>
        </div>
        <div class="message-content">${content}</div>
        <div class="message-time">${time}</div>
    `;
    
    return msgDiv;
}

// Inicializar PWA al cargar
document.addEventListener('DOMContentLoaded', () => {
    initPWA();
    
    // Configurar botón de instalación
    const installBtn = document.getElementById('installAppBtn');
    if (installBtn) {
        installBtn.addEventListener('click', handleInstallApp);
    }
});

// Exponer funciones globales
window.handleInstallApp = handleInstallApp;
window.requestPushPermission = requestPushPermission;
// ============================================
// PANEL DE NOTIFICACIONES PUSH
// Ruta: /adminprivado2026/ → nav item "Notificaciones"
// ============================================

let notifCurrentPage = 1;

async function loadNotificationsPanel() {
    const filter = document.getElementById('notifUserFilter')?.value || 'all';
    await Promise.all([
        loadNotifStats(),
        loadNotifUsers(1, filter)
    ]);
}

async function loadNotifStats() {
    try {
        const res = await fetch(`${API_URL}/api/notifications/users-status?page=1&limit=1&filter=all`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!data.success) return;
        const s = data.stats;
        document.getElementById('notifTotalUsers').textContent = s.totalUsers;
        document.getElementById('notifWithToken').textContent = s.usersWithToken;
        document.getElementById('notifWithoutToken').textContent = s.usersWithoutToken;
        document.getElementById('notifCoverage').textContent = s.coverage + '%';
    } catch (e) {
        console.error('[Notif Panel] Error cargando stats:', e);
    }
}

async function loadNotifUsers(page = 1, filter = 'all') {
    notifCurrentPage = page;
    const limit = 50;
    const listEl = document.getElementById('notifUsersList');
    const pagEl = document.getElementById('notifPagination');
    if (listEl) listEl.innerHTML = '<p style="color:#888;text-align:center">Cargando...</p>';

    try {
        const res = await fetch(`${API_URL}/api/notifications/users-status?page=${page}&limit=${limit}&filter=${filter}`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        const data = await res.json();
        if (!data.success) { if (listEl) listEl.innerHTML = '<p style="color:#f00">Error al cargar</p>'; return; }

        if (!data.users || data.users.length === 0) {
            if (listEl) listEl.innerHTML = '<p style="color:#888;text-align:center">No hay usuarios con este filtro</p>';
            if (pagEl) pagEl.innerHTML = '';
            return;
        }

        const rows = data.users.map(u => `
            <tr>
                <td style="padding:.5rem .75rem">${escapeHtml(u.username)}</td>
                <td style="padding:.5rem .75rem;text-align:center">
                    ${u.hasToken
                        ? '<span style="color:#00ff88;font-size:.85rem">📱 App instalada</span>'
                        : '<span style="color:#888;font-size:.85rem">📵 Sin app</span>'}
                </td>
                <td style="padding:.5rem .75rem;color:#888;font-size:.8rem">
                    ${u.tokenUpdatedAt ? new Date(u.tokenUpdatedAt).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—'}
                </td>
                <td style="padding:.5rem .75rem;color:#888;font-size:.8rem">
                    ${u.lastLogin ? new Date(u.lastLogin).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—'}
                </td>
            </tr>
        `).join('');

        if (listEl) listEl.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:.9rem">
                <thead>
                    <tr style="border-bottom:1px solid rgba(255,255,255,.1);color:#aaa;font-size:.8rem">
                        <th style="padding:.5rem .75rem;text-align:left">Usuario</th>
                        <th style="padding:.5rem .75rem;text-align:center">Estado App</th>
                        <th style="padding:.5rem .75rem;text-align:left">Token actualizado</th>
                        <th style="padding:.5rem .75rem;text-align:left">Último login</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;

        // Pagination: show prev, up to 5 pages around current, and next
        if (pagEl) {
            const totalPages = data.pagination.pages;
            let btns = '';
            if (page > 1) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${page - 1}, '${filter}')">◀ Ant</button>`;
            const startPage = Math.max(1, page - 2);
            const endPage = Math.min(totalPages, page + 2);
            if (startPage > 1) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(1, '${filter}')">1</button><span style="color:#888;padding:.25rem .25rem">…</span>`;
            for (let i = startPage; i <= endPage; i++) {
                btns += `<button class="btn btn-sm ${i === page ? 'btn-primary' : 'btn-secondary'}" onclick="loadNotifUsers(${i}, '${filter}')">${i}</button>`;
            }
            if (endPage < totalPages) btns += `<span style="color:#888;padding:.25rem .25rem">…</span><button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${totalPages}, '${filter}')">${totalPages}</button>`;
            if (page < totalPages) btns += `<button class="btn btn-sm btn-secondary" onclick="loadNotifUsers(${page + 1}, '${filter}')">Sig ▶</button>`;
            pagEl.innerHTML = btns;
        }
    } catch (e) {
        console.error('[Notif Panel] Error cargando usuarios:', e);
        if (listEl) listEl.innerHTML = '<p style="color:#f00;text-align:center">Error al cargar usuarios</p>';
    }
}

async function sendBatchNotification() {
    const title = document.getElementById('notifTitle')?.value?.trim();
    const body = document.getElementById('notifBody')?.value?.trim();
    const segment = document.getElementById('notifSegment')?.value || 'all';
    const batchSize = parseInt(document.getElementById('notifBatchSize')?.value || '100');

    if (!title || !body) {
        showToast('❌ El título y el mensaje son obligatorios', 'error');
        return;
    }

    let usernames = null;
    if (segment === 'specific') {
        const raw = document.getElementById('notifUsernames')?.value || '';
        usernames = raw.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
        if (usernames.length === 0) {
            showToast('❌ Ingresá al menos un username en "Usuarios específicos"', 'error');
            return;
        }
    }

    const sendBtn = document.getElementById('notifSendBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳ Enviando...'; }

    const resultEl = document.getElementById('notifResult');
    const resultContent = document.getElementById('notifResultContent');
    if (resultEl) resultEl.style.display = 'none';

    try {
        const res = await fetch(`${API_URL}/api/notifications/send-batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ title, body, batchSize, usernames })
        });
        const data = await res.json();

        if (resultEl) resultEl.style.display = 'block';
        if (resultContent) {
            if (data.success) {
                const pct = data.totalUsers > 0 ? Math.round((data.successCount / data.totalUsers) * 100) : 0;
                resultContent.innerHTML = `
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem;margin-bottom:1rem">
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#00ff88">${data.successCount}</div><div style="color:#aaa;font-size:.8rem">Enviados</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#f87171">${data.failureCount}</div><div style="color:#aaa;font-size:.8rem">Fallidos</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#fbbf24">${data.cleanedTokens}</div><div style="color:#aaa;font-size:.8rem">Tokens limpiados</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700;color:#6366f1">${data.totalUsers}</div><div style="color:#aaa;font-size:.8rem">Destinatarios</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700">${pct}%</div><div style="color:#aaa;font-size:.8rem">Tasa de éxito</div></div>
                        <div style="text-align:center"><div style="font-size:1.5rem;font-weight:700">${data.batches}</div><div style="color:#aaa;font-size:.8rem">Lotes (${data.batchSize} c/u)</div></div>
                    </div>
                    ${data.failedTokens && data.failedTokens.length > 0 ? `
                    <details style="margin-top:.5rem">
                        <summary style="cursor:pointer;color:#aaa;font-size:.85rem">Ver tokens fallidos (${data.failedTokens.length})</summary>
                        <div style="margin-top:.5rem;max-height:200px;overflow-y:auto">
                        ${data.failedTokens.map(f => `<div style="font-size:.8rem;padding:.25rem 0;border-bottom:1px solid rgba(255,255,255,.05)"><strong>${escapeHtml(f.username)}</strong> — ${escapeHtml(f.error || '')} ${f.cleaned ? '<span style="color:#fbbf24">(token limpiado)</span>' : ''}</div>`).join('')}
                        </div>
                    </details>` : ''}
                `;
                showToast(`✅ Notificación enviada a ${data.successCount} usuarios`, 'success');
                // Reload stats and token list after sending (tokens may have been cleaned)
                loadNotificationsPanel();
            } else {
                resultContent.innerHTML = `<p style="color:#f87171">❌ Error: ${escapeHtml(data.error || 'Error desconocido')}</p>`;
                showToast('❌ Error al enviar notificaciones', 'error');
            }
        }
    } catch (e) {
        showToast('❌ Error de conexión al enviar notificaciones', 'error');
        console.error('[Notif Panel] Error enviando:', e);
    } finally {
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '🚀 Enviar notificación'; }
    }
}

async function cleanInvalidTokens() {
    if (!confirm('¿Verificar y limpiar tokens inválidos? Esto enviará una notificación de prueba silenciosa a cada usuario con token. Puede tardar unos minutos.')) return;

    const btn = document.querySelector('button[onclick="cleanInvalidTokens()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

    try {
        const res = await fetch(`${API_URL}/api/notifications/verify-tokens`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ sendTest: false })
        });
        const data = await res.json();
        if (data.success) {
            const r = data.results;
            showToast(`🧹 Verificación completada: ${r.valid} válidos, ${r.invalid} inválidos, ${r.cleaned} limpiados`, 'success');
            loadNotificationsPanel();
        } else {
            showToast('❌ Error en verificación de tokens', 'error');
        }
    } catch (e) {
        showToast('❌ Error de conexión', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🧹 Limpiar tokens inválidos'; }
    }
}

// Mostrar/ocultar campo de usuarios específicos según segmento seleccionado
document.addEventListener('DOMContentLoaded', () => {
    const segmentSelect = document.getElementById('notifSegment');
    if (segmentSelect) {
        segmentSelect.addEventListener('change', () => {
            const specificDiv = document.getElementById('notifSpecificUsers');
            if (specificDiv) specificDiv.style.display = segmentSelect.value === 'specific' ? 'block' : 'none';
        });
    }
});

// Exponer funciones del panel de notificaciones al scope global (usadas por onclick)
window.loadNotificationsPanel = loadNotificationsPanel;
window.loadNotifUsers = loadNotifUsers;
window.sendBatchNotification = sendBatchNotification;
window.cleanInvalidTokens = cleanInvalidTokens;
