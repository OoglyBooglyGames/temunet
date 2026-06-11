const https = require('https');
const http = require('http');
const { URL } = require('url');

export default async function handler(req, res) {
    // Handle CORS preflight
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

        // Forward the request
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
                
                proxyRes.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                
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

        // Get content type
        const contentType = proxyResponse.headers['content-type'] || '';

        // Set response headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        
        // Remove restrictive headers
        delete proxyResponse.headers['content-security-policy'];
        delete proxyResponse.headers['content-security-policy-report-only'];
        delete proxyResponse.headers['x-frame-options'];
        delete proxyResponse.headers['x-content-security-policy'];
        
        // Set modified headers
        Object.entries(proxyResponse.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });

        // Handle HTML - inject base tag and proxy all resources
        if (contentType.includes('text/html')) {
            let html = proxyResponse.body.toString('utf8');
            
            // Get the proxy host
            const proxyHost = req.headers.host;
            const proxyProtocol = req.headers['x-forwarded-proto'] || 'https';
            const proxyBase = `${proxyProtocol}://${proxyHost}`;
            
            // Inject our proxy script before any other scripts
            const injectScript = `
<script>
(function() {
    // Override fetch to proxy all requests
    const originalFetch = window.fetch;
    window.fetch = function(url, options = {}) {
        if (typeof url === 'string' && url.startsWith('http')) {
            url = '/api/proxy?url=' + encodeURIComponent(url);
        }
        return originalFetch(url, options);
    };
    
    // Override XMLHttpRequest
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open;
        xhr.open = function(method, url, ...args) {
            if (typeof url === 'string' && url.startsWith('http') && !url.includes(window.location.host)) {
                url = '/api/proxy?url=' + encodeURIComponent(url);
            }
            return originalOpen.call(this, method, url, ...args);
        };
        return xhr;
    };
    
    // Override Image constructor
    const OriginalImage = window.Image;
    window.Image = function() {
        const img = new OriginalImage();
        const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        Object.defineProperty(img, 'src', {
            get: function() { return originalSrcDescriptor.get.call(this); },
            set: function(value) {
                if (typeof value === 'string' && value.startsWith('http') && !value.includes(window.location.host)) {
                    value = '/api/proxy?url=' + encodeURIComponent(value);
                }
                originalSrcDescriptor.set.call(this, value);
            }
        });
        return img;
    };
    
    // Proxy all resource elements
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
                if (node.tagName) {
                    proxyElement(node);
                }
            });
            if (mutation.type === 'attributes' && mutation.target.tagName) {
                proxyElement(mutation.target);
            }
        });
    });
    
    function proxyElement(el) {
        const proxyAttrs = {
            'IMG': 'src',
            'SCRIPT': 'src',
            'LINK': 'href',
            'VIDEO': 'src',
            'AUDIO': 'src',
            'SOURCE': 'src',
            'IFRAME': 'src',
            'OBJECT': 'data',
            'EMBED': 'src'
        };
        
        const attr = proxyAttrs[el.tagName];
        if (attr && el[attr] && el[attr].startsWith('http') && !el[attr].includes(window.location.host)) {
            const originalValue = el.getAttribute(attr);
            if (originalValue && originalValue.startsWith('http') && !originalValue.includes(window.location.host)) {
                el.setAttribute(attr, '/api/proxy?url=' + encodeURIComponent(originalValue));
            }
        }
    }
    
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'href', 'data']
    });
    
    // Fix existing elements
    document.querySelectorAll('img, script, link, video, audio, source, iframe, object, embed').forEach(proxyElement);
    
    // Override history API
    const originalPushState = history.pushState;
    history.pushState = function(state, title, url) {
        if (url && url.startsWith('http')) {
            url = '/?url=' + encodeURIComponent(url);
        }
        return originalPushState.call(this, state, title, url);
    };
    
    const originalReplaceState = history.replaceState;
    history.replaceState = function(state, title, url) {
        if (url && url.startsWith('http')) {
            url = '/?url=' + encodeURIComponent(url);
        }
        return originalReplaceState.call(this, state, title, url);
    };
    
    // Anti-detection
    try { delete window.frameElement; } catch(e) {}
    Object.defineProperties(window, {
        top: { get: () => window },
        parent: { get: () => window },
        frameElement: { get: () => null }
    });
    
    console.log('🛡️ Full reverse proxy active');
})();
</script>
`;
            
            // Insert at beginning of head
            html = html.replace('<head>', '<head>' + injectScript);
            
            // Add base tag
            if (!html.includes('<base ')) {
                html = html.replace('<head>', '<head><base href="' + targetUrl + '">');
            }
            
            // Rewrite all URLs in HTML to use proxy
            html = html.replace(/(src|href|action|data)=["'](https?:)?\/\/(?!temunet\.vercel\.app)([^"']+)["']/gi, 
                (match, attr, protocol, url) => {
                    const fullUrl = (protocol || 'https:') + '//' + url;
                    return attr + '="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                }
            );
            
            // Fix inline styles with URLs
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
            
            // Rewrite URLs in CSS
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
            
            // Rewrite URLs in JS
            js = js.replace(/(["'`])(https?:)?\/\/(?!temunet\.vercel\.app)([^"'`]+)\1/g,
                (match, quote, protocol, url) => {
                    const fullUrl = (protocol || 'https:') + '//' + url;
                    return quote + '/api/proxy?url=' + encodeURIComponent(fullUrl) + quote;
                }
            );
            
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            return res.send(js);
        }

        // For other content, send as-is
        res.status(proxyResponse.statusCode);
        return res.send(proxyResponse.body);

    } catch (error) {
        console.error('Proxy error:', error);
        return res.status(502).json({ error: error.message });
    }
}
