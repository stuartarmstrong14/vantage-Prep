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
  var TZ = 'Europe/London';
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
    $('#auth-title').textContent = setup ? 'Create the first account' : '145 Prepped';
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
    ['#ov-car', '#ov-new', '#ov-acct', '#ov-users', '#ov-reports'].forEach(function (s) { $(s).hidden = true; });
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
      if (!$('#ov-reports').hidden) renderReports();
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
    $('#rep-btn').hidden = !state.user || state.user.role !== 'admin';
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
  // A car is archived automatically once it has been on the system for more than 365 days. Nothing is deleted.
  function isArchived(c) { return !!c.added && dayNum(todayStr()) - dayNum(c.added) > 365; }
  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = [];
    state.cars.forEach(function (c, id) {
      if (state.tab === 'arch') { if (!isArchived(c)) return; }
      else {
        if (isArchived(c)) return;
        if (isDone(c) !== (state.tab === 'done')) return;
        if (state.tab === 'prep' && state.f !== 'all' && c.stage !== state.f) return;
      }
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
    var every = [];
    state.cars.forEach(function (c) { every.push(c); });
    var archived = every.filter(isArchived);
    var all = every.filter(function (c) { return !isArchived(c); });
    var inPrep = all.filter(function (c) { return c.stage !== 'ready'; });
    var completed = all.filter(isDone);
    var active = all.filter(function (c) { return !isDone(c); });
    var avg = inPrep.length ? Math.round(inPrep.reduce(function (n, c) { return n + carDays(c); }, 0) / inPrep.length * 10) / 10 : 0;
    $('#s-prep').textContent = inPrep.length;
    $('#s-avg').textContent = avg;
    $('#s-done').textContent = completed.length;
    $('#tab-prep-n').textContent = active.length;
    $('#tab-done-n').textContent = completed.length;
    $('#tab-arch-n').textContent = archived.length;
    $('#tab-arch').setAttribute('aria-selected', state.tab === 'arch');
    $('#tab-prep').setAttribute('aria-selected', state.tab === 'prep');
    $('#tab-done').setAttribute('aria-selected', state.tab === 'done');
    $('#stage-filter').hidden = state.tab !== 'prep';

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
    if (!vis.length) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>' + (state.tab === 'done' && !state.q.trim() ? 'No cars have completed prep yet. A car moves here when it reaches Quality Check.' : state.tab === 'arch' && !state.q.trim() ? 'Nothing archived yet. A car moves here automatically 365 days after it arrived. It is still counted in the reports.' : 'No cars match this search.') + '</p></div>'; return; }
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
        var tl = on && c.tickLog && c.tickLog[tid];
        if (tl && tl.at) signed += ' <small class="muted-s">' + new Date(tl.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: TZ }) + (tl.by ? ' by ' + esc(tl.by) : '') + '</small>';
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
  $('#tab-arch').addEventListener('click', function () { state.tab = 'arch'; render(); });
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
    // Everything ticked: the car is prepped, so move it to Completed.
    var after = Object.assign({}, c.done, o.done);
    var all = STAGES.every(function (s) { return s.t.every(function (t) { return after[s.k + '_' + t[0]] === true; }); });
    if (all && c.stage !== 'ready') { o.stage = 'ready'; toast('All prep complete. Moved to Completed.'); }
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
    ['#ov-users', '#ov-acct', '#ov-new', '#ov-reports', '#ov-car'].some(function (s) {
      if (!$(s).hidden) { if (s === '#ov-car') closeCar(); else $(s).hidden = true; return true; }
      return false;
    });
  });

  /* ---------- reports (administrators) ---------- */
  function wkStart(d) { return d - ((d + 3) % 7); }          // day number of that week's Monday
  function dayStr(d) { return new Date(d * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  function one(n) { return (Math.round(n * 10) / 10).toString(); }
  function renderReports() {
    var all = []; state.cars.forEach(function (c, id) { all.push(Object.assign({ id: id }, c)); });
    var done = all.filter(isDone), active = all.filter(function (c) { return !isDone(c) && !isArchived(c); });
    var avg = done.length ? done.reduce(function (n, c) { return n + carDays(c); }, 0) / done.length : 0;
    var onT = done.filter(function (c) { return carDays(c) <= TARGET; }).length;
    var pct = done.length ? Math.round(onT / done.length * 100) : 0;
    var stuck = active.filter(function (c) { return carDays(c) > TARGET; }).sort(function (a, b) { return carDays(b) - carDays(a); });

    var tiles = '<div class="rp-tiles">'
      + '<div class="rp-tile"><b class="num">' + done.length + '</b><span>Prep completed</span></div>'
      + '<div class="rp-tile"><b class="num">' + (done.length ? one(avg) : '–') + '</b><span>Avg days, arrival to completed</span></div>'
      + '<div class="rp-tile ' + (done.length && pct >= 80 ? 'good' : '') + '"><b class="num">' + (done.length ? pct + '%' : '–') + '</b><span>Done within ' + TARGET + ' days</span></div>'
      + '<div class="rp-tile ' + (stuck.length ? 'bad' : '') + '"><b class="num">' + stuck.length + '</b><span>In prep over ' + TARGET + ' days</span></div></div>';

    // completed cars by week, month or year
    var view = state.rpView || 'week';
    var todayN = dayNum(todayStr()), td = todayStr(), periods = [];
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function keyOf(c) {
      if (!c.readyAt) return null;
      return view === 'week' ? String(wkStart(dayNum(c.readyAt))) : view === 'month' ? c.readyAt.slice(0, 7) : c.readyAt.slice(0, 4);
    }
    if (view === 'week') {
      for (var w = 7; w >= 0; w--) { var wd = wkStart(todayN) - w * 7; periods.push({ k: String(wd), l: dayStr(wd), long: 'Week of ' + dayStr(wd) }); }
    } else if (view === 'month') {
      var y0 = +td.slice(0, 4), m0 = +td.slice(5, 7) - 1;
      for (var mi = 11; mi >= 0; mi--) {
        var mm = m0 - mi, yy = y0; while (mm < 0) { mm += 12; yy--; }
        periods.push({ k: yy + '-' + String(mm + 1).padStart(2, '0'), l: MON[mm] + (mm === 0 || mi === 11 ? ' ' + String(yy).slice(2) : ''), long: MON[mm] + ' ' + yy });
      }
    } else {
      var firstY = done.reduce(function (n, c) { return c.readyAt ? Math.min(n, +c.readyAt.slice(0, 4)) : n; }, +td.slice(0, 4));
      for (var yv = firstY; yv <= +td.slice(0, 4); yv++) periods.push({ k: String(yv), l: String(yv), long: String(yv) });
    }
    periods.forEach(function (p) { p.cars = done.filter(function (c) { return keyOf(c) === p.k; }); });
    function slowestOf(cars) {
      var a = {};
      cars.forEach(function (c) {
        var h = c.history || [];
        for (var k = 0; k + 1 < h.length; k++) {
          if (!h[k].at || !h[k + 1].at) continue;
          var x = a[h[k].s] || (a[h[k].s] = { sum: 0, n: 0 }); x.sum += (new Date(h[k + 1].at) - new Date(h[k].at)) / 864e5; x.n++;
        }
      });
      var best = null;
      STAGES.forEach(function (st) { if (st.k !== 'ready' && a[st.k] && (!best || a[st.k].sum / a[st.k].n > best.v)) best = { l: st.l, v: a[st.k].sum / a[st.k].n }; });
      return best ? best.l : '–';
    }
    var pmx = Math.max.apply(null, periods.map(function (p) { return p.cars.length; }).concat([1]));
    var VIEWS = [['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Annual'], ['pick', 'Pick a month']];
    var tabsHtml = '<div class="tabs rp-tabs" role="tablist" aria-label="Report period">' + VIEWS.map(function (v) {
      return '<button class="tab" type="button" role="tab" data-rpv="' + v[0] + '" aria-selected="' + (view === v[0]) + '">' + v[1] + '</button>';
    }).join('') + '</div>';
    var weekly = tabsHtml + '<div class="wk" role="img" aria-label="Cars completed per ' + view + '">' + periods.map(function (p) {
      return '<div class="wk-col"><b>' + p.cars.length + '</b><i style="height:' + Math.round(p.cars.length / pmx * 100) + '%"></i><span>' + esc(p.l) + '</span></div>';
    }).join('') + '</div>';
    var tbody = periods.slice().reverse().map(function (p) {
      var n = p.cars.length;
      var av = n ? p.cars.reduce(function (t, c) { return t + carDays(c); }, 0) / n : 0;
      var ok = n ? Math.round(p.cars.filter(function (c) { return carDays(c) <= TARGET; }).length / n * 100) : 0;
      var back = p.cars.reduce(function (t, c) { return t + (c.sentBack || 0); }, 0);
      return '<tr><td>' + esc(p.long) + '</td><td>' + n + '</td><td>' + (n ? one(av) : '–') + '</td><td>' + (n ? ok + '%' : '–') + '</td><td>' + (n ? back : '–') + '</td><td>' + (n ? esc(slowestOf(p.cars)) : '–') + '</td></tr>';
    }).join('');
    function pickHtml() {
      var cur = td.slice(0, 7), have = {}; have[cur] = 1;
      all.forEach(function (c) { if (c.readyAt) have[c.readyAt.slice(0, 7)] = 1; if (c.added) have[c.added.slice(0, 7)] = 1; });
      var keys = Object.keys(have).sort().reverse();
      var sel = state.rpMonth && have[state.rpMonth] ? state.rpMonth : cur;
      var name = MON[+sel.slice(5) - 1] + ' ' + sel.slice(0, 4);
      var opts = keys.map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + MON[+k.slice(5) - 1] + ' ' + k.slice(0, 4) + '</option>'; }).join('');
      var cars = done.filter(function (c) { return c.readyAt && c.readyAt.slice(0, 7) === sel; }).sort(function (a, b) { return a.readyAt < b.readyAt ? 1 : -1; });
      var arrived = all.filter(function (c) { return c.added && c.added.slice(0, 7) === sel; }).length;
      var n = cars.length;
      var av = n ? cars.reduce(function (t, c) { return t + carDays(c); }, 0) / n : 0;
      var ok = n ? Math.round(cars.filter(function (c) { return carDays(c) <= TARGET; }).length / n * 100) : 0;
      var back = cars.reduce(function (t, c) { return t + (c.sentBack || 0); }, 0);
      var a = {};
      cars.forEach(function (c) {
        var h = c.history || [];
        for (var k = 0; k + 1 < h.length; k++) {
          if (!h[k].at || !h[k + 1].at) continue;
          var x = a[h[k].s] || (a[h[k].s] = { sum: 0, n: 0 }); x.sum += (new Date(h[k + 1].at) - new Date(h[k].at)) / 864e5; x.n++;
        }
      });
      var rows = STAGES.filter(function (st) { return st.k !== 'ready' && a[st.k]; }).map(function (st) { return { l: st.l, v: a[st.k].sum / a[st.k].n }; });
      var rmx = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([0.1]));
      var slowN = rows.length > 1 ? rows.reduce(function (p, q) { return q.v > p.v ? q : p; }).l : '';
      var st = rows.length ? '<div class="hbars">' + rows.map(function (r) {
        return '<div class="hbar' + (r.l === slowN ? ' slow' : '') + '"><span class="nm">' + esc(r.l) + '</span><span class="tr"><span class="fl" style="width:' + Math.round(r.v / rmx * 100) + '%"></span></span><span class="vl">' + one(r.v) + ' d</span></div>';
      }).join('') + '</div>' : '<p class="rp-empty">No stage timings recorded for cars completed this month.</p>';
      var list = n ? '<div class="rp-list">' + cars.map(function (c) {
        return '<button type="button" class="rp-row" data-open="' + c.id + '"><span class="l"><b>' + esc(c.reg) + ' ' + esc([c.make, c.model].filter(Boolean).join(' ')) + '</b><small>Completed ' + esc(fmtDate(c.readyAt)) + '</small></span><span class="r' + (carDays(c) > TARGET ? ' bad' : '') + '">' + carDays(c) + ' days</span></button>';
      }).join('') + '</div>' : '<p class="rp-empty">No cars were completed in ' + esc(name) + '.</p>';
      return '<label class="rp-pick" for="rp-month">Month <select class="field" id="rp-month" data-rpm="1">' + opts + '</select></label>'
        + '<div class="rp-tiles"><div class="rp-tile"><b class="num">' + arrived + '</b><span>Arrived in ' + esc(name) + '</span></div>'
        + '<div class="rp-tile"><b class="num">' + n + '</b><span>Prep completed</span></div>'
        + '<div class="rp-tile"><b class="num">' + (n ? one(av) : '–') + '</b><span>Avg days, arrival to completed</span></div>'
        + '<div class="rp-tile ' + (n && ok >= 80 ? 'good' : '') + '"><b class="num">' + (n ? ok + '%' : '–') + '</b><span>Done within ' + TARGET + ' days</span></div></div>'
        + '<h3 style="font-size:16px">Time in each stage</h3>' + st
        + '<p class="sub">' + back + (back === 1 ? ' move back' : ' moves back') + ' to an earlier stage among these cars.</p>'
        + '<h3 style="font-size:16px">Cars completed in ' + esc(name) + '</h3>' + list;
    }
    var tot = periods.reduce(function (t, p) { return t + p.cars.length; }, 0);
    weekly += '<div style="overflow-x:auto"><table class="rp-tbl rp-per"><thead><tr><th>' + (view === 'week' ? 'Week' : view === 'month' ? 'Month' : 'Year') + '</th><th>Completed</th><th>Avg days</th><th>Within ' + TARGET + ' days</th><th>Sent back</th><th>Slowest stage</th></tr></thead><tbody>' + tbody + '</tbody></table></div>'
      + '<p class="sub">' + tot + (tot === 1 ? ' car' : ' cars') + ' completed in this period. Cars are counted in the period they reached completed. "Slowest stage" uses stage timings recorded since tracking began.</p>';
    if (view === 'pick') weekly = tabsHtml + pickHtml();

    // where the stock is now
    var stageRows = STAGES.filter(function (s) { return s.k !== 'ready'; }).map(function (s) {
      return { l: s.l, n: active.filter(function (c) { return c.stage === s.k; }).length };
    });
    var smx = Math.max.apply(null, stageRows.map(function (r) { return r.n; }).concat([1]));
    var byStage = '<div class="hbars">' + stageRows.map(function (r) {
      return '<div class="hbar"><span class="nm">' + esc(r.l) + '</span><span class="tr"><span class="fl" style="width:' + (r.n ? Math.round(r.n / smx * 100) : 0) + '%"></span></span><span class="vl">' + r.n + '</span></div>';
    }).join('') + '</div>';

    // time in each stage, from the recorded history
    var agg = {}, tracked = 0;
    all.forEach(function (c) {
      var h = c.history || [], got = false;
      for (var k = 0; k + 1 < h.length; k++) {
        if (!h[k].at || !h[k + 1].at) continue;
        var days = (new Date(h[k + 1].at) - new Date(h[k].at)) / 864e5;
        var a = agg[h[k].s] || (agg[h[k].s] = { sum: 0, n: 0 }); a.sum += days; a.n++; got = true;
      }
      if (got) tracked++;
    });
    var trows = STAGES.filter(function (s) { return s.k !== 'ready' && agg[s.k]; }).map(function (s) { return { l: s.l, v: agg[s.k].sum / agg[s.k].n, n: agg[s.k].n }; });
    var tmx = Math.max.apply(null, trows.map(function (r) { return r.v; }).concat([0.1]));
    var slow = trows.length > 1 ? trows.reduce(function (a, b) { return b.v > a.v ? b : a; }).l : '';
    var stageTime = trows.length ? '<div class="hbars">' + trows.map(function (r) {
      return '<div class="hbar' + (r.l === slow ? ' slow' : '') + '"><span class="nm">' + esc(r.l) + '</span><span class="tr"><span class="fl" style="width:' + Math.round(r.v / tmx * 100) + '%"></span></span><span class="vl">' + one(r.v) + ' d</span></div>';
    }).join('') + '</div><p class="sub">' + (slow ? esc(slow) + ' is the slowest stage. ' : '') + 'Average days a car spends in each stage, from ' + tracked + (tracked === 1 ? ' car' : ' cars') + ' since stage tracking began.</p>'
      : '<p class="rp-empty">No stage timings yet. They fill in as cars are moved from one stage to the next.</p>';

    var stuckHtml = stuck.length ? '<div class="rp-list">' + stuck.slice(0, 12).map(function (c) {
      return '<button type="button" class="rp-row" data-open="' + c.id + '"><span class="l"><b>' + esc(c.reg) + ' ' + esc([c.make, c.model].filter(Boolean).join(' ')) + '</b><small>' + esc((STAGES[stageIdx(c)] || {}).l || '') + '</small></span><span class="r bad">' + carDays(c) + ' days</span></button>';
    }).join('') + '</div>' : '<p class="rp-empty">No cars are over target.</p>';

    // people
    var ppl = {};
    function pp(n) { return ppl[n] || (ppl[n] = { qc: 0, ticks: 0 }); }
    all.forEach(function (c) {
      if (c.bodyQcName) pp(c.bodyQcName).qc++;
      if (c.finalQcName) pp(c.finalQcName).qc++;
      Object.keys(c.tickLog || {}).forEach(function (k) { if (c.tickLog[k] && c.tickLog[k].by) pp(c.tickLog[k].by).ticks++; });
    });
    var names = Object.keys(ppl).sort(function (a, b) { return ppl[b].qc - ppl[a].qc || ppl[b].ticks - ppl[a].ticks; });
    var people = names.length ? '<table class="rp-tbl"><thead><tr><th>Person</th><th>QC sign-offs</th><th>Boxes ticked</th></tr></thead><tbody>' + names.map(function (n) {
      return '<tr><td>' + esc(n) + '</td><td>' + ppl[n].qc + '</td><td>' + ppl[n].ticks + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="rp-empty">No sign-offs yet.</p>';

    // sent back
    var back = all.filter(function (c) { return c.sentBack > 0; }).sort(function (a, b) { return b.sentBack - a.sentBack; });
    var backTotal = back.reduce(function (n, c) { return n + c.sentBack; }, 0);
    var sent = back.length ? '<div class="rp-list">' + back.slice(0, 10).map(function (c) {
      return '<button type="button" class="rp-row" data-open="' + c.id + '"><span class="l"><b>' + esc(c.reg) + ' ' + esc([c.make, c.model].filter(Boolean).join(' ')) + '</b></span><span class="r">' + c.sentBack + (c.sentBack === 1 ? ' time' : ' times') + '</span></button>';
    }).join('') + '</div>' : '<p class="rp-empty">No car has been moved back to an earlier stage.</p>';

    $('#rp-body').innerHTML = tiles + '<div class="rp-grid" style="margin-top:14px">'
      + '<section class="rp-card full"><h3>Cars completed</h3>' + weekly + '</section>'
      + '<section class="rp-card"><h3>Where the stock is now</h3>' + byStage + '<p class="sub">' + active.length + ' cars in prep.</p></section>'
      + '<section class="rp-card"><h3>Time in each stage</h3>' + stageTime + '</section>'
      + '<section class="rp-card"><h3>Cars over target</h3>' + stuckHtml + '</section>'
      + '<section class="rp-card"><h3>Sent back to an earlier stage</h3>' + sent + '<p class="sub">' + backTotal + (backTotal === 1 ? ' move back' : ' moves back') + ' in total.</p></section>'
      + '<section class="rp-card full"><h3>Sign-offs and ticks by person</h3>' + people + '</section></div>';
  }
  function openReports() { $('#rp-target').textContent = TARGET; renderReports(); $('#ov-reports').hidden = false; $('#ov-reports .sheet').scrollTop = 0; $('#rp-close').focus(); }
  $('#rep-btn').addEventListener('click', openReports);
  $('#rp-close').addEventListener('click', function () { $('#ov-reports').hidden = true; });
  $('#rp-body').addEventListener('change', function (e) {
    if (e.target.dataset && e.target.dataset.rpm) { state.rpMonth = e.target.value; renderReports(); var m = $('#rp-month'); if (m) m.focus(); }
  });
  $('#rp-body').addEventListener('click', function (e) {
    var v = e.target.closest && e.target.closest('[data-rpv]');
    if (v) { state.rpView = v.dataset.rpv; renderReports(); return; }
    var b = e.target.closest && e.target.closest('[data-open]'); if (!b) return;
    $('#ov-reports').hidden = true; openCar(b.dataset.open);
  });

  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(function () { /* app still works in the browser */ }); }

  /* ---------- start ---------- */
  api('GET', '/api/session').then(function (s) {
    if (s.user) { state.user = s.user; startApp(); }
    else showAuth(s.setup ? 'setup' : 'login');
  }).catch(function () {
    showAuth('login', 'Could not reach the server. Check your connection and reload.');
  });
})();
