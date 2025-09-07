// public/app.js
// Two-engine architecture:
// - VOICE ENGINE: WebRTC Realtime (audio + text for transcript only).
// - SUMMARY ENGINE: REST /summary (independent). UI renders ONLY summaries.
//
// Fixes:
// - Explicitly create a voice response on end-of-speech (no more silent turns).
// - During speech, call the REST summarizer in 'live' mode (contextual live updates; no parroting).
// - After the assistant finishes talking, call a 'final' summary and render it.
// - Strict single-flight per engine; display never shows voice text.

import React, { useEffect, useRef, useState } from 'https://esm.sh/react@18';

/** Wait for RTCPeerConnection to be fully connected. */
function waitForConnected(pc) {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onChange = () => {
      if (pc.connectionState === 'connected') {
        pc.removeEventListener('connectionstatechange', onChange);
        resolve();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.removeEventListener('connectionstatechange', onChange);
        reject(new Error(`Peer connection ${pc.connectionState}`));
      }
    };
    pc.addEventListener('connectionstatechange', onChange);
  });
}

/** Create the VOICE engine session (WebRTC). */
async function connectRealtime() {
  const sessRes = await fetch('/session');
  if (!sessRes.ok) throw new Error('Failed to get ephemeral session');
  const { client_secret, base_url, model } = await sessRes.json();
  if (!client_secret) throw new Error('No client_secret returned');

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // Negotiate an m=audio recv line
  pc.addTransceiver('audio', { direction: 'recvonly' });

  // Remote audio playback
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

  // Data channel for JSON events
  const dc = pc.createDataChannel('oai-events');

  // Mic to peer
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  for (const track of mic.getTracks()) pc.addTrack(track, mic);

  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch(`${base_url}?model=${encodeURIComponent(model)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${client_secret}`,
      'Content-Type': 'application/sdp'
    },
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

/** REST summarizer. */
async function callSummarizer(payload) {
  const res = await fetch('/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Summarizer ${res.status}`);
  const j = await res.json();
  return j?.summary || '';
}

/** Throttle helper. */
function throttle(fn, ms) {
  let t = 0; let timer = 0; let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const now = Date.now(), rem = ms - (now - t);
    if (rem <= 0) { t = now; fn(...lastArgs); }
    else if (!timer) {
      timer = window.setTimeout(() => { t = Date.now(); timer = 0; fn(...lastArgs); }, rem);
    }
  };
}

export default function App() {
  const [status, setStatus] = useState('Idle');
  const [summary, setSummary] = useState('Say something and then pause…');

  const connRef = useRef(null);

  // Conversation transcript we feed the summarizer
  /** @type {React.MutableRefObject<Array<{role:'user'|'assistant', text:string, ts:number}>>} */
  const transcriptRef = useRef([]);

  // VOICE engine state
  const voiceRidRef = useRef(null);
  const voiceTextBufRef = useRef('');
  const voiceBusyRef = useRef(false);
  const pendingVoiceRef = useRef(false);

  // User speech via Web Speech API (for 'live' summaries)
  const srRef = useRef(null);
  const srActiveRef = useRef(false);
  const interimRef = useRef('');

  // Summary engine gates
  const liveInFlightRef = useRef(false);
  const finalInFlightRef = useRef(false);

  /** Proactive greeting (audio + text; UI ignores the text). */
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

  /** Explicitly ask the voice engine to answer after user speech stops. */
  function sendVoiceReply() {
    if (!connRef.current) return;
    if (voiceBusyRef.current) { pendingVoiceRef.current = true; return; }
    voiceBusyRef.current = true;
    voiceRidRef.current = null;
    voiceTextBufRef.current = '';
    connRef.current.dc.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        metadata: { kind: 'voice_turn' },
        instructions: [
          'Answer naturally in English to the most recent user utterance.',
          'Do not repeat the user verbatim; respond to their intent and advance the conversation.'
        ].join(' ')
      }
    }));
  }

  /** Start interim ASR and stream live summaries via REST (decoupled). */
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
      // Live, contextual summary (REST) — throttle + single-flight
      requestLiveSummary();
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

  const requestLiveSummary = throttle(async () => {
    if (!interimRef.current || interimRef.current.trim().length < 6) return;
    if (liveInFlightRef.current) return;
    liveInFlightRef.current = true;
    try {
      const out = await callSummarizer({
        transcript: transcriptRef.current.map(({ role, text }) => ({ role, text })),
        partial: interimRef.current,
        mode: 'live'
      });
      if (out) setSummary(out);
      setStatus('Listening…');
    } catch (e) {
      // quiet fail for live
    } finally {
      liveInFlightRef.current = false;
    }
  }, 900);

  async function requestFinalSummary() {
    if (finalInFlightRef.current) return;
    finalInFlightRef.current = true;
    setStatus('Summarizing…');
    try {
      const out = await callSummarizer({
        transcript: transcriptRef.current.map(({ role, text }) => ({ role, text })),
        mode: 'final'
      });
      if (out) setSummary(out);
      setStatus('Waiting for next turn…');
    } catch (e) {
      console.error('Summarizer error:', e);
      setStatus('Summary error');
    } finally {
      finalInFlightRef.current = false;
    }
  }

  /** Route VOICE engine events. */
  function handleServerEvent(ev) {
    switch (ev?.type) {
      // User VAD
      case 'input_audio_buffer.speech_started':
        startInterimRecognition();
        break;

      case 'input_audio_buffer.speech_stopped':
        stopInterimRecognition();
        // Commit the last interim as a user turn
        if (interimRef.current.trim()) {
          transcriptRef.current.push({ role: 'user', text: interimRef.current.trim(), ts: Date.now() });
          interimRef.current = '';
        }
        // Explicitly ask the voice engine to answer
        sendVoiceReply();
        break;

      // New response created; track voice responses
      case 'response.created': {
        const id = ev?.response?.id;
        const mods = ev?.response?.modalities || [];
        if (id && mods.includes('audio')) {
          voiceRidRef.current = id;
          voiceTextBufRef.current = '';
        }
        break;
      }

      // Capture assistant text for transcript (not rendered)
      case 'response.output_text.delta':
      case 'response.text.delta': {
        const rid = ev?.response_id;
        if (rid && rid === voiceRidRef.current) {
          voiceTextBufRef.current += ev.delta || '';
        }
        break;
      }

      // Voice/text response finished
      case 'response.completed':
      case 'response.done': {
        const rid = ev?.response_id;
        if (rid && rid === voiceRidRef.current) {
          voiceBusyRef.current = false;
          const a = voiceTextBufRef.current.trim();
          if (a) transcriptRef.current.push({ role: 'assistant', text: a, ts: Date.now() });
          voiceRidRef.current = null;
          voiceTextBufRef.current = '';
          // Queue handling: if user spoke again during the reply, send next reply
          if (pendingVoiceRef.current) { pendingVoiceRef.current = false; sendVoiceReply(); }
          // Final, authoritative summary now that the assistant finished
          requestFinalSummary();
        }
        break;
      }

      case 'response.error':
      case 'error': {
        // Most common: conversation_already_has_active_response -> we'll wait for done and retry next time.
        console.error('[realtime] error', ev);
        voiceBusyRef.current = true;
        break;
      }

      default:
        break;
    }
  }

  /** Connect / Disconnect */
  async function onConnect() {
    setStatus('Connecting…');
    try {
      const conn = await connectRealtime();
      connRef.current = conn;

      // Unlock autoplay on click
      document.getElementById('assistant-audio')?.play?.().catch(() => {});

      conn.dc.onmessage = (msg) => {
        try { handleServerEvent(JSON.parse(msg.data)); } catch {}
      };
      conn.dc.onopen = async () => {
        setStatus('Negotiating…');
        try {
          await waitForConnected(conn.pc);
          setStatus('Mic live. Prompting…');
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
