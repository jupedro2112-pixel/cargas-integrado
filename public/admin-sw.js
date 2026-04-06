
/**
 * Service Worker para Admin Panel - Sala de Juegos
 * Maneja notificaciones push y caché de la app
 *
 * IMPORTANTE: Incrementar CACHE_VERSION en cada deploy para forzar
 * la invalidación del caché en dispositivos con la app instalada.
 */

// Bump this version with every deploy so the admin PWA always loads fresh code.
const CACHE_VERSION = 'v4';
const CACHE_NAME = 'admin-sala-' + CACHE_VERSION;

// Only pre-cache stable assets (icons rarely change).
const PRECACHE_URLS = [
    '/icons/icon-192x192.png',
    '/icons/icon-512x512.png'
];

// Main admin files that must always be fetched fresh from the network after a
// redeploy so admins never run stale admin.js code.
function isNetworkFirst(url) {
    return (
        url.includes('/adminprivado2026/') ||
        url.includes('admin.js') ||
        url.includes('admin.css') ||
        url.includes('manifest.json')
    );
}

// Verifica si una URL pertenece a Cloudflare u otros dominios de seguridad
// que NUNCA deben pasar por el caché del SW.
function isCloudflareOrSecurityUrl(url) {
    try {
        const parsed = new URL(url);
        return (
            parsed.hostname === 'challenges.cloudflare.com' ||
            parsed.hostname.endsWith('.cloudflare.com') ||
            parsed.pathname.startsWith('/cdn-cgi/')
        );
    } catch (e) {
        return false;
    }
}

// Instalación del Service Worker
self.addEventListener('install', (event) => {
    console.log('[SW-Admin] Instalando Service Worker', CACHE_VERSION);
    
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW-Admin] Pre-cacheando recursos estables');
                return cache.addAll(PRECACHE_URLS);
            })
            .catch((err) => {
                console.log('[SW-Admin] Error al pre-cachear:', err);
            })
    );
    
    self.skipWaiting();
});

// Activación del Service Worker
self.addEventListener('activate', (event) => {
    console.log('[SW-Admin] Service Worker activado', CACHE_VERSION);
    
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW-Admin] Eliminando cache antiguo:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    
    self.clients.claim();
});

// Interceptar fetch requests
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') {
        return;
    }

    const url = event.request.url;

    // CLOUDFLARE FIX: nunca interceptar navigation requests.
    // Igual que en firebase-messaging-sw.js: si el SW intercepta una
    // navegación y Cloudflare redirige a challenges.cloudflare.com,
    // el challenge falla porque la respuesta se sirve en el contexto URL
    // incorrecto. Dejando pasar las navegaciones, el challenge se resuelve
    // correctamente y la pantalla de "red incompatible" desaparece.
    if (event.request.mode === 'navigate') {
        console.log('[SW-Admin] Navigation request - pasando al navegador nativo:', url);
        return;
    }

    // Excluir URLs de Cloudflare y seguridad.
    if (isCloudflareOrSecurityUrl(url)) {
        console.log('[SW-Admin] URL de seguridad excluida del caché:', url);
        return;
    }

    if (url.includes('/api/') || 
        url.includes('/socket.io/')) {
        return;
    }

    if (isNetworkFirst(url)) {
        // Network-first: always try network so deploys are immediately visible.
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        // Only cache same-origin ('basic') responses.
                        // Opaque cross-origin responses are excluded intentionally
                        // to avoid caching errors or security issues.
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    console.log('[SW-Admin] Red no disponible, buscando en caché:', url);
                    return caches.match(event.request);
                })
        );
    } else {
        // Cache-first for icons and other stable assets.
        event.respondWith(
            caches.match(event.request)
                .then((response) => {
                    if (response) {
                        return response;
                    }
                    return fetch(event.request)
                        .then((networkResponse) => {
                            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                                return networkResponse;
                            }
                            const responseToCache = networkResponse.clone();
                            caches.open(CACHE_NAME)
                                .then((cache) => {
                                    cache.put(event.request, responseToCache);
                                });
                            return networkResponse;
                        });
                })
                .catch(() => undefined)
        );
    }
});

// Manejar notificaciones push
// Supports both legacy (payload.title/body) and FCM format (payload.notification.title/body)
self.addEventListener('push', (event) => {
    console.log('[SW-Admin] Push recibido:', event);
    
    let title = 'Admin Sala de Juegos';
    let body = 'Tienes una nueva notificación';
    let icon = '/icons/icon-192x192.png';
    let badge = '/icons/icon-72x72.png';
    let tag = 'admin-notification';
    let extraData = {};

    try {
        const payload = event.data.json();

        const notif = payload.notification || {};
        const webpushNotif = (payload.webpush && payload.webpush.notification) || {};

        title = notif.title || webpushNotif.title || payload.title || title;
        body = notif.body || webpushNotif.body || payload.body || body;
        icon = notif.icon || webpushNotif.icon || payload.icon || icon;
        badge = notif.badge || webpushNotif.badge || payload.badge || badge;
        tag = (payload.data && payload.data.tag) || payload.tag || tag;
        extraData = payload.data || {};
    } catch (e) {
        try { body = event.data.text(); } catch (_) {}
    }
    
    const options = {
        body,
        icon,
        badge,
        tag,
        requireInteraction: extraData.requireInteraction || false,
        data: extraData,
        actions: [
            { action: 'open', title: 'Abrir' },
            { action: 'close', title: 'Cerrar' }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// Manejar click en notificación
self.addEventListener('notificationclick', (event) => {
    console.log('[SW-Admin] Click en notificación:', event);
    
    event.notification.close();
    
    const notificationData = event.notification.data;
    let url = '/adminprivado2026/';
    
    if (notificationData && notificationData.url) {
        url = notificationData.url;
    }
    
    if (event.action === 'close') {
        return;
    }
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                for (const client of clientList) {
                    if (client.url.includes('/adminprivado2026/') && 'focus' in client) {
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow(url);
                }
            })
    );
});

// Escuchar mensajes desde la app
self.addEventListener('message', (event) => {
    console.log('[SW-Admin] Mensaje recibido:', event.data);
    
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        self.registration.showNotification(event.data.title, {
            body: event.data.body,
            icon: event.data.icon || '/icons/icon-192x192.png',
            badge: event.data.badge || '/icons/icon-72x72.png',
            tag: event.data.tag || 'default',
            data: event.data.data || {}
        });
    }
});

console.log('[SW-Admin] Service Worker cargado', CACHE_VERSION);

