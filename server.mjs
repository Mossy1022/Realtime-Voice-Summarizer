// server.mjs
// Static server + three endpoints:
// 1) GET  /session  -> Ephemeral WebRTC session for VOICE (Realtime) [audio + text]
// 2) POST /summary  -> REST summarizer (Responses API)
// 3) POST /state    -> REST extractor that produces a compact "Perspective State" JSON
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
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * VOICE ENGINE (Realtime / WebRTC)
 * We do NOT target a "Custom GPT". Realtime expects a base model with instructions and optional tools.
 * We give it a tight persona geared to probing for missing info (Perspective Coach).
 */
async function createEphemeralSession() {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  
    const body = {
      model: 'gpt-realtime',
      modalities: ['audio', 'text'], // text only for transcript/logging
      voice: 'alloy',
      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
  
      // 1) Voice persona that knows a tool exists.
      instructions: [
        'You are the Perspective Coach. Speak English (US).',
        'Purpose: help the user clarify goals, facts, constraints, options, decisions, next steps, risks.',
        'When appropriate, call the tool update_state with a small patch (add/remove arrays) to update the live state.',
        'After updating state, continue speaking naturally and ask one targeted follow-up. Do not wait for tool results.'
      ].join(' '),
  
      // 2) Tool schema the model can call
      tools: [
        {
          type: 'function',
          name: 'update_state',
          description: 'Add or remove short items in the live Perspective State.',
          parameters: {
            type: 'object',
            properties: {
              add: {
                type: 'object',
                properties: {
                  goals: { type: 'array', items: { type: 'string' } },
                  facts: { type: 'array', items: { type: 'string' } },
                  questions: { type: 'array', items: { type: 'string' } },
                  options: { type: 'array', items: { type: 'string' } },
                  decisions: { type: 'array', items: { type: 'string' } },
                  next_steps: { type: 'array', items: { type: 'string' } },
                  risks: { type: 'array', items: { type: 'string' } }
                },
                additionalProperties: false
              },
              remove: {
                type: 'object',
                properties: {
                  goals: { type: 'array', items: { type: 'string' } },
                  facts: { type: 'array', items: { type: 'string' } },
                  questions: { type: 'array', items: { type: 'string' } },
                  options: { type: 'array', items: { type: 'string' } },
                  decisions: { type: 'array', items: { type: 'string' } },
                  next_steps: { type: 'array', items: { type: 'string' } },
                  risks: { type: 'array', items: { type: 'string' } }
                },
                additionalProperties: false
              }
            },
            additionalProperties: false
          }
        }
      ]
    };
  
    const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
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
  

/**
 * SUMMARY ENGINE
 * Input:  { transcript:[{role,text}], partial?, mode:'live'|'final' }
 * Output: { summary:string }
 */
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
    'Capture intent, decisions, constraints, and next steps; avoid quoting or paraphrasing verbatim.',
    mode === 'live'
      ? 'A partial, in-progress user utterance may be included; integrate it cautiously without echoing.'
      : 'This is a definitive post-turn refresh; reflect the latest assistant reply.',
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

/**
 * STATE EXTRACTOR (Perspective State)
 * Input:  { transcript:[{role,text}], partial?, mode:'live'|'final' }
 * Output: { state:{goals,facts,questions,options,decisions,next_steps,risks} }
 * We ask for strict JSON; we still harden with a best-effort JSON parse.
 */
async function extractState(payload) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

  const { transcript = [], partial = '', mode = 'final' } = payload || {};
  const lines = transcript
    .slice(-30)
    .map(({ role, text }) => `${role.toUpperCase()}: ${text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  const schema = `{
    "goals":        {"type":"array","items":{"type":"string"}},
    "facts":        {"type":"array","items":{"type":"string"}},
    "questions":    {"type":"array","items":{"type":"string"}},
    "options":      {"type":"array","items":{"type":"string"}},
    "decisions":    {"type":"array","items":{"type":"string"}},
    "next_steps":   {"type":"array","items":{"type":"string"}},
    "risks":        {"type":"array","items":{"type":"string"}}
  }`;

  const prompt = [
    'Extract a compact "Perspective State" JSON from the conversation.',
    'Focus on abstractions; deduplicate; keep each item short and specific.',
    mode === 'live'
      ? 'Partial user utterance may be present; include provisional items cautiously (no quotes).'
      : 'This is a definitive refresh; collapse repetition.',
    '',
    'Return ONLY a JSON object with exactly these top-level keys:',
    'goals, facts, questions, options, decisions, next_steps, risks.',
    'Each must be an array of strings.',
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

  // Hardened JSON extraction
  let state = {
    goals: [], facts: [], questions: [], options: [], decisions: [], next_steps: [], risks: []
  };
  try {
    // try direct parse
    state = JSON.parse(raw);
  } catch {
    // try to locate first {...} block
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i !== -1 && j !== -1 && j > i) {
      try { state = JSON.parse(raw.slice(i, j + 1)); } catch {}
    }
  }
  // Final shape guard
  for (const k of ['goals','facts','questions','options','decisions','next_steps','risks']) {
    if (!Array.isArray(state[k])) state[k] = [];
    state[k] = state[k].filter(v => typeof v === 'string').slice(0, 12);
  }
  return { state };
}

/** Static files */
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

    // CORS preflight helper
    const withCORS = () => res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && pathname === '/session') {
      withCORS();
      const session = await createEphemeralSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
      return;
    }

    if (pathname === '/summary') {
      withCORS();
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

    if (pathname === '/state') {
      withCORS();
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
