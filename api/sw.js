self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(clients.claim()); });

self.addEventListener('fetch', function(event) {
    var url = new URL(event.request.url);
    
    if (url.pathname.startsWith('/api/proxy')) return;
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js') return;
    
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
    } else if (targetPath.indexOf('reddit.com') > -1 || targetPath.indexOf('redd.it') > -1) {
        host = 'www.reddit.com';
    } else if (targetPath.indexOf('x.com') > -1 || targetPath.indexOf('twitter.com') > -1 || targetPath.indexOf('xcancel.com') > -1 || targetPath.indexOf('nitter') > -1) {
        host = 'xcancel.com';
    } else if (targetPath.indexOf('invidious') > -1) {
        host = 'invidious.fdn.fr';
    }
    
    event.respondWith(fetch('/api/proxy?url=' + encodeURIComponent('https://' + host + targetPath)));
});
