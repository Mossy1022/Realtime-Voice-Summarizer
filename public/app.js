// public/app.js
// PTT + single-finalize-per-turn + robust transcription
// + Speak-After-Confirm gate (no voice replies after greeting until user confirms)

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

  // Definition Gate
  const gateOpenRef = useRef(false);
  const defPackRef    = useRef(null);     // holds the accepted pack object/string
  const consentRef    = useRef(false);

  // ---- Minimal PV-like grid model + proposals ----
  const gridMDRef = useRef({
    options: new Set(),              // row ids
    criteria: new Set(),             // column ids
    cells: new Map()                 // key: `${opt}|${crit}` -> { weight, conf, rationale }
  });
  const proposalsRef = useRef([]);   // [{ id, type, option, criterion, weight, conf, rationale, source, ts }]

  function kCell(o,c){ return `${(o||'').trim().toLowerCase()}|${(c||'').trim().toLowerCase()}`; }
  function pKey(p){ return [p.type, (p.option||'').toLowerCase(), (p.criterion||'').toLowerCase()].join('|'); }

  function enqueueProposals(list){
    const seen = new Set(proposalsRef.current.map(p=>pKey(p)));
    for(const p of list){
      const key = pKey(p);
      if(!seen.has(key)){ proposalsRef.current.push({ id: genId('gp'), ts: Date.now(), source: p.source||'heuristic', ...p }); seen.add(key); }
    }
    renderGridPanel();
  }

  function renderGridPanel(){
    const el = document.getElementById('grid-proposals');
    if(!el) return;
    const rows = proposalsRef.current.map(p=>{
      let desc = '';
      if(p.type==='add_option') desc = `Add option: <b>${escapeHtml(p.option)}</b>`;
      else if(p.type==='add_criterion') desc = `Add criterion: <b>${escapeHtml(p.criterion)}</b>`;
      else if(p.type==='set_cell') desc = `Set <b>${escapeHtml(p.option)}</b> × <b>${escapeHtml(p.criterion)}</b> → weight ${p.weight} (conf ${Math.round((p.conf||0)*100)}%)`;
      return `
        <div class="gp-row" data-id="${p.id}" style="border:1px solid #eee;border-radius:8px;padding:8px;margin:6px 0;">
          <div class="small" style="color:#888;margin-bottom:2px;">${new Date(p.ts).toLocaleTimeString()} • ${p.source}</div>
          <div>${desc}${p.rationale ? ` — <i>${escapeHtml(p.rationale)}</i>` : ''}</div>
          <div style="margin-top:6px;">
            <button class="gp-accept">Accept</button>
            <button class="gp-edit">Edit</button>
            <button class="gp-discard">Discard</button>
          </div>
        </div>`;
    }).join('') || '<div class="small" style="color:#666;">No proposals yet.</div>';

    const summary = `
      <div class="small" style="color:#666;margin-bottom:6px;">
        Structure: ${gridMDRef.current.options.size} option(s), ${gridMDRef.current.criteria.size} criterion/criteria, ${gridMDRef.current.cells.size} cell(s)
      </div>`;

    el.innerHTML = summary + rows;

    // event delegation
    el.onclick = (e)=>{
      const row = e.target.closest('.gp-row'); if(!row) return;
      const id  = row.dataset.id;
      const p   = proposalsRef.current.find(x=>x.id===id);
      if(!p) return;

      if(e.target.classList.contains('gp-accept')) acceptProposal(p.id);
      if(e.target.classList.contains('gp-edit'))   editProposal(p.id);
      if(e.target.classList.contains('gp-discard')) discardProposal(p.id);
    };
  }

  function showDefinitionGateUI(draftText) {
    let wrap = document.getElementById('defgate');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'defgate';
      document.body.appendChild(wrap);
    }
    wrap.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999">
        <div style="background:#fff;color:#222;max-width:520px;width:90%;border-radius:8px;padding:14px;box-shadow:0 12px 30px rgba(0,0,0,.25)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <h3 style="margin:0;font:700 1rem system-ui">Definition Gate</h3>
            <button id="defgate-close" style="border:0;background:none;font-size:20px;cursor:pointer">×</button>
          </div>
          <p style="margin:8px 0 6px">Review or edit the decision definition, then accept:</p>
          <textarea id="defgate-text" style="width:100%;min-height:160px;border:1px solid #ddd;border-radius:6px;padding:8px;font:14px/1.4 system-ui">${(draftText||'').replaceAll('<','&lt;')}</textarea>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
            <button id="defgate-accept" style="background:#0b57d0;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer">Accept</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('defgate-close').onclick = () => { wrap.remove(); };
    document.getElementById('defgate-accept').onclick = () => {
      try {
        const txt = /** @type {HTMLTextAreaElement} */(document.getElementById('defgate-text')).value.trim();
        defPackRef.current = txt.startsWith('{') ? JSON.parse(txt) : txt; // allow plain text or JSON
        consentRef.current = true;
        gateOpenRef.current = false;
        wrap.remove();
        console.log('[defgate] accepted pack:', defPackRef.current);
      } catch {
        alert('Invalid JSON. Paste plain text or valid JSON object.');
      }
    };
  }

  function acceptProposal(id){
    const idx = proposalsRef.current.findIndex(p=>p.id===id);
    if(idx<0) return;
    const p = proposalsRef.current[idx];
    const grid = gridMDRef.current;

    if(p.type==='add_option'){
      grid.options.add(p.option);
      const opt = (p.option||'').trim();
      if(opt && !stateRef.current.options?.some?.(s => s.trim().toLowerCase()===opt.toLowerCase())){
        stateRef.current.options = stateRef.current.options || [];
        stateRef.current.options.push(opt);
        renderViz(document.getElementById('viz'), stateRef.current);
      }
    }else if(p.type==='add_criterion'){
      grid.criteria.add(p.criterion);
    }else if(p.type==='set_cell'){
      if(p.option) grid.options.add(p.option);
      if(p.criterion) grid.criteria.add(p.criterion);
      grid.cells.set(kCell(p.option,p.criterion), { weight: p.weight|0, conf: Math.max(0,Math.min(1,p.conf||0)), rationale: p.rationale||'' });
    }

    proposalsRef.current.splice(idx,1);
    renderGridPanel();
  }

  function editProposal(id){
    const p = proposalsRef.current.find(x=>x.id===id); if(!p) return;
    if(p.type==='set_cell'){
      const w = prompt('Weight (−100..+100):', String(p.weight ?? 0));
      if(w==null) return;
      const c = prompt('Confidence (0..1):', String(p.conf ?? 0.6));
      if(c==null) return;
      const r = prompt('Rationale:', p.rationale || '');
      p.weight = Math.max(-100, Math.min(100, parseFloat(w)||0));
      p.conf   = Math.max(0, Math.min(1, parseFloat(c)||0));
      p.rationale = (r||'').trim();
    }else if(p.type==='add_option'){
      const v = prompt('Option name:', p.option||''); if(v==null) return; p.option=(v||'').trim();
    }else if(p.type==='add_criterion'){
      const v = prompt('Criterion name:', p.criterion||''); if(v==null) return; p.criterion=(v||'').trim();
    }
    renderGridPanel();
  }

  function discardProposal(id){
    const i = proposalsRef.current.findIndex(x=>x.id===id);
    if(i>=0){ proposalsRef.current.splice(i,1); renderGridPanel(); }
  }

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

  // --- Speak-After-Confirm gate ---
  const speakGateRef = useRef(true);             // true => require confirmation before any voice
  const pendingSpeakRef = useRef(null);          // { kind, instructions }
  const performingSpeakRef = useRef(false);      // we intentionally allowed speech

  function ensureConfirmButton(){
    if (document.getElementById('confirm-speak')) return;
    const wrap = document.createElement('div');
    wrap.id = 'confirm-wrap-fallback';
    wrap.style.marginTop = '8px';
    const btn = document.createElement('button');
    btn.id = 'confirm-speak';
    btn.textContent = '✅ Confirm & Speak';
    btn.disabled = true;
    Object.assign(btn.style, {
      padding:'6px 10px', font:'inherit', borderRadius:'6px',
      border:'1px solid #ddd', cursor:'not-allowed', background:'#f8f8f8'
    });
    btn.addEventListener('click', () => {
      if (pendingSpeakRef.current && speakGateRef.current) performSpeak();
    });
    wrap.appendChild(btn);
    const hint = document.createElement('span');
    hint.id = 'confirm-hint';
    hint.textContent = ' (Or hold SPACE and say “go ahead”)';
    hint.style.marginLeft = '8px';
    hint.style.color = '#666';
    wrap.appendChild(hint);
    // place near the audio element
    const anchor = document.getElementById('assistant-audio') || document.body;
    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
  }

  function setConfirmUI(enabled, label){
    ensureConfirmButton();
    const btn = document.getElementById('confirm-speak');
    const hint = document.getElementById('confirm-hint');
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    btn.style.background = enabled ? '#0b57d0' : '#f8f8f8';
    btn.style.color = enabled ? '#fff' : '#444';
    if (label) btn.textContent = label;
    if (hint) hint.style.opacity = enabled ? 0.85 : 0.5;
  }

  function queueVoiceReply(kind='follow_up'){
    if (gateOpenRef.current) return;
    if (respPendingRef.current || currentResponseIdRef.current) return;
    const ctx = [
      'Context Summary:', summaryRef.current,
      'Context State JSON:', JSON.stringify(stateRef.current),
      'Use vocal prosody from the most recent user audio to infer tone.',
      'If a change is needed, CALL update_state(add/remove).',
      'Reply in English with one concise, targeted follow-up.'
    ].join('\n');
    pendingSpeakRef.current = { kind, instructions: ctx };
    speakGateRef.current = true;
    setConfirmUI(true, '✅ Confirm & Speak');
  }

  function performSpeak(){
    if (!pendingSpeakRef.current || !speakGateRef.current) return;
    const { instructions } = pendingSpeakRef.current;
  
    replyInFlightRef.current = true;
    expectResponseRef.current = true;
  
    // This speak is intentional; allow it to pass the gate.
    performingSpeakRef.current = true;
    speakGateRef.current = false;
    setConfirmUI(false, '✅ Confirm & Speak');
  
    // IMPORTANT: Realtime requires ['audio','text'] for speech
    safeSend({
      type:'response.create',
      response:{ modalities:['audio','text'], instructions }
    });
  }
  

  function isVoiceConfirmation(text){
    const t = (text||'').toLowerCase();
    // Avoid accidental "yes"; require explicit phrasing
    return /\b(go ahead|please proceed|proceed|you can speak|read it|say it|continue|please continue|ok speak|okay speak|go for it|sounds good|that works)\b/.test(t);
  }

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
    if (gateOpenRef.current) return { added: [], removed: [] }; // block until defined
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

  function inferCriteriaAndCellsFromUtterance(text){
    const low = (text||'').toLowerCase();
    const hits = [];
    const L = [
      { crit:'cost',      test:/\b(cost|price|budget|expensive|cheap)\b/,        weight: low.includes('cheap')||low.includes('lower') ? +20 : -30 },
      { crit:'commute',   test:/\bcommute|minutes|min|train|subway|walk\b/,      weight: low.includes('short')||low.includes('<') ? +20 : -10 },
      { crit:'space',     test:/\bspace|bedroom|br|sq ?ft|size\b/,               weight: +20 },
      { crit:'quality',   test:/\bquality|nice|renovated|modern|new\b/,          weight: +15 },
      { crit:'safety',    test:/\bsafe|crime|noisy|quiet\b/,                     weight: low.includes('quiet')||low.includes('safe') ? +15 : -15 },
      { crit:'risk',      test:/\brisk|uncertain|unstable\b/,                    weight: -20 },
      { crit:'convenience',test:/\bconvenient|near|close\b/,                     weight: +15 },
    ];
    for(const item of L){
      if(item.test.test(low)){
        hits.push({ criterion:item.crit, weight:item.weight, conf:0.6, rationale:`Heard: ${item.test}` });
      }
    }
    return hits;
  }

  async function addAndReconcileForUserTurn(lastUserText, mode='final'){
    if (gateOpenRef.current) return; // no extractor proposals before consent

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

    // ---- build grid proposals from extractor + heuristics ----
    const props = [];
    for(const opt of (wantState.options || [])){
      if(!gridMDRef.current.options.has(opt)){
        props.push({ type:'add_option', option: opt, source:'extractor' });
      }
    }
    for(const h of inferCriteriaAndCellsFromUtterance(lastUserText||'')){
      if(!gridMDRef.current.criteria.has(h.criterion)){
        props.push({ type:'add_criterion', criterion: h.criterion, source:'heuristic' });
      }
      const [onlyOpt] = Array.from(gridMDRef.current.options.values());
      if(onlyOpt){
        props.push({ type:'set_cell', option: onlyOpt, criterion: h.criterion, weight: h.weight, conf: h.conf, rationale: h.rationale, source:'heuristic' });
      }
    }
    enqueueProposals(props);
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

  // (kept for completeness, not used by the gate flow)
  function sendVoiceReply(){
    if (gateOpenRef.current) return;
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

  function sendToolOutput(callId,payload){
    safeSend({
      type: 'response.create',
      response: {
        tool_outputs: [{ tool_call_id: callId, output: JSON.stringify(payload) }]
      }
    });
  }

  function sendDefinitionGreeter() {
    // Definition Gate: natural back-and-forth (no confirm gate while active).
    performingSpeakRef.current = true;
    speakGateRef.current = false;
  
    safeSend({
      type: 'response.create',
      response: {
        modalities: ['audio','text'],
        metadata: { kind: 'definition_greeter' },
        instructions:
          'Let’s set the decision definition together. Speak one short question at a time. ' +
          'Start by asking, in English: "What decision are you making?" ' +
          'As the user answers, call a tool named definition.greeter with partial fields you can infer ' +
          '(title, scope, time_window, participants[], axes[]). ' +
          'Do NOT mention JSON or field names to the user; keep the conversation natural. ' +
          'After each answer, ask the next brief question (scope, time window, participants, key axes, etc.). ' +
          'When you have enough to proceed, include status:"complete" in the tool output and give a short acknowledgement.'
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
    performingSpeakRef.current = false;     // our intentional speak done
    speakGateRef.current = true;            // re-arm gate for next turn

    const lastUserFromLog = [...transcriptRef.current].reverse().find(t=>t.role==='user')?.text || '';
    const lastUser = lastUserTextRef.current || lastUserFromLog;

    if(lastUser) await addAndReconcileForUserTurn(lastUser, 'final');
    await refreshFinalSummary();
    lastFinalizeAtRef.current=Date.now();

    // Stage a reply (requires confirmation)
    pendingSpeakRef.current = null;
    if (!gateOpenRef.current) {
      queueVoiceReply('follow_up'); // requires confirmation post-gate
    }
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
      
        // Never let the model talk while user is holding SPACE
        if (pttActiveRef.current) {
          if (rid) {
            log('[cancel auto response]', rid);
            setAssistantMuted(true);
            unmuteWhenClearedRef.current = true;
            safeSend({ type:'response.cancel', response_id: rid });
          }
          return;
        }
      
        // HARD GATE: only enforce cancel when Definition Gate is NOT active
        if (!gateOpenRef.current && speakGateRef.current && !performingSpeakRef.current && rid) {
          log('[gate] cancel unexpected response.created', rid);
          safeSend({ type:'response.cancel', response_id: rid });
          return;
        }
      
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

      // Model's transcript of your audio -> make a user turn
      case 'conversation.item.input_audio_transcription.delta': {
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

          addAndReconcileForUserTurn(text, 'live').catch(()=>{});

          // Voice confirmation intent
          if (isVoiceConfirmation(text) && pendingSpeakRef.current && speakGateRef.current) {
            log('[confirm] voice confirmation detected');
            performSpeak();
          } else {
            // Stage a reply for confirmation if none is pending
            if (!pendingSpeakRef.current && !gateOpenRef.current) {
              queueVoiceReply('follow_up');
            }
          }
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
        const id   = ev?.call_id || ev?.tool_call_id || ev?.id;
        if (!id) break;
        const entry = toolBufRef.current.get(id);
        let args = {};
        try { args = entry?.args ? JSON.parse(entry.args) : {}; } catch {}
        toolBufRef.current.delete(id);
        const name = entry?.name || ev?.name || ev?.tool_name || '';

        if (name === 'definition.greeter') {
          const status = (args.status || args.phase || '').toString().toLowerCase();
          const pack   = args.pack || args.definition_pack || null;
        
          // Keep capturing partials as the conversation flows
          if (pack) {
            defPackRef.current = pack; // stash latest partial/complete pack
          }
        
          // If the greeter marks completion (or we get a good pack), close the gate
          if (status === 'complete' || args.complete === true || pack) {
            consentRef.current  = true;
            gateOpenRef.current = false;
        
            // Immediate, short acknowledgement (no confirmation required here)
            performingSpeakRef.current = true;
            speakGateRef.current = false;
            safeSend({
              type:'response.create',
              response:{
                modalities:['audio','text'],
                instructions:'Great — I captured the decision definition. When you want me to continue, say "go ahead" or press Confirm.'
              }
            });
        
            // Next turns will be gated again
            setTimeout(()=>{ speakGateRef.current = true; }, 0);
        
            sendToolOutput(id, { ok:true });
            return;
          }
        
          // Still collecting → stay in Definition Gate; the model will ask the next short question
          sendToolOutput(id, { ok:true });
          return;
        }
        
        const clean = sanitizePatch(args);
        if (name === 'update_state') {
          if (clean) applyStatePatch(clean);
          sendToolOutput(id, { ok: true });
        } else if (name === 'persist_session') {
          sendToolOutput(id, { ok: true, session_id: 'dev-local' });
        } else {
          sendToolOutput(id, { ok: false, reason: 'unsupported tool' });
        }
        break;
      }

      // ---- FINALIZE exactly once, keyed by response_id ----
      case 'response.done': {
        const rid = ev?.response_id || ev?.id || null;
        if (!respPendingRef.current) break;
        if (currentResponseIdRef.current && rid && rid !== currentResponseIdRef.current) break;

        respPendingRef.current = false;
        currentResponseIdRef.current = null;
        finalizeTurn();   // triggers /state(final) + /summary and re-arms gate
        break;
      }

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

      // Do NOT auto-speak; stage a reply that requires confirmation
      if (!gateOpenRef.current && !pendingSpeakRef.current) {
        queueVoiceReply('follow_up');
      }
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
    ensureConfirmButton();
    setConfirmUI(false);
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

      try{ micSenderRef.current?.replaceTrack(null); }catch{}

      const arm = () => {
        if (onConnect.didConfig) return;
        onConnect.didConfig = true;
      
        log('[session.update] voice+transcription+VAD');
        safeSend({
          type: 'session.update',
          session: {
            voice: 'alloy',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { type: 'server_vad', threshold: 0.6, silence_duration_ms: 700 }
          }
        });
      
        // Keep mic detached so the greeter can't hear itself
        try { micSenderRef.current?.replaceTrack(null); } catch {}
        setAssistantMuted(false);
      
        // Open the gate for definition
        gateOpenRef.current = true;
        consentRef.current  = false;
        defPackRef.current  = null;
      
        setStatus('Connected. Define the decision to begin.');
        sendDefinitionGreeter();        // speak-once greeter (audio)
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
    // reset gate/pending
    speakGateRef.current = true;
    pendingSpeakRef.current = null;
    setConfirmUI(false);
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

