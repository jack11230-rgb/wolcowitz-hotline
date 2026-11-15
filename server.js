'use strict';
// Wolcowitz Family Hotline - Twilio Voice webhook app.
const express = require('express');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 10000;
const BASE = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Wolcowitz Hotline <onboarding@resend.dev>';
// Menu digit -> stored section key. Recordings are stored by key, not digit, so menu changes never move them.
const SECTIONS = { '3': 'children', '4': 'teen-girls', '5': 'teen-boys', '6': 'events', '7': 'daily-lesson' };
const ROOMS = { '1': ['mishnayos', 'join_mishnayos'], '2': ['shmiras-haloshon', 'join_shmiras'] };
// Old digit-keyed rows (before the 2<->3 swap, children's updates were digit 2).
const LEGACY = { '2': 'children', '4': 'teen-girls', '5': 'teen-boys', '6': 'events', '7': 'daily-lesson' };

// ---------- storage (Postgres, or memory for local tests) ----------
let db;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
  db = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS recordings (
        id SERIAL PRIMARY KEY, token TEXT UNIQUE NOT NULL, section TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), twilio_url TEXT, recording_sid TEXT,
        audio BYTEA, content_type TEXT, duration INT, from_number TEXT, source_id INT)`);
      await pool.query('CREATE INDEX IF NOT EXISTS recordings_section_idx ON recordings(section, created_at DESC, id DESC)');
      for (const [d, key] of Object.entries(LEGACY)) {
        const r = await pool.query('UPDATE recordings SET section=$1 WHERE section=$2', [key, d]);
        if (r.rowCount) console.log(`Migrated ${r.rowCount} recording(s) from digit ${d} to section ${key}`);
      }
    },
    async nth(section, i) {
      const r = await pool.query('SELECT id, token, section, created_at, twilio_url, duration, from_number FROM recordings WHERE section=$1 ORDER BY created_at DESC, id DESC OFFSET $2 LIMIT 1', [section, i]);
      return r.rows[0];
    },
    async insert(row) {
      const r = await pool.query('INSERT INTO recordings(token, section, twilio_url, recording_sid, audio, content_type, duration, from_number, source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (token) DO NOTHING RETURNING id, token',
        [row.token, row.section, row.twilio_url, row.recording_sid, row.audio, row.content_type, row.duration, row.from_number, row.source_id || null]);
      return r.rows[0];
    },
    async bySid(sid, section) { const r = await pool.query('SELECT id FROM recordings WHERE recording_sid=$1 AND section=$2', [sid, section]); return r.rows[0]; },
    async byToken(t) { const r = await pool.query('SELECT * FROM recordings WHERE token=$1', [t]); return r.rows[0]; },
    async byId(id) { const r = await pool.query('SELECT * FROM recordings WHERE id=$1', [id]); return r.rows[0]; },
    async counts() { const r = await pool.query('SELECT section, count(*)::int n FROM recordings GROUP BY section'); return r.rows; },
  };
} else {
  const rows = []; let seq = 0;
  const sorted = (s) => rows.filter(r => r.section === s).sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  db = {
    async init() { console.warn('WARNING: no DATABASE_URL, using in-memory storage'); },
    async nth(s, i) { return sorted(s)[i]; },
    async insert(row) { if (rows.find(r => r.token === row.token)) return; const r = { ...row, id: ++seq, created_at: new Date() }; rows.push(r); return r; },
    async bySid(sid, section) { return rows.find(r => r.recording_sid === sid && r.section === section); },
    async byToken(t) { return rows.find(r => r.token === t); },
    async byId(id) { return rows.find(r => r.id === Number(id)); },
    async counts() { const c = {}; rows.forEach(r => c[r.section] = (c[r.section] || 0) + 1); return Object.entries(c).map(([section, n]) => ({ section, n })); },
  };
}

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const url = (p, q) => { const qs = q ? '?' + new URLSearchParams(q).toString() : ''; return esc(`${BASE}${p}${qs}`); };
const audio = (name) => `<Play>${esc(`${BASE}/audio/${name}.mp3`)}</Play>`;
const redirect = (p, q) => `<Redirect method="POST">${url(p, q)}</Redirect>`;
const twiml = (res, body) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
const sign = (callSid) => crypto.createHmac('sha256', 'admin:' + ADMIN_PIN).update(String(callSid || '')).digest('hex').slice(0, 32);
const adminOk = (req) => ADMIN_PIN && req.p.t && req.p.CallSid && crypto.timingSafeEqual(Buffer.from(sign(req.p.CallSid)), Buffer.from(String(req.p.t).padEnd(32).slice(0, 32)));
const newToken = () => crypto.randomBytes(16).toString('hex');

function validTwilioSignature(req) {
  if (!TW_TOKEN) return true; // validation enabled only when the auth token is configured
  const sig = req.get('X-Twilio-Signature') || '';
  const full = BASE + req.originalUrl;
  let data = full;
  if (req.method === 'POST') Object.keys(req.body || {}).sort().forEach(k => { data += k + req.body[k]; });
  const expected = crypto.createHmac('sha1', TW_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', async (req, res) => res.type('text/plain').send('Wolcowitz Family Hotline is running.'));
app.use('/audio', express.static(path.join(__dirname, 'audio'), { maxAge: '1h' }));

// Public playback of stored recordings (unguessable token).
app.get('/r/:token.mp3', async (req, res) => {
  const r = await db.byToken(req.params.token);
  if (!r) return res.status(404).send('not found');
  if (r.audio) return res.type(r.content_type || 'audio/mpeg').send(r.audio);
  if (r.twilio_url) return res.redirect(r.twilio_url + '.mp3');
  res.status(404).send('no audio');
});

// All Twilio webhooks: merge query + body into req.p and validate signature.
const tw = express.Router();
tw.use((req, res, next) => {
  if (!validTwilioSignature(req)) { console.warn('Bad Twilio signature', req.originalUrl); return res.status(403).send('forbidden'); }
  req.p = { ...req.query, ...req.body };
  next();
});

// Main menu
tw.all('/voice', (req, res) => {
  const n = Number(req.p.n || 0);
  if (n >= 3) return twiml(res, audio('goodbye') + '<Hangup/>');
  twiml(res, `<Gather input="dtmf" numDigits="1" timeout="7" action="${url('/menu')}" method="POST">${audio('greeting')}</Gather>${redirect('/voice', { n: n + 1 })}`);
});

tw.all('/menu', (req, res) => {
  const d = req.p.Digits || '';
  if (ROOMS[d]) {
    const [room, prompt] = ROOMS[d];
    return twiml(res, `${audio(prompt)}<Dial><Conference beep="true" startConferenceOnEnter="true" endConferenceOnExit="false" waitUrl="">${esc(room)}</Conference></Dial>`);
  }
  if (SECTIONS[d]) return twiml(res, redirect('/section', { s: d, i: 0 }));
  if (d === '8') return twiml(res, redirect('/message'));
  if (d === '9' || d === '*') return twiml(res, redirect('/admin'));
  twiml(res, audio('invalid') + redirect('/voice'));
});

// Recorded sections: newest first, press 1 for previous, * for menu
tw.all('/section', async (req, res) => {
  const s = req.p.s; const i = Math.max(0, Number(req.p.i || 0));
  if (!SECTIONS[s]) return twiml(res, redirect('/voice'));
  const r = await db.nth(SECTIONS[s], i);
  if (!r) return twiml(res, audio(i === 0 ? 'no_recording' : 'no_more') + redirect('/voice'));
  twiml(res, `<Gather input="dtmf" numDigits="1" timeout="8" action="${url('/section-nav', { s, i })}" method="POST"><Play>${url(`/r/${r.token}.mp3`)}</Play>${audio('prev_prompt')}</Gather>${redirect('/voice')}`);
});

tw.all('/section-nav', (req, res) => {
  const s = req.p.s; const i = Number(req.p.i || 0); const d = req.p.Digits || '';
  if (d === '1') return twiml(res, redirect('/section', { s, i: i + 1 }));
  if (d === '*') return twiml(res, redirect('/voice'));
  twiml(res, audio('invalid') + redirect('/section', { s, i }));
});

// Option 8: leave a message
tw.all('/message', (req, res) => {
  twiml(res, `${audio('record_prompt')}<Record maxLength="300" finishOnKey="#" playBeep="true" timeout="10" action="${url('/message-done')}" method="POST" recordingStatusCallback="${url('/recording-status', { target: 'inbox', From: req.p.From || '' })}" recordingStatusCallbackMethod="POST"/>${redirect('/voice')}`);
});
tw.all('/message-done', (req, res) => {
  if (!req.p.RecordingUrl || Number(req.p.RecordingDuration || 0) < 1) return twiml(res, audio('no_message') + redirect('/voice'));
  twiml(res, audio('thanks_message') + '<Hangup/>');
});

// Admin
tw.all('/admin', (req, res) => {
  twiml(res, `<Gather input="dtmf" numDigits="6" finishOnKey="#" timeout="10" action="${url('/admin-pin')}" method="POST">${audio('admin_pin')}</Gather>${redirect('/voice')}`);
});
tw.all('/admin-pin', (req, res) => {
  const d = String(req.p.Digits || '');
  const ok = ADMIN_PIN && d.length === ADMIN_PIN.length && crypto.timingSafeEqual(Buffer.from(d), Buffer.from(ADMIN_PIN));
  if (!ok) { console.warn('Bad admin PIN attempt from', req.p.From); return twiml(res, audio('admin_bad') + '<Hangup/>'); }
  twiml(res, redirect('/admin-menu', { t: sign(req.p.CallSid) }));
});
tw.all('/admin-menu', (req, res) => {
  if (!adminOk(req)) return twiml(res, redirect('/voice'));
  const t = req.p.t; const n = Number(req.p.n || 0);
  if (n >= 3) return twiml(res, audio('goodbye') + '<Hangup/>');
  twiml(res, `<Gather input="dtmf" numDigits="1" timeout="8" action="${url('/admin-choice', { t })}" method="POST">${audio('admin_section')}</Gather>${redirect('/admin-menu', { t, n: n + 1 })}`);
});
tw.all('/admin-choice', (req, res) => {
  if (!adminOk(req)) return twiml(res, redirect('/voice'));
  const t = req.p.t; const d = req.p.Digits || '';
  if (SECTIONS[d]) return twiml(res, redirect('/admin-record', { t, s: d }));
  if (d === '8') return twiml(res, redirect('/admin-inbox', { t, i: 0 }));
  if (d === '*') return twiml(res, audio('goodbye') + '<Hangup/>');
  twiml(res, audio('invalid') + redirect('/admin-menu', { t }));
});
tw.all('/admin-record', (req, res) => {
  if (!adminOk(req) || !SECTIONS[req.p.s]) return twiml(res, redirect('/voice'));
  const { t, s } = req.p;
  twiml(res, `${audio('admin_record')}<Record maxLength="900" finishOnKey="#" playBeep="true" timeout="15" action="${url('/admin-recorded', { t, s })}" method="POST" recordingStatusCallback="${url('/recording-status', { target: s, t })}" recordingStatusCallbackMethod="POST"/>${redirect('/admin-menu', { t })}`);
});
tw.all('/admin-recorded', (req, res) => {
  if (!adminOk(req)) return twiml(res, redirect('/voice'));
  const t = req.p.t;
  if (!req.p.RecordingUrl || Number(req.p.RecordingDuration || 0) < 1) return twiml(res, audio('no_message') + redirect('/admin-menu', { t }));
  twiml(res, audio('admin_published') + redirect('/admin-menu', { t }));
});
tw.all('/admin-inbox', async (req, res) => {
  if (!adminOk(req)) return twiml(res, redirect('/voice'));
  const t = req.p.t; const i = Math.max(0, Number(req.p.i || 0));
  const r = await db.nth('inbox', i);
  if (!r) return twiml(res, audio('admin_inbox_empty') + redirect('/admin-menu', { t }));
  twiml(res, `<Gather input="dtmf" numDigits="1" timeout="8" action="${url('/admin-inbox-choice', { t, i, id: r.id })}" method="POST">${audio('admin_inbox_play')}<Play>${url(`/r/${r.token}.mp3`)}</Play>${audio('admin_inbox_opts')}</Gather>${redirect('/admin-menu', { t })}`);
});
tw.all('/admin-inbox-choice', async (req, res) => {
  if (!adminOk(req)) return twiml(res, redirect('/voice'));
  const { t, id } = req.p; const i = Number(req.p.i || 0); const d = req.p.Digits || '';
  if (d === '1') return twiml(res, redirect('/admin-inbox', { t, i: i + 1 }));
  if (d === '*') return twiml(res, redirect('/admin-menu', { t }));
  if (SECTIONS[d]) {
    const src = await db.byId(id);
    if (src) {
      await db.insert({ token: newToken(), section: SECTIONS[d], twilio_url: src.twilio_url, recording_sid: src.recording_sid, audio: src.audio, content_type: src.content_type, duration: src.duration, from_number: src.from_number, source_id: src.id });
      console.log(`Published inbox message ${src.id} to section ${SECTIONS[d]}`);
      return twiml(res, audio('admin_published') + redirect('/admin-menu', { t }));
    }
  }
  twiml(res, audio('invalid') + redirect('/admin-inbox', { t, i }));
});

// Recording finished processing at Twilio: download and save it.
tw.all('/recording-status', async (req, res) => {
  res.status(204).end();
  try {
    const p = req.p;
    if (p.RecordingStatus && p.RecordingStatus !== 'completed') return;
    const target = p.target;
    let section;
    if (target === 'inbox') section = 'inbox';
    else if (SECTIONS[target] && adminOk(req)) section = SECTIONS[target];
    else return console.warn('recording-status: rejected target', target);
    const recUrl = String(p.RecordingUrl || '');
    if (!/^https:\/\/api\.twilio\.com\//.test(recUrl)) return console.warn('recording-status: bad url');
    if (Number(p.RecordingDuration || 0) < 1) return;
    if (p.RecordingSid && await db.bySid(p.RecordingSid, section)) return;
    let audioBuf = null;
    try {
      const headers = TW_SID && TW_TOKEN ? { Authorization: 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64') } : {};
      for (let attempt = 0; attempt < 3 && !audioBuf; attempt++) {
        const r = await fetch(recUrl + '.mp3', { headers });
        if (r.ok) audioBuf = Buffer.from(await r.arrayBuffer());
        else { console.warn('download failed', r.status); await new Promise(z => setTimeout(z, 2000)); }
      }
    } catch (e) { console.warn('download error', e.message); }
    const row = await db.insert({ token: newToken(), section, twilio_url: recUrl, recording_sid: p.RecordingSid, audio: audioBuf, content_type: 'audio/mpeg', duration: Number(p.RecordingDuration || 0), from_number: p.From || p.Caller || null });
    if (!row) return;
    console.log(`Saved recording ${row.id} to ${section} (${audioBuf ? audioBuf.length + ' bytes' : 'url only'})`);
    if (section === 'inbox') await notify(row, p);
  } catch (e) { console.error('recording-status error', e); }
});

async function callerNumber(p) {
  if (p.From || p.Caller) return p.From || p.Caller;
  if (!(TW_SID && TW_TOKEN && p.CallSid)) return 'unknown';
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Calls/${p.CallSid}.json`, { headers: { Authorization: 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64') } });
    if (r.ok) return (await r.json()).from || 'unknown';
  } catch (e) { /* ignore */ }
  return 'unknown';
}

async function notify(row, p) {
  if (!RESEND_KEY || !NOTIFY_EMAIL) return console.warn('notify: email not configured');
  const link = `${BASE}/r/${row.token}.mp3`;
  const from = await callerNumber(p);
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const body = { from: RESEND_FROM, to: NOTIFY_EMAIL.split(',').map(s => s.trim()), subject: `New hotline message (${p.RecordingDuration}s) from ${from}`,
    text: `A new message was left on the Wolcowitz Family Hotline (option 8).\n\nFrom: ${from}\nWhen: ${when} ET\nLength: ${p.RecordingDuration} seconds\nListen: ${link}\n\nTo publish it to a section, call the hotline, press 9, enter the admin PIN, then press 8 to review messages.`,
    html: `<p>A new message was left on the <b>Wolcowitz Family Hotline</b> (option 8).</p><p>From: ${esc(from)}<br>When: ${esc(when)} ET<br>Length: ${esc(p.RecordingDuration)} seconds</p><p><a href="${esc(link)}">Listen to the message</a></p><p>To publish it to a section, call the hotline, press 9, enter the admin PIN, then press 8 to review messages.</p>` };
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    console.log('notify email', r.status, await r.text());
  } catch (e) { console.error('notify error', e.message); }
}

app.use('/', tw);
app.use((err, req, res, next) => { console.error(err); twiml(res, audio('invalid') + redirect('/voice')); });

db.init().then(() => app.listen(PORT, () => console.log(`Hotline listening on ${PORT}, base ${BASE}`))).catch(e => { console.error('init failed', e); process.exit(1); });
