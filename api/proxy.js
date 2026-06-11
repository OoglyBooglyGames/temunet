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
            
            // INJECT THIS BEFORE ANYTHING ELSE - prevents reload loops
            const navBlocker = `
<script>
(function() {
    // Store original functions
    var _pushState = history.pushState;
    var _replaceState = history.replaceState;
    var _back = history.back;
    var _forward = history.forward;
    var _go = history.go;
    
    // Override pushState to prevent navigation
    history.pushState = function(state, title, url) {
        if (url) {
            try {
                var absolute = new URL(url, '${targetUrl}').href;
                if (absolute.startsWith('http') && !absolute.includes(window.location.host)) {
                    // Send to parent to handle navigation
                    window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
                    return;
                }
                // Update URL bar without reloading
                url = '/api/proxy?url=' + encodeURIComponent(absolute);
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
            } catch(e) {}
        }
        return _pushState.call(this, state, title, url);
    };
    
    history.replaceState = function(state, title, url) {
        if (url) {
            try {
                var absolute = new URL(url, '${targetUrl}').href;
                if (absolute.startsWith('http') && !absolute.includes(window.location.host)) {
                    window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
                    return;
                }
                url = '/api/proxy?url=' + encodeURIComponent(absolute);
                window.parent.postMessage({ type: 'URL_CHANGE', url: absolute }, '*');
            } catch(e) {}
        }
        return _replaceState.call(this, state, title, url);
    };
    
    // Override location changes
    var origLocation = window.location;
    try {
        Object.defineProperty(window, 'location', {
            get: function() { return origLocation; },
            set: function(url) {
                try {
                    var absolute = new URL(url, '${targetUrl}').href;
                    if (absolute.startsWith('http') && !absolute.includes(window.location.host)) {
                        window.parent.postMessage({ type: 'NAVIGATE', url: absolute }, '*');
                    }
                } catch(e) {}
            },
            configurable: true
        });
    } catch(e) {}
    
    console.log('Navigation blocker active');
})();
</script>
`;
            
            // Inject BEFORE YouTube's scripts
            html = html.replace(/<head[^>]*>/i, '<head>' + navBlocker);
            
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Rewrite URLs
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
