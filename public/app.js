function setStatus(msg, cls = '') {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = 'SW: ' + msg;
    el.className = 'status ' + cls;
  }
  console.log('[app]', msg);
}

// ---------- SW registration ----------
let swReadyPromise = Promise.resolve(false);

if (!('serviceWorker' in navigator)) {
  setStatus('not supported', 'err');
} else {
  setStatus('registering…');

  swReadyPromise = (async () => {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      setStatus('registered, installing…');

      await navigator.serviceWorker.ready;
      setStatus('active');

      if (!navigator.serviceWorker.controller) {
        setStatus('waiting for control…');
        await new Promise(resolve => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
          setTimeout(resolve, 3000);
        });
      }

      if (navigator.serviceWorker.controller) {
        setStatus('controlling page ✓');
        return true;
      } else {
        setStatus('registered but NOT controlling', 'warn');
        return false;
      }
    } catch (err) {
      setStatus('registration failed: ' + err.message, 'err');
      console.error('[app] SW error:', err);
      return false;
    }
  })();
}

// Auto-reload once after first SW activation
(async () => {
  if (!('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    console.log('[app] reloading to gain control');
    setTimeout(() => window.location.reload(), 300);
  }
})();

// ---------- Proxy launcher ----------
async function go() {
  let input = document.getElementById('url').value.trim();
  if (!input) return;

  if (!/^https?:\/\//i.test(input)) {
    if (/\.[a-z]{2,}/i.test(input) && !input.includes(' ')) {
      input = 'https://' + input;
    } else {
      input = 'https://duckduckgo.com/?q=' + encodeURIComponent(input);
    }
  }

  setStatus('waiting for SW…');
  const ok = await swReadyPromise;

  if (!ok || !navigator.serviceWorker.controller) {
    setStatus('SW not controlling — reload page', 'err');
    alert('Service Worker not active. Reload the page and try again.');
    return;
  }

  const origin = new URL(input).origin;

  const cache = await caches.open('proxy-meta');
  await cache.put('/origin', new Response(origin));

  navigator.serviceWorker.controller.postMessage({
    type: 'SET_ORIGIN',
    origin,
  });

  setStatus('loading ' + origin);
  await new Promise(r => setTimeout(r, 100));

  document.getElementById('frame').src = '/proxy/' + input;
}

document.getElementById('url').addEventListener('keydown', e => {
  if (e.key === 'Enter') go();
});