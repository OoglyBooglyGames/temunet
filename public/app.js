const VERSION = "1.1.10";

// ---------- Status ----------
function setStatus(msg, cls = '') {
  const el = document.getElementById('status');
  const txt = document.getElementById('status-text');
  if (el) el.className = 'status ' + cls;
  if (txt) txt.textContent = msg;
  console.log('[app]', msg);
}

// ---------- Version ----------
const versionEl = document.getElementById('version-text');
if (versionEl) versionEl.textContent = 'v' + VERSION;

const aboutVersionEl = document.getElementById('about-version');
if (aboutVersionEl) aboutVersionEl.textContent = 'v' + VERSION;

const aboutRuntimeEl = document.getElementById('about-runtime');
if (aboutRuntimeEl) {
  const chromeVer = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '?';
  aboutRuntimeEl.textContent = 'Chrome ' + chromeVer + ' / SW';
}
// ---------- Service Worker ----------
let swReadyPromise = Promise.resolve(false);

if (!('serviceWorker' in navigator)) {
  setStatus('SW not supported', 'err');
} else {
  setStatus('registering…');

  swReadyPromise = (async () => {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      setStatus('installing…');

      await navigator.serviceWorker.ready;
      setStatus('active');

      if (!navigator.serviceWorker.controller) {
        setStatus('waiting for control…', 'warn');
        await new Promise(resolve => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
          setTimeout(resolve, 3000);
        });
      }

      if (navigator.serviceWorker.controller) {
        setStatus('ready', 'ok');
        return true;
      } else {
        setStatus('not controlling — reload', 'warn');
        return false;
      }
    } catch (err) {
      setStatus('failed: ' + err.message, 'err');
      console.error('[app] SW error:', err);
      return false;
    }
  })();
}

// Reload once after first SW takes over
(async () => {
  if (!('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    setTimeout(() => window.location.reload(), 300);
  }
})();

// ---------- Navigation ----------
function go() {
  let input = document.getElementById('url').value.trim();
  if (!input) return;

  if (!/^https?:\/\//i.test(input)) {
    if (/\.[a-z]{2,}/i.test(input) && !input.includes(' ')) {
      input = 'https://' + input;
    } else {
      input = 'https://www.google.com/search?q=' + encodeURIComponent(input);
    }
  }

  loadUrl(input);
}

async function loadUrl(url) {
  setStatus('loading ' + url);

  const ok = await swReadyPromise;

  if (!ok || !navigator.serviceWorker.controller) {
    setStatus('SW not ready — reload', 'err');
    return;
  }

  const origin = new URL(url).origin;

  const cache = await caches.open('proxy-meta');
  await cache.put('/origin', new Response(origin));

  navigator.serviceWorker.controller.postMessage({
    type: 'SET_ORIGIN',
    origin,
  });

  await new Promise(r => setTimeout(r, 50));
  document.getElementById('frame').src = '/proxy/' + url;
}

function reloadFrame() {
  const frame = document.getElementById('frame');
  frame.src = frame.src;
}

// ---------- About modal ----------
function openAbout() {
  document.getElementById('about-modal').classList.add('open');
}
function closeAbout(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('about-modal').classList.remove('open');
}

// ---------- Events ----------
document.getElementById('url').addEventListener('keydown', e => {
  if (e.key === 'Enter') go();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAbout();
});