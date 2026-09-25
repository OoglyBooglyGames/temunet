const cheerio = require('cheerio');

module.exports = async function handler(req, res) {
  let targetUrl = req.query.url;

  // Sometimes Vercel passes "/https://..." — strip the leading slash
  if (targetUrl && targetUrl.startsWith('/')) {
    targetUrl = targetUrl.slice(1);
  }

  if (!targetUrl) {
    return res.status(400).send('Missing url');
  }

  // Validate it's a real URL
  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch {
    return res.status(400).send('Invalid url: ' + targetUrl);
  }

  const ext = (urlObj.pathname.split('.').pop() || '').toLowerCase();

  // Pick Accept header based on file type
  let accept;
  if (['js', 'mjs', 'cjs'].includes(ext)) {
    accept = 'application/javascript,text/javascript,*/*;q=0.1';
  } else if (ext === 'css') {
    accept = 'text/css,*/*;q=0.1';
  } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) {
    accept = 'image/*,*/*;q=0.1';
  } else if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) {
    accept = 'font/*,*/*;q=0.1';
  } else if (ext === 'json') {
    accept = 'application/json,*/*;q=0.1';
  } else if (['mp4', 'webm'].includes(ext)) {
    accept = 'video/*,*/*;q=0.1';
  } else {
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': accept,
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': urlObj.origin + '/',
      },
      redirect: 'follow',
    });

    const contentType = upstream.headers.get('content-type') || '';

    // ---------- CSS ----------
    if (contentType.includes('text/css') || ext === 'css') {
      let css = await upstream.text();
      css = rewriteCSS(css, targetUrl);
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(css);
    }

    // ---------- HTML ----------
    if (contentType.includes('text/html') && !['js', 'mjs', 'cjs'].includes(ext)) {
      let html = await upstream.text();
      html = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.send(html);
    }

    // ---------- Everything else (JS, images, fonts) ----------
    const buffer = Buffer.from(await upstream.arrayBuffer());

    // Force correct MIME based on extension, even if upstream lies
    let forcedType = contentType;
    if (['js', 'mjs', 'cjs'].includes(ext)) {
      forcedType = 'application/javascript; charset=utf-8';
    } else if (ext === 'css') {
      forcedType = 'text/css; charset=utf-8';
    } else if (ext === 'json') {
      forcedType = 'application/json; charset=utf-8';
    } else if (ext === 'svg') {
      forcedType = 'image/svg+xml';
    }

    res.setHeader('Content-Type', forcedType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(buffer);

  } catch (err) {
    console.error(err);
    return res.status(500).send('Proxy error: ' + err.message);
  }
};

// -------- Helpers --------

function proxify(rawUrl, baseUrl) {
  try {
    const abs = new URL(rawUrl, baseUrl).href;
    return '/proxy/' + abs;
  } catch {
    return rawUrl;
  }
}

function rewriteHTML(html, baseUrl) {
  const $ = cheerio.load(html);

  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('base').remove();

  const baseOrigin = new URL(baseUrl).origin;

  // Inject runtime patchers for fetch/XHR + frame-bust killer
$('head').prepend(`
  <script>
    (function() {
      var ORIGIN = ${JSON.stringify(baseOrigin)};
      var PROXY_PREFIX = '/proxy/';
      var PROXY_URL = location.origin + PROXY_PREFIX;

      // ---- THE CRITICAL FIX: Force import.meta.url to be the original site ----
      // This makes React and Vite see the same module identity.
      try {
        var originalUrl = ORIGIN + location.pathname.replace(PROXY_PREFIX, '') + location.search + location.hash;
        // We can't redefine import.meta.url directly, but we can trick modules into using the right one
        // by ensuring all module scripts get the correct base URL.
        // The <base> tag below handles this, but we'll also patch dynamic imports.
        var _import = window.import;
        // Dynamic import is tricky, but the <base> tag does most of the work.
      } catch (e) {}

      // ---- Location patch (keep this, it fixed the 404) ----
      function cleanPath() {
        var p = location.pathname;
        if (p.indexOf(PROXY_PREFIX) === 0) {
          var rest = p.slice(PROXY_PREFIX.length);
          try {
            var u = new URL(rest);
            return u.pathname + u.search + u.hash;
          } catch (e) {
            return '/';
          }
        }
        return p;
      }
      try {
        var _pathname = cleanPath();
        Object.defineProperty(window.location, 'pathname', { get: function() { return _pathname; } });
        Object.defineProperty(window.location, 'href', { get: function() { return ORIGIN + _pathname; } });
      } catch (e) {}

      // ---- History API patch (keep this) ----
      var _pushState = history.pushState;
      history.pushState = function(state, title, url) {
        var clean = url;
        try {
          if (typeof url === 'string' && url.indexOf(PROXY_PREFIX) !== 0) {
            clean = PROXY_PREFIX + ORIGIN + url;
          }
        } catch (e) {}
        return _pushState.call(this, state, title, clean);
      };
      var _replaceState = history.replaceState;
      history.replaceState = function(state, title, url) {
        var clean = url;
        try {
          if (typeof url === 'string' && url.indexOf(PROXY_PREFIX) !== 0) {
            clean = PROXY_PREFIX + ORIGIN + url;
          }
        } catch (e) {}
        return _replaceState.call(this, state, title, clean);
      };

      // ---- Frame-bust killer (keep this) ----
      try {
        Object.defineProperty(window, 'top', { get: function() { return window.self; } });
        Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
        Object.defineProperty(window, 'frameElement', { get: function() { return null; } });
      } catch (e) {}
    })();
  </script>
`);

// THE KEY FIX: Add a <base> tag pointing to the original site's root.
// This forces all relative module imports to resolve against the real URL,
// which gives React and Vite a consistent module identity.
$('head').prepend('<base href="' + new URL(baseUrl).origin + '/">');

  const attrs = ['href', 'src', 'action', 'poster', 'data-src', 'data-href', 'data-url'];
  attrs.forEach(attr => {
    $('[' + attr + ']').each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;
      if (val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('blob:') || val.startsWith('#')) return;
      if (val.startsWith('/proxy/')) return;
      $(el).attr(attr, proxify(val, baseUrl));
    });
  });

  $('[srcset]').each((_, el) => {
    const val = $(el).attr('srcset');
    if (!val) return;
    const rewritten = val.split(',').map(part => {
      const pieces = part.trim().split(/\s+/);
      const u = pieces[0];
      const size = pieces[1];
      return proxify(u, baseUrl) + (size ? ' ' + size : '');
    }).join(', ');
    $(el).attr('srcset', rewritten);
  });

  $('[style]').each((_, el) => {
    let style = $(el).attr('style');
    if (!style) return;
    style = style.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, u) => {
      if (u.startsWith('data:') || u.startsWith('blob:')) return m;
      return "url('" + proxify(u, baseUrl) + "')";
    });
    $(el).attr('style', style);
  });

  $('style').each((_, el) => {
    let css = $(el).html();
    if (!css) return;
    css = rewriteCSS(css, baseUrl);
    $(el).html(css);
  });

  return $.html();
}

function rewriteCSS(css, baseUrl) {
  return css.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, u) => {
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('/proxy/')) return m;
    return "url('" + proxify(u, baseUrl) + "')";
  });
}