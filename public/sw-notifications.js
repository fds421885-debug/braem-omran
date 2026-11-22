/* eslint-disable no-restricted-globals */
// Service Worker extension for braem-omran notifications, immediate updates & deep-link focus
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification && event.notification.data ? event.notification.data : {};
  const broadcastId = typeof data.broadcastId === 'string' ? data.broadcastId : '';
  const fallbackUrl =
    typeof data.targetUrl === 'string' && data.targetUrl
      ? data.targetUrl
      : self.registration.scope || '/';

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of windowClients) {
        if ('focus' in client) {
          try {
            await client.focus();
          } catch {
            // Focus may be restricted on some browsers; continue posting message
          }
          client.postMessage({
            type: 'OPEN_BROADCAST_MESSAGE',
            broadcastId,
          });
          return;
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(fallbackUrl);
      }
    })()
  );
});
