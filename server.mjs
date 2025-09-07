// server.mjs
// Static server + two OpenAI entry points:
// 1) /session  -> Ephemeral WebRTC session for VOICE (Realtime) [audio + text]
// 2) /summary  -> REST summarizer (Responses API), decoupled from voice
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

/** Ephemeral Realtime session for VOICE (WebRTC). */
async function createEphemeralSession() {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

  const body = {
    model: 'gpt-realtime',
    modalities: ['audio', 'text'], // text for transcript only; UI won’t render it
    voice: 'alloy',
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
    instructions: [
      'You are a helpful voice assistant.',
      'Speak only in English (US).',
      'Respond naturally via audio to each user utterance. Provide concise text alongside audio for transcription.',
      'Do not send standalone summaries unless explicitly requested.'
    ].join(' ')
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

/** REST summarizer: { transcript:[{role,text}], partial?, mode:'live'|'final' } -> { summary } */
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
    'Capture intent, decisions, constraints, next steps. Avoid parroting or quotes.',
    mode === 'live'
      ? 'You may receive a partial, in-progress user utterance; integrate it cautiously without echoing.'
      : 'This is a definitive post-turn refresh; ensure it reflects the latest assistant reply.',
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

/** Static files */
function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = requestUrl.pathname.replace(/\/+$/, ''); // strip trailing slash
  if (pathname === '') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.js' ? 'text/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname.replace(/\/+$/, ''); // normalize

    // Ephemeral session for voice (GET /session)
    if (req.method === 'GET' && pathname === '/session') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const session = await createEphemeralSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
      return;
    }

    // REST summarizer (POST /summary) + CORS preflight
    if (pathname === '/summary') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
      const body = await readJson(req);
      const out = await summarize(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    // Static
    serveStatic(req, res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Server error: ${/** @type {Error} */(err).message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
