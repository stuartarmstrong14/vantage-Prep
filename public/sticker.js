(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var cars = [], base = '';
  // Tags from email are stored as TAG-1042, so only add the word Tag when the number doesn't already start with it.
  var hasTagWord = function (t) { return /^tag/i.test(String(t || '')); };
  var tagLine = function (t) { return hasTagWord(t) ? esc(t) : 'Tag ' + esc(t); };

  function message(html) { $('#msg').innerHTML = html; }

  function privateAddress(host) {
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0)/.test(host) || /\.local$/.test(host) || host.indexOf('.') < 0;
  }

  function smallHtml(c) {
    var url = base + '/c/' + c.id;
    var name = [c.make, c.model].filter(Boolean).join(' ');
    return '<article class="sticker small">'
      + '<div class="s-qr">' + QR.svg(url, { label: 'QR code for ' + (c.reg || 'this car') }) + '</div>'
      + '<div class="s-info"><div class="s-plate">' + esc(c.reg || 'No reg') + '</div>'
      + (c.tag ? '<div class="s-tag">' + esc(c.tag) + '</div>' : '')
      + '<div class="s-car">' + esc(name) + '</div></div>'
      + '</article>';
  }

  // A4 landscape window notice: AWAITING PREP banner, a large QR and the car details.
  function noticeHtml(c) {
    var url = base + '/c/' + c.id;
    var name = [c.make, c.model].filter(Boolean).join(' ');
    return '<article class="sticker notice">'
      + '<header class="n-head"><img class="n-logo" src="/logo-navy.png" alt="Vantage Motor Group"></header>'
      + '<div class="n-status"><span class="n-rule"></span><h2 class="n-title">Awaiting prep</h2><span class="n-rule"></span></div>'
      + '<div class="n-body">'
      + '<figure class="n-qr"><div class="s-qr">' + QR.svg(url, { label: 'QR code for ' + (c.reg || 'this car') }) + '</div><figcaption>Staff: scan for prep progress</figcaption></figure>'
      + '<span class="n-div"></span>'
      + '<div class="n-info">'
      + '<div class="s-plate">' + esc(c.reg || 'No reg') + '</div>'
      + '<div class="n-car">' + esc(name) + '</div>'
      + (c.tag ? '<div class="n-tag">' + (hasTagWord(c.tag) ? '' : '<span>Tag</span>') + '<b>' + esc(c.tag) + '</b></div>' : '')
      + '</div></div>'
      + '</article>';
  }

  function stickerHtml(c) {
    if ($('#layout').value === 'small') return smallHtml(c);
    if ($('#layout').value === 'notice') return noticeHtml(c);
    var url = base + '/c/' + c.id;
    var name = [c.make, c.model].filter(Boolean).join(' ');
    return '<article class="sticker">'
      + '<img class="s-logo" src="/logo-navy.png" alt="Vantage Motor Group">'
      + '<div class="s-body">'
      + '<div class="s-qr">' + QR.svg(url, { label: 'QR code for ' + (c.reg || 'this car') }) + '</div>'
      + '<div class="s-info"><div class="s-plate">' + esc(c.reg || 'No reg') + '</div>'
      + '<div class="s-car">' + esc(name) + '</div>'
      + (c.tag ? '<div class="s-tag">' + tagLine(c.tag) + '</div>' : '')
      + '</div></div>'
      + '<p class="s-foot">Scan to see preparation progress</p>'
      + '</article>';
  }

  function draw() {
    var layout = $('#layout').value;
    var per = layout === 'sheet' ? 8 : 1;
    var html = '';
    for (var i = 0; i < cars.length; i += per) {
      html += '<section class="page ' + layout + '">' + cars.slice(i, i + per).map(stickerHtml).join('') + '</section>';
    }
    $('#pages').innerHTML = html;
    var pg = document.getElementById('pagestyle');
    if (!pg) { pg = document.createElement('style'); pg.id = 'pagestyle'; document.head.appendChild(pg); }
    pg.textContent = layout === 'sheet' ? '@page{size:A4;margin:8mm 5mm}' : layout === 'notice' ? '@page{size:A4 landscape;margin:22mm 10.5mm}' : layout === 'small' ? '@page{size:50mm 30mm;margin:0}' : '@page{size:100mm 70mm;margin:0}';
    try { localStorage.setItem('stickerLayout', layout); } catch (e) { /* ignore */ }
  }

  function api(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) { return { status: r.status, data: d }; });
    });
  }

  api('/api/session').then(function (s) {
    var user = s.data && s.data.user;
    if (!user) { message('Please <a href="/">sign in</a> first, then open this page again from the car.'); return null; }
    if (user.role === 'advisor') { message('Only staff can print stickers. Advisors can scan them to see progress.'); return null; }
    base = (s.data.publicUrl || location.origin).replace(/\/+$/, '');
    return api('/api/cars').then(function (c) {
      if (c.status !== 200) { message('Could not load the cars. Go back and try again.'); return; }
      var all = c.data.cars;
      var wanted = (new URLSearchParams(location.search).get('ids') || '').split(',').filter(function (x) { return /^[a-f0-9]{12}$/.test(x); }).slice(0, 100);
      if (wanted.length) {
        var byId = {}; all.forEach(function (x) { byId[x.id] = x; });
        cars = wanted.map(function (id) { return byId[id]; }).filter(Boolean);
      } else {
        cars = all.slice(0, 100);
      }
      if (!cars.length) { message('No cars found. Go back and choose a car.'); return; }
      message(cars.length + (cars.length === 1 ? ' sticker' : ' stickers') + ' ready. Each QR code opens ' + esc(base) + '/c/… and asks the person to sign in.');
      var warn = $('#warn');
      var host = new URL(base).hostname;
      if (privateAddress(host)) {
        warn.textContent = 'These QR codes point to ' + base + ', which phones outside this computer or network cannot reach. Open this page from your live web address, or set PUBLIC_URL on the server, before you print.';
        warn.hidden = false;
      }
      $('#ctl').hidden = false; $('#hint').hidden = false;
      var saved = null;
      try { saved = localStorage.getItem('stickerLayout'); } catch (e) { /* ignore */ }
      if (saved === 'sheet' || saved === 'label' || saved === 'small' || saved === 'notice') $('#layout').value = saved;
      draw();
    });
  }).catch(function () { message('Could not reach the server. Check your connection and reload.'); });

  $('#layout').addEventListener('change', draw);
  $('#print').addEventListener('click', function () { window.print(); });
})();
