// ============================================
// SERVICIO DE NOTIFICACIONES PUSH - FCM
// ============================================

const admin = require('firebase-admin');
const { createPrivateKey } = require('crypto');

// Variable para tracking de inicialización
let isInitialized = false;

// ============================================
// HELPER: DETECTAR TOKEN INVÁLIDO/NO REGISTRADO
// Cubre todos los códigos de error que FCM devuelve para
// tokens que ya no son válidos y deben borrarse de la BD.
// ROOT CAUSE FIX (Issue #3): anteriormente solo se detectaban
// algunos errores. Ahora se cubren también 'unregistered',
// 'UNREGISTERED', 'invalid-argument', y variaciones de case.
// ============================================
function isInvalidTokenError(errorMsg, errorCode) {
  const msg  = (errorMsg  || '').toLowerCase();
  const code = (errorCode || '').toLowerCase();
  return (
    msg.includes('registration-token-not-registered') ||
    msg.includes('invalid-registration-token')        ||
    msg.includes('requested entity was not found')    ||
    msg.includes('notregistered')                     ||
    msg.includes('not_registered')                    ||
    msg.includes('unregistered')                      ||
    msg.includes('mismatched-credential')             ||
    code.includes('registration-token-not-registered') ||
    code.includes('invalid-registration-token')        ||
    code.includes('unregistered')                      ||
    code === 'messaging/invalid-argument'
  );
}

// ============================================
// HELPER: NORMALIZAR FIREBASE PRIVATE KEY
// Maneja los distintos formatos en que AWS Elastic Beanstalk
// puede almacenar FIREBASE_PRIVATE_KEY:
//   - literal \\n (doble escape)
//   - \r\n (saltos Windows)
//   - \r solos (Mac clásico)
//   - comillas externas (simples o dobles)
//   - espacios/saltos al inicio o final
// ============================================
function normalizePrivateKey(raw) {
  // 1. Convertir a string y quitar espacios extremos
  let key = String(raw).trim();

  // 2. Eliminar comillas externas si las tiene (simples o dobles)
  if ((key.startsWith('"') && key.endsWith('"')) ||
      (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }

  // 3. Convertir \\n (literal backslash-n doble escapado) → \n real
  key = key.replace(/\\n/g, '\n');

  // 4. Normalizar saltos de línea Windows (\r\n) → \n
  key = key.replace(/\r\n/g, '\n');

  // 5. Normalizar retornos de carro solos (\r) → \n
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

// ============================================
// INICIALIZAR FIREBASE ADMIN
// Lee credenciales desde variables de entorno de AWS Elastic Beanstalk.
// NO lee ningún archivo .json del proyecto.
// Prioridad:
//   1) FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 (primaria)
//   2) FIREBASE_SERVICE_ACCOUNT_JSON (fallback)
//   3) Legacy: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// ============================================
function initializeFirebase() {
  // Si Firebase Admin ya fue inicializado por otro módulo/importación,
  // adoptarlo sin intentar inicializar de nuevo.
  if (admin.apps && admin.apps.length > 0) {
    if (!isInitialized) {
      isInitialized = true;
      console.log('[FCM] ✅ Firebase Admin ya estaba inicializado (adoptando app existente)');
    }
    return true;
  }

  if (isInitialized) {
    return true;
  }

  // ---- 1) Intentar inicialización con FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 ----
  const serviceAccountFromBase64 = getServiceAccountFromBase64Env();
  if (serviceAccountFromBase64) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountFromBase64),
      });

      isInitialized = true;
      console.log('[FCM] ✅ Firebase Admin inicializado con FIREBASE_SERVICE_ACCOUNT_JSON_BASE64');
      return true;
    } catch (error) {
      if (error.code === 'app/duplicate-app' || (error.message && error.message.includes('already exists'))) {
        isInitialized = true;
        console.log('[FCM] ✅ Firebase Admin ya inicializado (app/duplicate-app detectado)');
        return true;
      }
      console.error('[FCM] ❌ Error al inicializar Firebase Admin con FIREBASE_SERVICE_ACCOUNT_JSON_BASE64:', error.message);
      // Fall through to next method
    }
  }

  // ---- 2) Intentar inicialización con FIREBASE_SERVICE_ACCOUNT_JSON ----
  const serviceAccount = getServiceAccountFromJsonEnv();
  if (serviceAccount) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });

      isInitialized = true;
      console.log('[FCM] ✅ Firebase Admin inicializado con FIREBASE_SERVICE_ACCOUNT_JSON');
      return true;
    } catch (error) {
      if (error.code === 'app/duplicate-app' || (error.message && error.message.includes('already exists'))) {
        isInitialized = true;
        console.log('[FCM] ✅ Firebase Admin ya inicializado (app/duplicate-app detectado)');
        return true;
      }
      console.error('[FCM] ❌ Error al inicializar Firebase Admin con FIREBASE_SERVICE_ACCOUNT_JSON:', error.message);
      return false;
    }
  }

  // ---- Fallback: credenciales legacy por variables separadas ----
  console.log('[FCM] ⚠️ Usando credenciales legacy por variables separadas');

  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey      = process.env.FIREBASE_PRIVATE_KEY;

  // ---- Logs diagnóstico seguros (sin exponer la clave) ----
  console.log('[FCM] Diagnóstico FIREBASE_PRIVATE_KEY:');
  console.log('[FCM]   Existe:', !!rawKey);
  if (rawKey) {
    console.log('[FCM]   Longitud raw:', rawKey.length);
    console.log('[FCM]   Contiene \\\\n literal:', rawKey.includes('\\n'));
    console.log('[FCM]   Contiene saltos reales:', rawKey.includes('\n'));
  }

  if (!projectId || !clientEmail || !rawKey) {
    console.error('[FCM] ❌ Faltan variables de entorno para Firebase Admin:');
    if (!projectId)   console.error('[FCM]   - FIREBASE_PROJECT_ID no está definida');
    if (!clientEmail) console.error('[FCM]   - FIREBASE_CLIENT_EMAIL no está definida');
    if (!rawKey)      console.error('[FCM]   - FIREBASE_PRIVATE_KEY no está definida');
    return false;
  }

  const privateKey = normalizePrivateKey(rawKey);

  // ---- Validación defensiva del formato PEM ----
  console.log('[FCM]   Longitud normalizada:', privateKey.length);
  console.log('[FCM]   Empieza con BEGIN:', privateKey.startsWith('-----BEGIN PRIVATE KEY-----'));
  console.log('[FCM]   Termina con END:', privateKey.trimEnd().endsWith('-----END PRIVATE KEY-----'));

  if (!privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) {
    console.error('[FCM] ❌ FIREBASE_PRIVATE_KEY no comienza con -----BEGIN PRIVATE KEY-----');
    console.error('[FCM]   Verifica el valor de FIREBASE_PRIVATE_KEY en las env vars de AWS EB');
    return false;
  }

  if (!privateKey.trimEnd().endsWith('-----END PRIVATE KEY-----')) {
    console.error('[FCM] ❌ FIREBASE_PRIVATE_KEY no termina con -----END PRIVATE KEY-----');
    console.error('[FCM]   La clave está incompleta. Verifica FIREBASE_PRIVATE_KEY en AWS EB.');
    return false;
  }

  if (privateKey.length < 100) {
    console.error('[FCM] ❌ FIREBASE_PRIVATE_KEY tiene longitud sospechosamente corta:', privateKey.length);
    return false;
  }

  // ---- Validación criptográfica: verificar que la clave sea RSA válida ----
  // ROOT CAUSE FIX: si la clave no puede parsearse como RSA private key,
  // Firebase Admin inicializa sin error pero falla al primer uso con
  // "secretOrPrivateKey must be an asymmetric key when using RS256",
  // dejando isRefreshing=true y promiseToCachedToken_=undefined,
  // lo que en llamadas subsiguientes produce "Cannot read properties of
  // undefined (reading 'then')".
  try {
    // Solo validamos que la clave sea parseable; el resultado no se reutiliza
    // porque Firebase Admin SDK genera su propio objeto de clave internamente.
    createPrivateKey(privateKey);
  } catch (cryptoErr) {
    console.error('[FCM] ❌ FIREBASE_PRIVATE_KEY no es una clave RSA privada válida:', cryptoErr.message);
    console.error('[FCM]   Asegúrate de que FIREBASE_PRIVATE_KEY contenga la clave PKCS#8 completa con saltos de línea reales.');
    return false;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });

    isInitialized = true;
    console.log('[FCM] ✅ Firebase Admin inicializado correctamente con env vars');
    return true;
  } catch (error) {
    // Si ya existe una app por defecto (e.g. race condition entre módulos),
    // adoptarla en lugar de fallar.
    if (error.code === 'app/duplicate-app' || (error.message && error.message.includes('already exists'))) {
      isInitialized = true;
      console.log('[FCM] ✅ Firebase Admin ya inicializado (app/duplicate-app detectado)');
      return true;
    }
    console.error('[FCM] ❌ Error al inicializar Firebase Admin:', error.message);
    return false;
  }
}

// ============================================
// ENVIAR NOTIFICACIÓN A UN USUARIO
// ============================================
async function sendNotificationToUser(fcmToken, title, body, data = {}) {
  if (!isInitialized) {
    const initialized = initializeFirebase();
    if (!initialized) {
      return { success: false, error: 'Firebase Admin no inicializado' };
    }
  }

  // Comprobación defensiva adicional: asegurarse de que haya una app Firebase activa.
  // Esto cubre el caso donde isInitialized quedó en true pero la app fue removida.
  if (!admin.apps || admin.apps.length === 0) {
    console.error('[FCM] ❌ No hay apps Firebase activas pese a isInitialized=true. Reiniciando...');
    isInitialized = false;
    return { success: false, error: 'Firebase Admin perdió su estado. Intente de nuevo en un momento.' };
  }

  try {
    console.log('[FCM] Enviando notificación...');
    console.log('[FCM] Token preview:', fcmToken ? fcmToken.substring(0, 30) + '...' : 'null');
    console.log('[FCM] Título:', title);
    console.log('[FCM] Cuerpo:', body);

    // Convertir todos los valores de data a string (requisito de FCM),
    // omitiendo entradas con valores null/undefined.
    const safeData = {};
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (v !== null && v !== undefined) {
          safeData[k] = String(v);
        }
      }
    }

    const message = {
      notification: {
        title: String(title || ''),
        body: String(body || '')
      },
      data: {
        ...safeData,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        sound: 'default'
      },
      token: fcmToken,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'default_channel',
          priority: 'high'
        }
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: String(title || ''),
              body: String(body || '')
            },
            sound: 'default',
            badge: 1
          }
        },
        headers: {
          'apns-priority': '10'
        }
      },
      webpush: {
        notification: {
          title: String(title || ''),
          body: String(body || ''),
          icon: '/icons/icon-192x192.png',
          badge: '/icons/icon-72x72.png',
          requireInteraction: true,
          vibrate: [200, 100, 200]
        },
        fcm_options: {
          link: '/'
        }
      }
    };

    // Obtener el servicio de mensajería de forma defensiva
    const messagingService = admin.messaging();
    if (!messagingService || typeof messagingService.send !== 'function') {
      console.error('[FCM] ❌ Firebase Messaging no disponible');
      return { success: false, error: 'Firebase Messaging no disponible' };
    }

    const response = await messagingService.send(message);
    console.log('[FCM] ✅ Notificación enviada exitosamente:', response);
    return { success: true, messageId: response };
  } catch (error) {
    console.error('[FCM] ❌ Error al enviar notificación:', error.message);
    console.error('[FCM] Error code:', error.code);

    // ROOT CAUSE FIX: si el error es de credencial RSA (clave privada inválida),
    // el Firebase Admin SDK deja isRefreshing=true y promiseToCachedToken_=undefined,
    // lo que causa "Cannot read properties of undefined (reading 'then')" en llamadas
    // posteriores. Al resetear isInitialized y borrar la app, forzamos una
    // re-evaluación limpia en el próximo intento.
    const isCredentialError = error.message && (
      error.message.includes('secretOrPrivateKey') ||
      error.message.includes('Cannot read properties of undefined (reading \'then\')')
    );
    if (isCredentialError) {
      console.error('[FCM] ❌ Error de credencial detectado - reseteando estado de Firebase Admin');
      isInitialized = false;
      try {
        if (admin.apps && admin.apps.length > 0) {
          await admin.app().delete();
          console.log('[FCM] App Firebase borrada para forzar re-inicialización');
        }
      } catch (deleteErr) {
        console.error('[FCM] Error al borrar app Firebase:', deleteErr.message);
      }
    }

    return { 
      success: false, 
      error: error.message, 
      code: error.code,
      // Indicar explícitamente si el token debe borrarse
      invalidToken: isInvalidTokenError(error.message, error.code)
    };
  }
}

// ============================================
// ENVIAR NOTIFICACIÓN A MÚLTIPLES USUARIOS
// ============================================
async function sendNotificationToMultiple(fcmTokens, title, body, data = {}) {
  if (!isInitialized) {
    const initialized = initializeFirebase();
    if (!initialized) {
      return { success: false, error: 'Firebase Admin no inicializado' };
    }
  }

  try {
    // Crear mensajes individuales para cada token
    const messages = fcmTokens.map(token => ({
      notification: {
        title: title,
        body: body
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        sound: 'default'
      },
      token: token,
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
    }));

    // Usar sendEach (método nuevo) o sendAll (método antiguo)
    let response;
    if (admin.messaging().sendEach) {
      // Firebase Admin SDK v11+
      response = await admin.messaging().sendEach(messages);
    } else if (admin.messaging().sendAll) {
      // Firebase Admin SDK v10
      response = await admin.messaging().sendAll(messages);
    } else {
      // Fallback: enviar uno por uno
      const results = [];
      for (const message of messages) {
        try {
          await admin.messaging().send(message);
          results.push({ success: true });
        } catch (e) {
          results.push({ success: false, error: e });
        }
      }
      response = {
        successCount: results.filter(r => r.success).length,
        failureCount: results.filter(r => !r.success).length,
        responses: results
      };
    }

    console.log(`[FCM] ✅ Notificaciones enviadas: ${response.successCount} exitosas, ${response.failureCount} fallidas`);

    // Identificar tokens inválidos para que el caller pueda limpiarlos.
    // Nota: Firebase Admin SDK garantiza que responses[i] corresponde a messages[i]
    // (ver documentación de sendEach/sendAll: la respuesta conserva el orden de entrada).
    const invalidTokens = [];
    if (response.responses) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorMsg  = resp.error?.message || 'Error desconocido';
          const errorCode = resp.error?.code    || '';
          if (isInvalidTokenError(errorMsg, errorCode)) {
            invalidTokens.push(fcmTokens[idx]);
          }
        }
      });
    }

    return { 
      success: true, 
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses,
      invalidTokens  // lista de tokens que deben borrarse
    };
  } catch (error) {
    console.error('[FCM] ❌ Error al enviar notificaciones:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// ENVIAR NOTIFICACIÓN A TÓPICO
// ============================================
async function sendNotificationToTopic(topic, title, body, data = {}) {
  if (!isInitialized) {
    const initialized = initializeFirebase();
    if (!initialized) {
      return { success: false, error: 'Firebase Admin no inicializado' };
    }
  }

  try {
    const message = {
      notification: {
        title: title,
        body: body
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        sound: 'default'
      },
      topic: topic,
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

    const response = await admin.messaging().send(message);
    console.log('[FCM] ✅ Notificación enviada al tópico:', response);
    return { success: true, messageId: response };
  } catch (error) {
    console.error('[FCM] ❌ Error al enviar notificación al tópico:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// SUSCRIBIR USUARIO A TÓPICO
// ============================================
async function subscribeToTopic(fcmToken, topic) {
  if (!isInitialized) {
    const initialized = initializeFirebase();
    if (!initialized) {
      return { success: false, error: 'Firebase Admin no inicializado' };
    }
  }

  try {
    const response = await admin.messaging().subscribeToTopic([fcmToken], topic);
    console.log(`[FCM] ✅ Suscripción exitosa al tópico ${topic}:`, response);
    return { success: true, response };
  } catch (error) {
    console.error('[FCM] ❌ Error al suscribir al tópico:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// DESUSCRIBIR USUARIO DE TÓPICO
// ============================================
async function unsubscribeFromTopic(fcmToken, topic) {
  if (!isInitialized) {
    const initialized = initializeFirebase();
    if (!initialized) {
      return { success: false, error: 'Firebase Admin no inicializado' };
    }
  }

  try {
    const response = await admin.messaging().unsubscribeFromTopic([fcmToken], topic);
    console.log(`[FCM] ✅ Desuscripción exitosa del tópico ${topic}:`, response);
    return { success: true, response };
  } catch (error) {
    console.error('[FCM] ❌ Error al desuscribir del tópico:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// ENVIAR NOTIFICACIÓN MASIVA A TODOS LOS USUARIOS
// ============================================
async function sendNotificationToAllUsers(UserModel, title, body, data = {}, filter = {}) {
  if (!isInitialized) {
    const initialized = initializeFirebase();
    if (!initialized) {
      return { success: false, error: 'Firebase Admin no inicializado' };
    }
  }

  try {
    // Buscar todos los usuarios que tienen fcmToken
    const query = { 
      fcmToken: { $exists: true, $ne: null },
      ...filter
    };
    
    const users = await UserModel.find(query).select('fcmToken username').lean();
    
    if (users.length === 0) {
      return { success: false, error: 'No hay usuarios con tokens FCM registrados' };
    }

    console.log(`[FCM] Enviando notificación a ${users.length} usuarios...`);

    // Firebase permite enviar hasta 500 mensajes por solicitud con sendEach
    const BATCH_SIZE = 500;
    let totalSuccess = 0;
    let totalFailure = 0;
    const failedTokens = [];

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      
      // Crear mensajes individuales para cada token
      const messages = batch.map(u => ({
        notification: {
          title: title,
          body: body
        },
        data: {
          ...data,
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          sound: 'default'
        },
        token: u.fcmToken,
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
      }));

      let response;
      
      // Usar el método disponible según la versión de Firebase Admin
      if (admin.messaging().sendEach) {
        // Firebase Admin SDK v11+
        response = await admin.messaging().sendEach(messages);
      } else if (admin.messaging().sendAll) {
        // Firebase Admin SDK v10
        response = await admin.messaging().sendAll(messages);
      } else {
        // Fallback: enviar uno por uno
        const results = [];
        for (const message of messages) {
          try {
            await admin.messaging().send(message);
            results.push({ success: true });
          } catch (e) {
            results.push({ success: false, error: e });
          }
        }
        response = {
          successCount: results.filter(r => r.success).length,
          failureCount: results.filter(r => !r.success).length,
          responses: results
        };
      }

      totalSuccess += response.successCount;
      totalFailure += response.failureCount;

      // Registrar tokens fallidos y borrar los inválidos automáticamente
      const tokensToDelete = [];
      if (response.responses) {
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errorMsg  = resp.error?.message || 'Error desconocido';
            const errorCode = resp.error?.code    || '';
            
            failedTokens.push({
              token: batch[idx].fcmToken,
              username: batch[idx].username,
              error: errorMsg,
              code: errorCode
            });
            
            // Usar el helper compartido para detectar todos los tipos de token inválido
            if (isInvalidTokenError(errorMsg, errorCode)) {
              tokensToDelete.push({
                username: batch[idx].username,
                token: batch[idx].fcmToken
              });
            }
          }
        });
      }

      // Borrar tokens inválidos de la base de datos
      if (tokensToDelete.length > 0) {
        console.log(`[FCM] 🧹 Borrando ${tokensToDelete.length} tokens inválidos...`);
        for (const item of tokensToDelete) {
          try {
            await UserModel.updateOne(
              { username: item.username },
              { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
            );
            console.log(`[FCM] 🗑️ Token borrado para: ${item.username}`);
          } catch (e) {
            console.error(`[FCM] ❌ Error borrando token de ${item.username}:`, e.message);
          }
        }
      }

      console.log(`[FCM] Lote ${Math.floor(i / BATCH_SIZE) + 1}: ${response.successCount} exitosas, ${response.failureCount} fallidas`);
    }

    console.log(`[FCM] ✅ Total: ${totalSuccess} exitosas, ${totalFailure} fallidas de ${users.length} usuarios`);
    
    return { 
      success: true, 
      totalUsers: users.length,
      successCount: totalSuccess,
      failureCount: totalFailure,
      failedTokens: failedTokens.slice(0, 10), // Solo mostrar los primeros 10 errores
      cleanedTokens: failedTokens.filter(t => 
        t.error.includes('NotRegistered') || 
        t.error.includes('Requested entity was not found')
      ).length
    };
  } catch (error) {
    console.error('[FCM] ❌ Error al enviar notificaciones masivas:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// ENVIAR NOTIFICACIÓN A USUARIOS ESPECÍFICOS POR USERNAME
// ============================================
async function sendNotificationToUsernames(UserModel, usernames, title, body, data = {}) {
  if (!isInitialized) {
    const initialized = initializeFirebase();
    if (!initialized) {
      return { success: false, error: 'Firebase Admin no inicializado' };
    }
  }

  try {
    // Buscar usuarios por username
    const users = await UserModel.find({
      username: { $in: usernames },
      fcmToken: { $exists: true, $ne: null }
    }).select('fcmToken username').lean();

    if (users.length === 0) {
      return { success: false, error: 'Ninguno de los usuarios tiene token FCM' };
    }

    const tokens = users.map(u => u.fcmToken);
    
    console.log(`[FCM] Enviando notificación a ${users.length} usuarios específicos...`);

    const result = await sendNotificationToMultiple(tokens, title, body, data);
    result.targetUsers = users.map(u => u.username);

    // Limpiar tokens inválidos detectados por sendNotificationToMultiple
    if (result.invalidTokens && result.invalidTokens.length > 0) {
      console.log(`[FCM] 🧹 Borrando ${result.invalidTokens.length} tokens inválidos de usuarios específicos...`);
      for (const badToken of result.invalidTokens) {
        try {
          await UserModel.updateOne(
            { fcmToken: badToken },
            { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
          );
          console.log(`[FCM] 🗑️ Token inválido borrado: ${badToken.substring(0, 20)}...`);
        } catch (e) {
          console.error(`[FCM] ❌ Error borrando token inválido:`, e.message);
        }
      }
      result.cleanedTokens = result.invalidTokens.length;
    }
    
    return result;
  } catch (error) {
    console.error('[FCM] ❌ Error al enviar notificaciones:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// INICIALIZAR AL CARGAR
// ============================================
initializeFirebase();

module.exports = {
  sendNotificationToUser,
  sendNotificationToMultiple,
  sendNotificationToAllUsers,
  sendNotificationToUsernames,
  sendNotificationToTopic,
  subscribeToTopic,
  unsubscribeFromTopic,
  initializeFirebase
};
