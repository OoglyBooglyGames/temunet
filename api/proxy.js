import * as cheerio from 'cheerio';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import MagicString from 'magic-string';

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
  'assets-proxy.anthropic.com',
];

const BYPASS_PATH_PATTERNS = [
  /\/ces\/v1\//,
  /\/rgstr\b/,
  /\/statsc\//,
  /\/statsig\//,
  /\/flush\b/,
  /^\/claude-ai\/v2\/assets\//,
];

const BYPASS_URL_SUBSTRINGS = [
  'assets-proxy.anthropic.com/claude-ai/v2/assets/v1/vendor-all-0-UFkBfsaM.js',
  'vendor-all-0-UFkBfsaM.js',
];

const FORCE_PROXY_HOSTS = [
  'reddit.com',
  'redditstatic.com',
  'redd.it',
  'redditmedia.com',
];

function shouldForceProxy(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    for (const h of FORCE_PROXY_HOSTS) {
      if (host === h || host.endsWith('.' + h)) return true;
    }
  } catch {}
  return false;
}

function shouldBypass(url) {
  if (typeof url !== 'string' || !url) return false;
  if (shouldForceProxy(url)) return false;

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

const REWRITE_SKIP_PATTERNS = [
  '/vendor-', 'vendor.', '/shared-', '/chunk-', 'rolldown',
  'preload-helper', 'runtime-', 'bundle.', '.bundle.',
  '/polyfills', 'regenerator-runtime',
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

export default async function handler(req, res) {
  if (!req.query.url && req.url && req.url !== '/') {
    const referer = req.headers.referer || '';
    const m = referer.match(/\/proxy\/(https?:\/\/[^\/]+)/);
    if (m) {
      req.query.url = m[1] + req.url.split('?')[0] +
        (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '');
    }
  }

  let targetUrl = req.query.url;

  if (targetUrl && targetUrl.startsWith('/')) {
    targetUrl = targetUrl.slice(1);
  }

  if (targetUrl) {
    targetUrl = targetUrl.replace(/^(https?):\/(?!\/)/, '$1://');
  }

  if (!targetUrl) {
    return res.status(400).send('Missing url');
  }

  if (!shouldForceProxy(targetUrl) && shouldBypass(targetUrl)) {
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

  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext);
  const isJS = ['js', 'mjs', 'cjs'].includes(ext);
  const isCSS = ext === 'css';

  let accept;
  if (isJS) {
    accept = 'application/javascript,text/javascript,*/*;q=0.1';
  } else if (isCSS) {
    accept = 'text/css,*/*;q=0.1';
  } else if (isImage) {
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

    if (isCSS || contentType.includes('text/css')) {
      let css = await upstream.text();
      css = rewriteCSS(css, targetUrl);
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(css);
    }

    if (isJS || contentType.includes('javascript') || contentType.includes('ecmascript')) {
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

    if (!isImage && contentType.includes('text/html')) {
      let html = await upstream.text();
      html = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.send(html);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());

    let forcedType = contentType;
    if (isImage) {
      const imageExt = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
      forcedType = 'image/' + imageExt;
    } else if (ext === 'json') {
      forcedType = 'application/json; charset=utf-8';
    }

    if (isImage && contentType.includes('text/html')) {
      console.error('Upstream returned HTML for image:', targetUrl, '— status:', upstream.status);
    }

    res.setHeader('Content-Type', forcedType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(buffer);

  } catch (err) {
    console.error(err);
    return res.status(502).send('Proxy error: ' + err.message);
  }
}

// -------- Helpers --------

function proxify(rawUrl, baseUrl) {
  try {
    const abs = new URL(rawUrl, baseUrl).href;
    if (shouldForceProxy(abs)) return '/proxy/' + abs;
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

    if (shouldForceProxy(s)) {
      if (s.startsWith('/proxy/')) return false;
      return true;
    }

    if (s.startsWith('/proxy/')) return false;
    if (s.startsWith('/')) return true;
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('//')) return true;
    return false;
  }

  function rewrite(raw) {
    try {
      if (raw.startsWith('/proxy/')) return raw;
      const abs = new URL(raw, baseUrl).href;
      if (shouldForceProxy(abs)) return '/proxy/' + abs;
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
        if (callee.type === 'Identifier') name = callee.name;
        else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
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
        var FORCE_HOSTS = ${JSON.stringify(FORCE_PROXY_HOSTS)};

        function isForced(url) {
          try {
            var u = new URL(url, ORIGIN);
            var host = u.hostname;
            for (var i = 0; i < FORCE_HOSTS.length; i++) {
              var h = FORCE_HOSTS[i];
              if (host === h || host.slice(-(h.length + 1)) === '.' + h) return true;
            }
          } catch (e) {}
          return false;
        }

        function absolute(u) {
          try {
            if (typeof u !== 'string') return u;
            if (u.indexOf('/proxy/') === 0) return u;
            if (u.charAt(0) === '/') return ORIGIN + u;
            return u;
          } catch (e) { return u; }
        }

        // ---- Navigation interceptor ----
        function redirectToProxy(u) {
          try {
            if (typeof u !== 'string') return u;
            if (u.indexOf('/proxy/') === 0) return u;
            if (u.charAt(0) === '/') return PROXY_PREFIX + ORIGIN + u;
            if (u.indexOf(ORIGIN + '/') === 0) return PROXY_PREFIX + u;
            if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) {
              return PROXY_PREFIX + u;
            }
            return u;
          } catch (e) {
            return u;
          }
        }

        try {
          var _assign = window.location.assign.bind(window.location);
          window.location.assign = function(u) {
            return _assign(redirectToProxy(u));
          };
        } catch (e) {}

        try {
          var _replace = window.location.replace.bind(window.location);
          window.location.replace = function(u) {
            return _replace(redirectToProxy(u));
          };
        } catch (e) {}

        // ---- Intercept anchor clicks ----
        document.addEventListener('click', function(e) {
          try {
            var a = e.target && e.target.closest && e.target.closest('a[href]');
            if (!a) return;
            var href = a.getAttribute('href');
            if (!href) return;
            if (href.indexOf('/proxy/') === 0) return;
            if (href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
            if (href.charAt(0) === '/' || href.indexOf(ORIGIN + '/') === 0 ||
                href.indexOf('http://') === 0 || href.indexOf('https://') === 0) {
              e.preventDefault();
              e.stopPropagation();
              window.location.href = redirectToProxy(href);
            }
          } catch (err) {}
        }, true);

        // ---- Intercept form submissions ----
        document.addEventListener('submit', function(e) {
          try {
            var form = e.target;
            if (!form || !form.action) return;
            var action = form.getAttribute('action') || '';
            if (action.indexOf('/proxy/') === 0) return;
            if (action.charAt(0) === '/' || action.indexOf(ORIGIN + '/') === 0) {
              e.preventDefault();
              e.stopPropagation();
              var qs = new URLSearchParams(new FormData(form)).toString();
              var sep = action.indexOf('?') >= 0 ? '&' : '?';
              var target = redirectToProxy(action) + (qs ? sep + qs : '');
              window.location.href = target;
            }
          } catch (err) {}
        }, true);

        // ---- fetch patch ----
        var _fetch = window.fetch;
        window.fetch = function(input, init) {
          try {
            var u = typeof input === 'string' ? input : (input && input.url);
            if (u) {
              var abs = absolute(u);
              var forced = isForced(abs);
              var needsProxy = forced ||
                (typeof u === 'string' && u.charAt(0) === '/' && u.indexOf('/proxy/') !== 0);

              if (needsProxy && u.indexOf('/proxy/') !== 0) {
                var proxied = '/proxy/' + abs;
                if (typeof input === 'string') input = proxied;
                else input = new Request(proxied, input);
              }
            }
          } catch (e) {}
          return _fetch.call(this, input, init);
        };

        var _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
          try {
            if (typeof url === 'string') {
              var abs = absolute(url);
              if (isForced(abs) && url.indexOf('/proxy/') !== 0) {
                arguments[1] = '/proxy/' + abs;
              } else if (url.charAt(0) === '/' && url.indexOf('/proxy/') !== 0) {
                arguments[1] = '/proxy/' + abs;
              }
            }
          } catch (e) {}
          return _open.apply(this, arguments);
        };

        try {
          var _imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
          if (_imgSrcDesc && _imgSrcDesc.set) {
            Object.defineProperty(HTMLImageElement.prototype, 'src', {
              set: function(v) {
                try {
                  if (typeof v === 'string' && v.indexOf('/proxy/') !== 0) {
                    var abs = absolute(v);
                    if (isForced(abs)) v = '/proxy/' + abs;
                  }
                } catch (e) {}
                return _imgSrcDesc.set.call(this, v);
              },
              get: _imgSrcDesc.get,
            });
          }
        } catch (e) {}

        try {
          var _setAttr = Element.prototype.setAttribute;
          Element.prototype.setAttribute = function(name, value) {
            try {
              if (typeof value === 'string' && value.indexOf('/proxy/') !== 0) {
                if (name === 'src' || name === 'href' || name === 'srcset' ||
                    name === 'data-src' || name === 'data-href' || name === 'data-url' ||
                    name === 'action' || name === 'poster') {
                  var abs = absolute(value);
                  if (isForced(abs)) value = '/proxy/' + abs;
                }
              }
            } catch (e) {}
            return _setAttr.call(this, name, value);
          };
        } catch (e) {}

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
          Object.defineProperty(window.location, 'origin', { get: function() { return ORIGIN; } });
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