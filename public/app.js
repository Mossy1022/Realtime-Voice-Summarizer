// public/app.js
// Two-engine app:
//  - VOICE ENGINE (Realtime WebRTC): speaks back; we pass Summary + State for probing questions.
//  - SUMMARY/STATE ENGINE (REST): returns {summary} and {state} to render UI.
//
// Rules:
//  - During speech: throttle /summary (mode:'live') and /state (mode:'live').
//  - After assistant reply: call /summary(mode:'final') and /state(mode:'final').
//  - Display renders ONLY summaries, never voice text.

import React, { useEffect, useRef, useState } from 'https://esm.sh/react@18';

// ---------- helpers ----------

function waitForConnected(pc) {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const on = () => {
      if (pc.connectionState === 'connected') { pc.removeEventListener('connectionstatechange', on); resolve(); }
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { pc.removeEventListener('connectionstatechange', on); reject(new Error(`Peer connection ${pc.connectionState}`)); }
    };
    pc.addEventListener('connectionstatechange', on);
  });
}

async function connectRealtime() {
  const sessRes = await fetch('/session');
  if (!sessRes.ok) throw new Error('Failed to get ephemeral session');
  const { client_secret, base_url, model } = await sessRes.json();
  if (!client_secret) throw new Error('No client_secret returned');

  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  const audioEl = document.getElementById('assistant-audio');
  let remoteStream = new MediaStream();
  pc.ontrack = (ev) => {
    if (ev.track.kind === 'audio') {
      const stream = ev.streams?.[0] || remoteStream;
      if (!ev.streams?.length) stream.addTrack(ev.track);
      audioEl.srcObject = stream;
      audioEl.muted = false;
      audioEl.volume = 1.0;
      audioEl.play().catch(() => {});
    }
  };

  const dc = pc.createDataChannel('oai-events');

  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  for (const track of mic.getTracks()) pc.addTrack(track, mic);

  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch(`${base_url}?model=${encodeURIComponent(model)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client_secret}`, 'Content-Type': 'application/sdp' },
    body: offer.sdp
  });
  if (!sdpRes.ok) {
    const errTxt = await sdpRes.text();
    throw new Error(`SDP exchange failed: ${sdpRes.status} ${sdpRes.statusText} — ${errTxt}`);
  }
  const answer = { type: 'answer', sdp: await sdpRes.text() };
  await pc.setRemoteDescription(answer);

  const stop = () => {
    try { dc.close(); } catch {}
    try { pc.getSenders().forEach(s => s.track && s.track.stop()); } catch {}
    try { pc.close(); } catch {}
  };

  return { pc, dc, stop };
}

async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

function throttle(fn, ms) {
  let t = 0; let timer = 0; let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const now = Date.now(), rem = ms - (now - t);
    if (rem <= 0) { t = now; fn(...lastArgs); }
    else if (!timer) { timer = window.setTimeout(() => { t = Date.now(); timer = 0; fn(...lastArgs); }, rem); }
  };
}

// ---------- UI: very light diagram ----------

function renderViz(el, state) {
  if (!el) return;
  const cols = [
    ['goals', 'Goals'],
    ['facts', 'Facts'],
    ['questions', 'Questions'],
    ['options', 'Options'],
    ['decisions', 'Decisions'],
    ['next_steps', 'Next steps'],
    ['risks', 'Risks']
  ];
  const html = cols.map(([k, label]) => {
    const items = (state?.[k] || []).map(v => `<span class="pill">${escapeHtml(v)}</span>`).join('');
    return `<div class="card"><h4>${label}</h4>${items || '<div class="small">—</div>'}</div>`;
  }).join('');
  el.innerHTML = html;
}
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ---------- App ----------

export default function App() {
  const [status, setStatus] = useState('Idle');
  const [summary, setSummary] = useState('Say something and then pause…');

  const connRef = useRef(null);
  const transcriptRef = useRef([]); // [{role,text,ts}]
  const summaryRef = useRef('Say something and then pause…');
  const stateRef = useRef({ goals:[], facts:[], questions:[], options:[], decisions:[], next_steps:[], risks:[] });

  // VOICE engine trackers
  const voiceRidRef = useRef(null);
  const voiceTextBufRef = useRef('');
  const voiceBusyRef = useRef(false);
  const pendingVoiceRef = useRef(false);

  // SpeechRecognition
  const srRef = useRef(null);
  const srActiveRef = useRef(false);
  const interimRef = useRef('');

  // Tool-call tracking
const toolArgsByIdRef = useRef(new Map());   // call_id -> string (JSON buffer)
const toolNameByIdRef = useRef(new Map());   // call_id -> name

function applyStatePatch(patch) {
  const dst = stateRef.current;
  const uniq = (arr) => Array.from(new Set(arr.filter(Boolean).map(s => s.trim()).filter(Boolean)));
  if (patch?.add) {
    for (const k of Object.keys(patch.add)) {
      dst[k] = uniq([...(dst[k] || []), ...patch.add[k]]);
    }
  }
  if (patch?.remove) {
    for (const k of Object.keys(patch.remove)) {
      const rm = new Set(patch.remove[k].map(s => s.trim()));
      dst[k] = (dst[k] || []).filter(s => !rm.has(s.trim()));
    }
  }
  renderViz(document.getElementById('viz'), dst);
}

function sendToolOutput(callId, payload) {
  // Non-blocking ack; many runtimes accept this shape.
  try {
    connRef.current?.dc?.send(JSON.stringify({
      type: 'tool.output',
      tool_call_id: callId,
      output: JSON.stringify({ ok: true, ...payload })
    }));
  } catch {}
}


  // throttled REST calls
  const callLiveSummary = throttle(async () => {
    const out = await postJSON('/summary', {
      transcript: transcriptRef.current.map(({ role, text }) => ({ role, text })),
      partial: interimRef.current, mode: 'live'
    });
    if (out?.summary) { setSummary(out.summary); summaryRef.current = out.summary; }
    setStatus('Listening…');
  }, 900);

  const callLiveState = throttle(async () => {
    const out = await postJSON('/state', {
      transcript: transcriptRef.current.map(({ role, text }) => ({ role, text })),
      partial: interimRef.current, mode: 'live'
    });
    if (out?.state) {
      stateRef.current = out.state;
      renderViz(document.getElementById('viz'), stateRef.current);
    }
  }, 1100);

  async function callFinalSummaryAndState() {
    setStatus('Summarizing…');
    const [s, st] = await Promise.all([
      postJSON('/summary', { transcript: transcriptRef.current.map(({ role, text }) => ({ role, text })), mode: 'final' }),
      postJSON('/state',   { transcript: transcriptRef.current.map(({ role, text }) => ({ role, text })), mode: 'final' })
    ]);
    if (s?.summary) { setSummary(s.summary); summaryRef.current = s.summary; }
    if (st?.state) { stateRef.current = st.state; renderViz(document.getElementById('viz'), stateRef.current); }
    setStatus('Waiting for next turn…');
  }

  // ----- VOICE helpers -----

  function sendGreeting() {
    if (!connRef.current) return;
    voiceBusyRef.current = true;
    connRef.current.dc.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        metadata: { kind: 'voice_greeting' },
        instructions: 'Greet the user in English and ask: "What would you like to talk about?" Keep it brief.'
      }
    }));
  }

  function sendVoiceReply() {
    if (!connRef.current) return;
    if (voiceBusyRef.current) { pendingVoiceRef.current = true; return; }
    voiceBusyRef.current = true;
    voiceRidRef.current = null;
    voiceTextBufRef.current = '';

    // Give the model current context (summary + state) so it can probe gaps
    const context = [
      'Context Summary:', summaryRef.current,
      'Context State JSON:', JSON.stringify(stateRef.current)
    ].join('\n');

    connRef.current.dc.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        metadata: { kind: 'voice_turn' },
        instructions: [
          context,
          'Answer naturally in English to the most recent user utterance.',
          'Ask one short, targeted follow-up question that best fills a gap in the Context State.',
          'If useful, call update_state(add/remove) with short items; then continue speaking and ask one targeted follow-up.',
          'Avoid repeating the user verbatim.'
        ].join('\n')
      }
    }));
  }

  // ----- SpeechRecognition -----

  function startInterimRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || srActiveRef.current) return;
    const sr = new SR();
    sr.continuous = true;
    sr.interimResults = true;
    sr.lang = 'en-US';
    sr.onresult = async (e) => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0]?.transcript || '';
      interimRef.current = text.trim();
      if (interimRef.current.length >= 6) {
        // live REST updates (decoupled from voice)
        try { await Promise.allSettled([callLiveSummary(), callLiveState()]); } catch {}
      }
    };
    sr.onend = () => { srActiveRef.current = false; };
    sr.onerror = () => { srActiveRef.current = false; };
    sr.start();
    srRef.current = sr;
    srActiveRef.current = true;
  }
  function stopInterimRecognition() {
    try { srRef.current?.stop?.(); } catch {}
    srActiveRef.current = false;
  }

  // ----- Realtime event router (VOICE engine) -----

  function handleServerEvent(ev) {
    switch (ev?.type) {
      case 'input_audio_buffer.speech_started':
        startInterimRecognition();
        break;

      case 'input_audio_buffer.speech_stopped':
        stopInterimRecognition();
        if (interimRef.current.trim()) {
          transcriptRef.current.push({ role: 'user', text: interimRef.current.trim(), ts: Date.now() });
          interimRef.current = '';
        }
        sendVoiceReply();
        break;

      case 'response.created': {
        const id = ev?.response?.id;
        const mods = ev?.response?.modalities || [];
        if (id && mods.includes('audio')) {
          voiceRidRef.current = id;
          voiceTextBufRef.current = '';
        }
        break;
      }

      case 'response.output_text.delta':
      case 'response.text.delta': {
        const rid = ev?.response_id;
        if (rid && rid === voiceRidRef.current) {
          voiceTextBufRef.current += ev.delta || '';
        }
        break;
      }

       // Tool call started
    case 'response.function_call.created':
        case 'response.tool_call.created': {
          const id = ev?.call?.id || ev?.tool_call?.id || ev?.id;
          const name = ev?.call?.name || ev?.tool_call?.name || ev?.name;
          if (id) {
            toolArgsByIdRef.current.set(id, '');
            if (name) toolNameByIdRef.current.set(id, name);
          }
          break;
        }
    
        // Tool call argument streaming
        case 'response.function_call.arguments.delta':
        case 'response.tool_call.arguments.delta': {
          const id = ev?.call_id || ev?.tool_call_id || ev?.id || ev?.response_id;
          const d = ev?.delta || '';
          if (id && d) {
            const prev = toolArgsByIdRef.current.get(id) || '';
            toolArgsByIdRef.current.set(id, prev + d);
          }
          break;
        }
    
        // Tool call finished
        case 'response.function_call.completed':
        case 'response.tool_call.completed': {
          const id = ev?.call_id || ev?.tool_call_id || ev?.id;
          const name = toolNameByIdRef.current.get(id);
          const raw = toolArgsByIdRef.current.get(id) || '{}';
          let args = {};
          try { args = JSON.parse(raw); } catch { /* ignore */ }
    
          if (name === 'update_state') {
            applyStatePatch(args);
            // Optional: immediately tighten the summary after tool effect
            callFinalSummaryAndState();
          }
    
          sendToolOutput(id, { received: true });
          toolArgsByIdRef.current.delete(id);
          toolNameByIdRef.current.delete(id);
          break;
        }

      case 'response.completed':
      case 'response.done': {
        const rid = ev?.response_id;
        if (rid && rid === voiceRidRef.current) {
          voiceBusyRef.current = false;
          const a = voiceTextBufRef.current.trim();
          if (a) transcriptRef.current.push({ role: 'assistant', text: a, ts: Date.now() });
          voiceRidRef.current = null;
          voiceTextBufRef.current = '';
          if (pendingVoiceRef.current) { pendingVoiceRef.current = false; sendVoiceReply(); }
          // Final authoritative refresh for summary + state
          callFinalSummaryAndState();
        }
        break;
      }

      case 'response.error':
      case 'error':
        console.error('[realtime] error', ev);
        setStatus('Model error (see console)');
        voiceBusyRef.current = true; // wait for resolution before sending again
        break;

      default:
        break;
    }
  }

  // ----- Connect / Disconnect -----

  async function onConnect() {
    setStatus('Connecting…');
    try {
      const conn = await connectRealtime();
      connRef.current = conn;

      document.getElementById('assistant-audio')?.play?.().catch(() => {});

      conn.dc.onmessage = (msg) => { try { handleServerEvent(JSON.parse(msg.data)); } catch {} };
      conn.dc.onopen = async () => {
        setStatus('Negotiating…');
        try {
          await waitForConnected(conn.pc);
          setStatus('Mic live. Prompting…');
          renderViz(document.getElementById('viz'), stateRef.current);
          sendGreeting();
          document.getElementById('test-voice').disabled = false;
        } catch (e) {
          setStatus(`Connection failed: ${/** @type {Error} */(e).message}`);
        }
      };
      conn.dc.onclose = () => {
        setStatus('Disconnected');
        document.getElementById('test-voice').disabled = true;
        stopInterimRecognition();
        voiceRidRef.current = null;
        voiceTextBufRef.current = '';
        voiceBusyRef.current = false;
        pendingVoiceRef.current = false;
      };
    } catch (err) {
      setStatus(`Error: ${/** @type {Error} */(err).message}`);
    }
  }

  function onDisconnect() {
    connRef.current?.stop();
    connRef.current = null;
    setStatus('Idle');
    document.getElementById('test-voice').disabled = true;
    stopInterimRecognition();
    transcriptRef.current = [];
    voiceRidRef.current = null;
    voiceTextBufRef.current = '';
    voiceBusyRef.current = false;
    pendingVoiceRef.current = false;
  }

  function sendTestVoice() {
    if (!connRef.current) return;
    if (voiceBusyRef.current) { pendingVoiceRef.current = true; return; }
    voiceBusyRef.current = true;
    connRef.current.dc.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        metadata: { kind: 'voice_test' },
        instructions: 'Say: "Testing voice pipeline in English." Keep it short.'
      }
    }));
  }

  useEffect(() => {
    const connectBtn = document.getElementById('connect');
    const disconnectBtn = document.getElementById('disconnect');
    const testBtn = document.getElementById('test-voice');
    const statusEl = document.getElementById('status');
    const summaryEl = document.getElementById('summary');

    connectBtn.onclick = onConnect;
    disconnectBtn.onclick = onDisconnect;
    testBtn.onclick = sendTestVoice;

    const i = setInterval(() => {
      disconnectBtn.disabled = !connRef.current;
      if (statusEl) statusEl.textContent = status;
      if (summaryEl) summaryEl.textContent = summary;
    }, 200);
    return () => clearInterval(i);
  }, [status, summary]);

  return React.createElement(React.Fragment, null);
}
