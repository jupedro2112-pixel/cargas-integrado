/**
 * Service Worker para Usuario - Sala de Juegos (MIGRATION STUB)
 *
 * Este archivo existía antes como el SW principal de caché + push.
 * Ha sido reemplazado por /firebase-messaging-sw.js, que combina
 * el manejo de FCM (Firebase SDK) con la lógica de caché.
 *
 * Este stub limpia todos los cachés antiguos y se auto-desregistra para
 * que el navegador migre automáticamente a firebase-messaging-sw.js
 * en la siguiente carga de página.
 */

const CACHE_VERSION = 'v4-migrate';
const CACHE_NAME = 'sala-juegos-user-' + CACHE_VERSION;

self.addEventListener('install', function(event) {
    console.log('[SW-User] Migration stub - limpiando cachés antiguos...');
    // Limpiar todos los cachés para evitar conflictos con firebase-messaging-sw.js
    event.waitUntil(
        caches.keys().then(function(names) {
            return Promise.all(names.map(function(n) { return caches.delete(n); }));
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    console.log('[SW-User] Migration stub activado - el SW se desregistrará ahora');
    event.waitUntil(
        self.clients.claim().then(function() {
            // Desregistrar este SW para que firebase-messaging-sw.js tome el control
            return self.registration.unregister();
        })
    );
});
