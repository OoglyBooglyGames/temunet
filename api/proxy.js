const https = require('https');
const http = require('http');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    let targetUrl = '';
    
    if (req.query.url) {
        targetUrl = decodeURIComponent(req.query.url);
    } else if (req.query.catchall) {
        const referer = req.headers.referer || '';
        let host = 'www.youtube.com';
        const m = referer.match(/\/api\/proxy\?url=https?%3A%2F%2F([^%&/]+)/);
        if (m) host = decodeURIComponent(m[1]);
        targetUrl = 'https://' + host + '/' + req.query.catchall;
        const qs = req.url.substring(req.url.indexOf('?') + 1).replace(/catchall=[^&]*&?/g, '');
        if (qs) targetUrl += '?' + qs;
    }
    
    if (!targetUrl || !targetUrl.startsWith('http')) return res.status(400).send('Invalid URL');

    try {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
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

        const response = await new Promise((resolve, reject) => {
            const preq = client.request(options, (pres) => {
                if (pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location) {
                    let redir = pres.headers.location;
                    if (!redir.startsWith('http')) redir = new URL(redir, targetUrl).href;
                    res.writeHead(302, { 'Location': '/api/proxy?url=' + encodeURIComponent(redir) });
                    res.end();
                    return;
                }
                let chunks = [];
                pres.on('data', c => chunks.push(c));
                pres.on('end', () => resolve({ status: pres.statusCode, headers: pres.headers, body: Buffer.concat(chunks) }));
            });
            preq.on('error', reject);
            preq.setTimeout(15000, () => { preq.destroy(); reject(new Error('Timeout')); });
            preq.end();
        });

        if (res.headersSent) return;

        ['content-security-policy','content-security-policy-report-only','x-frame-options',
         'x-content-security-policy','x-webkit-csp','frame-options','x-xss-protection',
         'content-encoding','transfer-encoding'].forEach(h => delete response.headers[h]);

        Object.entries(response.headers).forEach(([k, v]) => {
            if (!['content-encoding','transfer-encoding'].includes(k.toLowerCase())) res.setHeader(k, v);
        });

        const ct = response.headers['content-type'] || '';
        if (ct.includes('text/html')) {
            let html = response.body.toString('utf8');
            
            // NUCLEAR NAVIGATION BLOCKER - injected BEFORE doctype
            const nuclearBlocker = `
<script>
(function() {
    // Freeze the current URL
    var FROZEN_URL = '${targetUrl}';
    var PROXY_PREFIX = '/api/proxy?url=';
    
    // Completely replace window.location
    var fakeLocation = {
        _url: FROZEN_URL,
        get href() { return PROXY_PREFIX + encodeURIComponent(this._url); },
        set href(url) {
            try {
                var absolute = new URL(url, this._url).href;
                if (absolute.startsWith('http')) {
                    this._url = absolute;
                    window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
                }
            } catch(e) {}
        },
        get protocol() { try { return new URL(this._url).protocol; } catch(e) { return 'https:'; } },
        get host() { try { return new URL(this._url).host; } catch(e) { return ''; } },
        get hostname() { try { return new URL(this._url).hostname; } catch(e) { return ''; } },
        get port() { try { return new URL(this._url).port; } catch(e) { return ''; } },
        get pathname() { try { return new URL(this._url).pathname; } catch(e) { return ''; } },
        get search() { try { return new URL(this._url).search; } catch(e) { return ''; } },
        get hash() { try { return new URL(this._url).hash; } catch(e) { return ''; } },
        get origin() { try { return new URL(this._url).origin; } catch(e) { return ''; } },
        assign: function(url) { this.href = url; },
        replace: function(url) { this.href = url; },
        reload: function() { window.parent.postMessage({ type: 'RELOAD' }, '*'); },
        toString: function() { return this.href; }
    };
    
    // Force override location
    try {
        Object.defineProperty(window, 'location', {
            get: function() { return fakeLocation; },
            set: function(url) { fakeLocation.href = url; },
            configurable: false,
            enumerable: true
        });
        Object.defineProperty(document, 'location', {
            get: function() { return fakeLocation; },
            set: function(url) { fakeLocation.href = url; },
            configurable: false,
            enumerable: true
        });
    } catch(e) {
        window.location = fakeLocation;
        document.location = fakeLocation;
    }
    
    // Override history API
    var _pushState = history.pushState.bind(history);
    var _replaceState = history.replaceState.bind(history);
    
    history.pushState = function(state, title, url) {
        if (url) {
            try {
                var absolute = new URL(url, fakeLocation._url).href;
                fakeLocation._url = absolute;
                url = PROXY_PREFIX + encodeURIComponent(absolute);
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
            } catch(e) {}
        }
        return _pushState(state, title, url);
    };
    
    history.replaceState = function(state, title, url) {
        if (url) {
            try {
                var absolute = new URL(url, fakeLocation._url).href;
                fakeLocation._url = absolute;
                url = PROXY_PREFIX + encodeURIComponent(absolute);
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
            } catch(e) {}
        }
        return _replaceState(state, title, url);
    };
    
    // Block window.open
    window.open = function(url, target, features) {
        if (url) {
            try {
                var absolute = new URL(url, fakeLocation._url).href;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(e) {}
        }
        return { closed: false, close: function(){}, focus: function(){} };
    };
    
    // Catch all link clicks
    document.addEventListener('click', function(e) {
        var target = e.target;
        while (target && target !== document.documentElement) {
            if ((target.tagName === 'A' || target.tagName === 'AREA') && target.href) {
                var href = target.getAttribute('href');
                if (href && href !== '#' && !href.startsWith('javascript:') && !href.startsWith('data:')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    try {
                        var absolute = new URL(href, fakeLocation._url).href;
                        window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
                    } catch(ex) {}
                    return false;
                }
            }
            target = target.parentElement;
        }
    }, true);
    
    // Catch form submissions
    document.addEventListener('submit', function(e) {
        var form = e.target;
        if (form.action && !form.action.startsWith('javascript:')) {
            e.preventDefault();
            e.stopPropagation();
            try {
                var action = form.action;
                if (form.method && form.method.toLowerCase() === 'get') {
                    var fd = new FormData(form);
                    var params = new URLSearchParams(fd).toString();
                    if (params) action += (action.includes('?') ? '&' : '?') + params;
                }
                var absolute = new URL(action, fakeLocation._url).href;
                window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
            } catch(ex) {}
            return false;
        }
    }, true);
    
    // Block beforeunload
    window.addEventListener('beforeunload', function(e) {
        e.preventDefault();
        e.returnValue = '';
        return '';
    });
    
    console.log('🔥 NUCLEAR NAVIGATION BLOCKER ACTIVE');
})();
</script>
<!DOCTYPE html>
`;
            
            // Replace the doctype with our blocker + doctype
            html = html.replace(/<!DOCTYPE[^>]*>/i, nuclearBlocker);
            
            // Add base tag
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Rewrite ALL URLs to go through proxy
            html = html.replace(/(src|href|action|data)=["']((?:https?:)?\/\/)([^"']+)["']/gi, (m,a,p,r) => { 
                const f = (p.startsWith('http')?'':'https:')+p+r; 
                return a+'="/api/proxy?url='+encodeURIComponent(f)+'"'; 
            });
            
            html = html.replace(/(src|href|action|data)=["'](?!https?:\/\/|\/api\/proxy|javascript:|data:|#|mailto:|tel:)([^"']+)["']/gi, (m,a,r) => { 
                try { 
                    const f = new URL(r, targetUrl).href; 
                    return a+'="/api/proxy?url='+encodeURIComponent(f)+'"'; 
                } catch(e) { return m; } 
            });
            
            html = html.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi, (m,u) => { 
                const f = u.startsWith('http')?u:'https:'+u; 
                return 'url("/api/proxy?url='+encodeURIComponent(f)+'")'; 
            });
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }
        
        if (ct.includes('text/css')) {
            let css = response.body.toString('utf8');
            css = css.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi, (m,u) => { 
                const f = u.startsWith('http')?u:'https:'+u; 
                return 'url("/api/proxy?url='+encodeURIComponent(f)+'")'; 
            });
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            return res.send(css);
        }
        
        if (ct.includes('javascript')) {
            let js = response.body.toString('utf8');
            js = js.replace(/(["'`])((?:https?:)?\/\/[^"'`]+)\1/g, (m,q,u) => { 
                const f = u.startsWith('http')?u:'https:'+u; 
                return q+'/api/proxy?url='+encodeURIComponent(f)+q; 
            });
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            return res.send(js);
        }
        
        res.status(response.status);
        return res.send(response.body);
    } catch (e) {
        return res.status(502).send('Error: ' + e.message);
    }
}
