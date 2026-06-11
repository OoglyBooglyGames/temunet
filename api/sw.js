self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Don't intercept our own API calls
    if (url.pathname.startsWith('/api/proxy')) return;
    
    // Don't intercept our main page or SW
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js') {
        return;
    }
    
    // Intercept EVERYTHING else and proxy it
    // This includes YouTube API calls like /youtubei/v1/next
    const targetUrl = url.pathname + url.search;
    
    // Determine the correct host
    let host = 'www.youtube.com';
    if (targetUrl.includes('google.com') || targetUrl.includes('/signin') || targetUrl.includes('/accounts')) {
        host = 'accounts.google.com';
    } else if (targetUrl.includes('googlevideo.com')) {
        host = url.hostname; // keep original for video CDN
    } else if (targetUrl.includes('gstatic.com')) {
        host = 'www.gstatic.com';
    } else if (targetUrl.includes('ytimg.com')) {
        host = 'i.ytimg.com';
    }
    
    const fullUrl = 'https://' + host + targetUrl;
    const proxyUrl = '/api/proxy?url=' + encodeURIComponent(fullUrl);
    
    console.log('SW proxying:', fullUrl);
    event.respondWith(fetch(proxyUrl));
});
