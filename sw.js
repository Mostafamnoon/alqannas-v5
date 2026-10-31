self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window'}).then(xs=>xs.length?xs[0].focus():clients.openWindow('./')));});
