console.log('[SW] script loaded');

const PROXY = '/proxy/';

self.addEventListener('install', () => {
  console.log('[SW] install');
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  console.log('[SW] activate');
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Pass through our own files
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/app.js' ||
    url.pathname === '/style.css' ||
    url.pathname === '/sw.js' ||
    url.pathname.startsWith('/proxy/') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  if (url.origin !== self.location.origin) return;

  console.log('[SW] intercept:', url.pathname);

  event.respondWith((async () => {
    const origin = await getStoredOrigin();
    if (!origin) {
      console.warn('[SW] no origin stored');
      return fetch(event.request);
    }

    const absolute = origin + url.pathname + url.search;
    const proxied = PROXY + absolute;
    console.log('[SW] →', proxied);

    const method = event.request.method;
    const init = {
      method,
      headers: event.request.headers,
      credentials: 'include',
      redirect: 'follow',
    };

    if (method !== 'GET' && method !== 'HEAD') {
      init.body = await event.request.clone().arrayBuffer();
    }

    return fetch(proxied, init);
  })());
});

let storedOrigin = null;

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SET_ORIGIN') {
    storedOrigin = event.data.origin;
    console.log('[SW] stored origin =', storedOrigin);
    caches.open('proxy-meta').then(c =>
      c.put('/origin', new Response(event.data.origin))
    );
  }
});

async function getStoredOrigin() {
  if (storedOrigin) return storedOrigin;
  const cache = await caches.open('proxy-meta');
  const res = await cache.match('/origin');
  if (res) {
    storedOrigin = await res.text();
    return storedOrigin;
  }
  return null;
}