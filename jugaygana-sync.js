
// ============================================
// SINCRONIZACIÓN AUTOMÁTICA JUGAYGANA
// Maneja creación continua de usuarios
// ============================================

const jugaygana = require('./jugaygana');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Configuración
const DATA_DIR = process.env.VERCEL ? '/tmp/data' : path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SYNC_LOG_FILE = path.join(DATA_DIR, 'sync-log.json');

// Asegurar que existan archivos
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(SYNC_LOG_FILE)) {
    fs.writeFileSync(SYNC_LOG_FILE, JSON.stringify({ lastSync: null, totalSynced: 0 }, null, 2));
  }
} catch (error) {
  console.error('Error creando archivos:', error);
}

// Helpers
function loadUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadSyncLog() {
  try {
    const data = fs.readFileSync(SYNC_LOG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { lastSync: null, totalSynced: 0, errors: [] };
  }
}

function saveSyncLog(log) {
  fs.writeFileSync(SYNC_LOG_FILE, JSON.stringify(log, null, 2));
}

function generateAccountNumber() {
  return 'ACC' + Date.now().toString().slice(-8) + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// ============================================
// OBTENER TODOS LOS USUARIOS DE JUGAYGANA (PAGINADO)
// ============================================

async function getAllJugayganaUsers() {
  const allUsers = [];
  let page = 1;
  const pageSize = 100;
  let hasMore = true;
  let consecutiveErrors = 0;

  console.log('🔍 Obteniendo usuarios de JUGAYGANA...');

  while (hasMore && page <= 2000 && consecutiveErrors < 5) {
    try {
      const sessionOk = await jugaygana.ensureSession();
      if (!sessionOk) {
        console.error('❌ No hay sesión válida');
        break;
      }

      const axios = require('axios');
      const { HttpsProxyAgent } = require('https-proxy-agent');
      
      const PROXY_URL = process.env.PROXY_URL || '';
      let httpsAgent = null;
      if (PROXY_URL) httpsAgent = new HttpsProxyAgent(PROXY_URL);

      const API_URL = 'https://admin.agentesadmin.bet/api/admin/';
      
      function toFormUrlEncoded(data) {
        return Object.keys(data)
          .filter(k => data[k] !== undefined && data[k] !== null)
          .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
          .join('&');
      }

      const body = toFormUrlEncoded({
        action: 'ShowUsers',
        token: jugaygana.SESSION_TOKEN,
        page: page,
        pagesize: pageSize,
        viewtype: 'tree',
        showhidden: 'false',
        parentid: jugaygana.SESSION_PARENT_ID || undefined
      });

      const headers = {};
      if (jugaygana.SESSION_COOKIE) headers.Cookie = jugaygana.SESSION_COOKIE;

      const resp = await axios.post(API_URL, body, {
        httpsAgent,
        proxy: false,
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        timeout: 30000
      });

      let data = resp.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
        } catch (_) {}
      }

      // Detectar bloqueo por HTML
      if (typeof data === 'string' && data.trim().startsWith('<')) {
        console.error('❌ Respuesta HTML (bloqueo de IP)');
        consecutiveErrors++;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const users = data.users || data.data || [];
      
      if (users.length === 0) {
        hasMore = false;
        console.log(`✅ No hay más usuarios en página ${page}`);
      } else {
        allUsers.push(...users);
        console.log(`📄 Página ${page}: +${users.length} usuarios (Total: ${allUsers.length})`);
        page++;
        consecutiveErrors = 0;
        
        // Delay para no saturar la API
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (error) {
      console.error(`❌ Error página ${page}:`, error.message);
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        console.error('❌ Demasiados errores consecutivos, abortando');
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return allUsers;
}

// ============================================
// SINCRONIZAR TODOS LOS USUARIOS
// ============================================

async function syncAllUsers(progressCallback = null) {
  console.log('\n🚀 INICIANDO SINCRONIZACIÓN MASIVA\n');
  
  const startTime = Date.now();
  const syncLog = loadSyncLog();
  
  // Obtener todos los usuarios de JUGAYGANA
  const jugayganaUsers = await getAllJugayganaUsers();
  
  if (jugayganaUsers.length === 0) {
    return { 
      success: false, 
      error: 'No se pudieron obtener usuarios de JUGAYGANA',
      totalJugaygana: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0
    };
  }

  // Cargar usuarios locales
  let localUsers = loadUsers();
  const initialCount = localUsers.length;
  
  // Estadísticas
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  
  // Crear mapa de usuarios locales por username para búsqueda rápida
  const localUsersMap = new Map();
  localUsers.forEach(u => {
    localUsersMap.set(u.username.toLowerCase(), u);
  });
  
  // Procesar cada usuario de JUGAYGANA
  for (let i = 0; i < jugayganaUsers.length; i++) {
    const jgUser = jugayganaUsers[i];
    const username = jgUser.user_name;
    const userId = jgUser.user_id;
    
    if (!username) {
      skipped++;
      continue;
    }
    
    try {
      const existingUser = localUsersMap.get(username.toLowerCase());
      
      if (existingUser) {
        // Actualizar si es necesario
        let needsUpdate = false;
        
        if (!existingUser.jugayganaUserId) {
          existingUser.jugayganaUserId = userId;
          existingUser.jugayganaUsername = username;
          existingUser.jugayganaSyncStatus = 'linked';
          existingUser.source = 'jugaygana';
          needsUpdate = true;
        }
        
        if (needsUpdate) {
          updated++;
        } else {
          skipped++;
        }
      } else {
        // Crear nuevo usuario
        const hashedPassword = await bcrypt.hash('asd123', 10);
        
        const newUser = {
          id: uuidv4(),
          username: username,
          password: hashedPassword,
          email: jgUser.user_email || null,
          phone: jgUser.user_phone || null,
          role: 'user',
          accountNumber: generateAccountNumber(),
          balance: 0,
          createdAt: new Date().toISOString(),
          lastLogin: null,
          isActive: true,
          jugayganaUserId: userId,
          jugayganaUsername: username,
          jugayganaSyncStatus: 'imported',
          source: 'jugaygana'
        };
        
        localUsers.push(newUser);
        localUsersMap.set(username.toLowerCase(), newUser);
        created++;
      }
      
      // Reportar progreso cada 100 usuarios
      if (progressCallback && i % 100 === 0) {
        progressCallback({
          current: i + 1,
          total: jugayganaUsers.length,
          percent: Math.round(((i + 1) / jugayganaUsers.length) * 100),
          created,
          updated,
          skipped
        });
      }
      
    } catch (error) {
      console.error(`❌ Error procesando ${username}:`, error.message);
      errors++;
    }
  }
  
  // Guardar usuarios
  saveUsers(localUsers);
  
  // Actualizar log
  syncLog.lastSync = new Date().toISOString();
  syncLog.totalSynced = (syncLog.totalSynced || 0) + created + updated;
  syncLog.lastResult = {
    totalJugaygana: jugayganaUsers.length,
    initialLocal: initialCount,
    finalLocal: localUsers.length,
    created,
    updated,
    skipped,
    errors,
    duration: Date.now() - startTime
  };
  saveSyncLog(syncLog);
  
  console.log('\n' + '='.repeat(50));
  console.log('✅ SINCRONIZACIÓN COMPLETADA');
  console.log('='.repeat(50));
  console.log(`📊 Total JUGAYGANA: ${jugayganaUsers.length}`);
  console.log(`📊 Usuarios locales inicial: ${initialCount}`);
  console.log(`📊 Usuarios locales final: ${localUsers.length}`);
  console.log(`✅ Creados: ${created}`);
  console.log(`🔄 Actualizados: ${updated}`);
  console.log(`⏭️ Saltados: ${skipped}`);
  console.log(`❌ Errores: ${errors}`);
  console.log(`⏱️ Duración: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log('='.repeat(50));
  
  return {
    success: true,
    totalJugaygana: jugayganaUsers.length,
    initialLocal: initialCount,
    finalLocal: localUsers.length,
    created,
    updated,
    skipped,
    errors,
    duration: Date.now() - startTime
  };
}

// ============================================
// SINCRONIZAR USUARIOS RECIENTES (últimos creados)
// ============================================

async function syncRecentUsers(limit = 100) {
  console.log(`🔄 Sincronizando ${limit} usuarios más recientes...`);
  
  // Obtener usuarios de JUGAYGANA
  const allUsers = await getAllJugayganaUsers();
  
  if (allUsers.length === 0) {
    return { success: false, error: 'No se pudieron obtener usuarios' };
  }
  
  // Ordenar por fecha de registro (más recientes primero)
  const recentUsers = allUsers
    .sort((a, b) => (b.registration_time_unix || 0) - (a.registration_time_unix || 0))
    .slice(0, limit);
  
  let localUsers = loadUsers();
  const localUsersMap = new Map(localUsers.map(u => [u.username.toLowerCase(), u]));
  
  let created = 0;
  let skipped = 0;
  
  for (const jgUser of recentUsers) {
    const username = jgUser.user_name;
    if (!username) continue;
    
    if (!localUsersMap.has(username.toLowerCase())) {
      const hashedPassword = await bcrypt.hash('asd123', 10);
      
      localUsers.push({
        id: uuidv4(),
        username: username,
        password: hashedPassword,
        email: jgUser.user_email || null,
        phone: jgUser.user_phone || null,
        role: 'user',
        accountNumber: generateAccountNumber(),
        balance: 0,
        createdAt: new Date().toISOString(),
        lastLogin: null,
        isActive: true,
        jugayganaUserId: jgUser.user_id,
        jugayganaUsername: username,
        jugayganaSyncStatus: 'imported',
        source: 'jugaygana'
      });
      
      created++;
    } else {
      skipped++;
    }
  }
  
  saveUsers(localUsers);
  
  return {
    success: true,
    checked: recentUsers.length,
    created,
    skipped,
    totalLocal: localUsers.length
  };
}

// ============================================
// VERIFICAR Y SINCRONIZAR UN USUARIO ESPECÍFICO
// ============================================

async function syncSingleUser(username) {
  console.log(`🔍 Verificando usuario: ${username}`);
  
  const localUsers = loadUsers();
  const existingUser = localUsers.find(u => 
    u.username.toLowerCase() === username.toLowerCase()
  );
  
  if (existingUser) {
    console.log(`✅ Usuario ${username} ya existe localmente`);
    return { 
      success: true, 
      action: 'exists',
      user: existingUser 
    };
  }
  
  // Buscar en JUGAYGANA
  const jgUser = await jugaygana.getUserInfoByName(username);
  
  if (!jgUser) {
    console.log(`❌ Usuario ${username} no existe en JUGAYGANA`);
    return { 
      success: false, 
      error: 'Usuario no encontrado en JUGAYGANA' 
    };
  }
  
  // Crear usuario local
  const hashedPassword = await bcrypt.hash('asd123', 10);
  
  const newUser = {
    id: uuidv4(),
    username: jgUser.username,
    password: hashedPassword,
    email: jgUser.email || null,
    phone: jgUser.phone || null,
    role: 'user',
    accountNumber: generateAccountNumber(),
    balance: jgUser.balance || 0,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    isActive: true,
    jugayganaUserId: jgUser.id,
    jugayganaUsername: jgUser.username,
    jugayganaSyncStatus: 'linked',
    source: 'jugaygana'
  };
  
  localUsers.push(newUser);
  saveUsers(localUsers);
  
  console.log(`✅ Usuario ${username} creado desde JUGAYGANA`);
  
  return {
    success: true,
    action: 'created',
    user: newUser
  };
}

// ============================================
// EXPORTAR
// ============================================

module.exports = {
  getAllJugayganaUsers,
  syncAllUsers,
  syncRecentUsers,
  syncSingleUser,
  loadSyncLog
};