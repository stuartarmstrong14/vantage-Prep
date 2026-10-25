(function () {
  'use strict';

  /* ---------- checklist definition ---------- */
  var STAGES = [
    { k: 'arrived', s: 'Inbound', l: 'Inbound', t: [['advert', 'Advertised on Auto Trader'], ['lines', 'Preparation lines requested'], ['qr', 'QR sticker fitted']] },
    { k: 'valet', s: 'Valet', l: 'Valet', t: [['done', 'Valet completed']] },
    { k: 'photos', s: 'Photos', l: 'Photos', t: [['done', 'Photographs completed']] },
    { k: 'mech', s: 'Mech', l: 'Mechanical', t: [['pt145', '145 point mechanical check', null, 'upload'], ['service', 'Service'], ['motbook', 'MOT passed'], ['qc', 'Mechanical QC complete']] },
    { k: 'body', s: 'Body', l: 'Bodywork', t: [
      ['cosmetic', 'Cosmetic check complete', { f: 'cosmeticNotes', label: 'Cosmetics to do', type: 'note' }],
      ['dent', 'Dents completed'],
      ['wheels', 'Alloy wheels completed', { f: 'bodyWheels', label: 'Wheels to refine', type: 'number' }],
      ['paint', 'Paint work completed'],
      ['qc', 'QC complete', { f: 'bodyQcBy', label: 'Initials', type: 'text', sign: 'bodyQcOn', name: 'bodyQcName' }]
    ] },
    { k: 'ready', s: 'QC', l: 'Quality Check', t: [['qc', 'Quality check completed', { f: 'finalQcBy', label: 'Initials', type: 'text', sign: 'finalQcOn', name: 'finalQcName' }]] }
  ];
  var TARGET = 7;
  var TZ = 'Europe/London';
  var TOTAL = STAGES.reduce(function (n, s) { return n + s.t.length; }, 0);
  var FIELDS = [
    ['reg', 'Registration', 'text'], ['make', 'Make', 'text'], ['model', 'Model', 'text'], ['tag', 'Tag number', 'text'],
    ['mileage', 'Mileage', 'number'], ['mot', 'MOT expiry', 'shortdate']
  ];
  var NUMERIC = { mileage: 1 };
  // Prep requested on the car (from the email, or set by hand). Order and labels are fixed.
  var PREP = [['TAC', 'TAC'], ['SERVICE', 'Service'], ['MOT', 'MOT']];
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

  var ROLE_LABELS = { admin: 'Administrator', staff: 'Staff', advisor: 'Advisor (view only)', paint: 'Paint (paint only)', alloy: 'Alloys (alloys only)', dent: 'Dents (dents only)' };
  var ROLE_ORDER = ['staff', 'paint', 'alloy', 'dent', 'advisor', 'admin'];
  // Specialist logins see everything but can only tick their own bodywork job.
  var SPECIALIST = {
    paint: { done: ['body_paint'], fields: [], job: 'job:body_paint' },
    alloy: { done: ['body_wheels'], fields: ['bodyWheels'], job: 'job:body_wheels' },
    dent: { done: ['body_dent'], fields: [], job: 'job:body_dent' }
  };
  function roleLabel(r) { return ROLE_LABELS[r] || r; }
  function specialist() { return !!state.user && SPECIALIST[state.user.role] || null; }
  function readOnly() { return !!state.user && (state.user.role === 'advisor' || !!SPECIALIST[state.user.role]); }
  // For a specialist, switch on only their own tick box (and wheels to refine for alloys); everything else stays locked.
  function lockForRole() {
    var sp = specialist(); if (!sp) return;
    $('#m-body').disabled = false;
    document.querySelectorAll('#m-body input, #m-body textarea, #m-body select, #m-body button').forEach(function (el) {
      var t = el.dataset && el.dataset.t, x = el.dataset && el.dataset.x;
      el.disabled = !((t && sp.done.indexOf(t) >= 0) || (x && sp.fields.indexOf(x) >= 0));
    });
  }

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
    state.user = null; state.cars = new Map(); state.rev = null; state.loaded = false; state.open = null; state.f = 'all'; state.q = ''; try { $('#q').value = ''; } catch (e) { /* ignore */ }
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
      if (state.loaded) announce(state.cars, m);
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

  /* ---------- "someone else updated" pop-ups ---------- */
  var ITEM_LABEL = {};
  STAGES.forEach(function (st) { st.t.forEach(function (t) { ITEM_LABEL[st.k + '_' + t[0]] = st.l + ': ' + t[1]; }); });
  var firstName = function (n) { return String(n || 'Someone').split(' ')[0]; };
  var noticeTimer = null;
  function announce(oldCars, newCars) {
    var me = state.user && state.user.display, notes = [];
    newCars.forEach(function (c, id) {
      var o = oldCars.get(id), reg = c.reg || 'a car';
      if (!o) {
        var by = c.history && c.history[0] && c.history[0].by;
        if (by && by !== me) notes.push((by === 'Email' ? 'New car from email: ' : firstName(by) + ' added ') + reg);
        return;
      }
      var log = c.tickLog || {}, was = o.tickLog || {};
      Object.keys(log).forEach(function (k) {
        var e = log[k];
        if (!e || e.by === me || !ITEM_LABEL[k] || (was[k] && was[k].at === e.at)) return;
        notes.push(firstName(e.by) + ' updated ' + ITEM_LABEL[k] + ' (' + reg + ')');
      });
    });
    if (!notes.length) return;
    var shown = notes.slice(0, 3);
    if (notes.length > 3) shown.push('and ' + (notes.length - 3) + ' more updates');
    var box = $('#notice');
    box.innerHTML = shown.map(function (n) { return '<div>' + esc(n) + '</div>'; }).join('');
    box.hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(function () { box.hidden = true; }, 7000);
  }
  document.addEventListener('click', function (e) { var b = $('#notice'); if (b && !b.hidden && b.contains(e.target)) b.hidden = true; });

  function startApp() {
    var spr = state.user && SPECIALIST[state.user.role];
    if (spr) state.f = spr.job;
    // signed in after following a link to the user guide: go there now
    if (/[?&]next=guide\b/.test(location.search)) { location.replace('/guide'); return; }
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
  // The stage is worked out from the ticks: the first area that is not fully ticked. All areas done means Quality Check.
  function keyFromDone(d) {
    for (var i = 0; i < STAGES.length - 1; i++) {
      var s = STAGES[i];
      if (!s.t.every(function (t) { return d[s.k + '_' + t[0]] === true; })) return s.k;
    }
    return 'ready';
  }
  function stageKey(c) { return keyFromDone(c.done || {}); }
  function stageDone(c, s) { var d = c.done || {}; return s.t.every(function (t) { return d[s.k + '_' + t[0]] === true; }); }
  function stageIdx(c) { var k = stageKey(c), i = STAGES.findIndex(function (s) { return s.k === k; }); return i < 0 ? 0 : i; }
  function carDays(c) {
    var end = (stageKey(c) === 'ready' && c.readyAt) ? c.readyAt : todayStr();
    return Math.max(0, dayNum(end) - dayNum(c.added || todayStr()));
  }
  function doneCount(c) {
    var n = 0, d = c.done || {};
    STAGES.forEach(function (s) { s.t.forEach(function (t) { if (d[s.k + '_' + t[0]] === true) n++; }); });
    return n;
  }
  function daysClass(c) {
    if (stageKey(c) === 'ready') return 'ok';
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
    STAGES.forEach(function (s, i) { h += '<i' + (stageDone(c, s) ? ' class="on"' : (i === cur ? ' class="cur"' : '')) + ' title="' + esc(s.l) + '"></i>'; });
    return '<div class="track" aria-hidden="true">' + h + '</div>';
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
  function isDone(c) { return stageKey(c) === 'ready'; }
  // A car is archived automatically 30 days after it was completed (passed Quality Check),
  // or once it has been on the system for more than 365 days. Nothing is deleted.
  // A person can also archive a completed car by hand, or restore one (archived: true / false overrides both rules).
  var ARCHIVE_AFTER_DONE = 30, ARCHIVE_AFTER_ADDED = 365;
  function isArchived(c) {
    if (c.archived === true) return true;
    if (c.archived === false) return false;
    var today = dayNum(todayStr());
    if (c.readyAt && stageKey(c) === 'ready' && today - dayNum(c.readyAt) > ARCHIVE_AFTER_DONE) return true;
    return !!c.added && today - dayNum(c.added) > ARCHIVE_AFTER_ADDED;
  }
  // The drop-down filters by work still outstanding, not by the stage a car has reached:
  // a car waiting at Valet with its mechanical work unticked counts under Mechanical too.
  var JOBS = [['body_cosmetic', 'Cosmetic'], ['body_dent', 'Dents'], ['body_wheels', 'Alloy wheels'], ['body_paint', 'Paint']];
  function needsWork(c, f) {
    if (!f || f === 'all') return true;
    var m = /^(need|job):(.+)$/.exec(f); if (!m) return true;
    if (m[1] === 'job') return (c.done || {})[m[2]] !== true;
    var st = STAGES.filter(function (x) { return x.k === m[2]; })[0];
    return st ? !stageDone(c, st) : true;
  }
  // Typing in the search box looks through every car: in prep, completed and archived.
  function matches(c, q) {
    var hay = ((c.reg || '') + ' ' + (c.tag || '') + ' ' + (c.make || '') + ' ' + (c.model || '') + ' ' + (c.prep || []).join(' ')).toLowerCase();
    return hay.indexOf(q) >= 0 || hay.replace(/[\s-]/g, '').indexOf(q.replace(/[\s-]/g, '')) >= 0;
  }
  function searching() { return !!state.q.trim(); }
  function statusOf(c) { return isArchived(c) ? 2 : isDone(c) ? 1 : 0; }
  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = [];
    state.cars.forEach(function (c, id) {
      if (q) { if (matches(c, q)) out.push({ id: id, c: c }); return; }
      if (state.tab === 'arch') { if (!isArchived(c)) return; }
      else {
        if (isArchived(c)) return;
        if (isDone(c) !== (state.tab === 'done')) return;
        if (state.tab === 'prep' && !needsWork(c, state.f)) return;
      }
      out.push({ id: id, c: c });
    });
    out.sort(function (a, b) {
      if (q) { var sa = statusOf(a.c), sb = statusOf(b.c); if (sa !== sb) return sa - sb; }
      var ra = stageKey(a.c) === 'ready', rb = stageKey(b.c) === 'ready';
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
    var inPrep = all.filter(function (c) { return stageKey(c) !== 'ready'; });
    var completed = all.filter(isDone);
    var active = all.filter(function (c) { return !isDone(c); });
    var avg = inPrep.length ? Math.round(inPrep.reduce(function (n, c) { return n + carDays(c); }, 0) / inPrep.length * 10) / 10 : 0;
    $('#s-prep').textContent = inPrep.length;
    $('#s-avg').textContent = avg;
    $('#s-done').textContent = completed.length;
    $('#tab-prep-n').textContent = active.length;
    $('#tab-done-n').textContent = completed.length;
    $('#tab-arch-n').textContent = archived.length;
    var srch = searching();
    $('#tab-arch').setAttribute('aria-selected', !srch && state.tab === 'arch');
    $('#tab-prep').setAttribute('aria-selected', !srch && state.tab === 'prep');
    $('#tab-done').setAttribute('aria-selected', !srch && state.tab === 'done');
    // department boxes: how many cars still need each department (tap to filter the stock list)
    if (!/^(all|need:\w+|job:\w+)$/.test(state.f)) state.f = 'all';
    var cnt = function (f) { return active.filter(function (c) { return needsWork(c, f); }).length; };
    var dHtml = STAGES.map(function (s) {
      var f = 'need:' + s.k, n = cnt(f), on = state.f === f;
      return '<button type="button" class="dbox' + (on ? ' on' : '') + (n ? '' : ' zero') + '" data-f="' + f + '" aria-pressed="' + on + '"><b class="num">' + n + '</b><span>' + esc(s.l) + '</span></button>';
    }).join('');
    var jHtml = '<span class="djl">Bodywork jobs</span>' + JOBS.map(function (j) {
      var f = 'job:' + j[0], n = cnt(f), on = state.f === f;
      return '<button type="button" class="djob' + (on ? ' on' : '') + '" data-f="' + f + '" aria-pressed="' + on + '">' + esc(j[1]) + ' <b class="num">' + n + '</b></button>';
    }).join('');
    var sig = dHtml + jHtml;
    if ($('#dept').dataset.sig !== sig) { $('#dept-boxes').innerHTML = dHtml; $('#dept-jobs').innerHTML = jHtml; $('#dept').dataset.sig = sig; }
    // the bodywork job buttons only show once Bodywork (or one of its jobs) is picked
    $('#dept-jobs').hidden = !(state.f === 'need:body' || state.f.indexOf('job:') === 0);
    var fl = $('#f-label');
    if (srch) {
      fl.innerHTML = 'Search results for <b>' + esc(state.q.trim()) + '</b> across all cars, including completed and archived <button type="button" class="linkbtn" id="q-clear">Clear search</button>';
      fl.hidden = false;
    } else if (state.f !== 'all' && state.tab === 'prep') {
      var lbl = state.f.indexOf('need:') === 0 ? STAGES.filter(function (x) { return 'need:' + x.k === state.f; })[0].l : JOBS.filter(function (x) { return 'job:' + x[0] === state.f; })[0][1];
      fl.innerHTML = 'Showing cars that still need <b>' + esc(lbl) + '</b> <button type="button" class="linkbtn" id="f-clear">Show all</button>';
      fl.hidden = false;
    } else fl.hidden = true;

    var vis = state.loaded ? visible() : [];
    var list = $('#list');
    if (state.err) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><h2>Stock is not available</h2><p>' + esc(state.err) + '</p></div>'; return; }
    if (!state.loaded) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>Loading stock…</p></div>'; return; }
    if (!all.length) {
      list.innerHTML = '<div class="empty" style="grid-column:1/-1"><h2>No cars in prep</h2><p>Add the first car as it arrives. Each one gets a checklist from inbound through to quality check.</p>' + (readOnly() ? '' : '<button class="btn primary" type="button" data-act="add" style="min-height:48px;padding:0 26px">Add car</button>') + '</div>';
      return;
    }
    if (!vis.length) { list.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>' + (state.tab === 'done' && !state.q.trim() ? 'No cars have completed prep yet. A car moves here when it reaches Quality Check.' : state.tab === 'arch' && !state.q.trim() ? 'Nothing archived yet. A car moves here automatically 30 days after it is completed, or 365 days after it arrived. It is still counted in the reports.' : 'No cars match this search.') + '</p></div>'; return; }
    list.innerHTML = vis.map(function (r) { return cardHtml(r.id, r.c, srch); }).join('');
  }
  function cardHtml(id, c, showStatus) {
    var d = carDays(c), dc = daysClass(c), mi = motInfo(c);
    var st = STAGES[stageIdx(c)];
    var name = [c.make, c.model].filter(Boolean).join(' ');
    var meta = [c.tag ? (/^tag/i.test(c.tag) ? c.tag : 'Tag ' + c.tag) : '', miles(c.mileage)].filter(Boolean).map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('');
    var tags = (showStatus ? '<span class="pill stat-' + ['prep', 'done', 'arch'][statusOf(c)] + '">' + ['In prep', 'Completed', 'Archived'][statusOf(c)] + '</span>' : '')
      + (mi ? '<span class="pill ' + mi.cls + '">' + esc(mi.t) + '</span>' : '');
    var daysTxt = stageKey(c) === 'ready' ? ('Prepped in ' + d + 'd') : (d + (d === 1 ? ' day' : ' days') + ' in prep');
    return '<button class="car" type="button" data-open="' + esc(id) + '">'
      + '<div class="car-top"><span class="plate">' + esc(c.reg || 'No reg') + '</span><span class="pill num ' + dc + '">' + daysTxt + '</span></div>'
      + '<div class="car-name">' + esc(name || 'Unnamed car') + '</div>'
      + '<div class="car-meta">' + meta + '</div>'
      + ((c.prep || []).length ? '<div class="pqs">' + PREP.filter(function (p) { return c.prep.indexOf(p[0]) >= 0; }).map(function (p) { return '<span class="pq on" data-k="' + p[0] + '">' + p[1] + '</span>'; }).join('') + '</div>' : '')
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
  /* ---------- car sheet ---------- */
  function openCar(id) {
    var c = state.cars.get(id); if (!c) return;
    state.open = id;
    state.expanded = new Set([stageKey(c)]);
    $('#m-fields').innerHTML = FIELDS.map(function (f) {
      var v = c[f[0]];
      if (f[2] === 'shortdate') return '<label for="f-' + f[0] + '">' + f[1] + '<input class="field" id="f-' + f[0] + '" data-f="' + f[0] + '" data-sd="1" type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yy" value="' + esc(isoToShort(v)) + '" autocomplete="off"></label>';
      return '<label for="f-' + f[0] + '">' + f[1] + '<input class="field' + (f[2] === 'number' ? ' num' : '') + '" id="f-' + f[0] + '" data-f="' + f[0] + '" type="' + f[2] + '"' + (f[2] === 'number' ? ' inputmode="numeric" min="0" max="2000000" step="1"' : '') + ' value="' + esc(v == null ? '' : v) + '" autocomplete="off"></label>';
    }).join('');
    $('#m-notes').value = c.notes || '';
    renderPrepChips(c);
    $('#m-del').hidden = state.user.role !== 'admin';
    $('#m-body').disabled = readOnly();
    $('#m-qr').hidden = readOnly();
    lockForRole();
    $('#m-qr').href = '/sticker.html?ids=' + id;
    $('#ov-car').hidden = false;
    $('#ov-car .sheet').scrollTop = 0;
    renderSheet();
    $('#m-close').focus();
  }
  function renderPrepChips(c) {
    var on = c.prep || [];
    $('#m-prep').innerHTML = PREP.map(function (p) {
      var yes = on.indexOf(p[0]) >= 0;
      return '<button type="button" class="pq' + (yes ? ' on' : '') + '" data-k="' + p[0] + '" aria-pressed="' + yes + '">' + p[1] + '</button>';
    }).join('');
  }
  $('#m-prep').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-k]'); if (!b || !state.open) return;
    var c = state.cars.get(state.open); if (!c) return;
    var cur = (c.prep || []).slice(), k = b.dataset.k, i = cur.indexOf(k);
    if (i >= 0) cur.splice(i, 1); else cur.push(k);
    upd(state.open, { prep: PREP.map(function (p) { return p[0]; }).filter(function (x) { return cur.indexOf(x) >= 0; }) });
  });
  function closeCar() {
    $('#ov-car').hidden = true; state.open = null;
    if (location.pathname !== '/') { try { history.replaceState(null, '', '/'); } catch (e) { /* ignore */ } }
  }
  function fmtSize(n) { return n >= 1048576 ? (Math.round(n / 104857.6) / 10) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  // The 145 point check is completed by uploading the paperwork, not by a tick box.
  function uploadRowHtml(c, tid, label, on) {
    var files = c.checks || [], ro = readOnly();
    var list = files.map(function (f) {
      return '<div class="ufile"><a href="/api/files/' + esc(f.id) + '" target="_blank" rel="noopener">' + esc(f.name) + '</a><small class="muted-s">' + fmtSize(f.size) + '</small>'
        + (ro ? '' : '<button type="button" class="linkbtn" data-rmfile="' + esc(f.id) + '">Remove</button>') + '</div>';
    }).join('');
    var note = on && !files.length ? '<p class="muted-s">Ticked before uploads were added.</p>' : '';
    var act = ro ? '' : '<div class="uplact"><label class="btn" for="up-' + tid + '">' + (files.length ? 'Add another file' : 'Upload check') + '</label>'
      + '<input class="vh" id="up-' + tid + '" type="file" accept="application/pdf,image/*" data-upload="' + tid + '"><span class="muted-s" data-upstatus>PDF or photo, up to 15 MB</span></div>';
    return '<div class="chkrow upl' + (on ? ' done' : '') + '"><div class="uplin"><div class="uplhead"><span class="uplname">' + esc(label) + '</span>'
      + (on ? '<span class="pill ok">Completed &#10003;</span>' : '<span class="pill">Needs upload</span>') + '</div>' + list + note + act + '</div></div>';
  }
  function syncStage(id) {
    var c = state.cars.get(id); if (!c) return;
    var want = keyFromDone(c.done || {});
    if (want !== c.stage) upd(id, { stage: want }, { readyAt: want === 'ready' ? todayStr() : '' });
  }
  function doUpload(id, file, inp) {
    if (file.size > 15 * 1024 * 1024) { toast('That file is over 15 MB. Use a smaller file or a lower photo quality.'); inp.value = ''; return; }
    var st = inp.parentNode.querySelector('[data-upstatus]'); if (st) st.textContent = 'Uploading ' + file.name + '…';
    inp.disabled = true;
    state.pending++;
    fetch('/api/cars/' + id + '/checks', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 401) { signedOut('You were signed out. Please sign in again.'); throw { code: 'unauth' }; }
        if (res.status >= 300) throw { message: (res.data && res.data.error) || 'The upload failed. Try again.' };
        state.cars.set(id, res.data); toast('145 point check uploaded.'); syncStage(id);
      })
      .catch(function (ex) { if (!ex || ex.code !== 'unauth') toast((ex && ex.message) || 'The upload failed. Check your connection and try again.'); })
      .then(function () { state.pending--; render(); if (state.open === id) renderSheet(); });
  }
  function renderSheet() {
    var id = state.open, c = id && state.cars.get(id);
    if (!c) { if (id) closeCar(); return; }
    renderPrepChips(c);
    $('#m-plate').textContent = c.reg || 'No reg';
    $('#m-title').textContent = [c.make, c.model].filter(Boolean).join(' ') || 'Unnamed car';
    var curI = stageIdx(c);
    $('#m-track').className = 'segs';
    $('#m-track').innerHTML = STAGES.map(function (st, i) {
      var cls = stageDone(c, st) ? ' on' : (i === curI ? ' cur' : '');
      return '<div class="seg' + cls + '"><i></i><span>' + esc(st.s || st.l) + (cls === ' on' ? ' &#10003;' : '') + '</span></div>';
    }).join('');
    var d = carDays(c);
    $('#m-days').innerHTML = '<span>Now at <b>' + esc(STAGES[stageIdx(c)].l) + '</b></span><span><b class="num">' + d + '</b> ' + (stageKey(c) === 'ready' ? 'days from arrival to quality check' : 'days in prep, target ' + TARGET) + '</span><span>Arrived <b>' + esc(fmtDate(c.added)) + '</b></span><span><b class="num">' + doneCount(c) + '</b> of ' + TOTAL + ' tasks done</span>';
    $('#m-upd').textContent = c.updatedBy ? ('Last updated by ' + c.updatedBy + ', ' + new Date(c.updatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '';

    var ab = $('#m-arch'), arch = isArchived(c);
    ab.hidden = readOnly() || !(arch || isDone(c));
    ab.textContent = arch ? 'Restore from archive' : 'Archive car';

    var ae = document.activeElement, ax = ae && ae.dataset && ae.dataset.x, av = ax ? ae.value : null, ass = null, ase = null;
    if (ax) { try { ass = ae.selectionStart; ase = ae.selectionEnd; } catch (er) { /* number inputs */ } }
    $('#m-checks').innerHTML = STAGES.map(function (s) {
      var done = s.t.filter(function (t) { return (c.done || {})[s.k + '_' + t[0]] === true; }).length;
      var items = s.t.map(function (t) {
        var tid = s.k + '_' + t[0], on = (c.done || {})[tid] === true;
        if (t[3] === 'upload') return uploadRowHtml(c, tid, t[1], on);
        var x = t[2], ex = '', signed = '';
        if (x && x.type === 'note') {
          return '<div class="chkrow colrow"><label class="chk' + (on ? ' done' : '') + '"><input type="checkbox" data-t="' + tid + '"' + (on ? ' checked' : '') + '><span>' + esc(t[1]) + '</span></label>'
            + '<textarea class="field cosn" data-x="' + x.f + '" maxlength="1000" rows="3" placeholder="What cosmetic work is needed? e.g. scuffed rear bumper, door ding, wheel refurb" aria-label="' + esc(x.label) + '">' + esc(c[x.f] || '') + '</textarea></div>';
        }
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
      return '<details class="grp' + (s.k === stageKey(c) ? ' current' : '') + (complete ? ' complete' : '') + '" data-s="' + s.k + '"' + (state.expanded.has(s.k) ? ' open' : '') + '><summary><span>' + esc(s.l) + '</span><small class="num">' + (complete ? 'Complete &#10003;' : done + ' of ' + s.t.length) + '</small></summary><div class="checks">' + items + '</div></details>';
    }).join('');
    if (ax) {
      var ni = $('#m-checks [data-x="' + ax + '"]');
      if (ni) { ni.value = av; ni.focus(); if (ass != null) { try { ni.setSelectionRange(ass, ase); } catch (er) { /* ignore */ } } }
    }
    lockForRole();
  }

  /* ---------- events: list and car sheet ---------- */
  $('#tab-prep').addEventListener('click', function () { clearSearch(); state.tab = 'prep'; render(); });
  $('#tab-done').addEventListener('click', function () { clearSearch(); state.tab = 'done'; render(); });
  $('#tab-arch').addEventListener('click', function () { clearSearch(); state.tab = 'arch'; render(); });
  $('#dept').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-f]'); if (!b) return;
    var f = b.dataset.f;
    if (state.f === f) { state.f = f.indexOf('job:') === 0 ? 'need:body' : 'all'; render(); return; }
    clearSearch(); state.f = f; state.tab = 'prep'; render(); toList();
  });
  $('#stock').addEventListener('click', function (e) {
    if (e.target.id === 'f-clear') { state.f = 'all'; render(); }
    if (e.target.id === 'q-clear') { clearSearch(); render(); }
  });
  $('#q').addEventListener('input', function (e) { state.q = e.target.value; if (state.q.trim()) state.f = 'all'; render(); });
  function toList() {
    var el = $('#stock');
    try { el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(); }
  }
  function clearSearch() { state.q = ''; $('#q').value = ''; }
  $('#go').addEventListener('click', function () { state.q = $('#q').value; render(); toList(); });
  $('#q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); state.q = e.target.value; render(); toList(); try { e.target.blur(); } catch (er) { /* ignore */ } } });
  $('#list').addEventListener('click', function (e) {
    if (e.target.closest('[data-act="add"]')) { openNew(); return; }
    var b = e.target.closest('[data-open]'); if (b) openCar(b.dataset.open);
  });
  $('#add-btn').addEventListener('click', openNew);
  $('#m-close').addEventListener('click', closeCar);
  $('#ov-car').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeCar(); });
  // Short dates: show dd/mm/yy, store yyyy-mm-dd.
  function isoToShort(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[3] + '/' + m[2] + '/' + m[1].slice(2) : ''; }
  function shortToIso(d) {
    if (d.length !== 6 && d.length !== 8) return null;
    var dd = +d.slice(0, 2), mm = +d.slice(2, 4), yy = d.length === 6 ? 2000 + +d.slice(4) : +d.slice(4);
    var t = new Date(Date.UTC(yy, mm - 1, dd));
    if (t.getUTCFullYear() !== yy || t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return null;
    return yy + '-' + pad(mm) + '-' + pad(dd);
  }
  $('#m-fields').addEventListener('input', function (e) {
    var f = e.target.dataset.f; if (!f || !state.open) return;
    if (e.target.dataset.sd) {
      var dg = e.target.value.replace(/\D/g, '').slice(0, 8), fm = dg.slice(0, 2) + (dg.length > 2 ? '/' + dg.slice(2, 4) : '') + (dg.length > 4 ? '/' + dg.slice(4) : '');
      if (e.target.value !== fm) e.target.value = fm;
      e.target.setCustomValidity('');
      if (!dg) debounced(state.open, f, '');
      else { var iso = shortToIso(dg); if (iso) debounced(state.open, f, iso); }
      return;
    }
    var v = e.target.value;
    if (f === 'reg') { v = v.toUpperCase(); if (e.target.value !== v) e.target.value = v; }
    if (NUMERIC[f]) v = (v === '' ? null : Number(v));
    debounced(state.open, f, v);
  });
  $('#m-notes').addEventListener('input', function (e) { if (state.open) debounced(state.open, 'notes', e.target.value); });
  $('#m-checks').addEventListener('change', function (e) {
    var up = e.target.dataset && e.target.dataset.upload;
    if (up) { var f = e.target.files && e.target.files[0]; if (f && state.open) doUpload(state.open, f, e.target); return; }
    var t = e.target.dataset && e.target.dataset.t; if (!t || !state.open) return;
    var c = state.cars.get(state.open); if (!c) return;
    var o = { done: {} }; o.done[t] = e.target.checked;
    var item = findItem(t), spec = item && item[2];
    if (spec && spec.sign && e.target.checked && !c[spec.f]) o[spec.f] = state.user.initials;   // sign with the logged-in person's initials
    // The stage follows the ticks. Reaching Quality Check means prep is complete.
    var after = Object.assign({}, c.done, o.done), want = keyFromDone(after), extra = null;
    if (want !== c.stage) {
      o.stage = want; extra = { readyAt: want === 'ready' ? todayStr() : '' };
      if (want === 'ready' && stageKey(c) !== 'ready') toast('All areas complete. Moved to Completed.');
    }
    upd(state.open, o, extra);
  });
  $('#m-checks').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-rmfile]'); if (!b || !state.open) return;
    if (!b.classList.contains('armed')) {
      b.classList.add('armed'); b.textContent = 'Tap again to remove';
      setTimeout(function () { if (b.isConnected) { b.classList.remove('armed'); b.textContent = 'Remove'; } }, 4000);
      return;
    }
    var id = state.open; state.pending++;
    api('DELETE', '/api/files/' + b.dataset.rmfile).then(function (car) {
      if (car && car.id) { state.cars.set(id, car); syncStage(id); }
      toast('File removed.');
    }).catch(function (ex) { if (!ex || ex.code !== 'unauth') toast((ex && ex.message) || 'Could not remove that file.'); })
      .then(function () { state.pending--; render(); if (state.open === id) renderSheet(); });
  });
  $('#m-checks').addEventListener('input', function (e) {
    var f = e.target.dataset && e.target.dataset.x; if (!f || !state.open) return;
    var spec = findExtra(f); if (!spec) return;
    var v = e.target.value;
    if (spec.type === 'note') { debounced(state.open, f, v.slice(0, 1000)); return; }
    if (spec.type === 'number') v = (v === '' ? null : Number(v));
    else { v = v.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (e.target.value !== v) e.target.value = v; }
    debounced(state.open, f, v);
  });
  $('#m-checks').addEventListener('toggle', function (e) {
    var s = e.target.dataset && e.target.dataset.s; if (!s) return;
    if (e.target.open) state.expanded.add(s); else state.expanded.delete(s);
  }, true);

  $('#m-arch').addEventListener('click', function () {
    var id = state.open, c = id && state.cars.get(id); if (!c) return;
    var archive = !isArchived(c);
    upd(id, { archived: archive });
    if (archive) { closeCar(); toast('Car archived. Find it under Archived.'); } else toast('Car restored.');
  });

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
  $('#n-prep').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.pq'); if (!b) return;
    b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on'));
  });
  function openNew() { $('#n-form').reset(); Array.prototype.forEach.call($('#n-prep').querySelectorAll('.pq'), function (b) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }); $('#ov-new').hidden = false; $('#n-reg').focus(); }
  function closeNew() { $('#ov-new').hidden = true; }
  $('#n-close').addEventListener('click', closeNew);
  $('#ov-new').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeNew(); });
  $('#n-reg').addEventListener('input', function (e) { e.target.value = e.target.value.toUpperCase(); });
  $('#n-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var miles = $('#n-miles').value;
    var body = {
      reg: $('#n-reg').value, make: $('#n-make').value, model: $('#n-model').value,
      tag: $('#n-tag').value, mileage: miles === '' ? null : Number(miles),
      prep: Array.prototype.map.call($('#n-prep').querySelectorAll('.pq.on'), function (b) { return b.dataset.k; })
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
        + (me ? '' : '<select class="field" data-role aria-label="Role for ' + esc(u.display) + '">' + ROLE_ORDER.map(function (r) { return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + esc(roleLabel(r)) + '</option>'; }).join('') + '</select>')
        + '<button class="btn" type="button" data-resetpw>Set new password</button>'
        + (me ? '' : '<button class="btn ' + (u.active ? 'danger' : '') + '" type="button" data-toggle>' + (u.active ? 'Deactivate' : 'Reactivate') + '</button>')
        + (me || u.active ? '' : '<button class="btn danger" type="button" data-delete>Delete login</button>')
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
    } else if (e.target.closest('[data-delete]')) {
      var db = e.target.closest('[data-delete]');
      if (!db.classList.contains('armed')) {
        db.classList.add('armed'); db.textContent = 'Tap again to delete for good';
        setTimeout(function () { if (db.isConnected) { db.classList.remove('armed'); db.textContent = 'Delete login'; } }, 4000);
        return;
      }
      api('DELETE', '/api/users/' + id).then(function () { toast('Login deleted. Their past sign-offs stay on the cars.'); return loadUsers(); }).catch(function (ex) {
        if (ex && ex.code === 'unauth') return;
        toast((ex && ex.message) || 'Could not delete that login.'); loadUsers();
      });
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
      return { l: s.l, n: active.filter(function (c) { return stageKey(c) === s.k; }).length };
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

    var checksCard = '<section class="rp-card full"><h3>145 point checks</h3>'
      + '<label class="rp-pick" for="rp-q">Search by registration<input class="field" id="rp-q" type="search" placeholder="For example YB19 CYZ" autocomplete="off" value="' + esc(state.rpQ || '') + '"></label>'
      + '<div id="rp-checks">' + checksHtml() + '</div></section>';
    var hadFocus = document.activeElement && document.activeElement.id === 'rp-q', selEnd = hadFocus ? document.activeElement.selectionEnd : 0;
    $('#rp-body').innerHTML = tiles + '<div class="rp-grid" style="margin-top:14px">'
      + '<section class="rp-card full"><h3>Cars completed</h3>' + weekly + '</section>'
      + '<section class="rp-card"><h3>Where the stock is now</h3>' + byStage + '<p class="sub">' + active.length + ' cars in prep.</p></section>'
      + '<section class="rp-card"><h3>Time in each stage</h3>' + stageTime + '</section>'
      + '<section class="rp-card"><h3>Cars over target</h3>' + stuckHtml + '</section>'
      + '<section class="rp-card"><h3>Sent back to an earlier stage</h3>' + sent + '<p class="sub">' + backTotal + (backTotal === 1 ? ' move back' : ' moves back') + ' in total.</p></section>'
      + '<section class="rp-card full"><h3>Sign-offs and ticks by person</h3>' + people + '</section>'
      + cosmCards()
      + checksCard + '</div>';
    if (hadFocus) { var qi = $('#rp-q'); if (qi) { qi.focus(); try { qi.setSelectionRange(selEnd, selEnd); } catch (er) { /* ignore */ } } }
  }
  function normReg(x) { return String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function checksHtml() {
    var qn = normReg(state.rpQ), cars = [];
    state.cars.forEach(function (c, id) { cars.push(Object.assign({ id: id }, c)); });
    var hits = cars.filter(function (c) { return !qn || normReg(c.reg).indexOf(qn) >= 0; });
    var withF = hits.filter(function (c) { return (c.checks || []).length; }).sort(function (a, b) {
      var la = a.checks[a.checks.length - 1].at, lb = b.checks[b.checks.length - 1].at; return la < lb ? 1 : -1;
    });
    var without = qn ? hits.filter(function (c) { return !(c.checks || []).length; }) : [];
    var shown = qn ? withF : withF.slice(0, 20);
    function row(c, has) {
      var last = has ? c.checks[c.checks.length - 1] : null;
      var links = has ? c.checks.map(function (f, i) { return '<a class="flink" href="/api/files/' + esc(f.id) + '" target="_blank" rel="noopener" title="' + esc(f.name) + '">' + (c.checks.length > 1 ? 'File ' + (i + 1) : 'View check') + '</a>'; }).join('') : '';
      return '<div class="rp-row plain"><button type="button" class="rplink" data-open="' + esc(c.id) + '"><span class="l"><b>' + esc(c.reg) + ' ' + esc([c.make, c.model].filter(Boolean).join(' ')) + '</b><small>'
        + (has ? 'Uploaded ' + esc(fmtDate(last.at.slice(0, 10))) + ' by ' + esc(last.by) : 'No 145 point check uploaded') + '</small></span></button><span class="flinks">' + links + '</span></div>';
    }
    if (!qn) return '<p class="sub">Type a registration to find its 145 point check.</p>';
    var out = shown.map(function (c) { return row(c, true); }).concat(without.map(function (c) { return row(c, false); })).join('');
    if (!out) return '<p class="rp-empty">' + (qn ? 'No car matches that registration.' : 'No 145 point checks have been uploaded yet.') + '</p>';
    return '<div class="rp-list">' + out + '</div>' + (!qn && withF.length > 20 ? '<p class="sub">Showing the latest 20. Search by registration to find an older one.</p>' : '');
  }
  /* ---------- cosmetic prep lists (shown in Reports) ---------- */
  function cosmCards() {
    var cars = []; state.cars.forEach(function (c, id) { if (!isDone(c) && !isArchived(c)) cars.push(Object.assign({ id: id }, c)); });
    var tagOf = function (c) { return c.tag ? esc(c.tag) : '<span class="muted-s">No tag</span>'; };
    var byTag = function (a, b) { return String(a.tag || '~').localeCompare(String(b.tag || '~'), 'en', { numeric: true }); };
    var done = function (c, k) { return (c.done || {})[k] === true; };
    var name = function (c) { return esc(c.reg || 'No reg') + ' ' + esc([c.make, c.model].filter(Boolean).join(' ')); };
    var wheels = cars.filter(function (c) { return !done(c, 'body_wheels') && Number(c.bodyWheels) > 0; }).sort(byTag);
    var wtotal = wheels.reduce(function (n, c) { return n + Number(c.bodyWheels); }, 0);
    var PAINT = /paint|respray|spray|refinish|lacquer|colour match/i;
    var paint = cars.filter(function (c) { return !done(c, 'body_paint') && String(c.cosmeticNotes || '').trim(); })
      .sort(function (a, b) { return (PAINT.test(b.cosmeticNotes) - PAINT.test(a.cosmeticNotes)) || byTag(a, b); });
    var wh = '<div class="rp-card full"><h3>Alloy wheels to refine</h3><p class="sub">' + (wheels.length ? wtotal + ' wheel' + (wtotal === 1 ? '' : 's') + ' on ' + wheels.length + ' car' + (wheels.length === 1 ? '' : 's') : 'Nothing to do') + '</p>'
      + wheels.map(function (c) {
        var n = Number(c.bodyWheels);
        return '<button type="button" class="rp-row" data-open="' + c.id + '"><span class="l"><b>' + tagOf(c) + '</b><small>' + name(c) + '</small></span><span class="r">' + n + (n === 1 ? ' wheel' : ' wheels') + '</span></button>';
      }).join('') + '</div>';
    var pt = '<div class="rp-card full"><h3>Paint and cosmetic work</h3><p class="sub">' + (paint.length ? paint.length + ' car' + (paint.length === 1 ? '' : 's') + ' with notes and paint work not yet done. Cars whose notes mention paint are listed first.' : 'No cosmetic notes to show.') + '</p>'
      + paint.map(function (c) {
        var isP = PAINT.test(c.cosmeticNotes);
        return '<button type="button" class="rp-row cmrow" data-open="' + c.id + '"><span class="l"><b>' + tagOf(c) + (isP ? ' <span class="pill">Paint</span>' : '') + '</b><small>' + name(c) + '</small><span class="cmnote">' + esc(c.cosmeticNotes) + '</span></span></button>';
      }).join('') + '</div>';
    var open = state.rpBody, chip = function (k, label, n) {
      return '<button type="button" class="tab" data-rpb="' + k + '" aria-pressed="' + (open === k) + '" aria-selected="' + (open === k) + '">' + label + ' <span class="num">' + n + '</span></button>';
    };
    return '<section class="rp-card full"><h3>Outstanding bodywork</h3>'
      + '<div class="tabs rp-tabs" role="group" aria-label="Outstanding bodywork">' + chip('alloys', 'Alloys', wheels.length) + chip('cosmetics', 'Cosmetics', paint.length) + '</div>'
      + (open === 'alloys' ? wh.replace('rp-card full', 'rp-inner') : open === 'cosmetics' ? pt.replace('rp-card full', 'rp-inner') : '<p class="sub">Tap Alloys or Cosmetics to see what is outstanding on cars in prep.</p>')
      + '</section>';
  }
  function openReports() { $('#rp-target').textContent = TARGET; renderReports(); $('#ov-reports').hidden = false; $('#ov-reports .sheet').scrollTop = 0; $('#rp-close').focus(); }
  $('#rep-btn').addEventListener('click', openReports);
  $('#rp-close').addEventListener('click', function () { $('#ov-reports').hidden = true; });
  $('#rp-body').addEventListener('input', function (e) {
    if (e.target.id !== 'rp-q') return;
    state.rpQ = e.target.value; $('#rp-checks').innerHTML = checksHtml();
  });
  $('#rp-body').addEventListener('change', function (e) {
    if (e.target.dataset && e.target.dataset.rpm) { state.rpMonth = e.target.value; renderReports(); var m = $('#rp-month'); if (m) m.focus(); }
  });
  $('#rp-body').addEventListener('click', function (e) {
    var v = e.target.closest && e.target.closest('[data-rpv]');
    if (v) { state.rpView = v.dataset.rpv; renderReports(); return; }
    var rb = e.target.closest && e.target.closest('[data-rpb]');
    if (rb) { state.rpBody = state.rpBody === rb.dataset.rpb ? null : rb.dataset.rpb; renderReports(); return; }
    var b = e.target.closest && e.target.closest('[data-open]'); if (!b) return;
    $('#ov-reports').hidden = true; openCar(b.dataset.open);
  });

  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(function () { /* app still works in the browser */ }); }

  /* ---------- start ---------- */
  api('GET', '/api/session').then(function (s) {
    if (s.user) { state.user = s.user; startApp(); }
    else {
      showAuth(s.setup ? 'setup' : 'login');
      if (!s.setup && /[?&]next=guide\b/.test(location.search)) $('#auth-sub').textContent = 'Sign in to read the user guide.';
    }
  }).catch(function () {
    showAuth('login', 'Could not reach the server. Check your connection and reload.');
  });
})();
