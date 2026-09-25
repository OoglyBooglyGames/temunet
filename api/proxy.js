const cheerio = require('cheerio');
const acorn = require('acorn');
const walk = require('acorn-walk');
const MagicStringModule = require('magic-string');
const MagicString = MagicStringModule.default || MagicStringModule;

// ---------- BYPASS WHITELIST ----------
const BYPASS_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'statsig.com',
  'sentry.io',
  'sentry-cdn.com',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'mixpanel.com',
  'hotjar.com',
  'fullstory.com',
  'clarity.ms',
  'doubleclick.net',
  'facebook.net',
  'intercom.io',
  'intercomcdn.com',
  'posthog.com',
  'plausible.io',
  'datadoghq.com',
  // Anthropic's asset CDN — huge vendor bundles get corrupted by rewriting
  'assets-proxy.anthropic.com',
];

const BYPASS_PATH_PATTERNS = [
  /\/ces\/v1\//,
  /\/rgstr\b/,
  /\/statsc\//,
  /\/statsig\//,
  /\/flush\b/,
  // Anthropic's claude-ai asset tree
  /^\/claude-ai\/v2\/assets\//,
];

// ---------- EXPLICIT URL BYPASS ----------
// Exact substring matches that should NEVER be proxied.
const BYPASS_URL_SUBSTRINGS = [
  'assets-proxy.anthropic.com/claude-ai/v2/assets/v1/vendor-all-0-UFkBfsaM.js',
  'vendor-all-0-UFkBfsaM.js',
];

function shouldBypass(url) {
  if (typeof url !== 'string' || !url) return false;

  // Fast path — exact substring match
  for (const sub of BYPASS_URL_SUBSTRINGS) {
    if (url.includes(sub)) return true;
  }

  try {
    const u = new URL(url);
    const host = u.hostname;
    for (const h of BYPASS_HOSTS) {
      if (host === h || host.endsWith('.' + h)) return true;
    }
    for (const p of BYPASS_PATH_PATTERNS) {
      if (p.test(u.pathname)) return true;
    }
  } catch {}
  return false;
}

// ---------- JS REWRITE SKIP LIST ----------
const REWRITE_SKIP_PATTERNS = [
  '/vendor-',
  'vendor.',
  '/shared-',
  '/chunk-',
  'rolldown',
  'preload-helper',
  'runtime-',
  'bundle.',
  '.bundle.',
  '/polyfills',
  'regenerator-runtime',
];

function shouldSkipRewrite(targetUrl, js) {
  const lower = targetUrl.toLowerCase();
  for (const p of REWRITE_SKIP_PATTERNS) {
    if (lower.includes(p)) return true;
  }
  if (js.length > 200_000) return true;
  if (js.split('\n').length < 5 && js.length > 50_000) return true;
  return false;
}

module.exports = async function handler(req, res) {
  let targetUrl = req.query.url;

  if (targetUrl && targetUrl.startsWith('/')) {
    targetUrl = targetUrl.slice(1);
  }

  if (!targetUrl) {
    return res.status(400).send('Missing url');
  }

  // If the URL is on the bypass list, tell the client to fetch it directly.
  // We can't serve it, because the whole point is that it should never have
  // been routed here in the first place. Return the target URL so the browser
  // retries it directly.
  if (shouldBypass(targetUrl)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Bypass', '1');
    return res.redirect(302, targetUrl);
  }

  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch {
    return res.status(400).send('Invalid url: ' + targetUrl);
  }

  const ext = (urlObj.pathname.split('.').pop() || '').toLowerCase();

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

    // ---------- JavaScript ----------
    if (['js', 'mjs', 'cjs'].includes(ext) ||
        contentType.includes('javascript') ||
        contentType.includes('ecmascript')) {

      const js = await upstream.text();
      let rewritten = js;

      if (shouldSkipRewrite(targetUrl, js)) {
        console.log('Skipping rewrite:', targetUrl);
      } else {
        try {
          rewritten = rewriteJS(js, targetUrl);
        } catch (e) {
          console.error('rewriteJS failed:', e.message, '—', targetUrl);
          rewritten = js;
        }
      }

      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(rewritten);
    }

    // ---------- HTML ----------
    if (contentType.includes('text/html')) {
      let html = await upstream.text();
      html = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.send(html);
    }

    // ---------- Everything else ----------
    const buffer = Buffer.from(await upstream.arrayBuffer());

    let forcedType = contentType;
    if (ext === 'json') forcedType = 'application/json; charset=utf-8';
    else if (ext === 'svg') forcedType = 'image/svg+xml';

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
    if (shouldBypass(abs)) return abs;
    return '/proxy/' + abs;
  } catch {
    return rawUrl;
  }
}

function rewriteJS(js, baseUrl) {
  if (js.length > 200_000) return js;

  let ast;
  try {
    ast = acorn.parse(js, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
  } catch {
    return js;
  }

  const magic = new MagicString(js);

  function shouldRewrite(s) {
    if (typeof s !== 'string' || !s) return false;
    if (/^(data|blob|javascript|mailto|tel|about|chrome|chrome-extension):/i.test(s)) return false;
    if (s.startsWith('#')) return false;
    if (s.startsWith('/proxy/')) return false;
    if (s.startsWith('/')) return true;
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('//')) return true;
    return false;
  }

  function rewrite(raw) {
    try {
      const abs = new URL(raw, baseUrl).href;
      if (shouldBypass(abs)) return raw;
      return '/proxy/' + abs;
    } catch {
      return raw;
    }
  }

  function rewriteArg(arg) {
    if (!arg) return;
    if (arg.type === 'Literal' && typeof arg.value === 'string') {
      if (!shouldRewrite(arg.value)) return;
      try {
        magic.overwrite(arg.start, arg.end, JSON.stringify(rewrite(arg.value)));
      } catch {}
    } else if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0 && arg.quasis.length === 1) {
      const v = arg.quasis[0].value.cooked;
      if (!shouldRewrite(v)) return;
      try {
        magic.overwrite(arg.start, arg.end, JSON.stringify(rewrite(v)));
      } catch {}
    }
  }

  const URL_FIRST_ARG = new Set([
    'fetch', 'open', 'sendBeacon', 'importScripts',
    'get', 'post', 'put', 'delete', 'head', 'options', 'patch',
    'request', 'query', 'mutate',
  ]);

  const URL_CONSTRUCTORS = new Set([
    'WebSocket', 'Worker', 'SharedWorker', 'EventSource',
    'Image', 'Audio',
  ]);

  try {
    walk.simple(ast, {
      CallExpression(node) {
        const callee = node.callee;
        let name = null;

        if (callee.type === 'Identifier') {
          name = callee.name;
        } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
          name = callee.property.name;
        }

        if (!name || !URL_FIRST_ARG.has(name)) return;
        rewriteArg(node.arguments[0]);
      },

      NewExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'Identifier') return;
        if (!URL_CONSTRUCTORS.has(callee.name)) return;
        rewriteArg(node.arguments[0]);
      },

      ImportExpression(node) {
        rewriteArg(node.source);
      },

      AssignmentExpression(node) {
        const left = node.left;
        if (left.type !== 'MemberExpression') return;
        if (left.property.type !== 'Identifier') return;
        const prop = left.property.name;
        if (!['src', 'href', 'action', 'poster', 'data'].includes(prop)) return;
        rewriteArg(node.right);
      },
    });
  } catch {
    return js;
  }

  try {
    return magic.toString();
  } catch {
    return js;
  }
}

function rewriteHTML(html, baseUrl) {
  const $ = cheerio.load(html);

  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('base').remove();

  const baseOrigin = new URL(baseUrl).origin;

  $('head').prepend(`
    <script>
      (function() {
        var ORIGIN = ${JSON.stringify(baseOrigin)};
        var PROXY_PREFIX = '/proxy/';

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

        try {
          Object.defineProperty(window, 'top', { get: function() { return window.self; } });
          Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
          Object.defineProperty(window, 'frameElement', { get: function() { return null; } });
        } catch (e) {}

        var reloadCount = 0;
        var _reload = location.reload.bind(location);
        var reloadTimer = null;
        function safeReload() {
          reloadCount++;
          if (reloadCount > 2) {
            console.warn('[TemuNet] reload loop detected — stopping');
            return;
          }
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(function() { _reload(); }, 500);
        }
        try {
          Object.defineProperty(location, 'reload', { value: safeReload, writable: false });
        } catch (e) {}
      })();
    </script>
  `);

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