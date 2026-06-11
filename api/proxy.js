const https = require('https');
const http = require('http');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    let targetUrl = '';
    
    // Method 1: Direct URL parameter
    if (req.query.url) {
        targetUrl = decodeURIComponent(req.query.url);
    }
    // Method 2: Path-based (YouTube navigation)
    else if (req.query.path) {
        let path = req.query.path;
        const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?') + 1) : '';
        
        // Remove the 'path=' from query string
        const cleanQuery = queryString.replace(/^path=[^&]*&?/, '').replace(/&path=[^&]*/g, '');
        
        // Try to determine the host from the path or use a default
        // If path contains a known domain, extract it
        if (path.includes('youtube.com') || path.includes('youtu.be')) {
            targetUrl = 'https://' + path;
            if (cleanQuery) targetUrl += '?' + cleanQuery;
        } else if (path.includes('google.com')) {
            targetUrl = 'https://' + path;
            if (cleanQuery) targetUrl += '?' + cleanQuery;
        } else if (path.includes('reddit.com')) {
            targetUrl = 'https://' + path;
            if (cleanQuery) targetUrl += '?' + cleanQuery;
        } else if (path.includes('x.com') || path.includes('twitter.com')) {
            targetUrl = 'https://' + path;
            if (cleanQuery) targetUrl += '?' + cleanQuery;
        } else {
            // Unknown path - check referer or use a best guess
            const referer = req.headers.referer || '';
            let baseHost = 'www.google.com';
            
            // Extract host from referer
            const refMatch = referer.match(/\/api\/proxy\?url=https?%3A%2F%2F([^%&]+)/);
            if (refMatch) {
                baseHost = decodeURIComponent(refMatch[1]);
            } else {
                // Check if referer contains the original host
                const refHostMatch = referer.match(/url=https?%3A%2F%2F([^%&]+)/);
                if (refHostMatch) {
                    baseHost = decodeURIComponent(refHostMatch[1]);
                }
            }
            
            // Build URL with the detected host
            targetUrl = 'https://' + baseHost + '/' + path;
            if (cleanQuery) targetUrl += '?' + cleanQuery;
        }
    }
    
    if (!targetUrl) {
        // Last resort: try to extract from the full URL
        const fullPath = req.url;
        const urlMatch = fullPath.match(/[?&]url=(https?%3A%2F%2F[^&]+)/);
        if (urlMatch) {
            targetUrl = decodeURIComponent(urlMatch[1]);
        }
    }
    
    if (!targetUrl) {
        return res.status(400).send('No URL provided');
    }

    // Ensure URL has protocol
    if (!targetUrl.startsWith('http')) {
        targetUrl = 'https://' + targetUrl;
    }

    console.log('Proxying:', targetUrl);

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
                // Handle redirects
                if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                    let redirectUrl = proxyRes.headers.location;
                    if (!redirectUrl.startsWith('http')) {
                        redirectUrl = new URL(redirectUrl, targetUrl).href;
                    }
                    res.writeHead(302, {
                        'Location': '/api/proxy?url=' + encodeURIComponent(redirectUrl)
                    });
                    res.end();
                    return;
                }
                
                let chunks = [];
                proxyRes.on('data', chunk => chunks.push(chunk));
                proxyRes.on('end', () => resolve({
                    status: proxyRes.statusCode,
                    headers: proxyRes.headers,
                    body: Buffer.concat(chunks)
                }));
            });
            proxyReq.on('error', reject);
            proxyReq.setTimeout(15000, () => {
                proxyReq.destroy();
                reject(new Error('Timeout'));
            });
            proxyReq.end();
        });

        if (res.headersSent) return;

        const contentType = response.headers['content-type'] || '';

        ['content-security-policy', 'content-security-policy-report-only', 
         'x-frame-options', 'x-content-security-policy', 'x-webkit-csp', 
         'frame-options', 'x-xss-protection', 'content-encoding', 
         'transfer-encoding'].forEach(h => delete response.headers[h]);

        Object.entries(response.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });

        if (contentType.includes('text/html')) {
            let html = response.body.toString('utf8');
            const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
            
            // INJECT SCRIPT THAT FIXES ALL NAVIGATION
            const script = `
<script>
(function() {
    var _realUrl = '${targetUrl}';
    var PROXY_API = '/api/proxy?url=';
    
    function proxyUrl(url) {
        if (!url || url.startsWith('javascript:') || url.startsWith('data:') || 
            url.startsWith('blob:') || url.startsWith('#') || url.startsWith('mailto:')) {
            return url;
        }
        try {
            var absolute = new URL(url, _realUrl).href;
            if (absolute.startsWith('http')) {
                return PROXY_API + encodeURIComponent(absolute);
            }
            return absolute;
        } catch(e) {
            return url;
        }
    }
    
    var _location = {
        get href() { return proxyUrl(_realUrl); },
        set href(url) {
            try {
                _realUrl = new URL(url, _realUrl).href;
                window.parent.postMessage({ type: 'NAVIGATE', url: _realUrl }, '*');
            } catch(e) {}
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
        toString: function() { return proxyUrl(_realUrl); }
    };
    
    try { delete window.location; } catch(e) {}
    try { delete document.location; } catch(e) {}
    Object.defineProperty(window, 'location', { get: function() { return _location; }, set: function(url) { _location.href = url; }, configurable: false });
    Object.defineProperty(document, 'location', { get: function() { return _location; }, set: function(url) { _location.href = url; }, configurable: false });
    
    var _pushState = history.pushState.bind(history);
    var _replaceState = history.replaceState.bind(history);
    history.pushState = function(state, title, url) {
        if (url) { try { _realUrl = new URL(url, _realUrl).href; } catch(e) {} url = proxyUrl(url); }
        return _pushState(state, title, url);
    };
    history.replaceState = function(state, title, url) {
        if (url) { try { _realUrl = new URL(url, _realUrl).href; } catch(e) {} url = proxyUrl(url); }
        return _replaceState(state, title, url);
    };
    
    window.open = function(url) {
        if (url) {
            try { _realUrl = new URL(url, _realUrl).href; } catch(e) {}
            window.parent.postMessage({ type: 'NAVIGATE', url: _realUrl }, '*');
        }
        return { closed: false, close: function(){}, focus: function(){} };
    };
    
    document.addEventListener('click', function(e) {
        var target = e.target;
        while (target && target !== document.documentElement) {
            if ((target.tagName === 'A' || target.tagName === 'AREA') && target.href) {
                var href = target.getAttribute('href');
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    try {
                        _realUrl = new URL(href, _realUrl).href;
                        window.parent.postMessage({ type: 'NAVIGATE', url: _realUrl }, '*');
                    } catch(e) {}
                    return false;
                }
            }
            target = target.parentElement;
        }
    }, true);
    
    document.addEventListener('submit', function(e) {
        if (e.target.action && !e.target.action.startsWith('javascript:')) {
            e.preventDefault();
            e.stopPropagation();
            try {
                var action = e.target.action;
                if (e.target.method.toLowerCase() === 'get') {
                    var fd = new FormData(e.target);
                    var params = new URLSearchParams(fd).toString();
                    if (params) action += (action.includes('?') ? '&' : '?') + params;
                }
                _realUrl = new URL(action, _realUrl).href;
                window.parent.postMessage({ type: 'NAVIGATE', url: _realUrl }, '*');
            } catch(e) {}
            return false;
        }
    }, true);
    
    function fixUrl(url) {
        if (url && (url.startsWith('http') || url.startsWith('//')) && !url.includes(window.location.hostname)) {
            return proxyUrl(url.startsWith('//') ? 'https:' + url : url);
        }
        return url;
    }
    
    function fixEl(el) {
        var attrs = { IMG: 'src', SCRIPT: 'src', LINK: 'href', VIDEO: 'src', AUDIO: 'src', SOURCE: 'src', IFRAME: 'src', EMBED: 'src', OBJECT: 'data' };
        var attr = attrs[el.tagName];
        if (attr && el.hasAttribute(attr)) {
            var val = el.getAttribute(attr);
            if (val && (val.startsWith('http') || val.startsWith('//'))) {
                el.setAttribute(attr, fixUrl(val));
            }
        }
    }
    
    document.querySelectorAll('img, script, link, video, audio, source, iframe, embed, object').forEach(fixEl);
    
    new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
            m.addedNodes.forEach(function(node) {
                if (node.nodeType === 1) {
                    fixEl(node);
                    node.querySelectorAll('img, script, link, video, audio, source, iframe, embed, object').forEach(fixEl);
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });
    
    var _fetch = window.fetch;
    window.fetch = function(url, opts) {
        if (typeof url === 'string') url = fixUrl(url);
        return _fetch.call(this, url, opts);
    };
    
    var OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        var xhr = new OrigXHR();
        var _open = xhr.open;
        xhr.open = function(method, url, ...args) {
            return _open.call(this, method, fixUrl(url), ...args);
        };
        return xhr;
    };
    
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
})();
</script>
`;
            
            html = html.replace(/<head[^>]*>/i, '<head>' + script);
            html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy[^>]*>/gi, '');
            html = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy-Report-Only[^>]*>/gi, '');
            
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Rewrite absolute URLs
            html = html.replace(/(src|href|action|data)=["']((?:https?:)?\/\/)([^"']+)["']/gi,
                function(match, attr, protocol, rest) {
                    const fullUrl = (protocol.startsWith('http') ? '' : 'https:') + protocol + rest;
                    if (rest.includes(proxyHost)) return match;
                    return attr + '="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                }
            );
            
            // Rewrite relative URLs
            html = html.replace(/(src|href|action|data)=["'](?!https?:\/\/|\/api\/proxy|javascript:|data:|#|mailto:)([^"']+)["']/gi,
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

        if (contentType.includes('text/css')) {
            let css = response.body.toString('utf8');
            css = css.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi,
                function(match, url) {
                    const fullUrl = url.startsWith('http') ? url : 'https:' + url;
                    return 'url("/api/proxy?url=' + encodeURIComponent(fullUrl) + '")';
                }
            );
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            return res.send(css);
        }

        if (contentType.includes('javascript')) {
            let js = response.body.toString('utf8');
            js = js.replace(/(["'`])((?:https?:)?\/\/[^"'`]+)\1/g,
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
        return res.status(502).send('Error: ' + error.message);
    }
}
