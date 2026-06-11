// Service Worker - Intercepts ALL requests
const PROXY_API = '/api/proxy?url=';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Intercept /proxy/* requests
    if (url.pathname.startsWith('/proxy/')) {
        const targetUrl = decodeURIComponent(url.pathname.replace('/proxy/', ''));
        
        // Reconstruct full URL with query string
        const fullTargetUrl = targetUrl + (url.search || '');
        
        console.log('SW Proxying:', fullTargetUrl);
        
        // Fetch through our API
        const proxyUrl = PROXY_API + encodeURIComponent(fullTargetUrl);
        event.respondWith(fetch(proxyUrl, {
            headers: event.request.headers
        }));
        return;
    }
    
    // Pass through all other requests
    event.respondWith(fetch(event.request));
});
