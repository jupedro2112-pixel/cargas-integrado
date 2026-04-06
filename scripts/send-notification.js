#!/usr/bin/env node

// ============================================
// SCRIPT PARA ENVIAR NOTIFICACIONES PUSH
// Uso: node send-notification.js <fcm-token> "Título" "Mensaje"
// Requiere env vars (en orden de prioridad):
//   1) FIREBASE_SERVICE_ACCOUNT_JSON_BASE64
//   2) FIREBASE_SERVICE_ACCOUNT_JSON
//   3) FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// ============================================

const admin = require('firebase-admin');

// ============================================
// HELPER: NORMALIZAR FIREBASE PRIVATE KEY
// Idéntico al de src/services/notificationService.js.
// ============================================
function normalizePrivateKey(raw) {
  let key = String(raw).trim();
  if ((key.startsWith('"') && key.endsWith('"')) ||
      (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\\n/g, '\n');
  key = key.replace(/\r\n/g, '\n');
  key = key.replace(/\r/g, '\n');
  return key;
}

// ============================================
// HELPER: OBTENER SERVICE ACCOUNT DESDE BASE64 ENV
// Lee FIREBASE_SERVICE_ACCOUNT_JSON_BASE64, decodifica base64 → utf8 → JSON.
// Devuelve el objeto serviceAccount o null si no disponible/inválido.
// ============================================
function getServiceAccountFromBase64Env() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!raw || !raw.trim()) {
    return null;
  }

  let serviceAccount;
  try {
    const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  } catch (e) {
    console.error('[FCM] ❌ FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 inválida:', e.message);
    return null;
  }

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    console.error('[FCM] ❌ Credenciales incompletas (project_id/client_email/private_key)');
    return null;
  }

  return serviceAccount;
}

// ============================================
// HELPER: OBTENER SERVICE ACCOUNT DESDE JSON ENV
// Lee FIREBASE_SERVICE_ACCOUNT_JSON (JSON completo) y valida campos.
// Devuelve el objeto serviceAccount o null si no disponible/inválido.
// ============================================
function getServiceAccountFromJsonEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) {
    return null;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw.trim());
  } catch (e) {
    console.error('[FCM] ❌ FIREBASE_SERVICE_ACCOUNT_JSON inválida:', e.message);
    return null;
  }

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    console.error('[FCM] ❌ Credenciales incompletas (project_id/client_email/private_key)');
    return null;
  }

  return serviceAccount;
}

// Inicializar Firebase Admin
if (!admin.apps.length) {
  // 1) Intentar con FIREBASE_SERVICE_ACCOUNT_JSON_BASE64
  const serviceAccountFromBase64 = getServiceAccountFromBase64Env();
  if (serviceAccountFromBase64) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountFromBase64),
    });
    console.log('[FCM] ✅ Firebase Admin inicializado con FIREBASE_SERVICE_ACCOUNT_JSON_BASE64');
  } else {
    // 2) Intentar con FIREBASE_SERVICE_ACCOUNT_JSON
    const serviceAccount = getServiceAccountFromJsonEnv();
    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('[FCM] ✅ Firebase Admin inicializado con FIREBASE_SERVICE_ACCOUNT_JSON');
    } else {
      // 3) Fallback: credenciales legacy por variables separadas
      console.log('[FCM] ⚠️ Usando credenciales legacy por variables separadas');

      const projectId   = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const rawKey      = process.env.FIREBASE_PRIVATE_KEY;

      if (!projectId || !clientEmail || !rawKey) {
        console.error('❌ Faltan variables de entorno para Firebase Admin:');
        if (!projectId)   console.error('   - FIREBASE_PROJECT_ID no está definida');
        if (!clientEmail) console.error('   - FIREBASE_CLIENT_EMAIL no está definida');
        if (!rawKey)      console.error('   - FIREBASE_PRIVATE_KEY no está definida');
        process.exit(1);
      }

      const privateKey = normalizePrivateKey(rawKey);

      if (!privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) {
        console.error('❌ FIREBASE_PRIVATE_KEY no comienza con -----BEGIN PRIVATE KEY-----');
        process.exit(1);
      }

      if (!privateKey.trimEnd().endsWith('-----END PRIVATE KEY-----')) {
        console.warn('⚠️  FIREBASE_PRIVATE_KEY no termina con -----END PRIVATE KEY-----. Se intentará enviar de todas formas.');
      }

      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }
  }
}

// Obtener argumentos
const args = process.argv.slice(2);

if (args.length < 3) {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         ENVIAR NOTIFICACIÓN PUSH - SALA DE JUEGOS          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Uso:');
  console.log('  node send-notification.js <fcm-token> "Título" "Mensaje"');
  console.log('');
  console.log('Ejemplo:');
  console.log('  node send-notification.js "fcm-token-aqui" "¡Hola!" "Tienes un nuevo mensaje"');
  console.log('');
  console.log('Para obtener el FCM Token:');
  console.log('  1. Abre la app en tu celular');
  console.log('  2. Abre la consola del navegador (chrome://inspect)');
  console.log('  3. Busca: "[FCM] Token obtenido:"');
  console.log('');
  process.exit(1);
}

const [fcmToken, title, body] = args;

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║         ENVIANDO NOTIFICACIÓN PUSH...                      ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('');
console.log('📱 Token:', fcmToken.substring(0, 30) + '...');
console.log('📝 Título:', title);
console.log('💬 Mensaje:', body);
console.log('');

// Enviar notificación
const message = {
  notification: {
    title: title,
    body: body
  },
  data: {
    type: 'notification',
    timestamp: Date.now().toString(),
    click_action: 'FLUTTER_NOTIFICATION_CLICK'
  },
  token: fcmToken,
  android: {
    priority: 'high',
    notification: {
      sound: 'default',
      channelId: 'default_channel'
    }
  },
  apns: {
    payload: {
      aps: {
        sound: 'default',
        badge: 1
      }
    }
  }
};

admin.messaging().send(message)
  .then((response) => {
    console.log('✅ Notificación enviada exitosamente!');
    console.log('🆔 Message ID:', response);
    console.log('');
    console.log('📲 La notificación debería aparecer en tu celular en segundos.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error al enviar notificación:');
    console.error(error.message);
    console.log('');
    console.log('💡 Posibles causas:');
    console.log('   - El FCM Token es inválido o ha expirado');
    console.log('   - El dispositivo no tiene conexión a internet');
    console.log('   - Las notificaciones están deshabilitadas en el dispositivo');
    process.exit(1);
  });
