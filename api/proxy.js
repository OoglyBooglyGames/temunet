const https = require('https');
const http = require('http');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    let targetUrl = '';
    
    // Get URL from various sources
    if (req.query.url) {
        targetUrl = decodeURIComponent(req.query.url);
    } else if (req.query.path) {
        targetUrl = 'https://' + req.query.path;
        // Add any other query params
        const queryKeys = Object.keys(req.query).filter(k => k !== 'path');
        if (queryKeys.length > 0) {
            const params = new URLSearchParams();
            queryKeys.forEach(k => params.append(k, req.query[k]));
            targetUrl += '?' + params.toString();
        }
    } else if (req.query.catchall) {
        // Try to figure out the host from the referer
        const referer = req.headers.referer || '';
        let host = 'www.youtube.com';
        const refMatch = referer.match(/\/proxy\/https?%3A%2F%2F([^%&/]+)/);
        if (refMatch) {
            host = decodeURIComponent(refMatch[1]);
        }
        targetUrl = 'https://' + host + '/' + req.query.catchall;
        if (req.url.includes('?')) {
            const qs = req.url.substring(req.url.indexOf('?') + 1);
            const cleanQs = qs.replace(/catchall=[^&]*&?/g, '');
            if (cleanQs) targetUrl += '?' + cleanQs;
        }
    }
    
    if (!targetUrl || !targetUrl.startsWith('http')) {
        return res.status(400).send('Invalid URL');
    }

    console.log('Proxying:', targetUrl);

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
            const proxyReq = client.request(options, (proxyRes) => {
                if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                    let redirectUrl = proxyRes.headers.location;
                    if (!redirectUrl.startsWith('http')) {
                        redirectUrl = new URL(redirectUrl, targetUrl).href;
                    }
                    res.writeHead(302, { 'Location': '/api/proxy?url=' + encodeURIComponent(redirectUrl) });
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
            proxyReq.setTimeout(15000, () => { proxyReq.destroy(); reject(new Error('Timeout')); });
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
            
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Rewrite absolute URLs to our proxy
            html = html.replace(/(src|href|action|data)=["']((?:https?:)?\/\/)([^"']+)["']/gi,
                function(match, attr, protocol, rest) {
                    const fullUrl = (protocol.startsWith('http') ? '' : 'https:') + protocol + rest;
                    if (rest.includes('temunet.vercel.app')) return match;
                    return attr + '="/api/proxy?url=' + encodeURIComponent(fullUrl) + '"';
                }
            );
            
            // Rewrite relative URLs to absolute through proxy
            html = html.replace(/(src|href|action|data)=["'](?!https?:\/\/|\/api\/proxy|javascript:|data:|#|mailto:|tel:)([^"']+)["']/gi,
                function(match, attr, relativeUrl) {
                    try {
                        const absolute = new URL(relativeUrl, targetUrl).href;
                        return attr + '="/api/proxy?url=' + encodeURIComponent(absolute) + '"';
                    } catch(e) { return match; }
                }
            );
            
            // Fix CSS urls
            html = html.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi,
                function(match, url) {
                    const fullUrl = url.startsWith('http') ? url : 'https:' + url;
                    return 'url("/api/proxy?url=' + encodeURIComponent(fullUrl) + '")';
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
