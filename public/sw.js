console.log('[SW] script loaded');

const PROXY = '/learn/';

// Vercel collapses https:// to https:/ in URL paths before routing.
// Pre-collapse on our side so the URL we emit matches what Vercel expects,
// and the handler un-collapses it on the way back in.
function collapseScheme(u) {
  return String(u).replace(/^(https?):\/\//, '$1:/');
}

function proxyUrl(u) {
  return PROXY + collapseScheme(u);
}

// Hosts whose cross-origin requests get intercepted and routed through the proxy.
// Keep in sync with FORCE_PROXY_HOSTS in api/learn.js.
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
  if (storedOrigin) return storedOrigin;
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

function originFromReferer(referer) {
  if (!referer) return null;
  const m = referer.match(/\/learn\/(https?:\/\/[^\/]+)/);
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
    url.pathname.startsWith('/learn/') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isCrossOriginForced = !isSameOrigin && isForced(url.hostname);

  if (!isSameOrigin && !isCrossOriginForced) return;

  event.respondWith((async () => {
    let absolute;

    if (isCrossOriginForced) {
      absolute = url.href;
    } else {
      let origin = await getStoredOrigin();

      if (!origin) {
        origin = originFromReferer(event.request.referrer);
        if (origin) {
          console.log('[SW] inferred origin from referrer:', origin);
          setStoredOrigin(origin);
        }
      }
      if (!origin) {
        try {
          const client = await self.clients.get(event.clientId);
          if (client && client.url) {
            const m = client.url.match(/\/learn\/(https?:\/\/[^\/]+)/);
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

    // Pre-collapse https:// → https:/ so Vercel's router doesn't reject it
    const proxied = proxyUrl(absolute);

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

    try {
      const headers = new Headers(event.request.headers);
      headers.delete('Origin');
      headers.delete('Referer');
      init.headers = headers;
    } catch (e) {}

    return fetch(proxied, init);
  })());
});