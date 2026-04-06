
/**
 * Servicio de Integración JUGAYGANA
 * Gestiona la comunicación con la API de JUGAYGANA
 */
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('../utils/logger');

// Configuración
const API_URL = process.env.JUGAYGANA_API_URL || 'https://admin.agentesadmin.bet/api/admin/';
const PROXY_URL = process.env.PROXY_URL || '';
const PLATFORM_USER = process.env.PLATFORM_USER;
const PLATFORM_PASS = process.env.PLATFORM_PASS;
const TOKEN_TTL_MINUTES = parseInt(process.env.TOKEN_TTL_MINUTES || '20', 10);

// Estado de sesión
let sessionToken = null;
let sessionCookie = null;
let sessionParentId = null;
let lastLogin = 0;

// Configurar agente proxy
let httpsAgent = null;
if (PROXY_URL) {
  httpsAgent = new HttpsProxyAgent(PROXY_URL);
  logger.info('Proxy configurado para JUGAYGANA');
}

// Cliente HTTP
const client = axios.create({
  baseURL: API_URL,
  timeout: 20000,
  httpsAgent,
  proxy: false,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://admin.agentesadmin.bet',
    'Referer': 'https://admin.agentesadmin.bet/users',
    'Accept-Language': 'es-419,es;q=0.9'
  }
});

// Helpers
const toFormUrlEncoded = (data) => {
  return Object.keys(data)
    .filter(k => data[k] !== undefined && data[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
    .join('&');
};

const parseJson = (data) => {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
  } catch {
    return data;
  }
};

const isHtmlBlocked = (data) => {
  return typeof data === 'string' && data.trim().startsWith('<');
};

/**
 * Login en JUGAYGANA
 */
const login = async () => {
  if (!PLATFORM_USER || !PLATFORM_PASS) {
    logger.error('Faltan credenciales de JUGAYGANA');
    return false;
  }

  try {
    const body = toFormUrlEncoded({
      action: 'LOGIN',
      username: PLATFORM_USER,
      password: PLATFORM_PASS
    });

    const resp = await client.post('', body, {
      validateStatus: s => s >= 200 && s < 500,
      maxRedirects: 0
    });

    if (resp.headers['set-cookie']) {
      sessionCookie = resp.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    }

    const data = parseJson(resp.data);
    
    if (isHtmlBlocked(data)) {
      logger.error('Login bloqueado por HTML');
      logger.error(`HTTP status: ${resp.status}, URL: ${API_URL}`);
      return false;
    }

    // Intentar token en múltiples campos por compatibilidad con cambios de API
    const token = data?.token || data?.access_token || data?.sessionToken || data?.data?.token;

    if (!token) {
      logger.error('Login falló: no se recibió token');
      logger.error(`HTTP status: ${resp.status}`);
      logger.error(`Content-Type: ${resp.headers['content-type'] || 'sin content-type'}`);
      logger.error(`URL usada: ${API_URL}`);
      if (typeof data === 'object' && data !== null) {
        const keys = Object.keys(data);
        logger.error(`Campos en respuesta: ${keys.length ? keys.join(', ') : '(objeto vacío)'}`);
        const errMsg = data.error || data.message || data.msg || data.detail;
        if (errMsg) logger.error(`Mensaje de error de API: ${errMsg}`);
      } else if (typeof data === 'string') {
        logger.error(`Respuesta (primeros 200 chars): ${data.substring(0, 200)}`);
      }
      return false;
    }

    sessionToken = token;
    sessionParentId = data?.user?.user_id ?? null;
    lastLogin = Date.now();
    
    logger.info('Login exitoso en JUGAYGANA');
    return true;
  } catch (error) {
    logger.error('Error en login JUGAYGANA:', error.message);
    return false;
  }
};

/**
 * Asegurar sesión válida
 */
const ensureSession = async () => {
  if (!PLATFORM_USER || !PLATFORM_PASS) return false;
  
  const expired = Date.now() - lastLogin > TOKEN_TTL_MINUTES * 60 * 1000;
  if (!sessionToken || expired) {
    sessionToken = null;
    sessionCookie = null;
    return await login();
  }
  return true;
};

/**
 * Obtener información de usuario
 */
const getUserInfo = async (username) => {
  const ok = await ensureSession();
  if (!ok) return null;

  try {
    const body = toFormUrlEncoded({
      action: 'ShowUsers',
      token: sessionToken,
      page: 1,
      pagesize: 50,
      viewtype: 'tree',
      username,
      showhidden: 'false',
      parentid: sessionParentId || undefined
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true, 
      maxRedirects: 0 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) return null;

    const list = data.users || data.data || (Array.isArray(data) ? data : []);
    const found = list.find(u => 
      String(u.user_name).toLowerCase().trim() === String(username).toLowerCase().trim()
    );
    
    if (!found?.user_id) return null;

    let balanceRaw = Number(found.user_balance ?? found.balance ?? 0);
    let balance = Number.isInteger(balanceRaw) ? balanceRaw / 100 : balanceRaw;

    return { 
      id: found.user_id, 
      balance,
      username: found.user_name,
      email: found.user_email,
      phone: found.user_phone
    };
  } catch (error) {
    logger.error('Error obteniendo info de usuario JUGAYGANA:', error.message);
    return null;
  }
};

/**
 * Crear usuario en JUGAYGANA
 */
const createUser = async ({ username, password, userrole = 'player', currency = 'ARS' }) => {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  try {
    const body = toFormUrlEncoded({
      action: 'CREATEUSER',
      token: sessionToken,
      username,
      password,
      userrole,
      currency
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true, 
      maxRedirects: 0 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP bloqueada / HTML' };
    }

    if (data?.success) {
      return { 
        success: true, 
        user: data.user,
        jugayganaUserId: data.user?.user_id,
        jugayganaUsername: data.user?.user_name
      };
    }
    
    return { success: false, error: data?.error || 'CREATEUSER falló' };
  } catch (error) {
    logger.error('Error creando usuario JUGAYGANA:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Sincronizar usuario con JUGAYGANA
 */
const syncUser = async (localUser) => {
  // Verificar si ya existe
  const existingUser = await getUserInfo(localUser.username);
  if (existingUser) {
    return {
      success: true,
      alreadyExists: true,
      jugayganaUserId: existingUser.id,
      jugayganaUsername: localUser.username
    };
  }

  // Crear nuevo usuario
  return await createUser({
    username: localUser.username,
    password: localUser.password || 'asd123',
    userrole: 'player',
    currency: 'ARS'
  });
};

/**
 * Obtener balance de usuario
 */
const getBalance = async (username) => {
  const user = await getUserInfo(username);
  if (!user) return { success: false, error: 'Usuario no encontrado' };
  
  return { 
    success: true, 
    balance: user.balance,
    username: user.username
  };
};

/**
 * Realizar depósito
 */
const deposit = async (username, amount, description = '') => {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  try {
    const body = toFormUrlEncoded({
      action: 'CREDITBALANCE',
      token: sessionToken,
      username,
      amount: Math.round(amount * 100),
      description: description || `Depósito - ${new Date().toLocaleString('es-AR')}`
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP bloqueada / HTML' };
    }

    if (data?.success) {
      return { 
        success: true, 
        data: data.data,
        newBalance: data.data?.user_balance_after
      };
    }
    
    return { success: false, error: data?.error || 'Depósito falló' };
  } catch (error) {
    logger.error('Error en depósito JUGAYGANA:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Realizar retiro
 */
const withdraw = async (username, amount, description = '') => {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  try {
    const body = toFormUrlEncoded({
      action: 'DEBITBALANCE',
      token: sessionToken,
      username,
      amount: Math.round(amount * 100),
      description: description || `Retiro - ${new Date().toLocaleString('es-AR')}`
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP bloqueada / HTML' };
    }

    if (data?.success) {
      return { 
        success: true, 
        data: data.data,
        newBalance: data.data?.user_balance_after
      };
    }
    
    return { success: false, error: data?.error || 'Retiro falló' };
  } catch (error) {
    logger.error('Error en retiro JUGAYGANA:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Acreditar bonificación (individual_bonus)
 */
const bonus = async (username, amount, description = '') => {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  try {
    const body = toFormUrlEncoded({
      action: 'CREDITBALANCE',
      token: sessionToken,
      username,
      amount: Math.round(amount * 100),
      deposit_type: 'individual_bonus',
      description: description || `Bonificación - ${new Date().toLocaleString('es-AR')}`
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP bloqueada / HTML' };
    }

    if (data?.success) {
      return { 
        success: true, 
        data: data.data,
        newBalance: data.data?.user_balance_after
      };
    }
    
    return { success: false, error: data?.error || 'Bonificación falló' };
  } catch (error) {
    logger.error('Error en bonificación JUGAYGANA:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Acreditar bonificación (alias - usa individual_bonus)
 */
const creditBalance = async (username, amount, description = '') => {
  return await bonus(username, amount, description);
};

module.exports = {
  login,
  ensureSession,
  getUserInfo,
  createUser,
  syncUser,
  getBalance,
  deposit,
  withdraw,
  bonus,
  creditBalance
};