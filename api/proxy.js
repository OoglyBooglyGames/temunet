const https = require('https');
const http = require('http');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    const targetUrl = decodeURIComponent(req.query.url || '');
    
    if (!targetUrl) {
        return res.status(400).send('No URL');
    }

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
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            },
            rejectUnauthorized: false,
        };

        const response = await new Promise((resolve, reject) => {
            const req = client.request(options, (resp) => {
                let data = [];
                resp.on('data', chunk => data.push(chunk));
                resp.on('end', () => resolve({
                    status: resp.statusCode,
                    headers: resp.headers,
                    body: Buffer.concat(data)
                }));
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
            req.end();
        });

        const contentType = response.headers['content-type'] || '';

        // Remove problematic headers
        ['content-security-policy', 'content-security-policy-report-only', 
         'x-frame-options', 'x-content-security-policy', 'content-encoding',
         'transfer-encoding'].forEach(h => delete response.headers[h]);

        Object.entries(response.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });

        if (contentType.includes('text/html')) {
            let html = response.body.toString('utf8');
            
            // THE NUCLEAR SCRIPT - Intercepts EVERYTHING
            const script = `
<script>
(function() {
    // Store original URL
    let currentRealUrl = '${targetUrl}';
    
    function makeProxyUrl(url) {
        if (!url || url.startsWith('javascript:') || url.startsWith('data:') || 
            url.startsWith('blob:') || url.startsWith('#') || url.startsWith('mailto:') ||
            url.startsWith('tel:')) {
            return url;
        }
        try {
            const absolute = new URL(url, currentRealUrl).href;
            if (absolute.startsWith('http')) {
                return '/api/proxy?url=' + encodeURIComponent(absolute);
            }
            return absolute;
        } catch(e) {
            return url;
        }
    }
    
    // NUCLEAR OPTION: Replace the entire location object
    const fakeLocation = {
        get href() { return makeProxyUrl(currentRealUrl); },
        set href(url) {
            try {
                const absolute = new URL(url, currentRealUrl).href;
                currentRealUrl = absolute;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(e) {}
        },
        get origin() { try { return new URL(currentRealUrl).origin; } catch(e) { return ''; } },
        get protocol() { try { return new URL(currentRealUrl).protocol; } catch(e) { return 'https:'; } },
        get host() { try { return new URL(currentRealUrl).host; } catch(e) { return ''; } },
        get hostname() { try { return new URL(currentRealUrl).hostname; } catch(e) { return ''; } },
        get port() { try { return new URL(currentRealUrl).port; } catch(e) { return ''; } },
        get pathname() { try { return new URL(currentRealUrl).pathname; } catch(e) { return ''; } },
        get search() { try { return new URL(currentRealUrl).search; } catch(e) { return ''; } },
        get hash() { try { return new URL(currentRealUrl).hash; } catch(e) { return ''; } },
        assign: function(url) {
            try {
                const absolute = new URL(url, currentRealUrl).href;
                currentRealUrl = absolute;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(e) {}
        },
        replace: function(url) {
            try {
                const absolute = new URL(url, currentRealUrl).href;
                currentRealUrl = absolute;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(e) {}
        },
        reload: function() {
            window.parent.postMessage({ type: 'RELOAD' }, '*');
        },
        toString: function() { return makeProxyUrl(currentRealUrl); }
    };
    
    // Force override location
    try { delete window.location; } catch(e) {}
    try { delete document.location; } catch(e) {}
    
    Object.defineProperty(window, 'location', {
        get: function() { return fakeLocation; },
        set: function(url) {
            try {
                const absolute = new URL(url, currentRealUrl).href;
                currentRealUrl = absolute;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(e) {}
        },
        configurable: false,
        enumerable: true
    });
    
    Object.defineProperty(document, 'location', {
        get: function() { return fakeLocation; },
        set: function(url) {
            try {
                const absolute = new URL(url, currentRealUrl).href;
                currentRealUrl = absolute;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(e) {}
        },
        configurable: false,
        enumerable: true
    });
    
    // Override history
    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);
    
    history.pushState = function(state, title, url) {
        if (url) {
            try {
                const absolute = new URL(url, currentRealUrl).href;
                currentRealUrl = absolute;
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
                url = makeProxyUrl(absolute);
            } catch(e) {}
        }
        return origPushState(state, title, url);
    };
    
    history.replaceState = function(state, title, url) {
        if (url) {
            try {
                const absolute = new URL(url, currentRealUrl).href;
                currentRealUrl = absolute;
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
                url = makeProxyUrl(absolute);
            } catch(e) {}
        }
        return origReplaceState(state, title, url);
    };
    
    // Override window.open
    window.open = function(url, target, features) {
        if (url) {
            try {
                const absolute = new URL(url, currentRealUrl).href;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(e) {}
            return { closed: false, close: function(){}, focus: function(){} };
        }
        return null;
    };
    
    // Catch ALL clicks with highest priority
    document.addEventListener('click', function(e) {
        let target = e.target;
        while (target && target !== document.documentElement) {
            if (target.tagName === 'A' || target.tagName === 'AREA') {
                const href = target.getAttribute('href');
                if (href && href !== '#' && !href.startsWith('javascript:') && !href.startsWith('data:')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    try {
                        const absolute = new URL(href, currentRealUrl).href;
                        window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
                    } catch(e) {}
                    return false;
                }
            }
            target = target.parentElement;
        }
    }, true);
    
    // Catch form submissions
    document.addEventListener('submit', function(e) {
        const form = e.target;
        if (form.action && !form.action.startsWith('javascript:')) {
            e.preventDefault();
            e.stopPropagation();
            try {
                let action = form.action;
                if (form.method.toLowerCase() === 'get') {
                    const fd = new FormData(form);
                    const params = new URLSearchParams(fd).toString();
                    if (params) action += (action.includes('?') ? '&' : '?') + params;
                }
                const absolute = new URL(action, currentRealUrl).href;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(e) {}
            return false;
        }
    }, true);
    
    // Proxy all resource URLs
    function fixUrl(url) {
        if (url && url.startsWith('http') && !url.includes(window.location.hostname)) {
            return makeProxyUrl(url);
        }
        return url;
    }
    
    function fixElement(el) {
        const attrs = { IMG: 'src', SCRIPT: 'src', LINK: 'href', VIDEO: 'src', 
                       AUDIO: 'src', SOURCE: 'src', IFRAME: 'src', EMBED: 'src', 
                       OBJECT: 'data' };
        const attr = attrs[el.tagName];
        if (attr) {
            const val = el.getAttribute(attr);
            if (val && val.startsWith('http')) {
                el.setAttribute(attr, fixUrl(val));
            }
        }
    }
    
    // Fix all existing elements
    document.querySelectorAll('img, script, link, video, audio, source, iframe, embed, object').forEach(fixElement);
    
    // Watch for new elements
    new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
            m.addedNodes.forEach(function(node) {
                if (node.nodeType === 1) {
                    fixElement(node);
                    node.querySelectorAll('img, script, link, video, audio, source, iframe, embed, object').forEach(fixElement);
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });
    
    // Override fetch
    const origFetch = window.fetch;
    window.fetch = function(url, opts) {
        if (typeof url === 'string') url = fixUrl(url);
        if (url instanceof Request) {
            url = new Request(fixUrl(url.url), url);
        }
        return origFetch.call(this, url, opts);
    };
    
    // Override XHR
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OrigXHR();
        const origOpen = xhr.open;
        xhr.open = function(method, url, ...args) {
            return origOpen.call(this, method, fixUrl(url), ...args);
        };
        return xhr;
    };
    
    // Override createElement for dynamic elements
    const origCreateElement = document.createElement.bind(document);
    document.createElement = function(tag, options) {
        const el = origCreateElement(tag, options);
        const origSetAttribute = el.setAttribute.bind(el);
        el.setAttribute = function(name, value) {
            if (['src', 'href', 'action', 'data'].includes(name.toLowerCase())) {
                value = fixUrl(value);
            }
            return origSetAttribute(name, value);
        };
        return el;
    };
    
    // Anti-detection
    try { delete window.frameElement; } catch(e) {}
    Object.defineProperties(window, {
        top: { get: () => window, configurable: false },
        parent: { get: () => window, configurable: false },
        frameElement: { get: () => null, configurable: false },
        self: { get: () => window, configurable: false }
    });
    
    // Update URL periodically
    setInterval(function() {
        try {
            const currentHref = document.location.href;
            if (currentHref && currentHref !== makeProxyUrl(currentRealUrl)) {
                // URL changed externally
                const match = currentHref.match(/url=([^&]+)/);
                if (match) {
                    const decoded = decodeURIComponent(match[1]);
                    if (decoded !== currentRealUrl) {
                        currentRealUrl = decoded;
                        window.parent.postMessage({ type: 'URL_CHANGE', url: decoded }, '*');
                    }
                }
            }
        } catch(e) {}
    }, 500);
    
    console.log('🔥 NUCLEAR PROXY ACTIVE');
})();
</script>
`;
            
            // Inject script at very beginning
            html = html.replace(/<head[^>]*>/i, '<head>' + script);
            
            // Add base tag
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Server-side URL rewriting
            html = html.replace(/(src|href|action|data)=["'](https?:)?\/\/((?!temunet\.vercel\.app)[^"']+)["']/gi,
                (match, attr, protocol, rest) => {
                    const fullUrl = (protocol || 'https:') + '//' + rest;
                    return attr + '="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                }
            );
            
            html = html.replace(/url\(["']?(https?:)?\/\/((?!temunet\.vercel\.app)[^)"']+)["']?\)/gi,
                (match, protocol, rest) => {
                    const fullUrl = (protocol || 'https:') + '//' + rest;
                    return 'url("/api/proxy?url=' + encodeURIComponent(fullUrl) + '")';
                }
            );
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }

        res.status(response.status);
        return res.send(response.body);

    } catch (error) {
        return res.status(502).json({ error: error.message });
    }
}
