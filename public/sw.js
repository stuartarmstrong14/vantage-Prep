/* Lets the tracker be installed as an app. It deliberately caches nothing, so staff never see out-of-date stock or a stale login screen. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* network only */ });
