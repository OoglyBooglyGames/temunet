const https = require('https');
const http = require('http');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('No URL');
    
    targetUrl = decodeURIComponent(targetUrl);

    try {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            },
            rejectUnauthorized: false,
        };

        const response = await new Promise((resolve, reject) => {
            const proxyReq = client.request(options, (proxyRes) => {
                let chunks = [];
                proxyRes.on('data', chunk => chunks.push(chunk));
                proxyRes.on('end', () => resolve({
                    status: proxyRes.statusCode,
                    headers: proxyRes.headers,
                    body: Buffer.concat(chunks)
                }));
            });
            proxyReq.on('error', reject);
            proxyReq.setTimeout(15000, () => { proxyReq.destroy(); reject(new Error('Timeout')); });
            proxyReq.end();
        });

        const contentType = response.headers['content-type'] || '';

        // Strip ALL restrictive headers
        ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 
         'x-content-security-policy', 'x-webkit-csp', 'frame-options', 'x-xss-protection',
         'content-encoding', 'transfer-encoding'].forEach(h => delete response.headers[h]);

        Object.entries(response.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });

        if (contentType.includes('text/html')) {
            let html = response.body.toString('utf8');
            
            const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
            const proxyProtocol = req.headers['x-forwarded-proto'] || 'https';
            
            // MEGA ANTI-DETECTION SCRIPT
            const antiDetectionScript = `
<script>
(function() {
    // COMPLETELY OVERRIDE LOCATION
    var _realUrl = '${targetUrl}';
    
    var _location = {
        get href() { return _realUrl; },
        set href(url) {
            _realUrl = new URL(url, _realUrl).href;
            window.parent.postMessage({ type: 'NAVIGATE', url: _realUrl }, '*');
        },
        get protocol() { try { return new URL(_realUrl).protocol; } catch(e) { return 'https:'; } },
        get host() { try { return new URL(_realUrl).host; } catch(e) { return ''; } },
        get hostname() { try { return new URL(_realUrl).hostname; } catch(e) { return ''; } },
        get port() { try { return new URL(_realUrl).port; } catch(e) { return ''; } },
        get pathname() { try { return new URL(_realUrl).pathname; } catch(e) { return ''; } },
        get search() { try { return new URL(_realUrl).search; } catch(e) { return ''; } },
        get hash() { try { return new URL(_realUrl).hash; } catch(e) { return ''; } },
        get origin() { try { return new URL(_realUrl).origin; } catch(e) { return ''; } },
        assign: function(url) { this.href = url; },
        replace: function(url) { this.href = url; },
        reload: function() { window.parent.postMessage({ type: 'RELOAD' }, '*'); },
        toString: function() { return _realUrl; }
    };
    
    try { delete window.location; } catch(e) {}
    try { delete document.location; } catch(e) {}
    Object.defineProperty(window, 'location', { get: function() { return _location; }, set: function(url) { _location.href = url; }, configurable: false });
    Object.defineProperty(document, 'location', { get: function() { return _location; }, set: function(url) { _location.href = url; }, configurable: false });
    
    // Override history
    var _pushState = history.pushState.bind(history);
    var _replaceState = history.replaceState.bind(history);
    
    history.pushState = function(state, title, url) {
        if (url) { _realUrl = new URL(url, _realUrl).href; }
        return _pushState(state, title, url);
    };
    history.replaceState = function(state, title, url) {
        if (url) { _realUrl = new URL(url, _realUrl).href; }
        return _replaceState(state, title, url);
    };
    
    // Override window.open
    window.open = function(url) {
        if (url) {
            _realUrl = new URL(url, _realUrl).href;
            window.parent.postMessage({ type: 'NAVIGATE', url: _realUrl }, '*');
        }
        return { closed: false, close: function(){}, focus: function(){} };
    };
    
    // Catch all clicks
    document.addEventListener('click', function(e) {
        var target = e.target;
        while (target && target !== document.documentElement) {
            if ((target.tagName === 'A' || target.tagName === 'AREA') && target.href && target.getAttribute('href') !== '#') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                _realUrl = new URL(target.href, _realUrl).href;
                window.parent.postMessage({ type: 'NAVIGATE', url: _realUrl }, '*');
                return false;
            }
            target = target.parentElement;
        }
    }, true);
    
    // Catch forms
    document.addEventListener('submit', function(e) {
        if (e.target.action) {
            e.preventDefault();
            e.stopPropagation();
            _realUrl = new URL(e.target.action, _realUrl).href;
            window.parent.postMessage({ type: 'NAVIGATE', url: _realUrl }, '*');
            return false;
        }
    }, true);
    
    // Anti-detection
    try { delete window.frameElement; } catch(e) {}
    Object.defineProperties(window, {
        top: { get: function() { return window; }, configurable: false },
        parent: { get: function() { return window; }, configurable: false },
        frameElement: { get: function() { return null; }, configurable: false },
        self: { get: function() { return window; }, configurable: false }
    });
    
    Object.defineProperties(document, {
        hidden: { get: function() { return false; }, configurable: false },
        visibilityState: { get: function() { return 'visible'; }, configurable: false }
    });
    
    document.hasFocus = function() { return true; };
    Object.defineProperty(navigator, 'webdriver', { get: function() { return false; }, configurable: false });
    
    console.log('🔒 ANTI-DETECTION ACTIVE');
})();
</script>
`;
            
            // Inject at absolute beginning
            html = html.replace(/<head[^>]*>/i, '<head>' + antiDetectionScript);
            
            // Remove CSP meta tags
            html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy[^>]*>/gi, '');
            html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy-Report-Only[^>]*>/gi, '');
            
            // Add base tag
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Server-side URL rewrite (catch what JS misses)
            html = html.replace(/(src|href|action|data)=["']((?:https?:)?\/\/)((?!temunet\.vercel\.app)[^"']+)["']/gi,
                function(match, attr, protocol, rest) {
                    const fullUrl = (protocol.startsWith('http') ? '' : 'https:') + protocol + rest;
                    return attr + '="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                }
            );
            
            // Rewrite relative URLs to absolute
            html = html.replace(/(src|href|action|data)=["'](?!https?:\/\/|\/api\/proxy|javascript:|data:|#)([^"']+)["']/gi,
                function(match, attr, relativeUrl) {
                    try {
                        const absolute = new URL(relativeUrl, targetUrl).href;
                        return attr + '="/api/proxy?url=' + encodeURIComponent(absolute) + '"';
                    } catch(e) {
                        return match;
                    }
                }
            );
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }

        // CSS - fix URLs
        if (contentType.includes('text/css')) {
            let css = response.body.toString('utf8');
            css = css.replace(/url\(["']?(?!https?:\/\/temunet\.vercel\.app)((?:https?:)?\/\/[^)"']+)["']?\)/gi,
                function(match, url) {
                    const fullUrl = url.startsWith('http') ? url : 'https:' + url;
                    return 'url("/api/proxy?url=' + encodeURIComponent(fullUrl) + '")';
                }
            );
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            return res.send(css);
        }

        // JS - fix URLs
        if (contentType.includes('javascript')) {
            let js = response.body.toString('utf8');
            js = js.replace(/(["'`])((?:https?:)?\/\/((?!temunet\.vercel\.app)[^"'`]+))\1/g,
                function(match, quote, url) {
                    const fullUrl = url.startsWith('http') ? url : 'https:' + url;
                    return quote + '/api/proxy?url=' + encodeURIComponent(fullUrl) + quote;
                }
            );
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            return res.send(js);
        }

        res.status(response.status);
        return res.send(response.body);

    } catch (error) {
        console.error('Proxy error:', error.message);
        return res.status(502).send('Proxy error: ' + error.message);
    }
}
