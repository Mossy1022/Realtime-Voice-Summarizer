// server.mjs
// Static server + three endpoints:
// 1) GET  /session  -> Ephemeral WebRTC session for VOICE (Realtime) [audio + text]
// 2) POST /summary  -> REST summarizer (Responses API)
// 3) POST /state    -> REST extractor producing "Perspective State" JSON
// Node 18+ (global fetch). No deps.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

async function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}


/**
 * Create an ephemeral Realtime session for VOICE (WebRTC).
 * Tools:
 *  - update_state(add/remove arrays)
 *  - persist_session(note)
 */
async function createEphemeralSession() {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

  const body = {
    model: 'gpt-realtime',
    modalities: ['audio', 'text'],
    voice: 'alloy',
    instructions: [
      'You are the Perspective Coach. Speak English (US).',
      'Purpose: help the user clarify goals, facts, constraints, options, decisions, next steps, risks.',
      'When appropriate, call update_state with a small patch (add/remove arrays).',
      'You may also call persist_session to save a durable snapshot; you will receive a session_id in the tool output.',
      'Do NOT begin a new response unless the client sends response.create.',
      'After any tool use, continue speaking naturally and ask one targeted follow-up that best fills a gap.'
    ].join(' ')
    // tools: [
    // {
    //     type: 'function',
    //     name: 'definition_greeter',
    //     description: 'Collect decision definition pieces (title, scope, time window, participants, axes).',
    //     parameters: {
    //       type: 'object',
    //       properties: {
    //         status: { type:'string', enum:['collecting','complete'] },
    //         pack: {
    //           type:'object',
    //           properties:{
    //             title:{type:'string'}, scope:{type:'string'}, time_window:{type:'string'},
    //             participants:{type:'array', items:{type:'string'}},
    //             axes:{type:'array', items:{type:'string'}}
    //           }
    //         }
    //       },
    //       additionalProperties: false
    //     }
    //   },
    //   {
    //     type: 'function',
    //     name: 'update_state',
    //     description: 'Add or remove short items in the live Perspective State.',
    //     parameters: {
    //       type: 'object',
    //       properties: {
    //         add: {
    //           type: 'object',
    //           properties: {
    //             goals: { type: 'array', items: { type: 'string' } },
    //             facts: { type: 'array', items: { type: 'string' } },
    //             questions: { type: 'array', items: { type: 'string' } },
    //             options: { type: 'array', items: { type: 'string' } },
    //             decisions: { type: 'array', items: { type: 'string' } },
    //             next_steps: { type: 'array', items: { type: 'string' } },
    //             risks: { type: 'array', items: { type: 'string' } }
    //           },
    //           additionalProperties: false
    //         },
    //         remove: {
    //           type: 'object',
    //           properties: {
    //             goals: { type: 'array', items: { type: 'string' } },
    //             facts: { type: 'array', items: { type: 'string' } },
    //             questions: { type: 'array', items: { type: 'string' } },
    //             options: { type: 'array', items: { type: 'string' } },
    //             decisions: { type: 'array', items: { type: 'string' } },
    //             next_steps: { type: 'array', items: { type: 'string' } },
    //             risks: { type: 'array', items: { type: 'string' } }
    //           },
    //           additionalProperties: false
    //         }
    //       },
    //       additionalProperties: false
    //     }
    //   },
    //   {
    //     type: 'function',
    //     name: 'persist_session',
    //     description: 'Ask the host app to persist the current summary and state; returns a session_id you can reference later.',
    //     parameters: {
    //       type: 'object',
    //       properties: {
    //         note: { type: 'string', description: 'Optional note or title for this save point.' }
    //       },
    //       additionalProperties: false
    //     }
    //   }
    // ]
  };

  const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'realtime=v1'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Failed to create session: ${res.status} ${res.statusText} — ${txt}`);
  }
  const j = await res.json();
  return {
    client_secret: j?.client_secret?.value || null,
    base_url: 'https://api.openai.com/v1/realtime',
    model: j?.model || 'gpt-realtime'
  };
}

/** ---------- SUMMARY ENGINE ---------- */
async function summarize(payload) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

  const { transcript = [], partial = '', mode = 'final' } = payload || {};
  const lines = transcript
    .slice(-30)
    .map(({ role, text }) => `${role.toUpperCase()}: ${text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  const prompt = [
    'You are a real-time conversation summarizer.',
    'Return ONE updated summary (1–2 sentences) of the conversation so far.',
    'Capture intent, decisions, constraints, and next steps; avoid parroting.',
    mode === 'live'
      ? 'A partial, in-progress user utterance may be included; integrate it cautiously.'
      : 'This is a definitive post-turn refresh; include the latest assistant reply.',
    '',
    'Transcript (most recent last):',
    lines || '(no prior turns)',
    partial ? `\nPartial user utterance: ${partial.replace(/\s+/g, ' ').trim()}` : '',
    '',
    'Output: ONLY the updated summary as plain text.'
  ].join('\n');

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', input: prompt })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Summarizer error: ${res.status} ${res.statusText} — ${txt}`);
  }
  const data = await res.json();
  let text = '';
  if (Array.isArray(data.output_text)) text = data.output_text.join('');
  else if (typeof data.output_text === 'string') text = data.output_text;
  else if (data.output?.[0]?.content?.[0]?.text) text = data.output[0].content[0].text;
  else if (data.content?.[0]?.text) text = data.content[0].text;
  else if (typeof data.text === 'string') text = data.text;
  return { summary: (text || '').trim() };
}

/** ---------- STATE EXTRACTOR ---------- */
async function extractState(payload) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

  const { transcript = [], partial = '', mode = 'final' } = payload || {};
  const lines = transcript
    .slice(-30)
    .map(({ role, text }) => `${role.toUpperCase()}: ${text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  const prompt = [
    'Extract a compact "Perspective State" JSON from the conversation.',
    'Keys: goals, facts, questions, options, decisions, next_steps, risks. Each is an array of short strings.',
    mode === 'live'
      ? 'Partial user utterance may be present; include cautiously (no quotes).'
      : 'Definitive refresh; collapse repetition.',
    '',
    'Transcript (most recent last):',
    lines || '(no prior turns)',
    partial ? `\nPartial user utterance: ${partial.replace(/\s+/g, ' ').trim()}` : ''
  ].join('\n');

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', input: prompt })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`State extractor error: ${res.status} ${res.statusText} — ${txt}`);
  }
  const data = await res.json();
  let raw = '';
  if (Array.isArray(data.output_text)) raw = data.output_text.join('');
  else if (typeof data.output_text === 'string') raw = data.output_text;
  else if (data.output?.[0]?.content?.[0]?.text) raw = data.output[0].content[0].text;
  else if (data.content?.[0]?.text) raw = data.content[0].text;
  else if (typeof data.text === 'string') raw = data.text;

  let state = { goals:[], facts:[], questions:[], options:[], decisions:[], next_steps:[], risks:[] };
  try { state = JSON.parse(raw); }
  catch {
    const i = raw.indexOf('{'); const j = raw.lastIndexOf('}');
    if (i !== -1 && j !== -1 && j > i) { try { state = JSON.parse(raw.slice(i, j + 1)); } catch {} }
  }
  for (const k of ['goals','facts','questions','options','decisions','next_steps','risks']) {
    if (!Array.isArray(state[k])) state[k] = [];
    state[k] = state[k].filter(v => typeof v === 'string').slice(0, 12);
  }
  return { state };
}

function proposePrompt({ transcript = [], focus = '', mode = 'final' }) {
  const lines = transcript.slice(-30)
    .map(({ role, text }) => `${role.toUpperCase()}: ${text.replace(/\s+/g,' ').trim()}`)
    .join('\n');
  return [
    'You are Reason-Scout. From the conversation and focus, propose a SMALL batch of actions.',
    'Return a JSON object with a single key "proposals": an array of 3..8 items.',
    'Each item is one of:',
    '- {"type":"add_option","option":"string"}',
    '- {"type":"add_criterion","criterion":"string"}',
    '- {"type":"set_cell","option":"string","criterion":"string","weight":-100..100,"conf":0..1,"rationale":"short","anchors":["LifeArea","..."]}',
    'LifeArea ∈ {Work, Health, Finances, Relationships, Identity, Logistics}.',
    'No commentary outside the JSON object.',
    '',
    `Focus: ${focus || '(none)'}\nTranscript:\n${lines || '(none)'}`
  ].join('\n');
}

function proposeLocalFallback({ transcript = [], focus = '' } = {}) {
  const text = (transcript || []).map(t => (t?.text || '')).join(' ').toLowerCase();

  const opts = new Set();
  if (/st\.?\s*pete|st\s*petersburg/.test(text)) opts.add('Move to St. Pete');
  if (/\bbrandon\b/.test(text))                 opts.add('Stay in Brandon');

  const props = Array.from(opts).map(option => ({ type:'add_option', option }));

  // A few sensible criteria for housing/location decisions
  ['cost','commute','community','noise','family distance'].slice(0, 3)
    .forEach(c => props.push({ type:'add_criterion', criterion:c }));

  return { proposals: props.slice(0, 8) };
}


/** ---------- static files ---------- */
function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = requestUrl.pathname.replace(/\/+$/, '');
  if (pathname === '') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.js'   ? 'text/javascript; charset=utf-8' :
      ext === '.css'  ? 'text/css; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname.replace(/\/+$/, '');

    const cors = () => res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && pathname === '/session') {
      cors();
      const session = await createEphemeralSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
      return;
    }

    if (pathname === '/summary') {
      cors();
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }); res.end(); return;
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
      const body = await readJson(req);
      const out = await summarize(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    if (pathname === '/propose') {
      cors();
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }); res.end(); return;
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    
      let proposals = [];
      try {
        const body = await readJson(req);
        const prompt = proposePrompt(body || {});
    
        if (OPENAI_API_KEY) {
          // Primary call (no text.format)
          let r = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-4o-mini', input: prompt })
          }).catch(err => ({ ok:false, _err: err }));
    
          // Fallback
          if (!r?.ok) {
            try { console.error('[propose primary error]', r?._err ? r._err : (await r.text())); } catch {}
            r = await fetch('https://api.openai.com/v1/responses', {
              method: 'POST',
              headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'gpt-4o-mini', input: prompt })
            }).catch(err => ({ ok:false, _err: err }));
          }
    
          if (r?.ok) {
            const j = await r.json().catch(()=> ({}));
            let raw = j?.output_text
                    || j?.output?.[0]?.content?.[0]?.text
                    || j?.content?.[0]?.text
                    || (typeof j === 'string' ? j : '');
            if (typeof raw !== 'string') raw = '';
    
            try {
              const obj = raw ? JSON.parse(raw) : null;
              if (obj && Array.isArray(obj.proposals)) proposals = obj.proposals;
              else if (Array.isArray(obj)) proposals = obj;
            } catch {
              const i = raw.indexOf('['), k = raw.lastIndexOf(']');
              if (i >= 0 && k > i) { try { proposals = JSON.parse(raw.slice(i, k+1)); } catch {} }
            }
          }
        }
    
        if (!Array.isArray(proposals) || proposals.length === 0) {
          proposals = proposeLocalFallback(body).proposals;
        }
      } catch (e) {
        console.error('[propose fatal]', e?.stack || e);
        proposals = [];
      }
    
      proposals = proposals.slice(0, 12);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proposals }));
      return;
    }
    

    if (pathname === '/state') {
      cors();
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }); res.end(); return;
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
      const body = await readJson(req);
      const out = await extractState(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    serveStatic(req, res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Server error: ${/** @type {Error} */(err).message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
