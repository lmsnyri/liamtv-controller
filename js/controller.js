/* LiamTV phone controller. Connects to the TV's WebRTC room (PeerJS handshake, then a
   direct data channel over Wi-Fi) and acts as a remote for the launcher or as a gamepad
   for the emulator. No install, no account: open the page, type the code on the TV. */
(function () {
  var PREFIX = 'liamtv-';
  var SIGNALING = null;                 // keep in sync with data/tiles.js remote.signaling
  var $ = function (id) { return document.getElementById(id); };
  var peer = null, conn = null, code = '', state = {}, me = { player: 0 };
  var manualView = null, lastPong = 0, missedPongs = 0, hbTimer = null, retryTimer = null, retryMs = 2500, wantConnect = false;
  var held = {}, toastTimer, wakeLock = null, lastPing = 0;

  function get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2000); }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 10); } catch (e) { } }

  /* ----- views ----- */
  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
  }
  function autoView() {
    if (!conn || !conn.open) { showView('connect'); return; }
    showView(manualView || (state.screen === 'play' ? 'pad' : 'remote'));
  }
  document.querySelectorAll('[data-view]').forEach(function (b) {
    b.addEventListener('click', function () { manualView = b.getAttribute('data-view'); autoView(); });
  });
  $('btn-leave').addEventListener('click', function () { if (window.PC_MODE) { retryMs = 1500; connect(); return; } wantConnect = false; disconnect(); set('ctl.code', ''); $('code').value = ''; showView('connect'); setStatus(''); });

  /* ----- connection ----- */
  window.__log = [];
  function dbg(text) { window.__log.push(new Date().toISOString().slice(11, 19) + ' ' + text); if (window.__log.length > 60) window.__log.shift(); }
  function setStatus(text, cls) {
    dbg(text);
    var s = $('connect-status'); s.textContent = text; s.className = 'status ' + (cls || '');
    var sub = text || 'Connected'; if (me.player) sub = 'Player ' + me.player + ' · ' + sub;
    $('r-sub').textContent = sub; $('r-sub').className = cls || '';
    $('p-sub').textContent = (state.game ? state.game + ' · ' : '') + (me.player ? 'Player ' + me.player : 'watching');
  }
  function disconnect() {
    dbg('disconnect()');
    clearInterval(hbTimer); clearTimeout(retryTimer);
    // Null the module vars first: PeerJS fires 'close'/'disconnected' synchronously inside close()/destroy(),
    // and those handlers must not treat our own teardown as a lost TV (that made a reconnect loop).
    var c = conn, p = peer; conn = null; peer = null;
    if (c) { try { c.close(); } catch (e) { } }
    if (p) { try { p.destroy(); } catch (e) { } }
  }
  function scheduleRetry(why) {
    if (!wantConnect) return;
    clearTimeout(retryTimer);
    setStatus(why + ' · retrying…', 'bad');
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(15000, retryMs * 1.5);
  }
  /* PC mode (page served by the gaming PC's phone-pad bridge): plain WebSocket, no room code. */
  function connectPC() {
    wantConnect = true;
    disconnect();
    setStatus('Connecting to the PC…');
    var sock;
    try { sock = new WebSocket(PC_MODE.wsUrl); } catch (e) { scheduleRetry('No connection'); return; }
    var c = { open: false, send: function (m) { sock.send(JSON.stringify(m)); }, close: function () { try { sock.close(); } catch (e) { } } };
    var timeout = setTimeout(function () { if (!c.open) { c.close(); scheduleRetry('PC not answering'); } }, 8000);
    sock.onopen = function () {
      c.open = true; clearTimeout(timeout); clearTimeout(retryTimer); conn = c; retryMs = 2500;
      c.send({ t: 'hello', name: $('name').value.trim() || 'Phone', v: 1 });
      setStatus('Connected', 'ok'); buzz(20); keepAwake();
      lastPong = Date.now(); missedPongs = 0;
      clearInterval(hbTimer); hbTimer = setInterval(heartbeat, 2000);
    };
    sock.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (err) { return; } onData(m); };
    sock.onclose = function () { dbg('ws close'); if (conn === c) { conn = null; clearInterval(hbTimer); autoView(); scheduleRetry('PC went away'); } };
    sock.onerror = function () { dbg('ws error'); };
  }
  function connect() {
    if (window.PC_MODE) return connectPC();
    if (!code) return;
    wantConnect = true;
    disconnect();
    if (typeof Peer !== 'function') { setStatus('Could not load the connection library. Internet needed once.', 'bad'); retryTimer = setTimeout(function () { location.reload(); }, 8000); return; }
    setStatus('Finding TV ' + code + '…');
    var opts = { debug: 1 };
    if (SIGNALING) for (var k in SIGNALING) opts[k] = SIGNALING[k];
    var p = peer = new Peer(opts);
    var opened = false;
    var timeout = setTimeout(function () { if (!opened && peer === p) scheduleRetry('TV not answering'); }, 12000);
    p.on('open', function () {
      var c = p.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      c.on('open', function () {
        if (peer !== p) return;
        opened = true; clearTimeout(timeout); clearTimeout(retryTimer); conn = c; retryMs = 2500;
        c.send({ t: 'hello', name: $('name').value.trim() || 'Phone', v: 1 });
        setStatus('Connected', 'ok'); buzz(20); keepAwake();
        lastPong = Date.now(); missedPongs = 0;
        clearInterval(hbTimer);
        hbTimer = setInterval(heartbeat, 2000);
      });
      c.on('data', onData);
      c.on('close', function () { dbg('conn close'); if (conn === c) { conn = null; clearInterval(hbTimer); autoView(); scheduleRetry('TV went away'); } });
      c.on('error', function (e) { dbg('conn error ' + (e && (e.type || e.message))); console.warn('conn error', e); });
      c.on('iceStateChanged', function (st) { dbg('ice ' + st); });
    });
    p.on('error', function (err) {
      if (peer !== p) return;
      var type = err && err.type;
      clearTimeout(timeout);
      if (type === 'peer-unavailable') { retryMs = Math.max(retryMs, 5000); scheduleRetry('No TV with code ' + code + ' (is LiamTV open?)'); }
      else scheduleRetry('Connection problem (' + (type || 'network') + ')');
    });
    p.on('disconnected', function () { dbg('peer disconnected'); if (peer === p && !conn) scheduleRetry('Lost the handshake service'); });
    p.on('close', function () { dbg('peer close'); });
  }
  function heartbeat() {
    if (!conn || !conn.open) return;
    // Count pings that got no answer (robust to a browser throttling our timer in the background).
    if (lastPong < lastPing) { if (++missedPongs >= 3) { console.warn('no pong, reconnecting'); scheduleRetry('TV stopped answering'); return; } }
    else missedPongs = 0;
    lastPing = Date.now();
    send({ t: 'ping', ts: lastPing });
    if (document.querySelector('#view-pad.active')) sendPad();   // snapshot resend: a dropped message never leaves a button stuck
  }
  function send(msg) { if (conn && conn.open) try { conn.send(msg); } catch (e) { } }

  function onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'pong') { lastPong = Date.now(); return; }
    if (msg.t === 'toast' && msg.text) { toast(String(msg.text)); return; }
    if (msg.t === 'welcome') {
      me.player = msg.player | 0;
      if (msg.title) { $('r-title').textContent = msg.title; document.title = msg.title + ' Controller'; }
      if (Array.isArray(msg.apps)) renderApps(msg.apps);
      lastPong = Date.now();
    }
    if (msg.t === 'welcome' || msg.t === 'state') {
      var wasScreen = state.screen;
      state = msg;
      if (Array.isArray(msg.games)) renderGames(msg.games);
      if (wasScreen !== msg.screen) { manualView = null; if (msg.screen !== 'play') held = {}; }   // TV changed screens: follow it, release buttons
      setStatus('Connected', 'ok');
      autoView();
    }
  }

  function renderApps(apps) {
    var box = $('apps'); box.textContent = '';
    apps.forEach(function (a) {
      var b = document.createElement('button'); b.className = 'app';
      b.style.background = a.bg || '#1f2434';
      if (a.logo) {   // the TV sends the same wordmark it shows on its own dock
        var img = document.createElement('img'); img.alt = a.name; img.src = a.logo;
        img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); b.textContent = a.name; };
        b.appendChild(img);
      } else b.textContent = a.name;
      var light = /^#(f|e)[0-9a-f]{5}$/i.test(a.bg || '') || /^#fff$/i.test(a.bg || '');
      b.style.color = light ? '#111' : (a.fg || '#fff');
      b.addEventListener('click', function () { send({ t: 'launch', name: a.name }); buzz(); toast('Opening ' + a.name + ' on the TV'); });
      box.appendChild(b);
    });
  }
  function renderGames(names) {
    var box = $('games'); box.textContent = '';
    if (!names.length) return;
    var h = document.createElement('h3'); h.textContent = 'Games on the TV'; box.appendChild(h);
    names.forEach(function (n) {
      var b = document.createElement('button'); b.textContent = n;
      var s = document.createElement('span'); s.textContent = 'play'; b.appendChild(s);
      b.addEventListener('click', function () { send({ t: 'play', name: n }); buzz(); toast('Starting ' + n); });
      box.appendChild(b);
    });
  }

  /* ----- one-shot keys (remote view): fire on touch down, repeat while held ----- */
  var repeatTimers = {};
  function oneShot(el, down) {
    var key = el.getAttribute('data-key'), vol = el.getAttribute('data-vol');
    var fire = function () { if (key) send({ t: 'key', k: key }); else if (vol != null) send({ t: 'vol', d: +vol }); };
    var id = key || ('vol' + vol);
    if (down) {
      el.classList.add('pressed'); fire(); buzz();
      if (el.getAttribute('data-repeat')) {
        clearTimeout(repeatTimers[id]);
        repeatTimers[id] = setTimeout(function rep() { fire(); repeatTimers[id] = setTimeout(rep, 160); }, 420);
      }
    } else { el.classList.remove('pressed'); clearTimeout(repeatTimers[id]); }
  }

  /* ----- gamepad: every active touch → set of pressed buttons → snapshot to the TV ----- */
  var touches = {};   // touch id → element
  function padFromTouches() {
    var next = {};
    Object.keys(touches).forEach(function (id) {
      var el = touches[id]; if (!el) return;
      String(el.getAttribute('data-btn')).split(' ').forEach(function (n) { if (n) next[n] = true; });
    });
    return next;
  }
  function sendPad() { send({ t: 'pad', b: held }); }
  function updatePad() {
    var next = padFromTouches(), changed = false;
    Object.keys(next).concat(Object.keys(held)).forEach(function (k) { if (!!next[k] !== !!held[k]) changed = true; });
    if (!changed) return;
    held = next; sendPad(); buzz(6);
    document.querySelectorAll('[data-btn]').forEach(function (b) {
      var names = String(b.getAttribute('data-btn')).split(' ');
      b.classList.toggle('pressed', names.every(function (n) { return held[n]; }));
    });
  }
  function target(x, y) {
    var el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest('[data-btn]') : null;
  }

  var padView = $('view-pad');
  padView.addEventListener('touchstart', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) { var t = e.changedTouches[i]; var el = target(t.clientX, t.clientY); if (el) { touches[t.identifier] = el; e.preventDefault(); } }
    updatePad();
  }, { passive: false });
  padView.addEventListener('touchmove', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) { var t = e.changedTouches[i]; if (t.identifier in touches) { touches[t.identifier] = target(t.clientX, t.clientY); e.preventDefault(); } }
    updatePad();
  }, { passive: false });
  function endTouch(e) {
    for (var i = 0; i < e.changedTouches.length; i++) delete touches[e.changedTouches[i].identifier];
    updatePad();
  }
  padView.addEventListener('touchend', endTouch); padView.addEventListener('touchcancel', endTouch);
  // Anything that ends a gesture globally releases every one-shot key (no stuck repeats).
  function releaseAll() {
    document.querySelectorAll('[data-key].pressed, [data-vol].pressed').forEach(function (el) { oneShot(el, false); });
  }
  window.addEventListener('mouseup', releaseAll); window.addEventListener('blur', releaseAll);
  document.addEventListener('touchend', releaseAll, true); document.addEventListener('touchcancel', releaseAll, true);
  // mouse fallback (desktop testing)
  padView.addEventListener('mousedown', function (e) { var el = target(e.clientX, e.clientY); if (el) { touches.mouse = el; updatePad(); } });
  window.addEventListener('mouseup', function () { if (touches.mouse) { delete touches.mouse; updatePad(); } });

  // remote-view keys: touch or mouse
  document.querySelectorAll('[data-key], [data-vol]').forEach(function (el) {
    if (el.closest('.bar')) {   // header chips: plain click (Exit game)
      el.addEventListener('click', function () { oneShot(el, true); setTimeout(function () { oneShot(el, false); }, 120); });
      return;
    }
    el.addEventListener('touchstart', function (e) { e.preventDefault(); oneShot(el, true); }, { passive: false });
    el.addEventListener('touchend', function (e) { e.preventDefault(); oneShot(el, false); }, { passive: false });
    el.addEventListener('touchcancel', function () { oneShot(el, false); });
    el.addEventListener('mousedown', function () { oneShot(el, true); });
    el.addEventListener('mouseup', function () { oneShot(el, false); });
    el.addEventListener('mouseleave', function () { oneShot(el, false); });
  });

  /* ----- keep the screen on, survive backgrounding ----- */
  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () { });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { held = {}; touches = {}; releaseAll(); sendPad(); document.querySelectorAll('[data-btn].pressed').forEach(function (b) { b.classList.remove('pressed'); }); return; }
    if (wantConnect && (!conn || !conn.open)) { retryMs = 1500; connect(); }
    else if (conn && conn.open) { keepAwake(); sendPad(); }
  });

  /* ----- full screen: Add to Home Screen on iPhone; the Fullscreen API where it exists ----- */
  var standalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  var tip = $('tip-fullscreen');
  if (standalone || get('ctl.tip', '') === 'off') tip.hidden = true;
  $('tip-close').addEventListener('click', function () { tip.hidden = true; set('ctl.tip', 'off'); });
  var fsBtn = $('btn-fullscreen'), root = document.documentElement;
  var canFs = !standalone && !!(root.requestFullscreen || root.webkitRequestFullscreen);
  if (canFs) fsBtn.hidden = false;
  fsBtn.addEventListener('click', function () {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    var p = (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    if (p && p.then) p.then(function () { try { screen.orientation.lock('landscape').catch(function () { }); } catch (e) { } }).catch(function () { toast('Full screen is not available in this browser'); });
  });

  /* ----- TV remote <-> PC gamepad switch, PC power ----- */
  if (window.PC_MODE) {
    $('btn-to-tv').hidden = false; $('btn-power').hidden = false; $('btn-to-pc').hidden = true; $('link-to-pc').hidden = true;
  }
  var armed = null, armTimer = null;
  function disarm() { armed = null; clearTimeout(armTimer); document.querySelectorAll('[data-power]').forEach(function (b) { b.classList.remove('armed'); b.textContent = b.getAttribute('data-label'); }); }
  document.querySelectorAll('[data-power]').forEach(function (b) {
    b.setAttribute('data-label', b.textContent);
    b.addEventListener('click', function () {
      var act = b.getAttribute('data-power');
      if (armed !== act) { disarm(); armed = act; b.classList.add('armed'); b.textContent = 'Tap again to ' + b.getAttribute('data-label').toLowerCase(); armTimer = setTimeout(disarm, 4000); buzz(15); return; }
      disarm(); $('power-sheet').hidden = true;
      if (!conn || !conn.open) { toast('Not connected to the PC'); return; }
      send({ t: 'power', action: act }); buzz(40);
    });
  });
  $('btn-power').addEventListener('click', function () { disarm(); $('power-sheet').hidden = false; });
  $('power-cancel').addEventListener('click', function () { disarm(); $('power-sheet').hidden = true; });
  $('power-sheet').addEventListener('click', function (e) { if (e.target === $('power-sheet')) { disarm(); $('power-sheet').hidden = true; } });
  // the power sheet and links must not be swallowed by the gamepad's touch handling
  ['power-sheet', 'btn-to-tv', 'btn-power', 'btn-to-pc'].forEach(function (id) { $(id).addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true }); });

  /* ----- connect screen ----- */
  function readCode() { return $('code').value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 4); }
  $('code').addEventListener('input', function () { var v = readCode(); if ($('code').value !== v) $('code').value = v; if (v.length === 4) { $('code').blur(); start(); } });
  $('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
  $('btn-connect').addEventListener('click', start);
  $('name').addEventListener('change', function () { set('ctl.name', $('name').value.trim()); });
  function start() {
    var v = readCode();
    if (v.length !== 4) { setStatus('The code is 4 letters or digits', 'bad'); return; }
    code = v; set('ctl.code', code); set('ctl.name', $('name').value.trim());
    retryMs = 2500; connect();
  }

  var fromUrl = (/[?&]c=([a-z0-9]{4})/i.exec(location.search) || [])[1];
  $('name').value = get('ctl.name', '');
  if (window.PC_MODE) {               // served by the PC: no code, straight to the gamepad
    code = 'PC'; $('code').value = 'PC';
    if (!$('name').value) { $('name').value = 'Phone ' + Math.floor(Math.random() * 90 + 10); set('ctl.name', $('name').value); }
    showView('connect'); setStatus('Connecting to the PC…');
    connect();
  } else {
    $('code').value = (fromUrl || get('ctl.code', '')).toUpperCase();
    showView('connect');
    if ($('code').value.length === 4) start();
  }
})();
