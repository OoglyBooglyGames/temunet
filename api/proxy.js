const https = require('https');
const http = require('http');
const dns = require('dns');

// Force DNS resolution to avoid ENOTFOUND errors
dns.setDefaultResultOrder('ipv4first');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    var targetUrl = req.query.url;
    if (!targetUrl) {
        var catchall = req.query.catchall;
        if (catchall) {
            var host = 'www.youtube.com';
            targetUrl = 'https://' + host + '/' + catchall;
            var qs = req.url.substring(req.url.indexOf('?') + 1).replace(/catchall=[^&]*&?/g, '');
            if (qs) targetUrl += '?' + qs;
        }
    }
    
    if (!targetUrl) return res.status(400).send('No URL');
    
    targetUrl = decodeURIComponent(targetUrl);
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    // Retry logic for DNS failures
    var maxRetries = 3;
    var lastError = null;
    
    for (var i = 0; i < maxRetries; i++) {
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
                    'Host': parsedUrl.hostname,
                },
                rejectUnauthorized: false,
                timeout: 10000,
                family: 4, // Force IPv4
            };

            var response = await new Promise(function(resolve, reject) {
                var preq = client.request(options, function(pres) {
                    if (pres.statusCode >= 300 && pres.statusCode < 400 && pres.headers.location) {
                        var redir = pres.headers.location;
                        if (!redir.startsWith('http')) redir = new URL(redir, targetUrl).href;
                        res.writeHead(302, { 'Location': '/api/proxy?url=' + encodeURIComponent(redir) });
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
                preq.on('timeout', function() {
                    preq.destroy();
                    reject(new Error('Timeout'));
                });
                preq.end();
            });

            if (res.headersSent) return;

            // Strip restrictive headers
            ['content-security-policy','content-security-policy-report-only','x-frame-options',
             'x-content-security-policy','x-webkit-csp','frame-options','x-xss-protection',
             'content-encoding','transfer-encoding','cross-origin-opener-policy',
             'cross-origin-embedder-policy','cross-origin-resource-policy'].forEach(function(h) {
                delete response.headers[h];
            });

            Object.entries(response.headers).forEach(function(entry) {
                var k = entry[0], v = entry[1];
                if (['content-encoding','transfer-encoding'].indexOf(k.toLowerCase()) === -1) {
                    res.setHeader(k, v);
                }
            });

            var ct = response.headers['content-type'] || '';
            
            if (ct.indexOf('text/html') > -1) {
                var html = response.body.toString('utf8');
                
                if (html.indexOf('<base ') === -1) {
                    html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
                }
                
                html = html.replace(/(src|href|action|data)=["']((?:https?:)?\/\/)([^"']+)["']/gi, function(m, attr, proto, rest) {
                    var fullUrl = (proto.startsWith('http') ? '' : 'https:') + proto + rest;
                    return attr + '="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                });
                
                html = html.replace(/(src|href|action|data)=["'](?!https?:\/\/|\/api\/proxy|javascript:|data:|#|mailto:|tel:)([^"']+)["']/gi, function(m, attr, rel) {
                    try {
                        var abs = new URL(rel, targetUrl).href;
                        return attr + '="/api/proxy?url=' + encodeURIComponent(abs) + '"';
                    } catch(e) { return m; }
                });
                
                html = html.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi, function(m, u) {
                    var f = u.startsWith('http') ? u : 'https:' + u;
                    return 'url("/api/proxy?url=' + encodeURIComponent(f) + '")';
                });
                
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.send(html);
            }
            
            if (ct.indexOf('text/css') > -1) {
                var css = response.body.toString('utf8');
                css = css.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi, function(m, u) {
                    var f = u.startsWith('http') ? u : 'https:' + u;
                    return 'url("/api/proxy?url=' + encodeURIComponent(f) + '")';
                });
                res.setHeader('Content-Type', 'text/css; charset=utf-8');
                return res.send(css);
            }
            
            if (ct.indexOf('javascript') > -1) {
                var js = response.body.toString('utf8');
                js = js.replace(/(["'`])((?:https?:)?\/\/[^"'`]+)\1/g, function(m, q, u) {
                    var f = u.startsWith('http') ? u : 'https:' + u;
                    return q + '/api/proxy?url=' + encodeURIComponent(f) + q;
                });
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                return res.send(js);
            }
            
            res.status(response.status);
            return res.send(response.body);
            
        } catch (e) {
            lastError = e;
            console.log('Attempt ' + (i + 1) + ' failed:', e.message);
            // Wait before retry
            await new Promise(function(r) { setTimeout(r, 1000); });
        }
    }
    
    // All retries failed
    return res.status(502).send('Proxy error after ' + maxRetries + ' attempts: ' + (lastError ? lastError.message : 'Unknown'));
};
