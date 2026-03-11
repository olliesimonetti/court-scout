const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Config & state ────────────────────────────────────────
let config = {
  venueUrl: '',
  cookies: '',
  ntfyTopic: '',
  preferredTimes: [],
  timeFrom: '',
  timeTo: '',
  courts: [],
  daysAhead: 7,
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
  const entry = {
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    msg,
    type: type || 'info'
  };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log('[' + entry.time + '] [' + (type || 'info') + '] ' + msg);
}

// ── ntfy ──────────────────────────────────────────────────
async function sendNtfy(title, message, topic) {
  const t = (topic || config.ntfyTopic || '').trim();
  if (!t) { addLog('ntfy: no topic configured', 'warn'); return false; }
  try {
    addLog('Sending ntfy to topic: ' + t);
    const url = 'https://ntfy.sh/' + encodeURIComponent(t) +
      '?title=' + encodeURIComponent(title) +
      '&priority=urgent&tags=tennis%2Ctada';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: message,
      timeout: 10000
    });
    if (res.ok) {
      addLog('ntfy sent successfully (HTTP ' + res.status + ')', 'success');
      return true;
    } else {
      const body = await res.text();
      addLog('ntfy failed: HTTP ' + res.status + ' — ' + body, 'error');
      return false;
    }
  } catch (e) {
    addLog('ntfy error: ' + e.message, 'error');
    return false;
  }
}

// ── Date helpers ──────────────────────────────────────────
function getDateRange(daysAhead) {
  const dates = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function buildUrlForDate(baseUrl, dateStr) {
  let url = baseUrl.split('#')[0];
  // Remove any existing date param
  url = url.replace(/([?&])date=[^&]*/g, '$1').replace(/[?&]$/, '');
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'date=' + dateStr;
}

// ── Fetch page ────────────────────────────────────────────
async function fetchPage(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none'
  };

  if (config.cookies && config.cookies.trim()) {
    headers['Cookie'] = config.cookies.trim();
  }

  const res = await fetch(url, { headers, timeout: 20000, redirect: 'follow' });
  const finalUrl = res.url || url;

  if (res.status === 401 || res.status === 403) {
    throw new Error('Access denied (HTTP ' + res.status + ') — cookies may have expired');
  }
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' from ClubSpark');
  }

  const html = await res.text();

  if ((finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('account/login')) &&
      !finalUrl.includes('Booking')) {
    throw new Error('Redirected to login page — cookies are missing or expired');
  }
  if (html.toLowerCase().includes('you need to be logged in') || html.toLowerCase().includes('please log in')) {
    throw new Error('Login required — add your cookies in the Login tab');
  }

  return html;
}

// ── Parse available slots ─────────────────────────────────
function parseSlots(html, dateStr) {
  const slots = [];
  const timeRx = /([01]?\d|2[0-3]):[0-5]\d/g;

  // Method 1: data attributes
  const dataTimeRx = /data-(?:time|start-time|slot-time)="(([01]?\d|2[0-3]):[0-5]\d)"/g;
  let m;
  while ((m = dataTimeRx.exec(html)) !== null) {
    const ctx = html.slice(Math.max(0, m.index - 200), m.index + 200);
    if (!/booked|unavailable|locked|disabled|full/i.test(ctx)) {
      slots.push({ time: m[1], date: dateStr });
    }
  }

  // Method 2: available class elements with times
  const availRx = /class="[^"]*\b(?:available|bookable|book-now|open)\b[^"]*"[^>]*>([\s\S]{0,300}?)<\/(?:td|div|span|li|button)>/gi;
  while ((m = availRx.exec(html)) !== null) {
    const times = m[1].match(timeRx);
    if (times) times.forEach(t => slots.push({ time: t, date: dateStr }));
  }

  // Method 3: JSON embedded data
  const jsonSlotRx = /"(?:startTime|bookingTime|time)"\s*:\s*"(([01]?\d|2[0-3]):[0-5]\d)"/g;
  while ((m = jsonSlotRx.exec(html)) !== null) {
    const ctx = html.slice(Math.max(0, m.index - 150), m.index + 150);
    if (!/booked|unavailable|locked/i.test(ctx)) {
      slots.push({ time: m[1], date: dateStr });
    }
  }

  // Method 4: broad scan for times near booking keywords (fallback)
  if (slots.length === 0) {
    addLog('Using broad scan for ' + dateStr + ' (no structured slots found)', 'warn');
    const lines = html.split('\n');
    lines.forEach(line => {
      if (/book|available|open/i.test(line) && !/booked|login|unavail|locked|disabled/i.test(line)) {
        const times = line.match(timeRx);
        if (times) times.forEach(t => slots.push({ time: t, date: dateStr }));
      }
    });
  }

  // Deduplicate
  const seen = {};
  return slots.filter(s => {
    const key = s.date + '@' + s.time;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// ── Filter slots ──────────────────────────────────────────
function filterSlots(slots) {
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  return slots.filter(s => {
    if (config.timeFrom && config.timeTo) {
      const sm = toMin(s.time);
      if (sm < toMin(config.timeFrom) || sm > toMin(config.timeTo)) return false;
    }
    if (config.preferredTimes && config.preferredTimes.length > 0) {
      if (!config.preferredTimes.some(pt => s.time.substring(0, 5) === pt.substring(0, 5))) return false;
    }
    return true;
  });
}

// ── Main check ────────────────────────────────────────────
async function doCheck() {
  if (!config.venueUrl) { addLog('No venue URL configured', 'warn'); return; }

  state.checkCount++;
  state.lastStatus = 'watching';
  state.lastCheck = new Date().toISOString();

  const dates = getDateRange(config.daysAhead || 7);
  addLog('── Check #' + state.checkCount + ': scanning ' + dates.length + ' dates ──');

  const allNewSlots = [];

  for (const dateStr of dates) {
    const url = buildUrlForDate(config.venueUrl, dateStr);
    try {
      const html = await fetchPage(url);
      const rawSlots = parseSlots(html, dateStr);
      const filtered = filterSlots(rawSlots);
      const newSlots = filtered.filter(s => !state.knownSlots[s.date + '@' + s.time]);

      if (rawSlots.length > 0) {
        addLog(dateStr + ': ' + rawSlots.length + ' slot(s) found, ' + filtered.length + ' match filter, ' + newSlots.length + ' new');
      } else {
        addLog(dateStr + ': no available slots');
      }

      if (newSlots.length > 0) {
        newSlots.forEach(s => { state.knownSlots[s.date + '@' + s.time] = true; });
        allNewSlots.push(...newSlots);
      }

      await new Promise(r => setTimeout(r, 600));

    } catch (e) {
      addLog('Error on ' + dateStr + ': ' + e.message, 'error');
      if (e.message.includes('login') || e.message.includes('expired') || e.message.includes('denied')) {
        state.lastStatus = 'error';
        state.lastMessage = '⚠ ' + e.message + ' — go to Login tab';
        return;
      }
    }
  }

  if (allNewSlots.length > 0) {
    const lines = allNewSlots.map(s => {
      const d = new Date(s.date + 'T12:00:00');
      return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' @ ' + s.time;
    });
    const summary = lines.join(', ');
    addLog('🎾 NEW SLOTS FOUND: ' + summary, 'alert');
    state.lastStatus = 'alert';
    state.lastMessage = '🎾 Available: ' + summary;
    await sendNtfy('🎾 Court Available!', lines.join('\n') + '\n\nBook now on ClubSpark!');
  } else {
    if (state.lastStatus !== 'error') {
      state.lastStatus = 'watching';
      state.lastMessage = 'Watching — last check #' + state.checkCount;
    }
    addLog('No new slots. Next check in ' + config.intervalMin + ' min.');
  }
}

// ── Monitor control ───────────────────────────────────────
function startMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  state.knownSlots = {};
  state.checkCount = 0;
  config.enabled = true;
  addLog('▶ Started. Every ' + config.intervalMin + ' min × ' + (config.daysAhead || 7) + ' days ahead.', 'success');
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

// ── Keep-alive ping ───────────────────────────────────────
setInterval(() => {
  fetch('http://localhost:' + PORT + '/api/status').catch(() => {});
}, 14 * 60 * 1000);

// ── API ───────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ config, state: { ...state, log: state.log.slice(0, 100) } });
});

app.post('/api/config', (req, res) => {
  const wasEnabled = config.enabled;
  config = { ...config, ...req.body };
  if (wasEnabled) { addLog('Config updated — restarting monitor…'); startMonitor(); }
  else addLog('Config saved.');
  res.json({ ok: true });
});

app.post('/api/start', (req, res) => {
  if (!config.venueUrl) { res.json({ ok: false, error: 'No venue URL set' }); return; }
  startMonitor();
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => { stopMonitor(); res.json({ ok: true }); });

app.post('/api/test-ntfy', async (req, res) => {
  const { topic } = req.body;
  if (!topic) { res.json({ ok: false, error: 'No topic' }); return; }
  const ok = await sendNtfy('🎾 Court Scout Test', 'Connected! Alerts will arrive here when courts become available.', topic.trim());
  res.json({ ok });
});

app.get('/', (req, res) => res.send(UI_HTML));

app.listen(PORT, () => console.log('Court Scout running on port ' + PORT));

// ─────────────────────────────────────────────────────────
// UI HTML
// ─────────────────────────────────────────────────────────
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
header{margin-bottom:28px;}
.logo{display:flex;align-items:center;gap:14px;margin-bottom:4px;}
.logo-icon{width:46px;height:46px;background:var(--lime);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:24px;}
h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(2.2rem,6vw,3.2rem);letter-spacing:.04em;line-height:1;}
h1 span{color:var(--lime);}
.tagline{font-family:'DM Mono',monospace;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:4px;}
.status-bar{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:13px 18px;margin-bottom:22px;font-family:'DM Mono',monospace;font-size:.8rem;}
.dot{width:8px;height:8px;border-radius:50%;background:#444;flex-shrink:0;transition:all .3s;}
.dot.watching{background:var(--lime);box-shadow:0 0 8px var(--lime);animation:pulse 2s infinite;}
.dot.alert{background:var(--clay);box-shadow:0 0 10px var(--clay);}
.dot.error{background:#e66;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
#status-text{flex:1;}#chk{color:var(--muted);font-size:.73rem;}
.tabs{display:flex;border-bottom:1px solid var(--border);margin-bottom:20px;overflow-x:auto;}
.tab{padding:10px 16px;cursor:pointer;font-family:'DM Mono',monospace;font-size:.73rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .2s,border-color .2s;user-select:none;white-space:nowrap;}
.tab:hover{color:var(--white);}.tab.active{color:var(--lime);border-bottom-color:var(--lime);}
.pane{display:none;}.pane.active{display:block;}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:14px;}
.clabel{font-family:'DM Mono',monospace;font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:var(--lime);margin-bottom:13px;display:flex;align-items:center;gap:10px;}
.clabel::after{content:'';flex:1;height:1px;background:var(--border);}
label{display:block;font-size:.79rem;color:var(--muted);margin-bottom:5px;font-family:'DM Mono',monospace;}
input[type=text],select,textarea{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(168,212,74,.22);border-radius:6px;color:var(--white);font-family:'DM Mono',monospace;font-size:.82rem;padding:10px 12px;margin-bottom:14px;outline:none;transition:border-color .2s;}
textarea{resize:vertical;min-height:80px;font-size:.72rem;line-height:1.5;}
input:focus,select:focus,textarea:focus{border-color:var(--lime);}
input::placeholder,textarea::placeholder{color:rgba(240,237,232,.18);}
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
.btn-go{width:100%;background:var(--lime);border:none;border-radius:8px;color:var(--dark);font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:.08em;padding:15px;cursor:pointer;transition:opacity .2s,transform .1s;margin-top:4px;}
.btn-go:hover{opacity:.88;transform:translateY(-1px);}
.btn-stop{width:100%;background:transparent;border:1px solid var(--clay);border-radius:8px;color:var(--clay);font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:.08em;padding:15px;cursor:pointer;margin-top:10px;display:none;transition:background .2s;}
.btn-stop:hover{background:rgba(200,99,42,.1);}
.log-box{background:rgba(0,0,0,.35);border:1px solid var(--border);border-radius:8px;padding:13px;height:300px;overflow-y:auto;font-family:'DM Mono',monospace;font-size:.73rem;}
.le{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);}
.le:last-child{border:none;}
.lt{color:var(--muted);flex-shrink:0;}
.lm{color:var(--white);}
.le.success .lm,.le.ok .lm{color:var(--lime);}
.le.warn .lm{color:#f0c040;}
.le.error .lm{color:#e66;}
.le.alert .lm{color:var(--clay);font-weight:600;}
.alert-banner{display:none;border:1px solid var(--clay);border-radius:10px;padding:20px;margin-bottom:18px;background:linear-gradient(135deg,rgba(200,99,42,.18),rgba(168,212,74,.08));}
.alert-banner h3{font-family:'Bebas Neue',sans-serif;font-size:1.7rem;color:var(--lime);margin-bottom:6px;}
.slot-pill{display:inline-block;background:rgba(168,212,74,.14);border:1px solid var(--lime);border-radius:4px;padding:3px 9px;font-family:'DM Mono',monospace;font-size:.76rem;color:var(--lime);margin:3px;}
.tresult{margin-top:8px;font-family:'DM Mono',monospace;font-size:.75rem;color:var(--muted);min-height:18px;line-height:1.5;}
.hint{font-size:.75rem;color:var(--muted);line-height:1.6;margin-top:-8px;margin-bottom:14px;}
.warn-box{background:rgba(200,99,42,.1);border:1px solid rgba(200,99,42,.3);border-radius:8px;padding:14px 16px;margin-bottom:14px;font-size:.8rem;line-height:1.6;}
code{background:rgba(168,212,74,.1);border:1px solid rgba(168,212,74,.22);border-radius:3px;padding:1px 5px;font-family:'DM Mono',monospace;font-size:.8em;color:var(--lime);}
.step{display:flex;gap:12px;margin-bottom:12px;font-size:.81rem;color:rgba(240,237,232,.82);line-height:1.6;}
.sn{width:22px;height:22px;border-radius:50%;background:var(--lime);color:var(--dark);font-size:.68rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;font-family:'DM Mono',monospace;}
a{color:var(--lime);}
.btn-test{background:rgba(91,200,245,.1);border:1px solid #5bc8f5;color:#5bc8f5;border-radius:6px;padding:10px 14px;font-family:'DM Mono',monospace;font-size:.77rem;cursor:pointer;white-space:nowrap;transition:background .2s;}
.btn-test:hover{background:rgba(91,200,245,.2);}
.field-row{display:flex;gap:8px;align-items:flex-start;margin-top:6px;}
.field-row input{margin:0;flex:1;}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">
      <div class="logo-icon">🎾</div>
      <div><h1>Court <span>Scout</span></h1><p class="tagline">ClubSpark 24/7 Monitor</p></div>
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
    <div class="tab" id="tb-login">🔑 Login</div>
    <div class="tab" id="tb-courts">🎾 Courts</div>
    <div class="tab" id="tb-alerts">📲 Alerts</div>
    <div class="tab" id="tb-log">📋 Log</div>
  </div>

  <!-- MONITOR -->
  <div class="pane active" id="pn-monitor">
    <div class="card">
      <div class="clabel">Venue</div>
      <label>ClubSpark booking page URL</label>
      <input type="text" id="venue-url" placeholder="https://clubspark.lta.org.uk/YourClub/Booking/BookByDate">
      <p class="hint">Go to your club on clubspark.lta.org.uk → Book a Court → copy the URL from your browser.</p>
    </div>
    <div class="card">
      <div class="clabel">Dates</div>
      <label>How many days ahead to scan</label>
      <select id="days-ahead">
        <option value="7" selected>Next 7 days</option>
        <option value="14">Next 14 days</option>
        <option value="30">Next 30 days</option>
      </select>
    </div>
    <div class="card">
      <div class="clabel">Time Preferences</div>
      <label>Preferred times (leave empty = any time)</label>
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
      <div class="clabel">Frequency</div>
      <select id="interval">
        <option value="1">Every 1 minute</option>
        <option value="2" selected>Every 2 minutes</option>
        <option value="5">Every 5 minutes</option>
        <option value="10">Every 10 minutes</option>
      </select>
    </div>
    <button class="btn-go" id="btn-start">🎾 Save &amp; Start Watching</button>
    <button class="btn-stop" id="btn-stop">⏹ Stop Watching</button>
  </div>

  <!-- LOGIN -->
  <div class="pane" id="pn-login">
    <div class="warn-box" style="color:rgba(240,237,232,.85);">
      🔑 <strong style="color:var(--white)">ClubSpark requires login to see bookings.</strong> Court Scout needs your browser session cookies to access the booking page on your behalf. Follow the steps below — it takes about 2 minutes.
    </div>
    <div class="card">
      <div class="clabel">Step-by-step</div>
      <div class="step"><div class="sn">1</div><div>Open <strong>Chrome</strong> on your Mac and log in to <a href="https://clubspark.lta.org.uk" target="_blank">clubspark.lta.org.uk</a></div></div>
      <div class="step"><div class="sn">2</div><div>Navigate to your club's court booking page</div></div>
      <div class="step"><div class="sn">3</div><div>Right-click anywhere on the page → click <strong>Inspect</strong> → click the <strong>Network</strong> tab</div></div>
      <div class="step"><div class="sn">4</div><div>Press <strong>Cmd+R</strong> to refresh the page</div></div>
      <div class="step"><div class="sn">5</div><div>Click the very first item in the Network list (it'll be the page name)</div></div>
      <div class="step"><div class="sn">6</div><div>On the right side, click <strong>Headers</strong> → scroll down to <strong>Request Headers</strong> → find the row that starts with <code>cookie:</code></div></div>
      <div class="step"><div class="sn">7</div><div>Click on the value next to <code>cookie:</code>, press <strong>Cmd+A</strong> to select all, then <strong>Cmd+C</strong> to copy</div></div>
      <div class="step"><div class="sn">8</div><div>Paste it into the box below and click <strong>Save Cookies</strong></div></div>
      <label style="margin-top:8px;">Cookie string</label>
      <textarea id="cookies" placeholder="Paste your cookie string here…"></textarea>
      <p class="hint">Cookies are stored only on your Render server. They expire after a few days — if Court Scout reports a login error, repeat these steps to refresh them.</p>
      <button class="btn-go" id="btn-save-cookies" style="font-size:1rem;padding:12px;">Save Cookies</button>
      <div class="tresult" id="cookie-result"></div>
    </div>
  </div>

  <!-- COURTS -->
  <div class="pane" id="pn-courts">
    <div class="card">
      <div class="clabel">Court Filter</div>
      <p class="hint" style="margin-top:0;margin-bottom:14px;">Add courts exactly as named on your ClubSpark page (e.g. <code>Court 1</code>, <code>Centre Court</code>). Leave empty to alert for any court.</p>
      <div class="add-row">
        <input type="text" id="court-input" placeholder="e.g. Court 1" style="margin:0">
        <button class="btn-sm" id="btn-add-court">+ Add</button>
      </div>
      <div class="tags" id="court-tags"></div>
    </div>
  </div>

  <!-- ALERTS -->
  <div class="pane" id="pn-alerts">
    <div class="card">
      <div class="clabel">ntfy.sh Notifications</div>
      <div class="step"><div class="sn">1</div><div>Install the free <strong>ntfy</strong> app on your phone — <a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank">iOS</a> or <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank">Android</a></div></div>
      <div class="step"><div class="sn">2</div><div>Open the app → tap <strong>+</strong> → subscribe to a unique topic like <code>courtscout-yourname</code></div></div>
      <div class="step"><div class="sn">3</div><div>Paste the exact topic name below and hit <strong>Test</strong></div></div>
      <label style="margin-top:4px;">Topic name</label>
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
      <div class="clabel">Live Activity Log</div>
      <div class="log-box" id="log"></div>
    </div>
    <button class="btn-sm" id="btn-clear" style="font-size:.74rem;padding:7px 13px;margin-top:4px;">Clear log</button>
  </div>
</div>

<script>
(function(){
  var preferredTimes=[], courts=[];
  var tabs={monitor:'pn-monitor',login:'pn-login',courts:'pn-courts',alerts:'pn-alerts',log:'pn-log'};

  Object.keys(tabs).forEach(function(k){
    document.getElementById('tb-'+k).addEventListener('click',function(){ switchTab(k); });
  });

  function switchTab(n){
    Object.keys(tabs).forEach(function(k){
      document.getElementById('tb-'+k).classList.toggle('active',k===n);
      document.getElementById(tabs[k]).classList.toggle('active',k===n);
    });
  }

  function renderTags(id,arr,onRemove){
    var el=document.getElementById(id);
    el.innerHTML=arr.map(function(t){return '<div class="tag">'+t+'<button data-v="'+t+'">✕</button></div>';}).join('');
    el.querySelectorAll('button[data-v]').forEach(function(b){
      b.addEventListener('click',function(){ onRemove(b.getAttribute('data-v')); });
    });
  }

  function refreshTimeTags(){
    renderTags('time-tags',preferredTimes,function(t){ preferredTimes=preferredTimes.filter(function(x){return x!==t;}); refreshTimeTags(); });
  }
  function refreshCourtTags(){
    renderTags('court-tags',courts,function(c){ courts=courts.filter(function(x){return x!==c;}); refreshCourtTags(); });
  }

  document.getElementById('btn-add-time').addEventListener('click',function(){
    var val=document.getElementById('time-input').value.trim(); if(!val)return;
    val.split(',').map(function(t){return t.trim();}).filter(Boolean).forEach(function(t){ if(preferredTimes.indexOf(t)===-1)preferredTimes.push(t); });
    document.getElementById('time-input').value=''; refreshTimeTags();
  });
  document.getElementById('time-input').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('btn-add-time').click();});

  document.getElementById('btn-add-court').addEventListener('click',function(){
    var val=document.getElementById('court-input').value.trim(); if(!val)return;
    if(courts.indexOf(val)===-1)courts.push(val);
    document.getElementById('court-input').value=''; refreshCourtTags();
  });
  document.getElementById('court-input').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('btn-add-court').click();});

  document.getElementById('btn-save-cookies').addEventListener('click',function(){
    var cookies=document.getElementById('cookies').value.trim();
    var el=document.getElementById('cookie-result');
    if(!cookies){el.style.color='#e66';el.textContent='✗ Paste your cookie string first.';return;}
    saveConfig({cookies:cookies}).then(function(){
      el.style.color='var(--lime)';
      el.textContent='✓ Cookies saved! Court Scout will now log in as you.';
    });
  });

  document.getElementById('btn-ntfy-test').addEventListener('click',function(){
    var el=document.getElementById('ntfy-result');
    var topic=document.getElementById('ntfy-topic').value.trim();
    if(!topic){el.style.color='#e66';el.textContent='✗ Enter topic name first.';return;}
    el.style.color='var(--muted)';el.textContent='Sending from server…';
    fetch('/api/test-ntfy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:topic})})
      .then(function(r){return r.json();})
      .then(function(d){
        el.style.color=d.ok?'var(--lime)':'#e66';
        el.textContent=d.ok
          ?'✓ Sent from server! Check your phone. Topic must match exactly (case-sensitive).'
          :'✗ Failed — check the Log tab for the error details.';
        if(d.ok)saveConfig({ntfyTopic:topic});
      });
  });

  function saveConfig(extra){
    var cfg=Object.assign({
      venueUrl:document.getElementById('venue-url').value.trim(),
      ntfyTopic:document.getElementById('ntfy-topic').value.trim(),
      preferredTimes:preferredTimes,
      timeFrom:document.getElementById('time-from').value.trim(),
      timeTo:document.getElementById('time-to').value.trim(),
      courts:courts,
      daysAhead:parseInt(document.getElementById('days-ahead').value),
      intervalMin:parseInt(document.getElementById('interval').value)
    },extra||{});
    return fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
  }

  document.getElementById('btn-start').addEventListener('click',function(){
    var url=document.getElementById('venue-url').value.trim();
    if(!url){alert('Please enter your ClubSpark venue URL first.');return;}
    saveConfig().then(function(){return fetch('/api/start',{method:'POST'});})
      .then(function(r){return r.json();})
      .then(function(d){
        if(!d.ok){alert('Error: '+d.error);return;}
        document.getElementById('btn-start').style.display='none';
        document.getElementById('btn-stop').style.display='block';
        switchTab('log');
      });
  });

  document.getElementById('btn-stop').addEventListener('click',function(){
    fetch('/api/stop',{method:'POST'}).then(function(){
      document.getElementById('btn-start').style.display='block';
      document.getElementById('btn-stop').style.display='none';
    });
  });

  document.getElementById('btn-clear').addEventListener('click',function(){
    document.getElementById('log').innerHTML='';
  });

  var prevStatus='';
  function loadStatus(){
    fetch('/api/status').then(function(r){return r.json();}).then(function(d){
      var s=d.state,c=d.config;
      document.getElementById('dot').className='dot '+(s.lastStatus||'');
      document.getElementById('status-text').textContent=s.lastMessage||'Ready';
      document.getElementById('chk').textContent=s.checkCount>0?'check #'+s.checkCount:'';

      if(c.venueUrl)document.getElementById('venue-url').value=c.venueUrl;
      if(c.ntfyTopic)document.getElementById('ntfy-topic').value=c.ntfyTopic;
      if(c.cookies)document.getElementById('cookies').value=c.cookies;
      if(c.timeFrom)document.getElementById('time-from').value=c.timeFrom;
      if(c.timeTo)document.getElementById('time-to').value=c.timeTo;
      if(c.intervalMin)document.getElementById('interval').value=c.intervalMin;
      if(c.daysAhead)document.getElementById('days-ahead').value=c.daysAhead;

      if(c.preferredTimes&&c.preferredTimes.length&&!preferredTimes.length){preferredTimes=c.preferredTimes;refreshTimeTags();}
      if(c.courts&&c.courts.length&&!courts.length){courts=c.courts;refreshCourtTags();}

      document.getElementById('btn-start').style.display=c.enabled?'none':'block';
      document.getElementById('btn-stop').style.display=c.enabled?'block':'none';

      if(s.lastStatus==='alert'&&prevStatus!=='alert'){
        var b=document.getElementById('alert-banner');
        b.style.display='block';
        document.getElementById('alert-desc').textContent=s.lastMessage;
      }
      prevStatus=s.lastStatus||'';

      var logEl=document.getElementById('log');
      logEl.innerHTML=(s.log||[]).map(function(e){
        return '<div class="le '+(e.type||'')+'"><span class="lt">'+e.time+'</span><span class="lm">'+e.msg+'</span></div>';
      }).join('');
    }).catch(function(){});
  }

  loadStatus();
  setInterval(loadStatus,4000);
})();
</script>
</body>
</html>`;
