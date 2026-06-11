self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // If it's already going to our API, let it through
    if (url.pathname.startsWith('/api/proxy')) {
        return;
    }
    
    // If it's our main page, let it through
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js') {
        event.respondWith(fetch(event.request));
        return;
    }
    
    // For everything else (YouTube paths, Google paths, etc.)
    // Rewrite to use our proxy API with the full URL
    const targetPath = url.pathname + url.search;
    // Determine the host based on the path
    let host = 'www.youtube.com'; // default
    
    if (targetPath.startsWith('/search') || targetPath.startsWith('/complete/search')) {
        host = url.pathname.includes('youtube') ? 'www.youtube.com' : 'www.google.com';
    }
    
    const fullUrl = 'https://' + host + targetPath;
    const proxyUrl = '/api/proxy?url=' + encodeURIComponent(fullUrl);
    
    console.log('SW redirecting to:', proxyUrl);
    event.respondWith(fetch(proxyUrl));
});
