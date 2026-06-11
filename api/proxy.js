const https = require('https');
const http = require('http');
const { URL } = require('url');

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        return res.status(200).end();
    }

    let targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    targetUrl = decodeURIComponent(targetUrl);

    try {
        const parsedUrl = new URL(targetUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: req.method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            },
            rejectUnauthorized: false,
        };

        const proxyResponse = await new Promise((resolve, reject) => {
            const proxyReq = client.request(options, (proxyRes) => {
                let chunks = [];
                proxyRes.on('data', (chunk) => chunks.push(chunk));
                proxyRes.on('end', () => {
                    resolve({
                        statusCode: proxyRes.statusCode,
                        headers: proxyRes.headers,
                        body: Buffer.concat(chunks)
                    });
                });
            });
            proxyReq.on('error', reject);
            proxyReq.end();
        });

        const contentType = proxyResponse.headers['content-type'] || '';

        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // Remove restrictive headers
        const cleanHeaders = { ...proxyResponse.headers };
        delete cleanHeaders['content-security-policy'];
        delete cleanHeaders['content-security-policy-report-only'];
        delete cleanHeaders['x-frame-options'];
        delete cleanHeaders['x-content-security-policy'];
        delete cleanHeaders['content-encoding'];
        delete cleanHeaders['transfer-encoding'];

        // Set cleaned headers
        Object.entries(cleanHeaders).forEach(([key, value]) => {
            if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });

        // Handle HTML
        if (contentType.includes('text/html')) {
            let html = proxyResponse.body.toString('utf8');
            
            const proxyHost = req.headers.host;
            const proxyProtocol = req.headers['x-forwarded-proto'] || 'https';
            
            // THE ULTIMATE NAVIGATION INTERCEPTION SCRIPT
            const navigationScript = `
<script>
(function() {
    // ============================================
    // ULTIMATE NAVIGATION INTERCEPTOR
    // ============================================
    
    const PROXY_BASE = '/api/proxy?url=';
    
    function proxyURL(url) {
        if (!url || url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) {
            return url;
        }
        try {
            // Resolve relative URLs
            const absolute = new URL(url, window.location.href).href;
            if (absolute.startsWith('http')) {
                return PROXY_BASE + encodeURIComponent(absolute);
            }
            return absolute;
        } catch(e) {
            return url;
        }
    }
    
    // 1. Override window.location
    const locationProxy = new Proxy(window.location, {
        get: function(target, prop) {
            if (prop === 'assign' || prop === 'replace') {
                return function(url) {
                    window.parent.postMessage({
                        type: 'NAVIGATE',
                        url: url.toString()
                    }, '*');
                };
            }
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
        },
        set: function(target, prop, value) {
            if (prop === 'href') {
                window.parent.postMessage({
                    type: 'NAVIGATE',
                    url: value.toString()
                }, '*');
                return true;
            }
            target[prop] = value;
            return true;
        }
    });
    
    try { window.location = locationProxy; } catch(e) {}
    try { document.location = locationProxy; } catch(e) {}
    
    // 2. Override history API
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    
    history.pushState = function(state, title, url) {
        if (url) {
            try {
                const absolute = new URL(url, window.location.href).href;
                url = proxyURL(absolute);
                // Notify parent of URL change
                window.parent.postMessage({
                    type: 'URL_CHANGE',
                    url: absolute
                }, '*');
            } catch(e) {}
        }
        return origPushState.call(this, state, title, url);
    };
    
    history.replaceState = function(state, title, url) {
        if (url) {
            try {
                const absolute = new URL(url, window.location.href).href;
                url = proxyURL(absolute);
                window.parent.postMessage({
                    type: 'URL_CHANGE',
                    url: absolute
                }, '*');
            } catch(e) {}
        }
        return origReplaceState.call(this, state, title, url);
    };
    
    // 3. Override window.open
    const origOpen = window.open;
    window.open = function(url, target, features) {
        if (url && typeof url === 'string') {
            window.parent.postMessage({
                type: 'NAVIGATE',
                url: url.toString()
            }, '*');
            return { closed: false, close: function(){}, focus: function(){} };
        }
        return origOpen.apply(this, arguments);
    };
    
    // 4. Intercept all link clicks (capture phase)
    document.addEventListener('click', function(e) {
        let target = e.target;
        while (target && target !== document) {
            if (target.tagName === 'A' || target.tagName === 'AREA') {
                const href = target.getAttribute('href');
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    
                    const absolute = new URL(href, window.location.href).href;
                    window.parent.postMessage({
                        type: 'NAVIGATE',
                        url: absolute
                    }, '*');
                    return false;
                }
            }
            target = target.parentElement;
        }
    }, true);
    
    // 5. Intercept form submissions
    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form.action && !form.action.startsWith('javascript:')) {
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
            
            const absolute = new URL(action, window.location.href).href;
            window.parent.postMessage({
                type: 'NAVIGATE',
                url: absolute
            }, '*');
            return false;
        }
    }, true);
    
    // 6. Override fetch
    const origFetch = window.fetch;
    window.fetch = function(url, options = {}) {
        if (typeof url === 'string') {
            url = proxyURL(url);
        } else if (url instanceof Request) {
            const newUrl = proxyURL(url.url);
            url = new Request(newUrl, url);
        }
        return origFetch.call(this, url, options);
    };
    
    // 7. Override XMLHttpRequest
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OrigXHR();
        const origOpen = xhr.open;
        xhr.open = function(method, url, ...args) {
            if (typeof url === 'string') {
                url = proxyURL(url);
            }
            return origOpen.call(this, method, url, ...args);
        };
        return xhr;
    };
    
    // 8. Proxy all resource elements
    function proxyElement(el) {
        const attrs = {
            'IMG': 'src', 'SCRIPT': 'src', 'LINK': 'href',
            'VIDEO': 'src', 'AUDIO': 'src', 'SOURCE': 'src',
            'IFRAME': 'src', 'OBJECT': 'data', 'EMBED': 'src',
            'A': 'href', 'FORM': 'action'
        };
        
        const attr = attrs[el.tagName];
        if (attr && el.hasAttribute(attr)) {
            const value = el.getAttribute(attr);
            if (value && value.startsWith('http')) {
                el.setAttribute(attr, proxyURL(value));
            }
        }
    }
    
    // Watch for new elements
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
                if (node.nodeType === 1) {
                    proxyElement(node);
                    node.querySelectorAll('*').forEach(proxyElement);
                }
            });
            if (mutation.type === 'attributes' && mutation.target.nodeType === 1) {
                proxyElement(mutation.target);
            }
        });
    });
    
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'href', 'action', 'data']
    });
    
    // Proxy existing elements
    document.querySelectorAll('*').forEach(proxyElement);
    
    // 9. Monitor URL changes
    let lastUrl = window.location.href;
    setInterval(function() {
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            window.parent.postMessage({
                type: 'URL_CHANGE',
                url: currentUrl
            }, '*');
        }
    }, 100);
    
    // 10. Anti-detection
    try { delete window.frameElement; } catch(e) {}
    Object.defineProperties(window, {
        top: { get: function() { return window; }, configurable: false },
        parent: { get: function() { return window; }, configurable: false },
        frameElement: { get: function() { return null; }, configurable: false }
    });
    
    console.log('🛡️ Navigation interceptor active');
})();
</script>
`;
            
            // Inject navigation script
            html = html.replace(/<head[^>]*>/i, '$&' + navigationScript);
            
            // Add base tag
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Server-side URL rewriting as backup
            html = html.replace(/(src|href|action|data)=["'](https?:)?\/\/(?!temunet\.vercel\.app)([^"']+)["']/gi, 
                (match, attr, protocol, url) => {
                    const fullUrl = (protocol || 'https:') + '//' + url;
                    return attr + '="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                }
            );
            
            // Fix CSS urls
            html = html.replace(/url\(["']?(https?:)?\/\/(?!temunet\.vercel\.app)([^)"']+)["']?\)/gi,
                (match, protocol, url) => {
                    const fullUrl = (protocol || 'https:') + '//' + url;
                    return 'url("/api/proxy?url=' + encodeURIComponent(fullUrl) + '")';
                }
            );
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }

        // Handle CSS
        if (contentType.includes('text/css')) {
            let css = proxyResponse.body.toString('utf8');
            css = css.replace(/url\(["']?(https?:)?\/\/(?!temunet\.vercel\.app)([^)"']+)["']?\)/gi,
                (match, protocol, url) => {
                    const fullUrl = (protocol || 'https:') + '//' + url;
                    return 'url("/api/proxy?url=' + encodeURIComponent(fullUrl) + '")';
                }
            );
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            return res.send(css);
        }

        // Handle JavaScript
        if (contentType.includes('javascript')) {
            let js = proxyResponse.body.toString('utf8');
            js = js.replace(/(["'`])(https?:)?\/\/(?!temunet\.vercel\.app)([^"'`]+)\1/g,
                (match, quote, protocol, url) => {
                    const fullUrl = (protocol || 'https:') + '//' + url;
                    return quote + '/api/proxy?url=' + encodeURIComponent(fullUrl) + quote;
                }
            );
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            return res.send(js);
        }

        // Other content
        res.status(proxyResponse.statusCode);
        return res.send(proxyResponse.body);

    } catch (error) {
        console.error('Proxy error:', error);
        return res.status(502).json({ error: error.message });
    }
}
