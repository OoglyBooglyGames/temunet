const https = require('https');
const http = require('http');

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Get URL from query parameter
    let targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).send('No URL provided');
    }
    
    targetUrl = decodeURIComponent(targetUrl);
    
    // Ensure URL has protocol
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
    }

    console.log('Proxying:', targetUrl);

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
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'identity',
                'Cache-Control': 'no-cache',
            },
            rejectUnauthorized: false,
        };

        const response = await new Promise((resolve, reject) => {
            const proxyReq = client.request(options, (proxyRes) => {
                // Handle redirects - send back /proxy/ path
                if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                    let redirectUrl = proxyRes.headers.location;
                    if (!redirectUrl.startsWith('http')) {
                        redirectUrl = new URL(redirectUrl, targetUrl).href;
                    }
                    res.writeHead(302, {
                        'Location': '/proxy/' + encodeURIComponent(redirectUrl)
                    });
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
            proxyReq.setTimeout(15000, () => {
                proxyReq.destroy();
                reject(new Error('Timeout'));
            });
            proxyReq.end();
        });

        if (res.headersSent) return;

        const contentType = response.headers['content-type'] || '';

        // Strip restrictive headers
        ['content-security-policy', 'content-security-policy-report-only', 
         'x-frame-options', 'x-content-security-policy', 'x-webkit-csp', 
         'frame-options', 'x-xss-protection', 'content-encoding', 
         'transfer-encoding'].forEach(h => delete response.headers[h]);

        // Set cleaned headers
        Object.entries(response.headers).forEach(([key, value]) => {
            if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });

        if (contentType.includes('text/html')) {
            let html = response.body.toString('utf8');
            
            // Add base tag
            if (!html.includes('<base ')) {
                html = html.replace(/<head[^>]*>/i, '$&<base href="' + targetUrl + '">');
            }
            
            // Rewrite all absolute URLs to /proxy/ path
            html = html.replace(/(src|href|action|data)=["']((?:https?:)?\/\/)([^"']+)["']/gi,
                function(match, attr, protocol, rest) {
                    const fullUrl = (protocol.startsWith('http') ? '' : 'https:') + protocol + rest;
                    return attr + '="/proxy/' + encodeURIComponent(fullUrl) + '"';
                }
            );
            
            // Rewrite relative URLs
            html = html.replace(/(src|href|action|data)=["'](?!https?:\/\/|\/proxy\/|javascript:|data:|#|mailto:|tel:)([^"']+)["']/gi,
                function(match, attr, relativeUrl) {
                    try {
                        const absolute = new URL(relativeUrl, targetUrl).href;
                        return attr + '="/proxy/' + encodeURIComponent(absolute) + '"';
                    } catch(e) {
                        return match;
                    }
                }
            );
            
            // Fix CSS urls
            html = html.replace(/url\(["']?((?:https?:)?\/\/[^)"']+)["']?\)/gi,
                function(match, url) {
                    const fullUrl = url.startsWith('http') ? url : 'https:' + url;
                    return 'url("/proxy/' + encodeURIComponent(fullUrl) + '")';
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
                    return 'url("/proxy/' + encodeURIComponent(fullUrl) + '")';
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
                    return quote + '/proxy/' + encodeURIComponent(fullUrl) + quote;
                }
            );
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            return res.send(js);
        }

        res.status(response.status);
        return res.send(response.body);

    } catch (error) {
        console.error('Proxy error:', error.message);
        return res.status(502).send('Proxy Error: ' + error.message);
    }
}
