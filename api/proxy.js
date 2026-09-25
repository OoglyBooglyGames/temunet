const cheerio = require('cheerio');

module.exports = async function handler(req, res) {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Missing url');
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    const contentType = upstream.headers.get('content-type') || '';

    // ---------- CSS ----------
    if (contentType.includes('text/css')) {
      let css = await upstream.text();
      css = rewriteCSS(css, targetUrl);
      res.setHeader('Content-Type', 'text/css');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(css);
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

    // ---------- Everything else (JS, images, fonts) ----------
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
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
    return '/proxy?url=' + encodeURIComponent(abs);
  } catch {
    return rawUrl;
  }
}

function rewriteHTML(html, baseUrl) {
  const $ = cheerio.load(html);

  // Strip CSP meta tags
  $('meta[http-equiv="Content-Security-Policy"]').remove();

  // Frame-bust killer
  $('head').prepend(`
    <script>
      Object.defineProperty(window, 'top', { get: () => window.self });
      Object.defineProperty(window, 'parent', { get: () => window.self });
      Object.defineProperty(window, 'frameElement', { get: () => null });
    </script>
  `);

  // Rewrite URL attributes
  const attrs = ['href', 'src', 'action', 'poster', 'data-src'];
  attrs.forEach(attr => {
    $('[' + attr + ']').each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;
      if (val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#')) return;
      $(el).attr(attr, proxify(val, baseUrl));
    });
  });

  // srcset
  $('[srcset]').each((_, el) => {
    const val = $(el).attr('srcset');
    const rewritten = val.split(',').map(part => {
      const pieces = part.trim().split(/\s+/);
      const u = pieces[0];
      const size = pieces[1];
      return proxify(u, baseUrl) + (size ? ' ' + size : '');
    }).join(', ');
    $(el).attr('srcset', rewritten);
  });

  // Inline styles
  $('[style]').each((_, el) => {
    let style = $(el).attr('style');
    style = style.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, u) => {
      if (u.startsWith('data:')) return m;
      return "url('" + proxify(u, baseUrl) + "')";
    });
    $(el).attr('style', style);
  });

  return $.html();
}

function rewriteCSS(css, baseUrl) {
  return css.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, u) => {
    if (u.startsWith('data:') || u.startsWith('blob:')) return m;
    return "url('" + proxify(u, baseUrl) + "')";
  });
}