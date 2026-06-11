const fetch = require('node-fetch');
const cheerio = require('cheerio');
const zlib = require('zlib');

// URL rewriting helper
function rewriteUrl(url, baseUrl, proxyBase) {
    if (!url || url.startsWith('#') || url.startsWith('javascript:') || 
        url.startsWith('data:') || url.startsWith('mailto:') || url.startsWith('tel:')) {
        return url;
    }
    
    try {
        const absoluteUrl = new URL(url, baseUrl).href;
        if (absoluteUrl.startsWith('http')) {
            return `${proxyBase}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
        }
        return absoluteUrl;
    } catch(e) {
        return url;
    }
}

// Anti-detection script
const ANTI_DETECTION_SCRIPT = `
<script>
(function() {
    try { delete window.frameElement; } catch(e) {}
    
    Object.defineProperties(window, {
        top: { get: function() { return window; }, configurable: false },
        parent: { get: function() { return window; }, configurable: false },
        frameElement: { get: function() { return null; }, configurable: false },
        self: { get: function() { return window; }, configurable: false }
    });
    
    try {
        Object.defineProperty(window.frames, 'length', { get: function() { return 0; }});
    } catch(e) {}
    
    Object.defineProperties(document, {
        hidden: { get: function() { return false; }},
        visibilityState: { get: function() { return 'visible'; }}
    });
    
    document.hasFocus = function() { return true; };
    
    const origOpen = window.open;
    window.open = function(url, target, features) {
        if (url && typeof url === 'string') {
            window.location.href = url;
            return window;
        }
        return origOpen.apply(this, arguments);
    };
    
    document.addEventListener('click', function(e) {
        let target = e.target;
        while (target && target !== document) {
            if (target.tagName === 'A' && target.href && 
                target.href.indexOf('javascript:') !== 0 &&
                target.href.indexOf('#') !== 0) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = target.href;
                return false;
            }
            target = target.parentElement;
        }
    }, true);
    
    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form.action && form.action.indexOf('javascript:') !== 0) {
            e.preventDefault();
            e.stopPropagation();
            let action = form.action;
            if (form.method.toLowerCase() === 'get') {
                const formData = new FormData(form);
                const params = new URLSearchParams(formData).toString();
                if (params) action += (action.includes('?') ? '&' : '?') + params;
            }
            window.location.href = action;
            return false;
        }
    }, true);
    
    Object.defineProperty(navigator, 'webdriver', { get: function() { return false; }});
})();
</script>
`;

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).send(`
            <!DOCTYPE html>
            <html>
            <head><title>Proxy Error</title>
            <style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;background:#0a0a0a;color:#fff}.error{text-align:center}h2{color:red}a{color:red}</style>
            </head>
            <body><div class="error"><h2>No URL provided</h2><a href="/">Go back</a></div></body>
            </html>
        `);
    }
    
    const decodedUrl = decodeURIComponent(targetUrl);
    
    try {
        console.log(`Proxying: ${decodedUrl}`);
        
        // IMPORTANT: Don't accept compressed responses - we'll handle it manually
        const response = await fetch(decodedUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',  // CRITICAL: Don't accept compression
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'none',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1'
            },
            redirect: 'follow',
            follow: 10
        });
        
        const contentType = response.headers.get('content-type') || '';
        console.log('Content-Type:', contentType);
        console.log('Status:', response.status);
        
        // Handle HTML content
        if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
            // Get raw text (no compression issues since we requested identity)
            const html = await response.text();
            
            const $ = cheerio.load(html);
            
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const host = req.headers['host'] || 'localhost:3000';
            const proxyBase = `${protocol}://${host}`;
            
            // Inject anti-detection FIRST
            $('head').prepend(ANTI_DETECTION_SCRIPT);
            
            // Remove CSP
            $('meta[http-equiv="Content-Security-Policy"]').remove();
            $('meta[http-equiv="Content-Security-Policy-Report-Only"]').remove();
            $('meta[http-equiv="X-Frame-Options"]').remove();
            
            // Add base tag
            if ($('base').length === 0) {
                $('head').prepend(`<base href="${decodedUrl}">`);
            }
            
            // Rewrite URLs
            $('a[href]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href && !href.startsWith('#')) {
                    $(elem).attr('href', rewriteUrl(href, decodedUrl, proxyBase));
                    $(elem).attr('target', '_self');
                }
            });
            
            $('form[action]').each((i, elem) => {
                const action = $(elem).attr('action');
                if (action) {
                    $(elem).attr('action', rewriteUrl(action, decodedUrl, proxyBase));
                    $(elem).attr('target', '_self');
                }
            });
            
            $('script[src]').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src && !src.startsWith('data:')) {
                    $(elem).attr('src', rewriteUrl(src, decodedUrl, proxyBase));
                }
            });
            
            $('img[src]').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src && !src.startsWith('data:')) {
                    $(elem).attr('src', rewriteUrl(src, decodedUrl, proxyBase));
                }
            });
            
            $('link[href]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href) {
                    $(elem).attr('href', rewriteUrl(href, decodedUrl, proxyBase));
                }
            });
            
            $('video[src], audio[src], source[src], iframe[src]').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src && !src.startsWith('data:')) {
                    $(elem).attr('src', rewriteUrl(src, decodedUrl, proxyBase));
                }
            });
            
            // Remove frame busters
            $('script').each((i, elem) => {
                const content = $(elem).html() || '';
                if (content.includes('top.location') ||
                    content.includes('window.top') ||
                    content.includes('self.location') ||
                    content.includes('frameElement') ||
                    content.includes('parent.location') ||
                    content.includes('breakout')) {
                    $(elem).remove();
                }
            });
            
            // Set response headers
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.setHeader('Content-Security-Policy', "frame-ancestors 'self' *");
            
            return res.send($.html());
        }
        
        // For non-HTML content, pipe directly
        // Remove problematic headers
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
            const lowerKey = key.toLowerCase();
            if (!['content-security-policy',
                  'content-security-policy-report-only', 
                  'x-frame-options',
                  'x-content-security-policy',
                  'x-webkit-csp',
                  'frame-options',
                  'content-encoding',  // Remove content-encoding since we're not compressing
                  'transfer-encoding'].includes(lowerKey)) {
                responseHeaders[key] = value;
            }
        });
        
        // Add permissive headers
        responseHeaders['x-frame-options'] = 'SAMEORIGIN';
        responseHeaders['access-control-allow-origin'] = '*';
        
        // Set headers
        Object.entries(responseHeaders).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        
        // Stream the response body
        const buffer = await response.buffer();
        return res.send(buffer);
        
    } catch (error) {
        console.error('Proxy error:', error);
        return res.status(502).send(`
            <!DOCTYPE html>
            <html>
            <head><title>Proxy Error</title>
            <style>body{font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh;background:#0a0a0a;color:#fff}.error{text-align:center}h2{color:red}p{color:#999;margin:10px 0}a{color:red}</style>
            </head>
            <body><div class="error"><h2>Failed to load page</h2><p>${error.message}</p><a href="javascript:history.back()">Go back</a></div></body>
            </html>
        `);
    }
}
