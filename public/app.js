(function () {
  'use strict';

  /* ---------- checklist definition ---------- */
  var STAGES = [
    { k: 'arrived', l: 'Inbound', t: [['advert', 'Advertised on Auto Trader'], ['lines', 'Preparation lines requested'], ['qr', 'QR sticker fitted']] },
    { k: 'valet', l: 'Valet', t: [['done', 'Valet completed']] },
    { k: 'photos', l: 'Photos', t: [['done', 'Photographs completed']] },
    { k: 'mech', l: 'Mechanical', t: [['pt145', '145 point mechanical check'], ['service', 'Service'], ['motbook', 'MOT passed'], ['qc', 'Mechanical QC complete']] },
    { k: 'body', l: 'Bodywork', t: [
      ['cosmetic', 'Cosmetic check complete'],
      ['dent', 'Dents completed'],
      ['wheels', 'Alloy wheels completed', { f: 'bodyWheels', label: 'Wheels to refine', type: 'number' }],
      ['paint', 'Paint work completed'],
      ['qc', 'QC complete', { f: 'bodyQcBy', label: 'Initials', type: 'text', sign: 'bodyQcOn', name: 'bodyQcName' }]
    ] },
    { k: 'ready', l: 'Quality Check', t: [['qc', 'Quality check completed', { f: 'finalQcBy', label: 'Initials', type: 'text', sign: 'finalQcOn', name: 'finalQcName' }]] }
  ];
  var TARGET = 7;
  var TOTAL = STAGES.reduce(function (n, s) { return n + s.t.length; }, 0);
  var FIELDS = [
    ['reg', 'Registration', 'text'], ['make', 'Make', 'text'], ['model', 'Model', 'text'], ['tag', 'Tag number', 'text'],
    ['mileage', 'Mileage', 'number'], ['colour', 'Colour', 'text'], ['mot', 'MOT expiry', 'date']
  ];
  var NUMERIC = { mileage: 1 };
  var POLL_MS = 8000;

  /* ---------- small helpers ---------- */
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var todayStr = function () { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var dayNum = function (s) { var p = s.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); };
  var miles = function (n) { return n == null || n === '' ? '' : Number(n).toLocaleString('en-GB') + ' mi'; };
  function fmtDate(s) {
    if (!s) return 'unknown';
    var p = s.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  var state = {
    user: null, cars: new Map(), rev: null, f: 'all', q: '', open: null,
    expanded: new Set(), loaded: false, err: '', pending: 0, tab: 'prep'
  };
  var timers = {};
  var pollTimer = null;
  var authMode = 'login';

  // Scanning a car's QR sticker opens /c/<id>; remember it so the car opens once signed in.
  var linkMatch = location.pathname.match(/^\/c\/([a-f0-9]{12})$/);
  state.deepLink = linkMatch ? linkMatch[1] : null;

  var ROLE_LABELS = { admin: 'Administrator', staff: 'Staff', advisor: 'Advisor (view only)' };
  function roleLabel(r) { return ROLE_LABELS[r] || r; }
  function readOnly() { return !!state.user && state.user.role === 'advisor'; }

  $('#target').textContent = TARGET;

  /* ---------- server calls ---------- */
  var OPEN_PATHS = ['/api/login', '/api/setup', '/api/session', '/api/logout'];
  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (r.status === 401 && OPEN_PATHS.indexOf(url) < 0) {
          signedOut('You were signed out. Please sign in again.');
          throw { code: 'unauth' };
        }
        if (!r.ok) throw { status: r.status, message: (data && data.error) || 'Something went wrong. Try again.' };
        return data;
      });
    });
  }

  /* ---------- sign in / setup ---------- */
  function showAuth(mode, message) {
    authMode = mode;
    $('#app').hidden = true;
    $('#auth').hidden = false;
    var setup = mode === 'setup';
    $('#auth-title').textContent = setup ? 'Create the first account' : 'Sign in';
    $('#auth-sub').textContent = setup
      ? 'This account will be the administrator. You can add staff logins afterwards.'
      : 'Use the username and password you were given.';
    $('#a-display').hidden = !setup;
    $('#a-display').required = setup;
    $('#a-pass').autocomplete = setup ? 'new-password' : 'current-password';
    $('#a-pass').minLength = setup ? 8 : 0;
    $('#a-go').textContent = setup ? 'Create account' : 'Sign in';
    var err = $('#a-err');
    err.hidden = !message;
    err.textContent = message || '';
  }
  $('#auth-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('#a-err');
    err.hidden = true;
    var body = { username: $('#a-user').value.trim(), password: $('#a-pass').value };
    if (authMode === 'setup') body.display = $('#a-display').value.trim();
    var btn = $('#a-go');
    btn.disabled = true;
    api('POST', authMode === 'setup' ? '/api/setup' : '/api/login', body).then(function (r) {
      $('#a-pass').value = '';
      state.user = r.user;
      startApp();
    }).catch(function (ex) {
      err.textContent = (ex && ex.message) || 'Could not reach the server. Check your connection.';
      err.hidden = false;
    }).then(function () { btn.disabled = false; });
  });

  function signedOut(message) {
    stopPolling();
    state.user = null; state.cars = new Map(); state.rev = null; state.loaded = false; state.open = null;
    ['#ov-car', '#ov-new', '#ov-acct', '#ov-users'].forEach(function (s) { $(s).hidden = true; });
    showAuth('login', message || '');
  }

  /* ---------- polling ---------- */
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () { if (!document.hidden) refresh(false); }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state.user) refresh(false); });

  function refresh(force) {
    if (!state.user) return Promise.resolve();
    var url = '/api/cars' + (force || state.rev == null ? '' : '?since=' + state.rev);
    return api('GET', url).then(function (r) {
      state.err = '';
      if (state.pending > 0) return;           // do not overwrite edits still being saved
      state.rev = r.rev;
      if (r.unchanged && state.loaded) return;
      var m = new Map();
      r.cars.forEach(function (c) { m.set(c.id, c); });
      state.cars = m;
      state.loaded = true;
      render();
      if (state.open) renderSheet();
      if (state.deepLink) {
        var dl = state.deepLink; state.deepLink = null;
        if (state.cars.has(dl)) openCar(dl); else toast('That car is no longer in stock.');
      }
    }).catch(function (ex) {
      if (ex && ex.code === 'unauth') return;
      if (!state.loaded) { state.err = 'Could not load the stock. Check your connection; this page will keep trying.'; render(); }
    });
  }

  function startApp() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    $('#a-user').value = '';
    $('#add-btn').hidden = readOnly();
    render();
    refresh(true);
    startPolling();
  }

  /* ---------- derived values ---------- */
  function stageIdx(c) { var i = STAGES.findIndex(function (s) { return s.k === c.stage; }); return i < 0 ? 0 : i; }
  function carDays(c) {
    var end = (c.stage === 'ready' && c.readyAt) ? c.readyAt : todayStr();
    return Math.max(0, dayNum(end) - dayNum(c.added || todayStr()));
  }
  function doneCount(c) {
    var n = 0, d = c.done || {};
    STAGES.forEach(function (s) { s.t.forEach(function (t) { if (d[s.k + '_' + t[0]] === true) n++; }); });
    return n;
  }
  function daysClass(c) {
    if (c.stage === 'ready') return 'ok';
    var d = carDays(c);
    return d > TARGET ? 'bad' : (d >= TARGET - 1 ? 'warn' : '');
  }
  function motInfo(c) {
    if (!c.mot) return null;
    var diff = dayNum(c.mot) - dayNum(todayStr());
    if (diff < 0) return { cls: 'bad', t: 'MOT expired' };
    if (diff <= 30) return { cls: 'warn', t: 'MOT in ' + diff + 'd' };
    return null;
  }
  function trackHtml(c) {
    var cur = stageIdx(c), h = '';
    STAGES.forEach(function (s, i) { h += '<i' + (i <= cur ? ' class="on"' : '') + ' title="' + esc(s.l) + '"></i>'; });
    return '<div class="track' + (c.stage === 'ready' ? ' done' : '') + '" aria-hidden="true">' + h + '</div>';
  }
  function findItem(tid) {
    var r = null;
    STAGES.forEach(function (s) { s.t.forEach(function (t) { if (s.k + '_' + t[0] === tid) r = t; }); });
    return r;
  }
  function findExtra(f) {
    var r = null;
    STAGES.forEach(function (s) { s.t.forEach(function (t) { if (t[2] && t[2].f === f) r = t[2]; }); });
    return r;
  }

  /* ---------- list ---------- */
  // Prep is completed once the car reaches the Quality Check stage.
  function isDone(c) { return c.stage === 'ready'; }
  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = [];
    state.cars.forEach(function (c, id) {
      if (isDone(c) !== (state.tab === 'done')) return;
      if (state.tab !== 'done' && state.f !== 'all' && c.stage !== state.f) return;
      if (q && ((c.reg || '') + ' ' + (c.tag || '') + ' ' + (c.make || '') + ' ' + (c.model || '') + ' ' + (c.colour || '')).toLowerCase().indexOf(q) < 0) return;
      out.push({ id: id, c: c });
    });
    out.sort(function (a, b) {
      var ra = a.c.stage === 'ready', rb = b.c.stage === 'ready';
      if (ra !== rb) return ra ? 1 : -1;
      return carDays(b.c) - carDays(a.c);
    });
    return out;
  }
  function render() {
    if (!state.user) return;
    var all = [];
    state.cars.forEach(function (c) { all.push(c); });
    var inPrep = all.filter(function (c) { return c.stage !== 'ready'; });
    var completed = all.filter(isDone);
    var active = all.filter(function (c) { return !isDone(c); });
    var avg = inPrep.length ? Math.round(inPrep.reduce(function (n, c) { return n + carDays(c); }, 0) / inPrep.length * 10) / 10 : 0;
    $('#s-prep').textContent = inPrep.length;
    $('#s-avg').textContent = avg;
    $('#s-done').textContent = completed.length;
    $('#tab-prep-n').textContent = active.length;
    $('#tab-done-n').textContent = completed.length;
    $('#tab-prep').setAttribute('aria-selected', state.tab === 'prep');
    $('#tab-done').setAttribute('aria-selected', state.tab === 'done');
    $('#stage-filter').hidden = state.tab === 'done';

    var sel = $('#stage-filter');
    var opts = '<option value="all">All stages (' + active.length + ')</option>' + STAGES.map(function (s) {
      var n = active.filter(function (c) { return c.stage === s.k; }).length;
      return '<option value="' + s.k + '">' + esc(s.l) + ' (' + n + ')</option>';
    }).join('');
    if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
    sel.value = state.f;

    var vis = state.loaded ? visible() : [];
    $('#go').textContent = 'Show ' + vis.length + (vis.length === 1 ? ' car' : ' cars');
    var list = $('#list');
    if (state.err) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><h2>Stock is not available</h2><p>' + esc(state.err) + '</p></div>'; return; }
    if (!state.loaded) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>Loading stock…</p></div>'; return; }
    if (!all.length) {
      list.innerHTML = '<div class="empty" style="grid-column:1/-1"><h2>No cars in prep</h2><p>Add the first car as it arrives. Each one gets a checklist from inbound through to quality check.</p>' + (readOnly() ? '' : '<button class="btn primary" type="button" data-act="add" style="min-height:48px;padding:0 26px">Add car</button>') + '</div>';
      return;
    }
    if (!vis.length) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>' + (state.tab === 'done' && !state.q.trim() ? 'No cars have completed prep yet. A car moves here when it reaches Quality Check.' : 'No cars match this search.') + '</p></div>'; return; }
    list.innerHTML = vis.map(function (r) { return cardHtml(r.id, r.c); }).join('');
  }
  function cardHtml(id, c) {
    var d = carDays(c), dc = daysClass(c), mi = motInfo(c);
    var st = STAGES[stageIdx(c)];
    var name = [c.make, c.model].filter(Boolean).join(' ');
    var meta = [c.tag ? ('Tag ' + c.tag) : '', miles(c.mileage), c.colour].filter(Boolean).map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('');
    var tags = mi ? '<span class="pill ' + mi.cls + '">' + esc(mi.t) + '</span>' : '';
    var daysTxt = c.stage === 'ready' ? ('Prepped in ' + d + 'd') : (d + (d === 1 ? ' day' : ' days') + ' in prep');
    return '<button class="car" type="button" data-open="' + esc(id) + '">'
      + '<div class="car-top"><span class="plate">' + esc(c.reg || 'No reg') + '</span><span class="pill num ' + dc + '">' + daysTxt + '</span></div>'
      + '<div class="car-name">' + esc(name || 'Unnamed car') + '</div>'
      + '<div class="car-meta">' + meta + '</div>'
      + (tags ? '<div class="car-tags">' + tags + '</div>' : '')
      + trackHtml(c)
      + '<div class="car-foot"><strong>' + esc(st.l) + '</strong><span class="num">' + doneCount(c) + ' of ' + TOTAL + ' tasks</span></div>'
      + '</button>';
  }

  /* ---------- saving ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }
  function fail(ex) {
    if (ex && ex.code === 'unauth') return;
    toast((ex && ex.message) || 'Could not save that change. Check your connection and try again.');
    refresh(true);
  }
  var queues = {};
  function queue(id, fn) {
    var p = (queues[id] || Promise.resolve()).then(fn).catch(fail);
    queues[id] = p;
    return p;
  }
  function applyLocal(id, data) {
    var c = state.cars.get(id); if (!c) return;
    var n = Object.assign({}, c);
    Object.keys(data).forEach(function (k) {
      if (k === 'done') n.done = Object.assign({}, c.done, data.done); else n[k] = data[k];
    });
    state.cars.set(id, n);
  }
  function upd(id, data, localExtra) {
    applyLocal(id, Object.assign({}, data, localExtra || {}));
    render();
    if (state.open === id) renderSheet();
    state.pending++;
    return queue(id, function () {
      return api('PATCH', '/api/cars/' + id, data).then(function (car) { state.cars.set(id, car); });
    }).then(function () {
      state.pending--;
      if (state.pending === 0) { render(); if (state.open === id) renderSheet(); }
    });
  }
  function debounced(id, field, val) {
    var key = id + '|' + field;
    if (timers[key]) clearTimeout(timers[key]); else state.pending++;
    timers[key] = setTimeout(function () {
      delete timers[key];
      var o = {}; o[field] = val;
      upd(id, o).then(function () {
        state.pending--;
        if (state.pending === 0) { render(); if (state.open === id) renderSheet(); }
      });
    }, 500);
  }
  function setStage(id, stage) {
    var c = state.cars.get(id); if (!c || c.stage === stage) return;
    state.expanded.add(stage);
    upd(id, { stage: stage }, { readyAt: stage === 'ready' ? todayStr() : '' });
  }

  /* ---------- car sheet ---------- */
  function openCar(id) {
    var c = state.cars.get(id); if (!c) return;
    state.open = id;
    state.expanded = new Set([c.stage]);
    $('#m-fields').innerHTML = FIELDS.map(function (f) {
      var v = c[f[0]];
      return '<label for="f-' + f[0] + '">' + f[1] + '<input class="field' + (f[2] === 'number' ? ' num' : '') + '" id="f-' + f[0] + '" data-f="' + f[0] + '" type="' + f[2] + '"' + (f[2] === 'number' ? ' inputmode="numeric" min="0" max="2000000" step="1"' : '') + ' value="' + esc(v == null ? '' : v) + '" autocomplete="off"></label>';
    }).join('');
    $('#m-notes').value = c.notes || '';
    $('#m-stage').innerHTML = STAGES.map(function (s) { return '<option value="' + s.k + '">' + esc(s.l) + '</option>'; }).join('');
    $('#m-del').hidden = state.user.role !== 'admin';
    $('#m-body').disabled = readOnly();
    $('#m-qr').hidden = readOnly();
    $('#m-qr').href = '/sticker.html?ids=' + id;
    $('#ov-car').hidden = false;
    $('#ov-car .sheet').scrollTop = 0;
    renderSheet();
    $('#m-close').focus();
  }
  function closeCar() {
    $('#ov-car').hidden = true; state.open = null;
    if (location.pathname !== '/') { try { history.replaceState(null, '', '/'); } catch (e) { /* ignore */ } }
  }
  function renderSheet() {
    var id = state.open, c = id && state.cars.get(id);
    if (!c) { if (id) closeCar(); return; }
    $('#m-plate').textContent = c.reg || 'No reg';
    $('#m-title').textContent = [c.make, c.model].filter(Boolean).join(' ') || 'Unnamed car';
    $('#m-track').className = 'track' + (c.stage === 'ready' ? ' done' : '');
    $('#m-track').innerHTML = STAGES.map(function (s, i) { return '<i' + (i <= stageIdx(c) ? ' class="on"' : '') + '></i>'; }).join('');
    $('#m-stage').value = c.stage;
    var i = stageIdx(c), next = STAGES[i + 1];
    var nb = $('#m-next');
    nb.textContent = next ? ('Move to ' + next.l) : 'Final stage';
    nb.disabled = !next; nb.dataset.next = next ? next.k : '';
    var d = carDays(c);
    $('#m-days').innerHTML = '<span><b class="num">' + d + '</b> ' + (c.stage === 'ready' ? 'days from arrival to quality check' : 'days in prep, target ' + TARGET) + '</span><span>Arrived <b>' + esc(fmtDate(c.added)) + '</b></span><span><b class="num">' + doneCount(c) + '</b> of ' + TOTAL + ' tasks done</span>';
    $('#m-upd').textContent = c.updatedBy ? ('Last updated by ' + c.updatedBy + ', ' + new Date(c.updatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '';

    var ae = document.activeElement, ax = ae && ae.dataset && ae.dataset.x, av = ax ? ae.value : null, ass = null, ase = null;
    if (ax) { try { ass = ae.selectionStart; ase = ae.selectionEnd; } catch (er) { /* number inputs */ } }
    $('#m-checks').innerHTML = STAGES.map(function (s) {
      var done = s.t.filter(function (t) { return (c.done || {})[s.k + '_' + t[0]] === true; }).length;
      var items = s.t.map(function (t) {
        var tid = s.k + '_' + t[0], on = (c.done || {})[tid] === true;
        var x = t[2], ex = '', signed = '';
        if (x) {
          var xv = c[x.f];
          ex = '<input class="field xin' + (x.type === 'number' ? ' num' : '') + '" data-x="' + x.f + '" type="' + x.type + '"'
            + (x.type === 'number' ? ' inputmode="numeric" min="0" max="5" step="1"' : ' maxlength="4" autocapitalize="characters" autocomplete="off"')
            + ' value="' + esc(xv == null ? '' : xv) + '" placeholder="' + esc(x.label) + '" aria-label="' + esc(x.label) + '">';
          if (x.sign && c[x.sign]) signed = ' <small class="muted-s">signed ' + esc(fmtDate(c[x.sign])) + (c[x.name] ? ' by ' + esc(c[x.name]) : '') + '</small>';
        }
        return '<div class="chkrow"><label class="chk' + (on ? ' done' : '') + '"><input type="checkbox" data-t="' + tid + '"' + (on ? ' checked' : '') + '><span>' + esc(t[1]) + signed + '</span></label>' + ex + '</div>';
      }).join('');
      var complete = done === s.t.length;
      return '<details class="grp' + (s.k === c.stage ? ' current' : '') + (complete ? ' complete' : '') + '" data-s="' + s.k + '"' + (state.expanded.has(s.k) ? ' open' : '') + '><summary><span>' + esc(s.l) + '</span><small class="num">' + (complete ? 'Complete &#10003;' : done + ' of ' + s.t.length) + '</small></summary><div class="checks">' + items + '</div></details>';
    }).join('');
    if (ax) {
      var ni = $('#m-checks [data-x="' + ax + '"]');
      if (ni) { ni.value = av; ni.focus(); if (ass != null) { try { ni.setSelectionRange(ass, ase); } catch (er) { /* ignore */ } } }
    }
  }

  /* ---------- events: list and car sheet ---------- */
  $('#tab-prep').addEventListener('click', function () { state.tab = 'prep'; render(); });
  $('#tab-done').addEventListener('click', function () { state.tab = 'done'; render(); });
  $('#stage-filter').addEventListener('change', function (e) { state.f = e.target.value; render(); });
  $('#q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  function toList() {
    var el = $('#stock');
    try { el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(); }
  }
  $('#go').addEventListener('click', toList);
  $('#list').addEventListener('click', function (e) {
    if (e.target.closest('[data-act="add"]')) { openNew(); return; }
    var b = e.target.closest('[data-open]'); if (b) openCar(b.dataset.open);
  });
  $('#add-btn').addEventListener('click', openNew);
  $('#m-close').addEventListener('click', closeCar);
  $('#ov-car').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeCar(); });
  $('#m-stage').addEventListener('change', function (e) { if (state.open) setStage(state.open, e.target.value); });
  $('#m-next').addEventListener('click', function (e) { var n = e.currentTarget.dataset.next; if (n && state.open) setStage(state.open, n); });
  $('#m-fields').addEventListener('input', function (e) {
    var f = e.target.dataset.f; if (!f || !state.open) return;
    var v = e.target.value;
    if (f === 'reg') { v = v.toUpperCase(); if (e.target.value !== v) e.target.value = v; }
    if (NUMERIC[f]) v = (v === '' ? null : Number(v));
    debounced(state.open, f, v);
  });
  $('#m-notes').addEventListener('input', function (e) { if (state.open) debounced(state.open, 'notes', e.target.value); });
  $('#m-checks').addEventListener('change', function (e) {
    var t = e.target.dataset && e.target.dataset.t; if (!t || !state.open) return;
    var c = state.cars.get(state.open); if (!c) return;
    var o = { done: {} }; o.done[t] = e.target.checked;
    var item = findItem(t), spec = item && item[2];
    if (spec && spec.sign && e.target.checked && !c[spec.f]) o[spec.f] = state.user.initials;   // sign with the logged-in person's initials
    upd(state.open, o);
  });
  $('#m-checks').addEventListener('input', function (e) {
    var f = e.target.dataset && e.target.dataset.x; if (!f || !state.open) return;
    var spec = findExtra(f); if (!spec) return;
    var v = e.target.value;
    if (spec.type === 'number') v = (v === '' ? null : Number(v));
    else { v = v.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (e.target.value !== v) e.target.value = v; }
    debounced(state.open, f, v);
  });
  $('#m-checks').addEventListener('toggle', function (e) {
    var s = e.target.dataset && e.target.dataset.s; if (!s) return;
    if (e.target.open) state.expanded.add(s); else state.expanded.delete(s);
  }, true);

  var delBtn = $('#m-del');
  delBtn.addEventListener('click', function () {
    if (!delBtn.classList.contains('armed')) {
      delBtn.classList.add('armed'); delBtn.textContent = 'Tap again to delete';
      delBtn._t = setTimeout(function () { delBtn.classList.remove('armed'); delBtn.textContent = 'Delete car'; }, 4000);
      return;
    }
    clearTimeout(delBtn._t); delBtn.classList.remove('armed'); delBtn.textContent = 'Delete car';
    var id = state.open;
    closeCar();
    api('DELETE', '/api/cars/' + id).then(function () {
      state.cars.delete(id); render(); toast('Car deleted.');
    }).catch(fail);
  });

  /* ---------- new car ---------- */
  function openNew() { $('#n-form').reset(); $('#ov-new').hidden = false; $('#n-reg').focus(); }
  function closeNew() { $('#ov-new').hidden = true; }
  $('#n-close').addEventListener('click', closeNew);
  $('#ov-new').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeNew(); });
  $('#n-reg').addEventListener('input', function (e) { e.target.value = e.target.value.toUpperCase(); });
  $('#n-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var miles = $('#n-miles').value;
    var body = {
      reg: $('#n-reg').value, make: $('#n-make').value, model: $('#n-model').value,
      tag: $('#n-tag').value, colour: $('#n-colour').value, mileage: miles === '' ? null : Number(miles)
    };
    api('POST', '/api/cars', body).then(function (car) {
      state.cars.set(car.id, car);
      closeNew(); render(); openCar(car.id);
    }).catch(fail);
  });

  /* ---------- account ---------- */
  function openAccount() {
    $('#ac-h').textContent = state.user.display;
    $('#ac-sub').textContent = '@' + state.user.username + ' · ' + roleLabel(state.user.role) + ' · Initials ' + state.user.initials;
    $('#ac-admin').hidden = state.user.role !== 'admin';
    $('#pw-form').reset();
    $('#pw-err').hidden = true;
    $('#ov-acct').hidden = false;
    $('#ac-close').focus();
  }
  $('#acct-btn').addEventListener('click', openAccount);
  $('#ac-close').addEventListener('click', function () { $('#ov-acct').hidden = true; });
  $('#ov-acct').addEventListener('click', function (e) { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  $('#pw-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('#pw-err'); err.hidden = true;
    api('POST', '/api/password', { current: $('#pw-cur').value, next: $('#pw-new').value }).then(function () {
      $('#pw-form').reset(); toast('Password changed.');
    }).catch(function (ex) {
      if (ex && ex.code === 'unauth') return;
      err.textContent = (ex && ex.message) || 'Could not change the password.'; err.hidden = false;
    });
  });
  $('#ac-out').addEventListener('click', function () {
    api('POST', '/api/logout', {}).catch(function () { /* still sign out locally */ }).then(function () {
      state.user = null;
      signedOut('');
    });
  });

  /* ---------- staff logins (administrators) ---------- */
  var users = [];
  function loadUsers() {
    return api('GET', '/api/users').then(function (r) { users = r.users; renderUsers(); }).catch(fail);
  }
  function renderUsers() {
    $('#us-list').innerHTML = users.map(function (u) {
      var me = u.id === state.user.id;
      return '<div class="urow' + (u.active ? '' : ' off') + '" data-uid="' + u.id + '">'
        + '<div class="urow-top"><div><div class="urow-name">' + esc(u.display) + (me ? ' (you)' : '') + '</div><div class="urow-user">@' + esc(u.username) + ' · Initials ' + esc(u.initials) + '</div></div>'
        + '<span class="pill ' + (u.active ? (u.role === 'admin' ? 'ok' : '') : 'bad') + '">' + (u.active ? roleLabel(u.role) : 'Deactivated') + '</span></div>'
        + '<div class="urow-actions">'
        + (me ? '' : '<select class="field" data-role aria-label="Role for ' + esc(u.display) + '">' + ['staff', 'advisor', 'admin'].map(function (r) { return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + esc(roleLabel(r)) + '</option>'; }).join('') + '</select>')
        + '<button class="btn" type="button" data-resetpw>Set new password</button>'
        + (me ? '' : '<button class="btn ' + (u.active ? 'danger' : '') + '" type="button" data-toggle>' + (u.active ? 'Deactivate' : 'Reactivate') + '</button>')
        + '</div></div>';
    }).join('');
  }
  $('#ac-users').addEventListener('click', function () {
    $('#ov-acct').hidden = true; $('#us-form').reset(); $('#u-err').hidden = true;
    $('#ov-users').hidden = false; loadUsers(); $('#us-close').focus();
  });
  $('#us-close').addEventListener('click', function () { $('#ov-users').hidden = true; });
  $('#ov-users').addEventListener('click', function (e) { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  function patchUser(id, body, okMsg) {
    return api('PATCH', '/api/users/' + id, body).then(function () { if (okMsg) toast(okMsg); return loadUsers(); }).catch(function (ex) {
      if (ex && ex.code === 'unauth') return;
      toast((ex && ex.message) || 'Could not update that person.'); loadUsers();
    });
  }
  $('#us-list').addEventListener('change', function (e) {
    if (!e.target.matches('[data-role]')) return;
    var id = e.target.closest('.urow').dataset.uid;
    patchUser(id, { role: e.target.value }, 'Role updated.');
  });
  $('#us-list').addEventListener('click', function (e) {
    var row = e.target.closest('.urow'); if (!row) return;
    var id = row.dataset.uid;
    if (e.target.closest('[data-toggle]')) {
      var u = users.find(function (x) { return String(x.id) === id; });
      patchUser(id, { active: !u.active }, u.active ? 'Deactivated. They are signed out.' : 'Reactivated.');
    } else if (e.target.closest('[data-resetpw]')) {
      if (row.querySelector('.pwbox')) { row.querySelector('.pwbox input').focus(); return; }
      var box = document.createElement('div');
      box.className = 'pwbox';
      box.innerHTML = '<input class="field" type="text" minlength="8" maxlength="200" autocomplete="off" aria-label="New password" placeholder="New password (8+ characters)"><button class="btn primary" type="button" data-savepw>Save password</button>';
      row.appendChild(box);
      box.querySelector('input').focus();
    } else if (e.target.closest('[data-savepw]')) {
      var pw = row.querySelector('.pwbox input').value;
      patchUser(id, { password: pw }, 'Password changed. They are signed out and must use the new one.');
    }
  });
  $('#us-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('#u-err'); err.hidden = true;
    api('POST', '/api/users', {
      display: $('#u-display').value, username: $('#u-user').value, password: $('#u-pass').value, role: $('#u-role').value
    }).then(function () {
      $('#us-form').reset(); toast('Person added.'); return loadUsers();
    }).catch(function (ex) {
      if (ex && ex.code === 'unauth') return;
      err.textContent = (ex && ex.message) || 'Could not add that person.'; err.hidden = false;
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    ['#ov-users', '#ov-acct', '#ov-new', '#ov-car'].some(function (s) {
      if (!$(s).hidden) { if (s === '#ov-car') closeCar(); else $(s).hidden = true; return true; }
      return false;
    });
  });

  /* ---------- start ---------- */
  api('GET', '/api/session').then(function (s) {
    if (s.user) { state.user = s.user; startApp(); }
    else showAuth(s.setup ? 'setup' : 'login');
  }).catch(function () {
    showAuth('login', 'Could not reach the server. Check your connection and reload.');
  });
})();
