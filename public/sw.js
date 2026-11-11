const CACHE_NAME = 'svitlo-pwa-v18-7-12';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Network-first for navigation requests: ensures user gets newest version immediately on open
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((response) => {
          if (response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((res) => res || caches.match('./index.html')))
    );
  }
});

// Handle incoming Apple Web Push (iOS 18.7+)
self.addEventListener('push', (event) => {
  let data = {
    title: '⚡ Світло • ДТЕК',
    body: 'Оновлення статусу електропостачання за вашою адресою',
    tag: 'svitlo-alert',
    url: './',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch {
      data.body = event.data.text();
    }
  }

  let icon = data.icon || './icon-192.svg';
  if (!data.icon && data.tag) {
    if (data.tag.includes('off')) {
      icon = './icon-off.svg';
    } else if (data.tag.includes('on')) {
      icon = './icon-on.svg';
    } else if (data.tag.includes('change')) {
      icon = './icon-change.svg';
    }
  }

  const options = {
    body: data.body,
    icon: icon,
    badge: icon,
    tag: data.tag || 'svitlo-alert',
    renotify: true,
    data: {
      url: data.url || './',
      addressId: data.addressId,
    },
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
