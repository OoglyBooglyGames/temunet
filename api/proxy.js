const https = require('https');
const http = require('http');

export default async function handler(req, res) {
    // CORS
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        return res.status(200).end();
    }

    // Get the target URL from the query or path
    let targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'No URL' });
    }

    // If the URL doesn't have a protocol, it's a path-based request
    if (!targetUrl.startsWith('http')) {
        // Get the host from the request
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        
        // Extract the real target from the URL path
        // The URL might look like: /proxy/youtube.com/results?search_query=test
        // Or: /youtube.com/results?search_query=test
        let path = targetUrl;
        
        // Remove /proxy/ prefix if present
        if (path.startsWith('proxy/')) {
            path = path.substring(6);
        }
        
        // Get the full URL including query string
        const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        
        // Build the real URL
        targetUrl = 'https://' + path + queryString;
        
        // Remove any duplicate query parameters
        const urlObj = new URL(targetUrl);
        targetUrl = urlObj.origin + urlObj.pathname + urlObj.search;
    }

    // Decode if it's still encoded
    if (targetUrl.includes('%')) {
        targetUrl = decodeURIComponent(targetUrl);
    }

    console.log('Proxying:', targetUrl);

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

        // Set CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // Clean and set headers
        const cleanHeaders = { ...proxyResponse.headers };
        delete cleanHeaders['content-security-policy'];
        delete cleanHeaders['content-security-policy-report-only'];
        delete cleanHeaders['x-frame-options'];
        delete cleanHeaders['x-content-security-policy'];
        delete cleanHeaders['content-encoding'];
        delete cleanHeaders['transfer-encoding'];

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
            
            // Inject our navigation handler
            const navigationScript = `
<script>
(function() {
    const PROXY_ORIGIN = '${proxyOrigin}';
    
    function proxyUrl(url) {
        if (!url || url.startsWith('javascript:') || url.startsWith('data:') || 
            url.startsWith('blob:') || url.startsWith('#') || url.startsWith('mailto:')) {
            return url;
        }
        try {
            const absolute = new URL(url, window.location.href).href;
            if (absolute.startsWith('http')) {
                // Convert to path-based proxy URL
                const urlObj = new URL(absolute);
                return PROXY_ORIGIN + '/' + urlObj.host + urlObj.pathname + urlObj.search + urlObj.hash;
            }
            return absolute;
        } catch(e) {
            return url;
        }
    }
    
    // Intercept navigation
    window.addEventListener('message', function(e) {
        if (e.data && e.data.type === 'NAVIGATE') {
            window.location.href = proxyUrl(e.data.url);
        }
    });
    
    // Override history
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    
    history.pushState = function(state, title, url) {
        if (url) {
            try {
                const absolute = new URL(url, window.location.href).href;
                url = proxyUrl(absolute);
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
            } catch(e) {}
        }
        return origPushState.call(this, state, title, url);
    };
    
    history.replaceState = function(state, title, url) {
        if (url) {
            try {
                const absolute = new URL(url, window.location.href).href;
                url = proxyUrl(absolute);
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
            } catch(e) {}
        }
        return origReplaceState.call(this, state, title, url);
    };
    
    // Catch all clicks
    document.addEventListener('click', function(e) {
        let target = e.target;
        while (target && target !== document) {
            if ((target.tagName === 'A' || target.tagName === 'AREA') && target.href) {
                const href = target.getAttribute('href');
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                    e.preventDefault();
                    e.stopPropagation();
                    const absolute = new URL(href, window.location.href).href;
                    window.location.href = proxyUrl(absolute);
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
            let action = form.action;
            if (form.method.toLowerCase() === 'get') {
                const fd = new FormData(form);
                const params = new URLSearchParams(fd).toString();
                if (params) action += (action.includes('?') ? '&' : '?') + params;
            }
            const absolute = new URL(action, window.location.href).href;
            window.location.href = proxyUrl(absolute);
            return false;
        }
    }, true);
    
    // Proxy all resources
    function proxyElement(el) {
        const attrs = { IMG: 'src', SCRIPT: 'src', LINK: 'href', VIDEO: 'src', 
                       AUDIO: 'src', SOURCE: 'src', IFRAME: 'src', EMBED: 'src', 
                       OBJECT: 'data', A: 'href', FORM: 'action' };
        const attr = attrs[el.tagName];
        if (attr && el.hasAttribute(attr)) {
            const val = el.getAttribute(attr);
            if (val && val.startsWith('http') && !val.includes(PROXY_ORIGIN)) {
                el.setAttribute(attr, proxyUrl(val));
            }
        }
    }
    
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
    }).observe(document.documentElement, { childList: true, subtree: true, 
        attributes: true, attributeFilter: ['src', 'href', 'action', 'data'] });
    
    document.querySelectorAll('*').forEach(proxyElement);
    
    // Override fetch and XHR
    const origFetch = window.fetch;
    window.fetch = function(url, opts) {
        if (typeof url === 'string') url = proxyUrl(url);
        return origFetch.call(this, url, opts);
    };
    
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
        top: { get: () => window },
        parent: { get: () => window },
        frameElement: { get: () => null }
    });
    
    console.log('🛡️ Path-based proxy active');
})();
</script>
`;
            
            html = html.replace(/<head[^>]*>/i, '$&' + navigationScript);
            
            // Add base tag
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Server-side URL rewriting as backup
            html = html.replace(/(src|href|action|data)=["'](https?:)?\/\/([^"']+)["']/gi, 
                (match, attr, protocol, domain) => {
                    const fullUrl = (protocol || 'https:') + '//' + domain;
                    if (domain.includes(proxyHost)) return match;
                    const urlObj = new URL(fullUrl);
                    return attr + '="/' + urlObj.host + urlObj.pathname + urlObj.search + '"';
                }
            );
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }

        // Other content types
        if (contentType.includes('text/css')) {
            let css = proxyResponse.body.toString('utf8');
            css = css.replace(/url\(["']?(https?:)?\/\/([^)"']+)["']?\)/gi,
                (match, protocol, domain) => {
                    const fullUrl = (protocol || 'https:') + '//' + domain;
                    const urlObj = new URL(fullUrl);
                    return 'url("/' + urlObj.host + urlObj.pathname + urlObj.search + '")';
                }
            );
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            return res.send(css);
        }

        res.status(proxyResponse.statusCode);
        return res.send(proxyResponse.body);

    } catch (error) {
        console.error('Proxy error:', error);
        return res.status(502).json({ error: error.message });
    }
}
