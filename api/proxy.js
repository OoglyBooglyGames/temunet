const https = require('https');
const http = require('http');

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Get target URL
    let targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    // Decode the URL
    targetUrl = decodeURIComponent(targetUrl);
    
    console.log('Proxying:', targetUrl);

    try {
        // Parse the URL
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
            proxyReq.setTimeout(10000, () => {
                proxyReq.destroy();
                reject(new Error('Timeout'));
            });
            proxyReq.end();
        });

        const contentType = proxyResponse.headers['content-type'] || '';

        // Clean headers
        const cleanHeaders = { ...proxyResponse.headers };
        delete cleanHeaders['content-security-policy'];
        delete cleanHeaders['content-security-policy-report-only'];
        delete cleanHeaders['x-frame-options'];
        delete cleanHeaders['x-content-security-policy'];
        delete cleanHeaders['content-encoding'];
        delete cleanHeaders['transfer-encoding'];

        // Set response headers
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
            const proxyOrigin = `${proxyProtocol}://${proxyHost}`;
            
            // THE ULTIMATE FIX - Use ?url= pattern everywhere
            const navigationScript = `
<script>
(function() {
    const PROXY_PREFIX = '/api/proxy?url=';
    
    function proxyUrl(url) {
        if (!url || url.startsWith('javascript:') || url.startsWith('data:') || 
            url.startsWith('blob:') || url.startsWith('#') || url.startsWith('mailto:')) {
            return url;
        }
        try {
            const absolute = new URL(url, window.location.href).href;
            if (absolute.startsWith('http')) {
                return PROXY_PREFIX + encodeURIComponent(absolute);
            }
            return absolute;
        } catch(e) {
            return url;
        }
    }
    
    // Override window.location
    try {
        delete window.location;
    } catch(e) {}
    
    Object.defineProperty(window, 'location', {
        get: function() {
            return document.location;
        },
        set: function(url) {
            window.parent.postMessage({ type: 'NAVIGATE', url: url.toString() }, '*');
        },
        configurable: true
    });
    
    // Override history
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    
    history.pushState = function(state, title, url) {
        if (url) {
            try {
                const absolute = new URL(url, window.location.href).href;
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
                url = proxyUrl(absolute);
            } catch(e) {}
        }
        return origPushState.call(this, state, title, url);
    };
    
    history.replaceState = function(state, title, url) {
        if (url) {
            try {
                const absolute = new URL(url, window.location.href).href;
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
                url = proxyUrl(absolute);
            } catch(e) {}
        }
        return origReplaceState.call(this, state, title, url);
    };
    
    // Override window.open
    window.open = function(url, target, features) {
        if (url && typeof url === 'string') {
            window.parent.postMessage({ type: 'NAVIGATE', url: url.toString() }, '*');
            return { closed: false, close: function(){}, focus: function(){} };
        }
        return null;
    };
    
    // Catch ALL clicks
    document.addEventListener('click', function(e) {
        let target = e.target;
        while (target && target !== document) {
            if ((target.tagName === 'A' || target.tagName === 'AREA') && target.href) {
                const href = target.getAttribute('href');
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    const absolute = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
                    return false;
                }
            }
            target = target.parentElement;
        }
    }, true);
    
    // Catch forms
    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form.action && !form.action.startsWith('javascript:')) {
            e.preventDefault();
            e.stopPropagation();
            let action = form.action;
            if (form.method.toLowerCase() === 'get') {
                const fd = new FormData(form);
                const params = new URLSearchParams(fd).toString();
                if (params) action += (action.includes('?') ? '&' : '?') + params;
            }
            const absolute = new URL(action, window.location.href).href;
            window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            return false;
        }
    }, true);
    
    // Proxy resources
    function proxyElement(el) {
        const attrs = { IMG: 'src', SCRIPT: 'src', LINK: 'href', VIDEO: 'src', 
                       AUDIO: 'src', SOURCE: 'src', IFRAME: 'src', EMBED: 'src', 
                       OBJECT: 'data', A: 'href', FORM: 'action' };
        const attr = attrs[el.tagName];
        if (attr && el.hasAttribute(attr)) {
            const val = el.getAttribute(attr);
            if (val && val.startsWith('http') && !val.includes(window.location.host)) {
                el.setAttribute(attr, proxyUrl(val));
            }
        }
    }
    
    // Watch for new elements
    new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
            m.addedNodes.forEach(function(node) {
                if (node.nodeType === 1) {
                    proxyElement(node);
                    node.querySelectorAll('*').forEach(proxyElement);
                }
            });
            if (m.type === 'attributes' && m.target.nodeType === 1) {
                proxyElement(m.target);
            }
        });
    }).observe(document.documentElement, { 
        childList: true, subtree: true, 
        attributes: true, 
        attributeFilter: ['src', 'href', 'action', 'data'] 
    });
    
    document.querySelectorAll('*').forEach(proxyElement);
    
    // Override fetch
    const origFetch = window.fetch;
    window.fetch = function(url, opts) {
        if (typeof url === 'string') url = proxyUrl(url);
        return origFetch.call(this, url, opts);
    };
    
    // Override XMLHttpRequest
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OrigXHR();
        const origOpen = xhr.open;
        xhr.open = function(method, url, ...args) {
            if (typeof url === 'string') url = proxyUrl(url);
            return origOpen.call(this, method, url, ...args);
        };
        return xhr;
    };
    
    // Anti-detection
    try { delete window.frameElement; } catch(e) {}
    Object.defineProperties(window, {
        top: { get: () => window, configurable: false },
        parent: { get: () => window, configurable: false },
        frameElement: { get: () => null, configurable: false }
    });
    
    // Monitor URL changes
    let lastHref = window.location.href;
    setInterval(function() {
        if (window.location.href !== lastHref) {
            lastHref = window.location.href;
            window.parent.postMessage({ type: 'URL_CHANGE', url: lastHref }, '*');
        }
    }, 200);
    
    console.log('🛡️ Proxy active - using ?url= pattern');
})();
</script>
`;
            
            // Inject script
            html = html.replace(/<head[^>]*>/i, '$&' + navigationScript);
            
            // Add base tag
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Server-side URL rewriting
            html = html.replace(/(src|href|action|data)=["'](https?:)?\/\/([^"']+)["']/gi, 
                (match, attr, protocol, rest) => {
                    const fullUrl = (protocol || 'https:') + '//' + rest;
                    return attr + '="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                }
            );
            
            // Fix relative URLs in inline styles
            html = html.replace(/url\(["']?(https?:)?\/\/([^)"']+)["']?\)/gi,
                (match, protocol, rest) => {
                    const fullUrl = (protocol || 'https:') + '//' + rest;
                    return 'url("/api/proxy?url=' + encodeURIComponent(fullUrl) + '")';
                }
            );
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }

        // CSS
        if (contentType.includes('text/css')) {
            let css = proxyResponse.body.toString('utf8');
            css = css.replace(/url\(["']?(https?:)?\/\/([^)"']+)["']?\)/gi,
                (match, protocol, rest) => {
                    const fullUrl = (protocol || 'https:') + '//' + rest;
                    return 'url("/api/proxy?url=' + encodeURIComponent(fullUrl) + '")';
                }
            );
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            return res.send(css);
        }

        // JS
        if (contentType.includes('javascript')) {
            let js = proxyResponse.body.toString('utf8');
            js = js.replace(/(["'`])(https?:)?\/\/([^"'`]+)\1/g,
                (match, quote, protocol, rest) => {
                    const fullUrl = (protocol || 'https:') + '//' + rest;
                    return quote + '/api/proxy?url=' + encodeURIComponent(fullUrl) + quote;
                }
            );
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            return res.send(js);
        }

        // Everything else
        res.status(proxyResponse.statusCode);
        return res.send(proxyResponse.body);

    } catch (error) {
        console.error('Proxy error:', error.message);
        return res.status(502).json({ error: error.message });
    }
}
