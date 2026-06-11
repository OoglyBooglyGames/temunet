const https = require('https');
const http = require('http');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    var targetUrl = req.query.url;
    if (!targetUrl) {
        // Try catchall
        var catchall = req.query.catchall;
        if (catchall) {
            var referer = req.headers.referer || '';
            var host = 'www.youtube.com';
            var m = referer.match(/\/proxy\/([^/?&]+)/);
            if (m) host = decodeURIComponent(m[1]);
            targetUrl = 'https://' + host + '/' + catchall;
            var qs = req.url.substring(req.url.indexOf('?') + 1).replace(/catchall=[^&]*&?/g, '');
            if (qs) targetUrl += '?' + qs;
        }
    }
    
    if (!targetUrl) return res.status(400).send('No URL');
    
    targetUrl = decodeURIComponent(targetUrl);
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    try {
        var parsedUrl = new URL(targetUrl);
        var client = parsedUrl.protocol === 'https:' ? https : http;
        var options = {
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

        var response = await new Promise(function(resolve, reject) {
            var preq = client.request(options, function(pres) {
                if (pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location) {
                    var redir = pres.headers.location;
                    if (!redir.startsWith('http')) redir = new URL(redir, targetUrl).href;
                    res.writeHead(302, { 'Location': '/proxy/' + encodeURIComponent(redir) });
                    res.end();
                    return;
                }
                var chunks = [];
                pres.on('data', function(c) { chunks.push(c); });
                pres.on('end', function() {
                    resolve({ status: pres.statusCode, headers: pres.headers, body: Buffer.concat(chunks) });
                });
            });
            preq.on('error', reject);
            preq.setTimeout(15000, function() { preq.destroy(); reject(new Error('Timeout')); });
            preq.end();
        });

        if (res.headersSent) return;

        // Strip ALL restrictive headers
        ['content-security-policy','content-security-policy-report-only','x-frame-options',
         'x-content-security-policy','x-webkit-csp','frame-options','x-xss-protection',
         'content-encoding','transfer-encoding','cross-origin-opener-policy',
         'cross-origin-embedder-policy','cross-origin-resource-policy'].forEach(function(h) {
            delete response.headers[h];
        });

        // Set permissive headers
        Object.entries(response.headers).forEach(function(entry) {
            var k = entry[0], v = entry[1];
            if (['content-encoding','transfer-encoding'].indexOf(k.toLowerCase()) === -1) {
                res.setHeader(k, v);
            }
        });

        var ct = response.headers['content-type'] || '';
        
        if (ct.indexOf('text/html') > -1) {
            var html = response.body.toString('utf8');
            
            // Add base tag
            if (html.indexOf('<base ') === -1) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Rewrite absolute URLs to /proxy/ path
            html = html.replace(/(src|href|action|data)=["']((?:https?:)?\/\/)([^"']+)["']/gi, function(m, attr, proto, rest) {
                var fullUrl = (proto.startsWith('http') ? '' : 'https:') + proto + rest;
                return attr + '="/proxy/' + encodeURIComponent(fullUrl) + '"';
            });
            
            // Rewrite relative URLs
            html = html.replace(/(src|href|action|data)=["'](?!https?:\/\/|\/proxy\/|javascript:|data:|#|mailto:|tel:)([^"']+)["']/gi, function(m, attr, rel) {
                try {
                    var abs = new URL(rel, targetUrl).href;
                    return attr + '="/proxy/' + encodeURIComponent(abs) + '"';
                } catch(e) { return m; }
            });
            
            // Fix CSS urls
            html = html.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi, function(m, u) {
                var f = u.startsWith('http') ? u : 'https:' + u;
                return 'url("/proxy/' + encodeURIComponent(f) + '")';
            });
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }
        
        if (ct.indexOf('text/css') > -1) {
            var css = response.body.toString('utf8');
            css = css.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi, function(m, u) {
                var f = u.startsWith('http') ? u : 'https:' + u;
                return 'url("/proxy/' + encodeURIComponent(f) + '")';
            });
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            return res.send(css);
        }
        
        if (ct.indexOf('javascript') > -1) {
            var js = response.body.toString('utf8');
            js = js.replace(/(["'`])((?:https?:)?\/\/[^"'`]+)\1/g, function(m, q, u) {
                var f = u.startsWith('http') ? u : 'https:' + u;
                return q + '/proxy/' + encodeURIComponent(f) + q;
            });
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            return res.send(js);
        }
        
        res.status(response.status);
        return res.send(response.body);
    } catch (e) {
        return res.status(502).send('Error: ' + e.message);
    }
};
