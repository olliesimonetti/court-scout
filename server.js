const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── In-memory config & state ──────────────────────────────
let config = {
  venueUrl: '',
  ntfyTopic: '',
  preferredTimes: [],
  timeFrom: '',
  timeTo: '',
  courts: [],          // e.g. ["Court 1", "Court 2", "Centre Court"]
  intervalMin: 2,
  enabled: false
};

let state = {
  checkCount: 0,
  lastCheck: null,
  lastStatus: 'idle',
  lastMessage: 'Not started',
  knownSlots: {},
  log: []
};

let monitorTimer = null;

// ── Logging ───────────────────────────────────────────────
function addLog(msg, type) {
  const entry = { time: new Date().toLocaleTimeString('en-GB'), msg, type: type || 'info' };
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  console.log('[' + entry.time + '] ' + msg);
}

// ── ntfy notification ─────────────────────────────────────
async function sendNtfy(title, message) {
  if (!config.ntfyTopic) return false;
  try {
    const url = 'https://ntfy.sh/' + config.ntfyTopic +
      '?title=' + encodeURIComponent(title) +
      '&priority=urgent&tags=tennis,tada';
    await fetch(url, { method: 'POST', body: message });
    return true;
  } catch (e) {
    addLog('ntfy error: ' + e.message, 'error');
    return false;
  }
}

// ── Parse slots from HTML ─────────────────────────────────
function parseSlots(html) {
  const timeRx = /\b([01]?\d|2[0-3]):[0-5]\d\b/g;
  const slots = [];

  // Look for time patterns near available/bookable markers
  const chunks = html.split(/(<[^>]+>)/);
  let context = '';
  chunks.forEach(chunk => {
    context = (context + ' ' + chunk).slice(-300);
    if (/avail|bookable|book now|free/i.test(context)) {
      const matches = chunk.match(timeRx);
      if (matches) matches.forEach(t => slots.push(t));
    }
  });

  // Also try structured approach
  const structuredRx = /class="[^"]*(?:available|bookable|free|book-now)[^"]*"[^>]*>([^<]*([01]?\d|2[0-3]):[0-5]\d[^<]*)</gi;
  let m;
  while ((m = structuredRx.exec(html)) !== null) {
    const times = m[0].match(timeRx);
    if (times) times.forEach(t => slots.push(t));
  }

  // Deduplicate
  return [...new Set(slots)].sort();
}

// ── Check which courts are mentioned near a time slot ─────
function extractCourtInfo(html, slot) {
  // Look for court names/numbers near the slot time in the HTML
  const idx = html.indexOf(slot);
  if (idx === -1) return [];
  const window = html.slice(Math.max(0, idx - 500), idx + 500);
  const courtMatches = [];
  const courtRx = /court\s*(\d+|[a-z]+)/gi;
  let m;
  while ((m = courtRx.exec(window)) !== null) {
    courtMatches.push(m[0].trim());
  }
  return [...new Set(courtMatches)];
}

// ── Filter slots ──────────────────────────────────────────
function filterSlots(slots, html) {
  const toMin = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };

  return slots.filter(slot => {
    // Time range
    if (config.timeFrom && config.timeTo) {
      const sm = toMin(slot);
      if (sm < toMin(config.timeFrom) || sm > toMin(config.timeTo)) return false;
    }

    // Preferred specific times
    if (config.preferredTimes.length > 0) {
      const match = config.preferredTimes.some(pt => slot.substring(0,5) === pt.substring(0,5));
      if (!match) return false;
    }

    // Court filter
    if (config.courts.length > 0) {
      const nearbyCourtText = extractCourtInfo(html, slot).join(' ').toLowerCase();
      const matchesCourt = config.courts.some(c => nearbyCourtText.includes(c.toLowerCase()));
      if (!matchesCourt) return false;
    }

    return true;
  });
}

// ── Fetch booking page ────────────────────────────────────
async function fetchPage(url) {
  const proxies = [
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`
  ];

  for (let i = 0; i < proxies.length; i++) {
    try {
      const res = await fetch(proxies[i], { timeout: 15000 });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data.contents || data;
    } catch (e) {
      addLog('Proxy ' + (i+1) + ' failed: ' + e.message, 'warn');
    }
  }
  throw new Error('All proxies failed — venue may require login');
}

// ── Main check ────────────────────────────────────────────
async function doCheck() {
  if (!config.venueUrl) return;
  state.checkCount++;
  state.lastCheck = new Date().toISOString();
  state.lastStatus = 'watching';
  addLog('Fetching booking page…');

  try {
    const html = await fetchPage(config.venueUrl);
    const raw = parseSlots(html);
    addLog('Found ' + raw.length + ' time pattern(s) on page.');

    const filtered = filterSlots(raw, html);
    const newSlots = filtered.filter(s => !state.knownSlots[s]);

    if (newSlots.length > 0) {
      const msg = 'Slots open: ' + newSlots.join(', ') + '. Book now on ClubSpark!';
      addLog('🎾 ALERT: ' + newSlots.join(', '), 'alert');
      state.lastStatus = 'alert';
      state.lastMessage = '🎾 Court available: ' + newSlots.join(', ');
      const ok = await sendNtfy('🎾 Court Available!', msg);
      if (ok) addLog('📲 ntfy notification sent to ' + config.ntfyTopic, 'success');
      else addLog('⚠ ntfy send failed — check your topic name', 'warn');
      newSlots.forEach(s => { state.knownSlots[s] = true; });
    } else {
      addLog('No new matching slots. Watching… (check #' + state.checkCount + ')');
      state.lastStatus = 'watching';
      state.lastMessage = 'Watching — check #' + state.checkCount + ' done';
    }
  } catch (e) {
    addLog('Error: ' + e.message, 'error');
    state.lastStatus = 'error';
    state.lastMessage = 'Error: ' + e.message;
  }
}

// ── Monitor control ───────────────────────────────────────
function startMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  state.knownSlots = {};
  state.checkCount = 0;
  config.enabled = true;
  addLog('▶ Monitor started. Interval: ' + config.intervalMin + ' min.', 'success');
  doCheck();
  monitorTimer = setInterval(doCheck, config.intervalMin * 60 * 1000);
}

function stopMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  config.enabled = false;
  state.lastStatus = 'idle';
  state.lastMessage = 'Stopped';
  addLog('⏹ Monitor stopped.');
}

// ── API routes ────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ config, state: { ...state, log: state.log.slice(0, 50) } });
});

app.post('/api/config', (req, res) => {
  const wasEnabled = config.enabled;
  config = { ...config, ...req.body };
  addLog('Config updated.');
  if (wasEnabled) {
    addLog('Restarting monitor with new config…');
    startMonitor();
  }
  res.json({ ok: true });
});

app.post('/api/start', (req, res) => {
  if (!config.venueUrl) { res.json({ ok: false, error: 'No venue URL set' }); return; }
  startMonitor();
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  stopMonitor();
  res.json({ ok: true });
});

app.post('/api/test-ntfy', async (req, res) => {
  const { topic } = req.body;
  if (!topic) { res.json({ ok: false, error: 'No topic provided' }); return; }
  config.ntfyTopic = topic;
  const ok = await sendNtfy('🎾 Court Scout Test', 'Connection successful! You will be alerted here when courts become available.');
  res.json({ ok });
});

// ── Serve UI ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(UI_HTML);
});

// ── Keep-alive ping (prevents Render free tier sleep) ─────
setInterval(() => {
  fetch('http://localhost:' + PORT + '/api/status').catch(() => {});
}, 14 * 60 * 1000); // every 14 minutes

app.listen(PORT, () => {
  console.log('Court Scout running on port ' + PORT);
});

// ── UI HTML ───────────────────────────────────────────────
const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Court Scout</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{--lime:#a8d44a;--white:#f0ede8;--clay:#c8632a;--dark:#0e160c;--panel:#151e12;--panel2:#1a2517;--border:rgba(168,212,74,0.18);--muted:rgba(240,237,232,0.45);}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--dark);color:var(--white);font-family:'DM Sans',sans-serif;min-height:100vh;}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;background-image:linear-gradient(rgba(168,212,74,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(168,212,74,0.03) 1px,transparent 1px);background-size:56px 56px;}
.wrap{position:relative;z-index:1;max-width:780px;margin:0 auto;padding:36px 22px 80px;}
header{margin-bottom:32px;}
.logo{display:flex;align-items:center;gap:14px;margin-bottom:4px;}
.logo-icon{width:46px;height:46px;background:var(--lime);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:24px;}
h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(2.2rem,6vw,3.4rem);letter-spacing:.04em;line-height:1;}
h1 span{color:var(--lime);}
.tagline{font-family:'DM Mono',monospace;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:4px;}
.status-bar{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:13px 18px;margin-bottom:24px;font-family:'DM Mono',monospace;font-size:.8rem;}
.dot{width:8px;height:8px;border-radius:50%;background:#444;flex-shrink:0;transition:all .3s;}
.dot.watching{background:var(--lime);box-shadow:0 0 8px var(--lime);animation:pulse 2s infinite;}
.dot.alert{background:var(--clay);box-shadow:0 0 10px var(--clay);}
.dot.error{background:#e66;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
#status-text{flex:1;}
#chk{color:var(--muted);font-size:.73rem;}
.tabs{display:flex;border-bottom:1px solid var(--border);margin-bottom:20px;}
.tab{padding:11px 18px;cursor:pointer;font-family:'DM Mono',monospace;font-size:.76rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .2s,border-color .2s;user-select:none;}
.tab:hover{color:var(--white);}
.tab.active{color:var(--lime);border-bottom-color:var(--lime);}
.pane{display:none;}.pane.active{display:block;}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:22px;margin-bottom:16px;}
.clabel{font-family:'DM Mono',monospace;font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:var(--lime);margin-bottom:14px;display:flex;align-items:center;gap:10px;}
.clabel::after{content:'';flex:1;height:1px;background:var(--border);}
label{display:block;font-size:.79rem;color:var(--muted);margin-bottom:5px;font-family:'DM Mono',monospace;}
input[type=text],select{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(168,212,74,.22);border-radius:6px;color:var(--white);font-family:'DM Mono',monospace;font-size:.82rem;padding:10px 12px;margin-bottom:14px;outline:none;transition:border-color .2s;}
input:focus,select:focus{border-color:var(--lime);}
input::placeholder{color:rgba(240,237,232,.18);}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media(max-width:500px){.row2{grid-template-columns:1fr;}}
.cb-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;}
.cb-item{display:flex;align-items:center;gap:7px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:6px;padding:7px 11px;cursor:pointer;user-select:none;font-size:.8rem;transition:border-color .2s;}
.cb-item:hover{border-color:var(--lime);}
.cb-item input[type=checkbox]{display:none;}
.tick{width:13px;height:13px;border:1.5px solid rgba(168,212,74,.35);border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;transition:all .15s;}
.cb-item input[type=checkbox]:checked~.tick{background:var(--lime);border-color:var(--lime);color:var(--dark);}
.tags{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px;min-height:10px;}
.tag{background:rgba(168,212,74,.1);border:1px solid rgba(168,212,74,.28);border-radius:4px;padding:3px 9px;font-size:.76rem;font-family:'DM Mono',monospace;color:var(--lime);display:flex;align-items:center;gap:6px;}
.tag button{background:none;border:none;color:var(--lime);cursor:pointer;font-size:11px;opacity:.6;padding:0;}
.tag button:hover{opacity:1;}
.add-row{display:flex;gap:8px;align-items:center;margin-bottom:10px;}
.add-row input{margin:0;flex:1;}
.btn-sm{background:rgba(168,212,74,.12);border:1px solid var(--lime);border-radius:6px;color:var(--lime);padding:10px 14px;cursor:pointer;font-size:.8rem;font-family:'DM Mono',monospace;white-space:nowrap;transition:background .2s;}
.btn-sm:hover{background:rgba(168,212,74,.22);}
.btn-go{width:100%;background:var(--lime);border:none;border-radius:8px;color:var(--dark);font-family:'Bebas Neue',sans-serif;font-size:1.35rem;letter-spacing:.08em;padding:16px;cursor:pointer;transition:opacity .2s,transform .1s;}
.btn-go:hover{opacity:.88;transform:translateY(-1px);}
.btn-stop{width:100%;background:transparent;border:1px solid var(--clay);border-radius:8px;color:var(--clay);font-family:'Bebas Neue',sans-serif;font-size:1.35rem;letter-spacing:.08em;padding:16px;cursor:pointer;margin-top:10px;display:none;transition:background .2s;}
.btn-stop:hover{background:rgba(200,99,42,.1);}
.log-box{background:rgba(0,0,0,.35);border:1px solid var(--border);border-radius:8px;padding:13px;height:260px;overflow-y:auto;font-family:'DM Mono',monospace;font-size:.74rem;}
.le{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);}
.le:last-child{border:none;}
.lt{color:var(--muted);flex-shrink:0;}
.lm{color:var(--white);}
.le.success .lm{color:var(--lime);}
.le.warn .lm{color:#f0c040;}
.le.error .lm{color:#e66;}
.le.alert .lm{color:var(--clay);font-weight:600;}
.alert-banner{display:none;border:1px solid var(--clay);border-radius:10px;padding:20px 22px;margin-bottom:20px;background:linear-gradient(135deg,rgba(200,99,42,.18),rgba(168,212,74,.08));}
.alert-banner h3{font-family:'Bebas Neue',sans-serif;font-size:1.7rem;color:var(--lime);margin-bottom:6px;letter-spacing:.04em;}
.slot-pill{display:inline-block;background:rgba(168,212,74,.14);border:1px solid var(--lime);border-radius:4px;padding:3px 9px;font-family:'DM Mono',monospace;font-size:.76rem;color:var(--lime);margin:3px;}
.field-row{display:flex;gap:8px;align-items:center;margin-top:8px;}
.field-row input{margin:0;flex:1;}
.btn-test{background:rgba(91,200,245,.1);border:1px solid #5bc8f5;color:#5bc8f5;border-radius:6px;padding:10px 14px;font-family:'DM Mono',monospace;font-size:.77rem;cursor:pointer;white-space:nowrap;transition:background .2s;}
.btn-test:hover{background:rgba(91,200,245,.2);}
.tresult{margin-top:8px;font-family:'DM Mono',monospace;font-size:.75rem;color:var(--muted);min-height:18px;line-height:1.5;}
.hint{font-size:.75rem;color:var(--muted);line-height:1.6;margin-top:-8px;margin-bottom:14px;}
a{color:var(--lime);}
code{background:rgba(168,212,74,.1);border:1px solid rgba(168,212,74,.22);border-radius:3px;padding:1px 5px;font-family:'DM Mono',monospace;font-size:.8em;color:var(--lime);}
.step{display:flex;gap:12px;margin-bottom:12px;font-size:.82rem;color:rgba(240,237,232,.82);line-height:1.55;}
.sn{width:22px;height:22px;border-radius:50%;background:var(--lime);color:var(--dark);font-size:.68rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;font-family:'DM Mono',monospace;}
.server-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(168,212,74,.1);border:1px solid var(--border);border-radius:6px;padding:6px 12px;font-family:'DM Mono',monospace;font-size:.73rem;color:var(--lime);margin-bottom:16px;}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">
      <div class="logo-icon">🎾</div>
      <div>
        <h1>Court <span>Scout</span></h1>
        <p class="tagline">ClubSpark — 24/7 Server Monitor</p>
      </div>
    </div>
  </header>

  <div class="alert-banner" id="alert-banner">
    <h3>🎾 Court Available!</h3>
    <p style="font-size:.85rem;margin-bottom:8px;" id="alert-desc"></p>
    <div id="alert-slots"></div>
  </div>

  <div class="status-bar">
    <div class="dot" id="dot"></div>
    <span id="status-text">Loading…</span>
    <span id="chk"></span>
  </div>

  <div class="tabs">
    <div class="tab active" id="tb-monitor">⚙ Monitor</div>
    <div class="tab" id="tb-courts">🎾 Courts</div>
    <div class="tab" id="tb-alerts">📲 Alerts</div>
    <div class="tab" id="tb-log">📋 Log</div>
  </div>

  <!-- MONITOR -->
  <div class="pane active" id="pn-monitor">
    <div class="server-badge">🟢 Running on server — works 24/7 even when your device is off</div>
    <div class="card">
      <div class="clabel">Venue</div>
      <label>ClubSpark booking page URL</label>
      <input type="text" id="venue-url" placeholder="https://clubspark.lta.org.uk/YourClub/Booking/BookByDate">
      <p class="hint">Navigate to your club on clubspark.lta.org.uk → Book a Court → copy the URL from your browser.</p>
    </div>
    <div class="card">
      <div class="clabel">Time Preferences</div>
      <label>Preferred slot times (leave empty = any time)</label>
      <div class="add-row">
        <input type="text" id="time-input" placeholder="e.g. 18:00, 19:30" style="margin:0">
        <button class="btn-sm" id="btn-add-time">+ Add</button>
      </div>
      <div class="tags" id="time-tags"></div>
      <div class="row2">
        <div><label>Earliest</label><input type="text" id="time-from" placeholder="07:00"></div>
        <div><label>Latest</label><input type="text" id="time-to" placeholder="22:00"></div>
      </div>
    </div>
    <div class="card">
      <div class="clabel">Check Frequency</div>
      <div class="row2">
        <div>
          <label>Check every</label>
          <select id="interval">
            <option value="1">1 minute</option>
            <option value="2" selected>2 minutes</option>
            <option value="5">5 minutes</option>
            <option value="10">10 minutes</option>
          </select>
        </div>
      </div>
    </div>
    <button class="btn-go" id="btn-start">🎾 Save &amp; Start Watching</button>
    <button class="btn-stop" id="btn-stop">⏹ Stop Watching</button>
  </div>

  <!-- COURTS -->
  <div class="pane" id="pn-courts">
    <div class="card">
      <div class="clabel">Court Filter</div>
      <p style="font-size:.82rem;color:var(--muted);margin-bottom:16px;line-height:1.6;">
        Add the courts you want to be alerted for. Use the exact name or number as shown on the ClubSpark booking page (e.g. <code>Court 1</code>, <code>Centre Court</code>). Leave empty to alert for any court.
      </p>
      <label>Add a court</label>
      <div class="add-row">
        <input type="text" id="court-input" placeholder="e.g. Court 1" style="margin:0">
        <button class="btn-sm" id="btn-add-court">+ Add</button>
      </div>
      <div class="tags" id="court-tags"></div>
      <p class="hint" style="margin-top:8px;">Not sure of the names? Leave this empty for now — Court Scout will alert you for any available slot, and you can add filters later once you've seen the booking page.</p>
    </div>
  </div>

  <!-- ALERTS -->
  <div class="pane" id="pn-alerts">
    <div class="card">
      <div class="clabel">ntfy.sh Push Notification</div>
      <div class="step"><div class="sn">1</div><div>Install the free <strong>ntfy</strong> app on your phone — <a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank">iOS</a> or <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank">Android</a>.</div></div>
      <div class="step"><div class="sn">2</div><div>Open the app, tap <strong>+</strong> and subscribe to a unique topic name like <code>courtscout-yourname</code>.</div></div>
      <div class="step"><div class="sn">3</div><div>Paste the topic name below and hit Test — your phone should buzz within seconds.</div></div>
      <div class="field-row">
        <input type="text" id="ntfy-topic" placeholder="e.g. courtscout-james" style="margin:0">
        <button class="btn-test" id="btn-ntfy-test">Test</button>
      </div>
      <div class="tresult" id="ntfy-result"></div>
    </div>
  </div>

  <!-- LOG -->
  <div class="pane" id="pn-log">
    <div class="card">
      <div class="clabel">Activity Log</div>
      <div class="log-box" id="log"></div>
    </div>
  </div>
</div>

<script>
(function(){
  var preferredTimes = [], courts = [];

  // Tabs
  var tabMap = {monitor:'pn-monitor',courts:'pn-courts',alerts:'pn-alerts',log:'pn-log'};
  Object.keys(tabMap).forEach(function(k){
    document.getElementById('tb-'+k).addEventListener('click',function(){ switchTab(k); });
  });
  function switchTab(name){
    Object.keys(tabMap).forEach(function(k){
      document.getElementById('tb-'+k).classList.toggle('active',k===name);
      document.getElementById(tabMap[k]).classList.toggle('active',k===name);
    });
  }

  // Tags helper
  function renderTags(containerId, items, removeFn){
    var el=document.getElementById(containerId);
    el.innerHTML=items.map(function(t){
      return '<div class="tag">'+t+'<button data-v="'+t+'">✕</button></div>';
    }).join('');
    el.querySelectorAll('button[data-v]').forEach(function(btn){
      btn.addEventListener('click',function(){ removeFn(btn.getAttribute('data-v')); });
    });
  }

  // Time tags
  document.getElementById('btn-add-time').addEventListener('click',function(){
    var val=document.getElementById('time-input').value.trim();
    if(!val) return;
    val.split(',').map(function(t){return t.trim();}).filter(Boolean).forEach(function(t){
      if(preferredTimes.indexOf(t)===-1) preferredTimes.push(t);
    });
    document.getElementById('time-input').value='';
    renderTags('time-tags',preferredTimes,function(t){ preferredTimes=preferredTimes.filter(function(x){return x!==t;}); renderTags('time-tags',preferredTimes,arguments.callee); });
  });

  // Court tags
  document.getElementById('btn-add-court').addEventListener('click',function(){
    var val=document.getElementById('court-input').value.trim();
    if(!val) return;
    if(courts.indexOf(val)===-1) courts.push(val);
    document.getElementById('court-input').value='';
    renderTags('court-tags',courts,function(c){ courts=courts.filter(function(x){return x!==c;}); renderTags('court-tags',courts,arguments.callee); });
  });

  // ntfy test
  document.getElementById('btn-ntfy-test').addEventListener('click',function(){
    var el=document.getElementById('ntfy-result');
    var topic=document.getElementById('ntfy-topic').value.trim();
    if(!topic){el.style.color='#e66';el.textContent='✗ Enter a topic name first.';return;}
    el.style.color='var(--muted)';el.textContent='Sending…';
    fetch('/api/test-ntfy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:topic})})
      .then(function(r){return r.json();})
      .then(function(d){
        el.style.color=d.ok?'var(--lime)':'#e66';
        el.textContent=d.ok?'✓ Sent! Check your phone. If nothing arrives, check the topic name matches exactly.':'✗ Failed — check topic name and internet.';
      });
  });

  // Save config helper
  function saveConfig(extra){
    var cfg=Object.assign({
      venueUrl:document.getElementById('venue-url').value.trim(),
      ntfyTopic:document.getElementById('ntfy-topic').value.trim(),
      preferredTimes:preferredTimes,
      timeFrom:document.getElementById('time-from').value.trim(),
      timeTo:document.getElementById('time-to').value.trim(),
      courts:courts,
      intervalMin:parseInt(document.getElementById('interval').value)
    }, extra||{});
    return fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
  }

  // Start
  document.getElementById('btn-start').addEventListener('click',function(){
    var url=document.getElementById('venue-url').value.trim();
    if(!url){alert('Please enter your ClubSpark venue URL.');return;}
    saveConfig().then(function(){
      return fetch('/api/start',{method:'POST'});
    }).then(function(r){return r.json();}).then(function(d){
      if(!d.ok){alert('Error: '+d.error);return;}
      document.getElementById('btn-start').style.display='none';
      document.getElementById('btn-stop').style.display='block';
    });
  });

  // Stop
  document.getElementById('btn-stop').addEventListener('click',function(){
    fetch('/api/stop',{method:'POST'}).then(function(){
      document.getElementById('btn-start').style.display='block';
      document.getElementById('btn-stop').style.display='none';
    });
  });

  // Poll status every 5s
  function loadStatus(){
    fetch('/api/status').then(function(r){return r.json();}).then(function(d){
      var s=d.state, c=d.config;
      var dot=document.getElementById('dot');
      dot.className='dot '+(s.lastStatus||'');
      document.getElementById('status-text').textContent=s.lastMessage||'Ready';
      document.getElementById('chk').textContent=s.checkCount>0?s.checkCount+' check'+(s.checkCount!==1?'s':''):'';

      // Restore fields
      if(c.venueUrl) document.getElementById('venue-url').value=c.venueUrl;
      if(c.ntfyTopic) document.getElementById('ntfy-topic').value=c.ntfyTopic;
      if(c.timeFrom) document.getElementById('time-from').value=c.timeFrom;
      if(c.timeTo) document.getElementById('time-to').value=c.timeTo;
      if(c.intervalMin) document.getElementById('interval').value=c.intervalMin;
      if(c.preferredTimes&&c.preferredTimes.length){ preferredTimes=c.preferredTimes; renderTags('time-tags',preferredTimes,function(t){preferredTimes=preferredTimes.filter(function(x){return x!==t;});renderTags('time-tags',preferredTimes,arguments.callee);}); }
      if(c.courts&&c.courts.length){ courts=c.courts; renderTags('court-tags',courts,function(t){courts=courts.filter(function(x){return x!==t;});renderTags('court-tags',courts,arguments.callee);}); }

      if(c.enabled){
        document.getElementById('btn-start').style.display='none';
        document.getElementById('btn-stop').style.display='block';
      }

      // Alert banner
      if(s.lastStatus==='alert'){
        var banner=document.getElementById('alert-banner');
        banner.style.display='block';
        document.getElementById('alert-desc').textContent=s.lastMessage;
      }

      // Log
      var logEl=document.getElementById('log');
      logEl.innerHTML=s.log.map(function(e){
        return '<div class="le '+(e.type||'')+'"><span class="lt">'+e.time+'</span><span class="lm">'+e.msg+'</span></div>';
      }).join('');
    }).catch(function(){});
  }

  loadStatus();
  setInterval(loadStatus, 5000);
})();
</script>
</body>
</html>`;
