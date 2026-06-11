self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Intercept /proxy/* requests and rewrite them
    if (url.pathname.startsWith('/proxy/')) {
        const encodedUrl = url.pathname.replace('/proxy/', '');
        const targetUrl = decodeURIComponent(encodedUrl);
        
        // Keep any query parameters
        const queryString = url.search || '';
        const fullUrl = targetUrl + queryString;
        
        console.log('SW proxying:', fullUrl);
        
        // Fetch from our API
        const apiUrl = '/api/proxy?url=' + encodeURIComponent(fullUrl);
        event.respondWith(fetch(apiUrl));
        return;
    }
    
    // Pass through everything else
    event.respondWith(fetch(event.request));
});
