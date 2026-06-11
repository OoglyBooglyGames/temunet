const fetch = require('node-fetch');
const cheerio = require('cheerio');

// URL rewriting helper
function rewriteUrl(url, baseUrl, proxyBase) {
    if (!url || url.startsWith('#') || url.startsWith('javascript:') || 
        url.startsWith('data:') || url.startsWith('mailto:')) {
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

// Anti-detection injection script
const ANTI_DETECTION_SCRIPT = `
<script>
(function() {
    // Prevent iframe detection
    try {
        delete window.frameElement;
    } catch(e) {}
    
    // Override window properties
    Object.defineProperties(window, {
        top: {
            get: function() { return window; },
            configurable: false
        },
        parent: {
            get: function() { return window; },
            configurable: false
        },
        frameElement: {
            get: function() { return null; },
            configurable: false
        },
        self: {
            get: function() { return window; },
            configurable: false
        }
    });
    
    // Fake frames length
    try {
        Object.defineProperty(window.frames, 'length', {
            get: function() { return 0; }
        });
    } catch(e) {}
    
    // Hide from visibility API
    Object.defineProperties(document, {
        hidden: {
            get: function() { return false; }
        },
        visibilityState: {
            get: function() { return 'visible'; }
        }
    });
    
    // Override hasFocus
    const origHasFocus = document.hasFocus;
    document.hasFocus = function() { return true; };
    
    // Prevent navigation escapes
    const origOpen = window.open;
    window.open = function(url, target, features) {
        if (url && typeof url === 'string') {
            window.location.href = url;
            return window;
        }
        return origOpen.apply(this, arguments);
    };
    
    // Intercept all link clicks
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
    
    // Intercept form submissions
    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form.action && form.action.indexOf('javascript:') !== 0) {
            e.preventDefault();
            e.stopPropagation();
            
            let action = form.action;
            if (form.method.toLowerCase() === 'get') {
                const formData = new FormData(form);
                const params = new URLSearchParams(formData).toString();
                if (params) {
                    action += (action.includes('?') ? '&' : '?') + params;
                }
            }
            
            window.location.href = action;
            return false;
        }
    }, true);
    
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', {
        get: function() { return false; }
    });
    
    console.log('🛡️ Anti-detection active');
})();
</script>
`;

export default async function handler(req, res) {
    // Handle CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Get target URL
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Proxy Error</title>
                <style>
                    body { font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; background: #0a0a0a; color: #fff; }
                    .error { text-align: center; }
                    h2 { color: #ff0000; }
                </style>
            </head>
            <body>
                <div class="error">
                    <h2>No URL provided</h2>
                    <p>Please specify a URL to proxy</p>
                    <a href="/" style="color: #ff0000;">Go back</a>
                </div>
            </body>
            </html>
        `);
    }
    
    const decodedUrl = decodeURIComponent(targetUrl);
    
    try {
        console.log(`Proxying: ${decodedUrl}`);
        
        // Fetch the target URL
        const response = await fetch(decodedUrl, {
            method: req.method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            },
            redirect: 'follow',
            follow: 5,
            compress: true
        });
        
        // Get content type
        const contentType = response.headers.get('content-type') || '';
        
        // Set response headers (remove restrictive ones)
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
            const lowerKey = key.toLowerCase();
            // Remove headers that might cause issues
            if (!['content-security-policy', 
                  'content-security-policy-report-only',
                  'x-frame-options',
                  'x-content-security-policy',
                  'x-webkit-csp',
                  'frame-options',
                  'x-xss-protection'].includes(lowerKey)) {
                responseHeaders[key] = value;
            }
        });
        
        // Add permissive headers
        responseHeaders['x-frame-options'] = 'SAMEORIGIN';
        responseHeaders['access-control-allow-origin'] = '*';
        
        // Handle HTML content
        if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
            let html = await response.text();
            
            // Load into cheerio
            const $ = cheerio.load(html);
            
            // Get proxy base URL
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const host = req.headers['host'] || 'localhost:3000';
            const proxyBase = `${protocol}://${host}`;
            
            // Inject anti-detection script at the very beginning
            $('head').prepend(ANTI_DETECTION_SCRIPT);
            
            // Remove existing CSP meta tags
            $('meta[http-equiv="Content-Security-Policy"]').remove();
            $('meta[http-equiv="Content-Security-Policy-Report-Only"]').remove();
            $('meta[http-equiv="X-Frame-Options"]').remove();
            
            // Add base tag if not present
            if ($('base').length === 0) {
                $('head').prepend(`<base href="${decodedUrl}">`);
            }
            
            // Rewrite all links
            $('a[href]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href && !href.startsWith('#')) {
                    $(elem).attr('href', rewriteUrl(href, decodedUrl, proxyBase));
                    $(elem).attr('target', '_self');
                }
            });
            
            // Rewrite form actions
            $('form[action]').each((i, elem) => {
                const action = $(elem).attr('action');
                if (action) {
                    $(elem).attr('action', rewriteUrl(action, decodedUrl, proxyBase));
                    $(elem).attr('target', '_self');
                }
            });
            
            // Rewrite script sources
            $('script[src]').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src && !src.startsWith('data:')) {
                    $(elem).attr('src', rewriteUrl(src, decodedUrl, proxyBase));
                }
            });
            
            // Rewrite image sources
            $('img[src]').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src && !src.startsWith('data:')) {
                    $(elem).attr('src', rewriteUrl(src, decodedUrl, proxyBase));
                }
            });
            
            // Rewrite link stylesheets
            $('link[href]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href) {
                    $(elem).attr('href', rewriteUrl(href, decodedUrl, proxyBase));
                }
            });
            
            // Rewrite video/audio sources
            $('video[src], audio[src], source[src]').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src) {
                    $(elem).attr('src', rewriteUrl(src, decodedUrl, proxyBase));
                }
            });
            
            // Remove frame-busting scripts
            $('script').each((i, elem) => {
                const scriptContent = $(elem).html() || '';
                if (scriptContent.includes('top.location') ||
                    scriptContent.includes('window.top') ||
                    scriptContent.includes('self.location') ||
                    scriptContent.includes('frameElement') ||
                    scriptContent.includes('parent.location') ||
                    scriptContent.includes('breakout') ||
                    scriptContent.includes('frame-busting')) {
                    $(elem).remove();
                }
            });
            
            // Remove onload handlers that might bust frames
            $('[onload]').each((i, elem) => {
                const onload = $(elem).attr('onload') || '';
                if (onload.includes('top') || onload.includes('parent') || onload.includes('frame')) {
                    $(elem).removeAttr('onload');
                }
            });
            
            // Send modified HTML
            res.setHeader('content-type', 'text/html; charset=utf-8');
            Object.entries(responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            return res.send($.html());
        }
        
        // For non-HTML content, stream the response
        res.status(response.status);
        Object.entries(responseHeaders).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        
        // Handle binary content
        const buffer = await response.buffer();
        return res.send(buffer);
        
    } catch (error) {
        console.error('Proxy error:', error);
        return res.status(502).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Proxy Error</title>
                <style>
                    body { font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; background: #0a0a0a; color: #fff; }
                    .error { text-align: center; }
                    h2 { color: #ff0000; }
                    p { color: #999; margin: 10px 0; }
                    a { color: #ff0000; }
                </style>
            </head>
            <body>
                <div class="error">
                    <h2>Failed to load page</h2>
                    <p>${error.message}</p>
                    <p>Target: ${decodedUrl}</p>
                    <a href="javascript:history.back()">Go back</a>
                </div>
            </body>
            </html>
        `);
    }
}
