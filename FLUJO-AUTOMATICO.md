# 🔄 Flujo Automático - Notificaciones Push

## ¿Cómo funciona TODO automático?

```
┌─────────────────────────────────────────────────────────────────┐
│                    FLUJO AUTOMÁTICO COMPLETO                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  📱 USUARIO (Chrome Android)                                     │
│  ─────────────────────────                                       │
│                                                                  │
│  1. Usuario abre la app en su celular                           │
│     ↓                                                            │
│  2. Aparece: "¿Permitir notificaciones?"                        │
│     ↓                                                            │
│  3. Usuario acepta → Token FCM se guarda en localStorage        │
│     ↓                                                            │
│  4. Usuario hace LOGIN                                          │
│     ↓                                                            │
│  5. Token se envía AUTOMÁTICAMENTE al servidor                  │
│     ↓                                                            │
│  6. Token se guarda en MongoDB (campo fcmToken)                 │
│                                                                  │
│  💻 ADMIN (Tu Notebook)                                          │
│  ──────────────────────                                          │
│                                                                  │
│  7. Abres: /admin-panel.html                                    │
│     ↓                                                            │
│  8. Ves cuántos usuarios tienen la app                          │
│     ↓                                                            │
│  9. Escribes mensaje y envías                                   │
│     ↓                                                            │
│  10. Todos los usuarios reciben la notificación                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✅ TODO es automático para el usuario

El usuario **NO tiene que hacer nada especial**. Solo:
1. Instalar la app (agregar a inicio)
2. Aceptar notificaciones (aparece automático)
3. Hacer login (como siempre)

---

## 🧪 Cómo probar el flujo completo

### Paso 1: En tu celular Android

1. **Abre Chrome** (NO Firefox, NO Safari)
2. Ve a: `https://tudominio.com`
3. **Instala la app:**
   - Toca los 3 puntos (⋮) → "Agregar a pantalla de inicio"
4. **Abre la app instalada** (desde el icono en tu pantalla)
5. **Acepta notificaciones** cuando aparezca el popup
6. **Haz login** con tu usuario

### Paso 2: Verificar en MongoDB

El usuario ahora debe tener el campo `fcmToken`:

```javascript
db.users.find({ username: "tu_usuario" }, { username: 1, fcmToken: 1 })

// Resultado:
{
  "username": "tu_usuario",
  "fcmToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

### Paso 3: En tu notebook

1. Abre: `https://tudominio.com/admin-panel.html`
2. Debería mostrar:
   - 👥 Total Usuarios: X
   - 📱 Con App: 1 (o más)
   - 📊 Porcentaje: X%
3. Escribe un mensaje
4. Haz clic en "Enviar a Todos"
5. ¡Recibirás la notificación en tu celular!

---

## ⚠️ IMPORTANTE: Chrome Android

**Firebase SOLO funciona bien en Chrome Android.**

| Navegador | ¿Funciona? | Notas |
|-----------|------------|-------|
| **Chrome Android** | ✅ Sí | Perfecto, recomendado |
| **Chrome Desktop** | ✅ Sí | Funciona para pruebas |
| **Firefox** | ❌ No | Bloquea scripts de Google |
| **Safari** | ⚠️ Parcial | Requiere configuración extra |
| **Samsung Internet** | ⚠️ Parcial | Puede tener problemas |

---

## 🔧 Si no funciona en el celular

### Verificar que Firebase cargue:

1. En tu celular, abre Chrome
2. Ve a tu app
3. En Chrome de tu PC, escribe: `chrome://inspect`
4. Conecta tu celular y abre la consola
5. Busca estos mensajes:
   ```
   [PWA] Service Worker registrado
   [FCM] Token obtenido: eyJhbG...
   [FCM] ✅ Token registrado en el servidor
   ```

### Si no aparecen los mensajes:

- **Desactiva AdBlock** en Chrome del celular
- **Usa conexión WiFi** (no datos móviles con restricciones)
- **Asegúrate de usar HTTPS** (no HTTP)

---

## 📁 Archivos del sistema

| Archivo | Función |
|---------|---------|
| `public/index.html` | Obtiene token FCM al cargar |
| `public/app.js` | Envía token al servidor después del login |
| `public/admin-panel.html` | Panel para enviar notificaciones |
| `src/routes/notificationRoutes.js` | API para guardar/enviar notificaciones |
| `src/services/notificationService.js` | Lógica de Firebase Admin |
| `firebase-service-account.json` | Credenciales de Firebase (en servidor) |

---

## 🎯 Resumen

Para que funcione automáticamente:

1. **Usuario usa Chrome Android** ✅
2. **Acepta notificaciones** ✅
3. **Hace login** ✅
4. **Token se guarda solo en MongoDB** ✅
5. **Tú envías notificaciones desde el panel** ✅

---

## ❓ Preguntas frecuentes

**¿El usuario tiene que hacer algo especial?**
→ NO. Solo instalar la app y hacer login.

**¿Se guarda automáticamente en MongoDB?**
→ SÍ, al hacer login el token se envía automáticamente.

**¿Puedo enviar notificaciones desde mi notebook?**
→ SÍ, usa `/admin-panel.html`

**¿Funciona con Firefox?**
→ NO. Usa Chrome Android.

---

## 🚀 Prueba ahora

1. Sube los archivos actualizados
2. Abre tu app en Chrome Android
3. Instala la app y haz login
4. Verifica en MongoDB que aparece `fcmToken`
5. Abre `/admin-panel.html` en tu notebook
6. Envía una notificación de prueba
