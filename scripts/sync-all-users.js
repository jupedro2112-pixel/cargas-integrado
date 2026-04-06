
#!/usr/bin/env node
// ============================================
// SINCRONIZACIÓN MASIVA - IMPORTAR TODOS LOS USUARIOS DE JUGAYGANA
// ============================================

require('dotenv').config();
const { connectDB, disconnectDB, User } = require('../config/database');
const jugaygana = require('../jugaygana');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Generar número de cuenta
function generateAccountNumber() {
  return 'ACC' + Date.now().toString().slice(-8) + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// Obtener todos los usuarios de JUGAYGANA (paginado)
async function getAllJugayganaUsers() {
  const allUsers = [];
  let page = 1;
  const pageSize = 100;
  let hasMore = true;

  console.log('🔍 Obteniendo usuarios de JUGAYGANA...');

  while (hasMore && page <= 1000) { // Límite de seguridad
    try {
      const sessionOk = await jugaygana.ensureSession();
      if (!sessionOk) {
        console.error('❌ No se pudo establecer sesión con JUGAYGANA');
        break;
      }

      // Usar ShowUsers sin filtro para obtener todos
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 30000
      });

      let data = resp.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
        } catch (_) {}
      }

      const users = data.users || data.data || [];
      
      if (users.length === 0) {
        hasMore = false;
      } else {
        allUsers.push(...users);
        console.log(`📄 Página ${page}: ${users.length} usuarios (Total: ${allUsers.length})`);
        page++;
        
        // Delay para no saturar la API
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (error) {
      console.error(`❌ Error en página ${page}:`, error.message);
      hasMore = false;
    }
  }

  return allUsers;
}

// Sincronizar usuarios
async function syncUsers() {
  console.log('🚀 INICIANDO SINCRONIZACIÓN MASIVA\n');

  // Conectar a MongoDB
  const dbConnected = await connectDB();
  if (!dbConnected) {
    console.error('❌ No se pudo conectar a la base de datos');
    process.exit(1);
  }

  // Verificar IP
  console.log('🌐 Verificando IP...');
  await jugaygana.logProxyIP();

  // Obtener usuarios de JUGAYGANA
  const jugayganaUsers = await getAllJugayganaUsers();
  console.log(`\n📊 Total usuarios en JUGAYGANA: ${jugayganaUsers.length}`);

  if (jugayganaUsers.length === 0) {
    console.log('⚠️ No se encontraron usuarios para sincronizar');
    await disconnectDB();
    process.exit(0);
  }

  // Estadísticas
  let created = 0;
  let updated = 0;
  let errors = 0;
  let skipped = 0;

  // Procesar en lotes de 100 para no saturar
  const batchSize = 100;
  const totalBatches = Math.ceil(jugayganaUsers.length / batchSize);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batch = jugayganaUsers.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
    
    console.log(`\n📦 Lote ${batchIndex + 1}/${totalBatches} (${batch.length} usuarios)`);

    for (const jgUser of batch) {
      try {
        const username = jgUser.user_name;
        const userId = jgUser.user_id;
        
        if (!username) {
          skipped++;
          continue;
        }

        // Verificar si ya existe
        const existingUser = await User.findOne({ 
          $or: [
            { username: username },
            { jugayganaUserId: userId }
          ]
        });

        if (existingUser) {
          // Actualizar si es necesario
          if (!existingUser.jugayganaUserId) {
            existingUser.jugayganaUserId = userId;
            existingUser.jugayganaUsername = username;
            existingUser.jugayganaSyncStatus = 'linked';
            existingUser.source = 'jugaygana';
            await existingUser.save();
            updated++;
          } else {
            skipped++;
          }
        } else {
          // Crear nuevo usuario
          const hashedPassword = await bcrypt.hash('asd123', 10);
          
          await User.create({
            username: username,
            password: hashedPassword,
            email: jgUser.user_email || null,
            phone: jgUser.user_phone || null,
            role: 'user',
            accountNumber: generateAccountNumber(),
            balance: 0,
            isActive: true,
            jugayganaUserId: userId,
            jugayganaUsername: username,
            jugayganaSyncStatus: 'imported',
            source: 'jugaygana'
          });
          created++;
        }
      } catch (error) {
        console.error(`❌ Error procesando ${jgUser.user_name}:`, error.message);
        errors++;
      }
    }

    // Progreso
    const progress = Math.round(((batchIndex + 1) / totalBatches) * 100);
    console.log(`⏳ Progreso: ${progress}% | Creados: ${created} | Actualizados: ${updated} | Saltados: ${skipped} | Errores: ${errors}`);
  }

  // Resumen final
  console.log('\n' + '='.repeat(50));
  console.log('✅ SINCRONIZACIÓN COMPLETADA');
  console.log('='.repeat(50));
  console.log(`📊 Total procesados: ${jugayganaUsers.length}`);
  console.log(`✅ Creados: ${created}`);
  console.log(`🔄 Actualizados: ${updated}`);
  console.log(`⏭️ Saltados: ${skipped}`);
  console.log(`❌ Errores: ${errors}`);
  console.log('='.repeat(50));

  // Contar totales en DB
  const totalInDB = await User.countDocuments();
  const jugayganaInDB = await User.countDocuments({ source: 'jugaygana' });
  console.log(`\n📁 Total usuarios en base de datos: ${totalInDB}`);
  console.log(`🎰 Usuarios de JUGAYGANA: ${jugayganaInDB}`);

  await disconnectDB();
  process.exit(0);
}

// Ejecutar
syncUsers().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});