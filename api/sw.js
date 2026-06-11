self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Don't intercept our own API calls
    if (url.pathname.startsWith('/api/proxy')) return;
    
    // Don't intercept main page or SW
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js') return;
    
    // Intercept everything else and proxy it
    const targetPath = url.pathname + url.search;
    let host = 'www.youtube.com';
    
    if (targetPath.includes('google.com') || targetPath.includes('/signin') || targetPath.includes('/accounts')) {
        host = 'accounts.google.com';
    } else if (targetPath.includes('googlevideo.com')) {
        host = url.hostname;
    } else if (targetPath.includes('gstatic.com')) {
        host = 'www.gstatic.com';
    } else if (targetPath.includes('ytimg.com')) {
        host = 'i.ytimg.com';
    } else if (targetPath.includes('reddit.com') || targetPath.includes('redd.it')) {
        host = 'www.reddit.com';
    } else if (targetPath.includes('x.com') || targetPath.includes('twitter.com')) {
        host = 'x.com';
    }
    
    const fullUrl = 'https://' + host + targetPath;
    const proxyUrl = '/api/proxy?url=' + encodeURIComponent(fullUrl);
    event.respondWith(fetch(proxyUrl));
});
