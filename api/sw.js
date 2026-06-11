self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(clients.claim()); });

self.addEventListener('fetch', function(event) {
    var url = new URL(event.request.url);
    
    // Intercept /proxy/* paths
    if (url.pathname.startsWith('/proxy/')) {
        var encodedUrl = url.pathname.replace('/proxy/', '');
        var targetUrl = decodeURIComponent(encodedUrl) + url.search;
        
        // Fetch through our API
        event.respondWith(fetch('/api/proxy?url=' + encodeURIComponent(targetUrl)));
        return;
    }
    
    // Don't intercept our own API calls or main page
    if (url.pathname.startsWith('/api/proxy') || url.pathname === '/' || 
        url.pathname === '/index.html' || url.pathname === '/sw.js') {
        return;
    }
    
    // For everything else (YouTube API calls, etc), proxy them
    var targetPath = url.pathname + url.search;
    var host = 'www.youtube.com';
    
    if (targetPath.indexOf('google.com') > -1 || targetPath.indexOf('/signin') > -1 || targetPath.indexOf('/accounts') > -1) {
        host = 'accounts.google.com';
    } else if (targetPath.indexOf('googlevideo.com') > -1) {
        host = url.hostname;
    } else if (targetPath.indexOf('gstatic.com') > -1) {
        host = 'www.gstatic.com';
    } else if (targetPath.indexOf('ytimg.com') > -1) {
        host = 'i.ytimg.com';
    } else if (targetPath.indexOf('ggpht.com') > -1) {
        host = 'yt3.ggpht.com';
    }
    
    event.respondWith(fetch('/api/proxy?url=' + encodeURIComponent('https://' + host + targetPath)));
});
