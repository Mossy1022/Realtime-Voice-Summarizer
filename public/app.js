// public/app.js
// PTT + single-finalize-per-turn + robust transcription + auto-reply cancel while holding
// - VAD ON for transcripts (server_vad) — configured on connect
// - Cancel any response.created that happens while SPACE is held (no talk-over)
// - Mute remote audio during PTT and while a canceled auto-reply is being cleared
// - Run /state and /summary once per assistant response
// - Handle tool calls via response.create { tool_outputs: [...] }
// - Early (live) /state refresh on input_audio_transcription.completed for snappier viz
// - Force input_audio_buffer.commit on keyup to guarantee a user turn

import React, { useEffect, useRef, useState } from 'https://esm.sh/react@18';

function now(){ return new Date().toISOString().split('T')[1].replace('Z',''); }
function log(...a){ console.log(`[app ${now()}]`, ...a); }

// --- small helpers ---
function withTimeout(p, ms, tag='timeout'){ return Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error(tag)), ms))]); }
function waitIce(pc, ms=2500){
  if(pc.iceGatheringState==='complete') return Promise.resolve();
  return withTimeout(new Promise(res=>{
    const h=()=>{ if(pc.iceGatheringState==='complete'){ pc.removeEventListener('icegatheringstatechange',h); res(); } };
    pc.addEventListener('icegatheringstatechange',h);
  }), ms).catch(()=>{});
}

// --- WebRTC connect ---
async function connectRealtime(){
  const sRes=await fetch('/session');
  if(!sRes.ok) throw new Error('Failed to get ephemeral session');
  const { client_secret, base_url, model } = await sRes.json();
  if(!client_secret) throw new Error('No client_secret returned');

  const pc=new RTCPeerConnection({
    iceServers:[
      { urls:'stun:stun.l.google.com:19302' },
      { urls:'stun:stun1.l.google.com:19302' }
    ]
  });
  pc.oniceconnectionstatechange=()=>log('[ice]', pc.iceConnectionState);
  pc.onconnectionstatechange=()=>log('[pc]', pc.connectionState);
  pc.onicegatheringstatechange=()=>log('[gather]', pc.iceGatheringState);

  // remote audio
  const audioEl=document.getElementById('assistant-audio');
  const remoteStream=new MediaStream();
  pc.addTransceiver('audio',{ direction:'recvonly' });
  pc.ontrack=(ev)=>{
    if(ev.track.kind!=='audio') return;
    const stream=ev.streams?.[0]||remoteStream;
    if(!ev.streams?.length) stream.addTrack(ev.track);
    audioEl.srcObject=stream;
    audioEl.muted=false; audioEl.volume=1.0;
    audioEl.play().catch(()=>{});
  };

  // data channel
  let dc=pc.createDataChannel('oai-events',{ ordered:true });
  const routerRef={ current:null };
  function attachDC(ch,label){
    dc=ch;
    dc.onopen = ()=>log('[dc] open', label||'client');
    dc.onclose= ()=>log('[dc] close', label||'client');
    dc.onerror= (e)=>log('[dc] error', e?.message||e);
    dc.onmessage=(msg)=>{
      let ev=null; try{ ev=JSON.parse(msg.data); }catch{ log('[dc<- raw]', msg.data); return; }
      if(ev?.type) log('[dc<-]', ev.type);
      routerRef.current?.(ev);
    };
  }
  attachDC(dc,'client');
  pc.ondatachannel=(ev)=>attachDC(ev.channel,'server');

  // mic
  const micStream=await navigator.mediaDevices.getUserMedia({
    audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true }
  });
  const micTrack=micStream.getAudioTracks()[0]||null;
  if(micTrack && 'contentHint' in micTrack) micTrack.contentHint='speech';
  const micSender = micTrack ? pc.addTrack(micTrack, micStream) : null;

  // SDP
  const offer=await pc.createOffer({ offerToReceiveAudio:true });
  await pc.setLocalDescription(offer);
  await waitIce(pc, 2500);
  const sdp=pc.localDescription?.sdp || offer.sdp || '';

  const sdpRes=await withTimeout(fetch(`${base_url}?model=${encodeURIComponent(model)}`,{
    method:'POST',
    headers:{ Authorization:`Bearer ${client_secret}`, 'Content-Type':'application/sdp', 'OpenAI-Beta':'realtime=v1' },
    body:sdp
  }), 8000,'sdp-post-timeout');
  if(!sdpRes.ok) throw new Error(`SDP exchange failed: ${sdpRes.status} ${sdpRes.statusText}`);
  const answer={ type:'answer', sdp: await sdpRes.text() };
  await pc.setRemoteDescription(answer);

  function stop(){
    try{ dc?.close(); }catch{}
    try{ pc.getSenders().forEach(s=>s.track&&s.track.stop()); }catch{}
    try{ pc.close(); }catch{}
  }

  return { pc, get dc(){ return dc; }, setHandler(fn){ routerRef.current=fn; }, stop, micTrack, micSender, remoteStream };
}

// --- POST JSON ---
async function postJSON(url, body){
  const res=await fetch(url,{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  if(!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

// --- viz ---
function renderViz(el, state){
  if(!el) return;
  const cols=[ ['goals','Goals'], ['facts','Facts'], ['questions','Questions'], ['options','Options'], ['decisions','Decisions'], ['next_steps','Next steps'], ['risks','Risks'] ];
  el.innerHTML=cols.map(([k,label])=>{
    const items=(state?.[k]||[]).map(v=>`<span class="pill">${escapeHtml(v)}</span>`).join('');
    return `<div class="card"><h4>${label}</h4>${items || '<div class="small">—</div>'}</div>`;
  }).join('');
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function genId(prefix){ const n=Math.random().toString(36).slice(2,7); return `${prefix}_${Date.now().toString(36)}${n}`; }

// --- tokens ---
const STOP=new Set('a,an,the,of,to,in,on,for,with,from,into,by,at,as,and,or,not,no,just,only,that,this,those,these,over,under,near,about,around,after,before,than,then,there,is,are,be,been,being,do,does,did,can,could,should,would,will,may,might,have,has,had,i,we,you,they,he,she,it,my,our,your,their,me,us'.split(','));
function tokens(s){ return (s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w && !STOP.has(w)); }
function overlap(a,b){ const A=new Set(a); for(const w of b) if(A.has(w)) return true; return false; }

// --- audio gate helper ---
function setAssistantMuted(m){
  const el = document.getElementById('assistant-audio');
  if (el) el.muted = !!m;
}

export default function App(){
  const [status,setStatus]=useState('Idle');
  const [summary,setSummary]=useState('Say something and then press SPACE…');

  const connRef=useRef(null);
  const transcriptRef=useRef([]);
  const summaryRef=useRef('Say something and then press SPACE…');
  const stateRef=useRef({goals:[],facts:[],questions:[],options:[],decisions:[],next_steps:[],risks:[]});
  const idMapRef=useRef(new Map());

  const voiceTextBufRef=useRef('');
  const assistantSpeakingRef=useRef(false);

  const micTrackRef=useRef(null);
  const micSenderRef=useRef(null);
  const srRef=useRef(null);
  const pttActiveRef=useRef(false);
  const pttBufferRef=useRef('');

  // response gating
  const respPendingRef=useRef(false);
  const lastFinalizeAtRef=useRef(0);
  const expectResponseRef=useRef(false);
  const currentResponseIdRef=useRef(null);

  // reply single-flight
  const replyInFlightRef=useRef(false);
  const lastReplyAtRef=useRef(0);
  const REPLY_COOLDOWN_MS=800;

  // audio unmute control after cancel->clear
  const unmuteWhenClearedRef=useRef(false);

  // tool buffers
  const toolBufRef = useRef(new Map()); // id -> { name, args: '' }

  // track last user text robustly (server transcript OR local SR)
  const lastUserTextRef = useRef('');

  // queue sends
  const outboxRef=useRef([]);
  function safeSend(obj){
    const dc=connRef.current?.dc;
    const payload=JSON.stringify(obj);
    if(!dc || dc.readyState!=='open'){ outboxRef.current.push(payload); log('[dc queue]', obj.type); return false; }
    try{ dc.send(payload); log('[dc->]', obj.type, obj.response?.metadata?.kind||''); return true; }
    catch{ outboxRef.current.push(payload); log('[dc queue after send fail]', obj.type); return false; }
  }
  function flushOutbox(){
    const dc=connRef.current?.dc; if(!dc || dc.readyState!=='open') return;
    while(outboxRef.current.length){
      const p=outboxRef.current.shift();
      try{ dc.send(p); log('[dc-> flush]', JSON.parse(p)?.type); }catch{ break; }
    }
  }

  // --- local nudge for viz (only used on PTT release) ---
  function localAddOnlyFromUser(text){
    if(!text||text.trim().length<3) return null;
    const parts=text.split(/[,;]|(?:\s+\band\b\s+)|(?:\s+\bor\b\s+)|(?:\s+\bthen\b\s+)/i)
      .map(s=>s.trim()).filter(s=>s&&s.length>2).slice(0,12);
    if(!parts.length) return null;
    return { add:{ facts:parts } };
  }

  function hasCi(arr,text){ const t=(text||'').trim().toLowerCase(); for(const s of arr) if((s||'').trim().toLowerCase()===t) return true; return false; }
  function applyStatePatch(patch){
    const dst=stateRef.current; const added=[]; const removed=[];
    if(patch?.add){
      for(const bucket of Object.keys(patch.add)){ const arr=patch.add[bucket]||[]; dst[bucket]=dst[bucket]||[];
        for(const raw of arr){ const text=(raw||'').trim(); if(!text) continue; if(hasCi(dst[bucket],text)) continue;
          const key=`${bucket}:${text.toLowerCase()}`; let id=idMapRef.current.get(key);
          if(!id){ id=genId(bucket[0]||'i'); idMapRef.current.set(key,id); }
          dst[bucket].push(text); added.push({bucket,id,text});
        }
      }
    }
    if(patch?.remove){
      for(const bucket of Object.keys(patch.remove)){ const arr=patch.remove[bucket]||[]; dst[bucket]=dst[bucket]||[];
        for(const raw of arr){ const text=(raw||'').trim(); if(!text) continue;
          const key=`${bucket}:${text.toLowerCase()}`; const id=idMapRef.current.get(key)||genId(bucket[0]||'i');
          const before=dst[bucket].length;
          dst[bucket]=dst[bucket].filter(s=>(s||'').trim().toLowerCase()!==text.toLowerCase());
          if(dst[bucket].length!==before) removed.push({bucket,id,text});
        }
      }
    }
    renderViz(document.getElementById('viz'), dst);
    if(added.length||removed.length) log('[viz] patch', {added,removed});
    return {added,removed};
  }

  // --- Summary ---
  async function refreshFinalSummary(){
    try{
      const res=await postJSON('/summary',{ transcript:transcriptRef.current.map(({role,text})=>({role,text})), mode:'final' });
      if(res?.summary){
        setSummary(res.summary);
        summaryRef.current=res.summary;
        log('[summary]', res.summary);
      }
    }catch(e){ log('[summary err]', e?.message||e); } finally{ setStatus('Waiting for next turn…'); }
  }

  // --- Extractor reconcile ---
  function computeRemovePatchAgainst(extracted, lastUser) {
    const remove = {};
    const buckets=['goals','facts','questions','options','decisions','next_steps','risks'];
    const lastTok=tokens(lastUser||'');
    const NEG=/\b(no|not|no longer|instead|rather|prefer|switch|change|stop|cancel|drop|remove|exclude)\b/i;
    for(const b of buckets){
      const wantArr=Array.isArray(extracted[b])?extracted[b]:[];
      const wantSet=new Set(wantArr.map(s=>(s||'').trim().toLowerCase()));
      const wantTok=wantArr.map(s=>tokens(s));
      const curArr=stateRef.current[b]||[];
      const rem=[];
      for(const item of curArr){
        const low=(item||'').trim().toLowerCase();
        if(!low) continue;
        if(wantSet.has(low)) continue;
        const itok=tokens(item); if(!itok.length) continue;
        const topical=overlap(itok,lastTok)||wantTok.some(wt=>overlap(itok,wt));
        if(!topical) continue;
        const conflicts=wantTok.some(wt=>{
          let inter=0; const S=new Set(wt);
          for(const t of itok) if(S.has(t)) inter++;
          const minLen=Math.max(1,Math.min(itok.length,wt.length));
          return inter>=2 || inter/minLen>=0.4;
        });
        if(NEG.test(lastUser)||conflicts) rem.push(item);
      }
      if(rem.length) remove[b]=rem;
    }
    return Object.keys(remove).length?{ remove }:null;
  }

  async function addAndReconcileForUserTurn(lastUserText, mode='final'){
    const userOnly=transcriptRef.current.filter(t=>t.role==='user');
    let wantState={};
    try{
      const st=await postJSON('/state',{ transcript:userOnly, mode });
      wantState=st?.state||{};
      log('[extractor state]', wantState);
    }catch(e){ log('[state err]', e?.message||e); }
    const addPatch={ add:{} }; const buckets=['goals','facts','questions','options','decisions','next_steps','risks']; let anyAdd=false;
    for(const b of buckets){
      const cur=stateRef.current[b]||[]; const want=Array.isArray(wantState[b])?wantState[b]:[];
      const toAdd=want.filter(v=>v && !hasCi(cur,v)); if(toAdd.length){ addPatch.add[b]=toAdd; anyAdd=true; }
    }
    if(anyAdd) applyStatePatch(addPatch);
    const rmPatch=computeRemovePatchAgainst(wantState,lastUserText||'');
    if(rmPatch) applyStatePatch(rmPatch);
  }

  // --- Voice turns ---
  function sendGreeting(){
    try { micSenderRef.current?.replaceTrack(null); } catch {}
    expectResponseRef.current = true;
    safeSend({
      type:'response.create',
      response:{ modalities:['audio','text'], instructions:'Greet the user briefly in English and ask: What would you like to talk about?' }
    });
  }

  function sendVoiceReply(){
    // NEW: don’t send if a reply is already pending/active
    if (respPendingRef.current || currentResponseIdRef.current) return;
    if (replyInFlightRef.current) return;
    if (Date.now()-lastReplyAtRef.current < REPLY_COOLDOWN_MS) return;

    replyInFlightRef.current = true;
    expectResponseRef.current = true;
    const ctx = [
      'Context Summary:', summaryRef.current,
      'Context State JSON:', JSON.stringify(stateRef.current),
      'Use vocal prosody from the most recent user audio to infer tone.',
      'If a change is needed, CALL update_state(add/remove).',
      'Reply in English with one concise, targeted follow-up.'
    ].join('\n');
    safeSend({ type:'response.create', response:{ modalities:['audio','text'], instructions:ctx } });
  }

  // IMPORTANT: correct way to answer a tool call in Realtime
  function sendToolOutput(callId,payload){
    safeSend({
      type: 'response.create',
      response: {
        tool_outputs: [{ tool_call_id: callId, output: JSON.stringify(payload) }]
      }
    });
  }

  // --- optional local SR for UI ---
  function startSpeech(){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR || srRef.current) return;
    const sr=new SR(); sr.continuous=true; sr.interimResults=true; sr.lang='en-US';
    sr.onresult=(e)=>{
      if(!pttActiveRef.current) return;
      let finalText=''; for(let i=e.resultIndex;i<e.results.length;i++){ const r=e.results[i]; if(r.isFinal) finalText+=r[0]?.transcript||''; }
      finalText=(finalText||'').trim(); if(finalText.length<2) return;
      pttBufferRef.current=(pttBufferRef.current?(pttBufferRef.current+' '):'')+finalText;
    };
    sr.onerror=(err)=>log('[sr error]', err?.message||err);
    sr.onend=()=>{ srRef.current=null; };
    srRef.current=sr; sr.start();
  }
  function stopSpeech(){ try{ srRef.current?.stop?.(); }catch{} srRef.current=null; }

  // --- finalize once ---
  async function finalizeTurn(){
    if(voiceTextBufRef.current.trim()){
      transcriptRef.current.push({ role:'assistant', text:voiceTextBufRef.current.trim(), ts:Date.now() });
      voiceTextBufRef.current='';
    }
    assistantSpeakingRef.current=false;
    replyInFlightRef.current=false;
    lastReplyAtRef.current=Date.now();

    // Use the strongest available last-user text
    const lastUserFromLog = [...transcriptRef.current].reverse().find(t=>t.role==='user')?.text || '';
    const lastUser = lastUserTextRef.current || lastUserFromLog;

    if(lastUser) await addAndReconcileForUserTurn(lastUser, 'final');
    await refreshFinalSummary();
    lastFinalizeAtRef.current=Date.now();
  }

  // --- sanitize tool patch ---
  function sanitizePatch(p){
    if (!p || typeof p !== 'object') return null;
    const keys = ['goals','facts','questions','options','decisions','next_steps','risks'];
    const out = {};
    if (p.add && typeof p.add === 'object') {
      out.add = {};
      for (const k of keys) if (Array.isArray(p.add[k])) out.add[k] = p.add[k].filter(s=>typeof s==='string').slice(0,12);
      if (!Object.keys(out.add).length) delete out.add;
    }
    if (p.remove && typeof p.remove === 'object') {
      out.remove = {};
      for (const k of keys) if (Array.isArray(p.remove[k])) out.remove[k] = p.remove[k].filter(s=>typeof s==='string').slice(0,12);
      if (!Object.keys(out.remove).length) delete out.remove;
    }
    return (out.add || out.remove) ? out : null;
  }

  // --- router ---
  function handleServerEvent(ev){
    if(!ev || typeof ev!=='object') return;

    switch(ev.type){
      case 'response.created': {
        const rid = ev?.response?.id || ev?.id || null;

        // Cancel ONLY while user is holding PTT (talk-over prevention).
        if (pttActiveRef.current) {
          if (rid) {
            log('[cancel auto response]', rid);
            setAssistantMuted(true);
            unmuteWhenClearedRef.current = true;
            safeSend({ type:'response.cancel', response_id: rid });
          }
          return;
        }

        // Accept server-owned replies after release (even if !expectResponseRef).
        currentResponseIdRef.current = rid || null;
        respPendingRef.current = true;
        expectResponseRef.current = false;
        break;
      }

      // Assistant text stream (buffer) — only for our active response
      case 'response.output_text.delta':
      case 'response.audio_transcript.delta': {
        const rid = ev?.response_id || ev?.response?.id || null;
        if (currentResponseIdRef.current && rid && rid !== currentResponseIdRef.current) break;
        voiceTextBufRef.current += ev?.delta || '';
        break;
      }

      // Model's transcript of your audio -> make a user turn; also do an early (live) viz refresh
      case 'conversation.item.input_audio_transcription.delta': {
        // ignore partials
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
      case 'input_audio_transcription.completed': {
        const t =
          (ev.transcript || ev.text) ??
          (ev.item && (ev.item.transcript || ev.item.text)) ??
          (Array.isArray(ev.item?.content)
            ? ev.item.content.map(c => c?.transcript || c?.text).filter(Boolean).join(' ')
            : '');
        const text=(t||'').trim();
        if(text){
          log('[input transcript]', text);
          transcriptRef.current.push({ role:'user', text, ts:Date.now() });
          lastUserTextRef.current = text;

          // EARLY extractor refresh (live) for faster viz
          addAndReconcileForUserTurn(text, 'live').catch(()=>{});

          // Watchdog — if nothing is pending shortly after transcript, trigger a reply
          setTimeout(() => {
            if (!pttActiveRef.current &&
                !respPendingRef.current &&
                !currentResponseIdRef.current &&
                !assistantSpeakingRef.current) {
              log('[watchdog] triggering reply after transcript.completed');
              sendVoiceReply();
            }
          }, 180);
        }
        break;
      }

      // Audio cleared after cancel — safe to unmute if not holding PTT
      case 'output_audio_buffer.cleared': {
        if (unmuteWhenClearedRef.current && !pttActiveRef.current) {
          setAssistantMuted(false);
          unmuteWhenClearedRef.current = false;
        }
        break;
      }

      case 'output_audio_buffer.started': {
        assistantSpeakingRef.current = true;
        try { micSenderRef.current?.replaceTrack(null); } catch {}
        break;
      }

      // ---- Tool streaming (respond on arguments.done) ----
      case 'response.function_call_arguments.delta': {
        const id   = ev?.call_id || ev?.tool_call_id || ev?.id;
        const name = ev?.name    || ev?.tool_name;
        if (!id) break;
        const entry = toolBufRef.current.get(id) || { name, args: '' };
        entry.args += ev?.delta || '';
        if (name && !entry.name) entry.name = name;
        toolBufRef.current.set(id, entry);
        break;
      }
      case 'response.function_call_arguments.done': {
        const id = ev?.call_id || ev?.tool_call_id || ev?.id;
        const entry = id && toolBufRef.current.get(id);
        if (!entry) break;

        let args = {};
        try { args = entry.args ? JSON.parse(entry.args) : {}; } catch {}
        const clean = sanitizePatch(args);

        if (entry.name === 'update_state') {
          if (clean) applyStatePatch(clean);
          sendToolOutput(id, { ok:true });
        } else if (entry.name === 'persist_session') {
          sendToolOutput(id, { ok:true, session_id:'dev-local' });
        } else {
          sendToolOutput(id, { ok:false, reason:'unsupported tool' });
        }

        toolBufRef.current.delete(id);
        break;
      }

      // ---- FINALIZE exactly once, keyed by response_id ----
      case 'response.done': {
        const rid = ev?.response_id || ev?.id || null;
        if (!respPendingRef.current) break;
        if (currentResponseIdRef.current && rid && rid !== currentResponseIdRef.current) break;

        respPendingRef.current = false;
        currentResponseIdRef.current = null;
        finalizeTurn();   // triggers /state(final) + /summary
        break;
      }

      // Ignore these to avoid double-finalize; 'response.done' is source of truth
      case 'response.audio.done':
      case 'response.completed':
      case 'output_audio_buffer.stopped': {
        break;
      }

      case 'error': { log('[event error]', ev); break; }
      default: { if(ev.type) log('[event]', ev.type); }
    }

    flushOutbox();
  }

  // --- PTT ---
  useEffect(()=>{
    function isTypingInInput(){
      const el=document.activeElement; if(!el) return false;
      const tag=el.tagName?.toLowerCase();
      return tag==='input'||tag==='textarea'||el.isContentEditable;
    }
    async function onKeyDown(e){
      if(e.code!=='Space') return; if(isTypingInInput()) return;
      e.preventDefault();
      if(assistantSpeakingRef.current) return;
      if(pttActiveRef.current) return;

      pttActiveRef.current=true;
      expectResponseRef.current=false;       // while holding, do NOT allow replies
      setPTTActiveUI(true);
      pttBufferRef.current='';

      // Mute assistant audio while holding
      setAssistantMuted(true);

      // Start fresh server buffer (prevents stale audio)
      safeSend({ type:'input_audio_buffer.clear' });

      // attach mic + optional local SR
      try{ if(micSenderRef.current && micTrackRef.current) micSenderRef.current.replaceTrack(micTrackRef.current); }catch{}
      startSpeech();
    }
    async function onKeyUp(e){
      if(e.code!=='Space') return; if(isTypingInInput()) return;
      e.preventDefault(); if(!pttActiveRef.current) return;

      pttActiveRef.current=false;
      setPTTActiveUI(false);

      // Stop local SR first
      stopSpeech();

      // FORCE a commit of the server's audio buffer BEFORE detaching mic
      log('[ptt] committing input_audio_buffer');
      safeSend({ type:'input_audio_buffer.commit' });

      // small tail for prosody and to let commit enqueue cleanly
      await new Promise(r=>setTimeout(r,150));

      try{ micSenderRef.current?.replaceTrack(null); }catch{}

      // log local text right away (if any)
      const text = (pttBufferRef.current||'').trim();
      pttBufferRef.current='';
      if (text) {
        log('[ptt local text]', text);
        transcriptRef.current.push({ role:'user', text, ts:Date.now() });
        lastUserTextRef.current = text;
        const local = localAddOnlyFromUser(text);   // optional immediate chips
        if (local) applyStatePatch(local);
      }

      // Unmute unless we're waiting for a server "cleared" after a cancel
      if (!unmuteWhenClearedRef.current) setAssistantMuted(false);

      // If a reply already started (server auto), don't double-send
      if (respPendingRef.current || currentResponseIdRef.current) return;

      // now allow a single reply
      sendVoiceReply();
    }
    function ensurePTTIndicator(){
      let el=document.getElementById('ptt-indicator');
      if(!el){ el=document.createElement('div'); el.id='ptt-indicator'; el.className='small'; el.style.marginTop='10px'; el.style.color='#666'; el.textContent='Press and hold SPACE to talk'; document.body.appendChild(el); }
      return el;
    }
    function setPTTActiveUI(active){
      const el=ensurePTTIndicator(); el.style.color=active?'green':'#666'; el.style.fontWeight=active?'bold':'normal';
      el.textContent=active?'Listening… release SPACE to send':'Press and hold SPACE to talk';
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    ensurePTTIndicator();
    return ()=>{ window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  // --- Connect / Disconnect ---
  async function onConnect(){
    setStatus('Connecting…');
    try{
      const conn=await connectRealtime(); connRef.current=conn;
      micTrackRef.current=conn.micTrack;
      micSenderRef.current=conn.micSender;
      renderViz(document.getElementById('viz'), stateRef.current);
      conn.setHandler(handleServerEvent);

      // mic detached by default
      try{ micSenderRef.current?.replaceTrack(null); }catch{}

      // Configure: voice, transcription, and VAD (ON)
      const arm=()=>{
        if(onConnect.didConfig) return; onConnect.didConfig=true;
        log('[session.update] voice+transcription+VAD');
        safeSend({
          type:'session.update',
          session:{
            voice:'alloy',
            input_audio_transcription:{ model:'whisper-1' },
            turn_detection:{ type:'server_vad', threshold:0.6, silence_duration_ms:700 }
          }
        });
        setStatus('Connected. Hold SPACE to talk.');
        sendGreeting();
        flushOutbox();
      };
      if(conn.dc?.readyState==='open'){ arm(); } else { conn.dc?.addEventListener('open', arm); }

      const flusher=setInterval(flushOutbox,200);
      conn.pc.onconnectionstatechange=()=>{ if(['failed','closed','disconnected'].includes(conn.pc.connectionState)) clearInterval(flusher); };
    }catch(err){
      setStatus(`Error: ${/** @type {Error} */(err).message}`);
      log('[connect error]', err);
    }
  }

  function onDisconnect(){
    try{ connRef.current?.stop?.(); }catch{}
    connRef.current=null;
    setStatus('Idle');
    try{ srRef.current?.stop?.(); }catch{}
    transcriptRef.current=[];
    voiceTextBufRef.current='';
    outboxRef.current.length=0;
    assistantSpeakingRef.current=false;
    unmuteWhenClearedRef.current=false;
    lastUserTextRef.current='';
    try{ micSenderRef.current?.replaceTrack(micTrackRef.current||null); }catch{}
    const ind=document.getElementById('ptt-indicator'); if(ind) ind.textContent='Press and hold SPACE to talk';
    setAssistantMuted(false);
  }

  useEffect(()=>{
    const connectBtn=document.getElementById('connect');
    const disconnectBtn=document.getElementById('disconnect');
    const statusEl=document.getElementById('status');
    const summaryEl=document.getElementById('summary');
    connectBtn.onclick=onConnect;
    disconnectBtn.onclick=onDisconnect;
    const i=setInterval(()=>{
      disconnectBtn.disabled=!connRef.current;
      if(statusEl) statusEl.textContent=status;
      if(summaryEl) summaryEl.textContent=summary;
    },200);
    return ()=>clearInterval(i);
  },[status,summary]);

  return React.createElement(React.Fragment,null);
}
