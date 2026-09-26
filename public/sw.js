console.log('[SW] script loaded');

const PROXY = '/proxy/';

// Hosts whose cross-origin requests get intercepted and routed through the proxy.
// Keep in sync with FORCE_PROXY_HOSTS in api/proxy.js.
const FORCE_HOSTS = [
  'reddit.com',
  'redditstatic.com',
  'redd.it',
  'redditmedia.com',
];

function isForced(hostname) {
  for (const h of FORCE_HOSTS) {
    if (hostname === h || hostname.endsWith('.' + h)) return true;
  }
  return false;
}

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

  const isSameOrigin = url.origin === self.location.origin;
  const isCrossOriginForced = !isSameOrigin && isForced(url.hostname);

  // Only intercept same-origin requests or cross-origin requests on the force list
  if (!isSameOrigin && !isCrossOriginForced) return;

  console.log('[SW] intercept:', isCrossOriginForced ? 'XORIGIN ' + url.href : url.pathname);

  event.respondWith((async () => {
    // For cross-origin requests, use the full URL directly
    // For same-origin requests, resolve against the stored proxy origin
    let absolute;

    if (isCrossOriginForced) {
      absolute = url.href;
    } else {
      const origin = await getStoredOrigin();
      if (!origin) {
        console.warn('[SW] no origin stored');
        return fetch(event.request);
      }
      absolute = origin + url.pathname + url.search;
    }

    const proxied = PROXY + absolute;
    console.log('[SW] →', proxied);

    const method = event.request.method;
    const init = {
      method,
      headers: event.request.headers,
      credentials: 'include',
      redirect: 'follow',
      mode: 'cors',
    };

    if (method !== 'GET' && method !== 'HEAD') {
      init.body = await event.request.clone().arrayBuffer();
    }

    // Strip Origin header — Vercel's function will set its own Referer, and
    // keeping localhost origin makes some CDNs reject the request.
    try {
      const headers = new Headers(event.request.headers);
      headers.delete('Origin');
      headers.delete('Referer');
      init.headers = headers;
    } catch (e) {}

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