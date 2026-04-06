# 🔥 Guía Paso a Paso - Configurar Firebase con tu Página

## 📋 Paso 1: Crear Proyecto en Firebase

### 1.1 Ir a Firebase Console
1. Abre: https://console.firebase.google.com/
2. Inicia sesión con tu cuenta de Google
3. Haz clic en **"Crear un proyecto"**

### 1.2 Configurar el Proyecto
1. **Nombre del proyecto:** `sala-de-juegos` (o el que quieras)
2. Haz clic en **"Continuar"**
3. **Google Analytics:** Puedes desactivarlo (opcional)
4. Haz clic en **"Crear proyecto"**
5. Espera a que se cree y haz clic en **"Continuar"**

---

## 📋 Paso 2: Agregar App Web a Firebase

### 2.1 Registrar App
1. En la página principal del proyecto, haz clic en el icono **"</>"** (Web)
2. **Apodo de la app:** `sala-de-juegos-web`
3. Haz clic en **"Registrar app"**

### 2.2 Guardar la Configuración
Te aparecerá un código como este:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyAjZuVIxNY-SrnihkyNVupZ8AhXX6qxAxY",
  authDomain: "saladejuegos-673fa.firebaseapp.com",
  projectId: "saladejuegos-673fa",
  storageBucket: "saladejuegos-673fa.firebasestorage.app",
  messagingSenderId: "553123191180",
  appId: "1:553123191180:web:277eb460ef78dab8525ea9",
  measurementId: "G-3ZJRT0NCTE"
};
```

**Guarda estos datos, los necesitarás.**

---

## 📋 Paso 3: Obtener VAPID Key (para notificaciones push)

### 3.1 Ir a Configuración del Proyecto
1. Haz clic en el **engranaje** (Configuración del proyecto)
2. Ve a la pestaña **"Cloud Messaging"**

### 3.2 Generar Par de Claves
1. Desplázate hasta **"Configuración de Web Push"**
2. Haz clic en **"Generar par de claves"**
3. Aparecerá una clave larga como esta:
   ```
   BHnnRx4J6u3aYBK_JExhceybaNNLhMEGosFSFau0niy0cSsW1qw02oZqyFFfOH-Hnr61mQq7TOVcM3TW58eVQRc
   ```
4. **Guarda esta clave (VAPID Key)**

---

## 📋 Paso 4: Descargar Credenciales de Admin (para el servidor)

### 4.1 Ir a Cuentas de Servicio
1. En Configuración del proyecto, ve a **"Cuentas de servicio"**
2. Haz clic en **"Generar nueva clave privada"**
3. Se descargará un archivo JSON
4. **Renómbralo a:** `firebase-service-account.json`

### 4.2 Subir al Servidor
Sube este archivo a la **raíz de tu proyecto** (al lado de `server.js`):

```
proyecto/
├── server.js
├── firebase-service-account.json  ← AQUÍ
├── package.json
└── ...
```

---

## 📋 Paso 5: Actualizar el Código de tu App

### 5.1 Abrir `public/index.html`
Busca esta sección (ya está en el código que te di):

```javascript
const firebaseConfig = {
    apiKey: "TU_API_KEY",
    authDomain: "TU_AUTH_DOMAIN",
    projectId: "TU_PROJECT_ID",
    storageBucket: "TU_STORAGE_BUCKET",
    messagingSenderId: "TU_MESSAGING_SENDER_ID",
    appId: "TU_APP_ID"
};
```

**Reemplaza con tus datos de Firebase.**

### 5.2 Actualizar VAPID Key
Busca esta línea:
```javascript
const VAPID_KEY = 'TU_VAPID_KEY';
```

**Reemplaza con tu VAPID Key.**

---

## 📋 Paso 6: Instalar Firebase Admin en el Servidor

### 6.1 Conectar por SSH a tu servidor
```bash
ssh usuario@tuservidor.com
```

### 6.2 Ir a la carpeta del proyecto
```bash
cd /ruta/a/tu/proyecto
```

### 6.3 Instalar Firebase Admin
```bash
npm install firebase-admin
```

### 6.4 Verificar que el archivo de credenciales está
```bash
ls -la firebase-service-account.json
```

Debe mostrar el archivo.

---

## 📋 Paso 7: Reiniciar el Servidor

### 7.1 Detener el servidor actual
```bash
# Si usas pm2
pm2 stop server

# O si lo corres manualmente, presiona Ctrl+C
```

### 7.2 Iniciar el servidor
```bash
# Si usas pm2
pm2 start server.js

# O manualmente
node server.js
```

---

## 📋 Paso 8: Probar que Funciona

### 8.1 Abrir la app en Chrome
1. Abre Chrome (en Windows o Android)
2. Ve a: `https://tudominio.com`
3. Abre la consola (F12 → Console)

### 8.2 Verificar mensajes
Debes ver:
```
[PWA] Service Worker registrado
[FCM] Token obtenido: eyJhbGciOiJIUzI1NiIs...
```

### 8.3 Hacer login
1. Ingresa tu usuario y contraseña
2. Haz clic en "Ingresar"
3. En la consola debe aparecer:
   ```
   [FCM] ✅ Token registrado en el servidor
   ```

### 8.4 Verificar en MongoDB
```javascript
db.users.find({ username: "tu_usuario" }, { fcmToken: 1 })
```

Debe mostrar el campo `fcmToken` con el token.

---

## 📋 Paso 9: Enviar Notificación de Prueba

### 9.1 Abrir el panel de admin
Ve a: `https://tudominio.com/admin-panel.html`

### 9.2 Ver estadísticas
Debe mostrar:
- 👥 Total Usuarios: X
- 📱 Con App: 1 (o más)

### 9.3 Enviar notificación
1. Escribe un título
2. Escribe un mensaje
3. Haz clic en "Enviar a Todos"
4. ¡Deberías recibir la notificación!

---

## 🎯 Resumen de Configuración

| Dato | Dónde lo obtienes | Dónde lo usas |
|------|-------------------|---------------|
| `apiKey` | Firebase Console → Configuración del proyecto | `index.html` |
| `authDomain` | Firebase Console → Configuración del proyecto | `index.html` |
| `projectId` | Firebase Console → Configuración del proyecto | `index.html` + servidor |
| `VAPID Key` | Firebase Console → Cloud Messaging → Web Push | `index.html` |
| `firebase-service-account.json` | Firebase Console → Cuentas de servicio | Servidor (raíz del proyecto) |

---

## ❓ Si algo falla

### "Firebase no se carga"
→ Usa Chrome (no Firefox). Desactiva adblockers.

### "Firebase Admin no inicializado"
→ Verifica que `firebase-service-account.json` esté en la raíz del proyecto.

### "Token no se guarda en MongoDB"
→ Verifica que el usuario existe en la base de datos y que el login funciona.

---

## ✅ Checklist Final

- [ ] Proyecto creado en Firebase Console
- [ ] App web registrada en Firebase
- [ ] VAPID Key generada
- [ ] `firebase-service-account.json` descargado
- [ ] Archivo subido al servidor (raíz del proyecto)
- [ ] `npm install firebase-admin` ejecutado
- [ ] Configuración actualizada en `index.html`
- [ ] Servidor reiniciado
- [ ] Prueba de login exitosa
- [ ] Token aparece en MongoDB

---

**¿Tienes alguna duda en algún paso?**
