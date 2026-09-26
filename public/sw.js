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

// ---------- Origin tracking ----------
let storedOrigin = null;

async function setStoredOrigin(origin) {
  storedOrigin = origin;
  try {
    const cache = await caches.open('proxy-meta');
    await cache.put('/origin', new Response(origin));
  } catch (e) {
    console.warn('[SW] failed to cache origin:', e);
  }
}

async function getStoredOrigin() {
  // 1. In-memory
  if (storedOrigin) return storedOrigin;

  // 2. Cache API
  try {
    const cache = await caches.open('proxy-meta');
    const res = await cache.match('/origin');
    if (res) {
      storedOrigin = await res.text();
      return storedOrigin;
    }
  } catch (e) {}

  return null;
}

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SET_ORIGIN') {
    console.log('[SW] stored origin =', event.data.origin);
    setStoredOrigin(event.data.origin);
  }
});

// ---------- Referrer-based origin inference ----------
// If the cache/memory is empty, try to recover the origin from the request's
// referrer (which looks like http://localhost:3000/proxy/https://site.com/...).
function originFromReferer(referer) {
  if (!referer) return null;
  const m = referer.match(/\/proxy\/(https?:\/\/[^\/]+)/);
  return m ? m[1] : null;
}

// ---------- Fetch handler ----------
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

  event.respondWith((async () => {
    let absolute;

    if (isCrossOriginForced) {
      // Cross-origin requests already have the full URL
      absolute = url.href;
    } else {
      // Same-origin requests need an origin to reconstruct against
      let origin = await getStoredOrigin();

      // Fallback 1: infer from the request's referrer
      if (!origin) {
        origin = originFromReferer(event.request.referrer);
        if (origin) {
          console.log('[SW] inferred origin from referrer:', origin);
          setStoredOrigin(origin);
        }
      }

      // Fallback 2: use the tab's own URL if it's a proxied page
      if (!origin) {
        try {
          const client = await self.clients.get(event.clientId);
          if (client && client.url) {
            const m = client.url.match(/\/proxy\/(https?:\/\/[^\/]+)/);
            if (m) {
              origin = m[1];
              console.log('[SW] inferred origin from client url:', origin);
              setStoredOrigin(origin);
            }
          }
        } catch (e) {}
      }

      if (!origin) {
        console.warn('[SW] no origin — passing through:', url.pathname);
        return fetch(event.request);
      }

      absolute = origin + url.pathname + url.search;
    }

    const proxied = PROXY + absolute;

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

    // Strip Origin and Referer — Vercel sets its own, and leaving localhost
    // causes some CDNs to reject the request.
    try {
      const headers = new Headers(event.request.headers);
      headers.delete('Origin');
      headers.delete('Referer');
      init.headers = headers;
    } catch (e) {}

    return fetch(proxied, init);
  })());
});