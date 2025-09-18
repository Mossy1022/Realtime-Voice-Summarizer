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

const LIFE_AREAS = ['Work','Health','Finances','Relationships','Identity','Logistics'];

function renderAnchorChips(selected = []) {
  const sel = new Set((selected || []).map(s => (s || '').trim()));
  return LIFE_AREAS.map(name => {
    const isSel = sel.has(name);
    const bg = isSel ? '#0b57d0' : '#f7f7f7';
    const fg = isSel ? '#fff' : '#222';
    const br = isSel ? '#0b57d0' : '#ddd';
    return `<button class="gp-anchor${isSel ? ' sel' : ''}" data-anchor="${escapeHtml(name)}"
              style="display:inline-block;margin:4px 6px 0 0;padding:4px 8px;border-radius:999px;
                     border:1px solid ${br};background:${bg};color:${fg};font-size:.85rem;cursor:pointer">
              ${escapeHtml(name)}
            </button>`;
  }).join('');
}

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
  const evidenceRegRef = useRef(new Map()); // id -> EvidenceCard
  const claimRegRef    = useRef(new Map()); // id -> ClaimTemplate
  const usageRegRef    = useRef(new Map()); // usage_id -> ClaimUsage

  const coverageRef = useRef({ possible:0, anchored:0, reviewed:0, fresh:0 });

function updateCoverageCounters(){
  const cells = Array.from(gridMDRef.current.cells.values());
  const possible = cells.length;
  const anchored = cells.filter(c => Array.isArray(c.anchors) && c.anchors.length > 0).length;
  const reviewed = anchored; // MVP: treat accepted as reviewed
  const fresh    = anchored; // MVP: treat accepted this session as fresh

  coverageRef.current = { possible, anchored, reviewed, fresh };
  const pct = anchored ? Math.round(100 * reviewed / anchored) : 0;

  const chip = document.getElementById('coverage');
  if (chip) chip.textContent = `anchors ${anchored}/${possible} • reviewed ${pct}% • fresh ${fresh}`;
}



  function upsertEvidence(card){ evidenceRegRef.current.set(card.id, { ...card, updated_at: new Date().toISOString() }); styleEvidenceEverywhere(card.id); }
  function upsertClaimTemplate(t){ claimRegRef.current.set(t.id, { ...t, updated_at: new Date().toISOString() }); openPropagationPanel(t.id); }
  function styleEvidenceEverywhere(evId){
    // MVP: no drawing call needed yet; when cells render rails with inner-line, consult evidence cred.
  }


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
    const grid = gridMDRef.current;

    for(const p of list){
      // Skip duplicates against the accepted model
      if (p.type === 'add_option' && grid.options.has((p.option||'').trim().toLowerCase())) continue;
      if (p.type === 'add_criterion' && grid.criteria.has((p.criterion||'').trim().toLowerCase())) continue;
      if (p.type === 'set_cell') {
        const key = kCell(p.option, p.criterion);
        if (grid.cells.has(key)) continue; // already accepted
      }

      const key = pKey(p);
      if(!seen.has(key)){ proposalsRef.current.push({ id: genId('gp'), ts: Date.now(), source: p.source||'heuristic', ...p }); seen.add(key); }
    }
    renderGridPanel();
  }

  function renderGridPanel(){
    const el = document.getElementById('grid-proposals');
    if(!el) return;
  
    // Normalize proposals: ensure arrays exist
    for (const p of proposalsRef.current) {
      if (p.type === 'set_cell') {
        if (!Array.isArray(p.anchors)) p.anchors = [];
      }
    }
  
    const rows = proposalsRef.current.map(p => {
      let desc = '';
      if (p.type === 'add_option') {
        desc = `Add option: <b>${escapeHtml(p.option)}</b>`;
      } else if (p.type === 'add_criterion') {
        desc = `Add criterion: <b>${escapeHtml(p.criterion)}</b>`;
      } else if (p.type === 'set_cell') {
        desc = `Set <b>${escapeHtml(p.option)}</b> × <b>${escapeHtml(p.criterion)}</b> → weight ${p.weight} (conf ${Math.round((p.conf||0)*100)}%)`;
      }
  
      // Anchors UI only for set_cell
      const anchorsBlock = (p.type === 'set_cell')
        ? `
          <div class="small" style="color:#666;margin-top:6px;margin-bottom:2px;">Anchors (pick up to 2):</div>
          <div class="gp-anchors" data-for="${p.id}">
            ${renderAnchorChips(p.anchors)}
          </div>`
        : '';
  
      const rationale = p.rationale ? ` — <i>${escapeHtml(p.rationale)}</i>` : '';
  
      return `
        <div class="gp-row" data-id="${p.id}" style="border:1px solid #eee;border-radius:8px;padding:8px;margin:6px 0;">
          <div class="small" style="color:#888;margin-bottom:2px;">
            ${new Date(p.ts).toLocaleTimeString()} • ${escapeHtml(p.source||'')}
          </div>
          <div>${desc}${rationale}</div>
          ${anchorsBlock}
          <div style="margin-top:8px;">
            <button class="gp-accept">Accept</button>
            <button class="gp-edit">Edit</button>
            <button class="gp-discard">Discard</button>
          </div>
        </div>`;
    }).join('') || '<div class="small" style="color:#666;">No proposals yet.</div>';
  
    const summary = `
      <div class="small" style="color:#666;margin-bottom:6px;">
        Structure: ${gridMDRef.current.options.size} option(s),
        ${gridMDRef.current.criteria.size} criterion/criteria,
        ${gridMDRef.current.cells.size} cell(s)
      </div>`;
  
    el.innerHTML = summary + rows;
  
    // Event delegation (accept/edit/discard + anchor toggles)
    el.onclick = (e) => {
      const row = e.target.closest('.gp-row'); if(!row) return;
      const id  = row.dataset.id;
      const p   = proposalsRef.current.find(x=>x.id===id);
      if(!p) return;
  
      // Toggle anchor chip (limit 2)
      if (e.target.classList.contains('gp-anchor')) {
        if (p.type !== 'set_cell') return;
  
        const btn = e.target;
        const name = btn.dataset.anchor;
        if (!name) return;
  
        p.anchors = Array.isArray(p.anchors) ? p.anchors : [];
        const has = p.anchors.includes(name);
  
        if (has) {
          // deselect
          p.anchors = p.anchors.filter(a => a !== name);
          btn.classList.remove('sel');
          btn.style.background = '#f7f7f7';
          btn.style.color = '#222';
          btn.style.borderColor = '#ddd';
        } else {
          // enforce at most 2
          if (p.anchors.length >= 2) {
            // remove the first selected in the row
            const firstSel = row.querySelector('.gp-anchor.sel');
            if (firstSel) {
              const firstName = firstSel.dataset.anchor;
              p.anchors = p.anchors.filter(a => a !== firstName);
              firstSel.classList.remove('sel');
              firstSel.style.background = '#f7f7f7';
              firstSel.style.color = '#222';
              firstSel.style.borderColor = '#ddd';
            }
          }
          p.anchors.push(name);
          btn.classList.add('sel');
          btn.style.background = '#0b57d0';
          btn.style.color = '#fff';
          btn.style.borderColor = '#0b57d0';
        }
        return; // don’t fall through to buttons
      }
  
      if (e.target.classList.contains('gp-accept'))  acceptProposal(p.id);
      if (e.target.classList.contains('gp-edit'))    editProposal(p.id);
      if (e.target.classList.contains('gp-discard')) discardProposal(p.id);
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
        const ft = document.getElementById('focus-title');
        if (ft) {
          const pack = defPackRef.current;
          const label = typeof pack==='string' ? pack : (pack?.title || '(set)');
          ft.textContent = `Focus: ${label}`;
        }
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
  
    if (p.type === 'add_option') {
      grid.options.add(p.option);
      const opt = (p.option||'').trim();
      if(opt && !stateRef.current.options?.some?.(s => s.trim().toLowerCase()===opt.toLowerCase())){
        stateRef.current.options = stateRef.current.options || [];
        stateRef.current.options.push(opt);
        renderViz(document.getElementById('viz'), stateRef.current);
      }
    } else if (p.type === 'add_criterion') {
      grid.criteria.add(p.criterion);
    } else if (p.type === 'set_cell') {
      if(p.option)   grid.options.add(p.option);
      if(p.criterion) grid.criteria.add(p.criterion);
  
      // Finalize anchors: prefer selected chips in the row; fallback to p.anchors
      const row = document.querySelector(`.gp-row[data-id="${id}"]`);
      let selected = [];
      if (row) {
        selected = Array.from(row.querySelectorAll('.gp-anchor.sel')).map(b => b.dataset.anchor).filter(Boolean);
      }
      const anchors = (selected.length ? selected : (Array.isArray(p.anchors) ? p.anchors : [])).slice(0,2);
  
      grid.cells.set(
        kCell(p.option, p.criterion),
        {
          weight: p.weight|0,
          conf: Math.max(0, Math.min(1, p.conf||0)),
          rationale: p.rationale || '',
          anchors
        }
      );
  
      // Update coverage counters whenever we write a cell
      if (typeof updateCoverageCounters === 'function') updateCoverageCounters();
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

  const turnCommittedRef = useRef(false);
  const manualCommitRef = useRef(false);   // only true when we commit on keyup
  const pttStartAtRef     = useRef(0);       // when SPACE was pressed
  const MIN_PTT_MS        = 150;             // avoid 0ms commits

  const commitWindowUntilRef = useRef(0);
  const COMMIT_WINDOW_MS = 2500; // accept transcript for 2.5s after commit

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

  // ---- sendDefinitionGreeter (greeting on connect) ----
function sendDefinitionGreeter() {
  // Definition Gate: allow one intentional speak
  performingSpeakRef.current = true;
  speakGateRef.current = false;

  // ✅ Tell the router that a reply is expected (don’t cancel it)
  expectResponseRef.current = true;

  safeSend({
    type: 'response.create',
    response: {
      modalities: ['audio','text'],
      metadata: { kind: 'definition_greeter' },
      instructions:
        'Let’s set the decision definition together. Speak one short question at a time. ' +
        'Start by asking, in English: "What decision are you making?" ' +
        'As the user answers, call a tool named definition_greeter with partial fields you can infer ' +
        '(title, scope, time_window, participants[], axes[]). ' +
        'Do NOT mention JSON or field names to the user; keep the conversation natural. ' +
        'After each answer, ask the next brief question (scope, time window, participants, key axes, etc.). ' +
        'When you have enough to proceed, include status:"complete" in the tool output and give a short acknowledgement.'
    }
  });
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

  function sendToolOutput(callId, payload){
    // The model will often continue the SAME response after tool outputs.
    // Let that continuation through the gate.
    expectResponseRef.current = true;
  
    safeSend({
      type: 'response.create',
      // NOTE: tool_outputs is a top-level field (not inside "response")
      tool_outputs: [
        { tool_call_id: callId, output: JSON.stringify(payload) }
      ]
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
    if (!gateOpenRef.current && speakPolicyRef.current === 'confirm') {
      queueVoiceReply('follow_up'); // requires confirmation post-gate
    }
  }

  async function onUserTextSend(text){
    // 1) chat bubble
    addMessage('user', text);
    transcriptRef.current.push({ role:'user', text, ts:Date.now() });
    lastUserTextRef.current = text;
  
    // 2) helpers in parallel
    try {
      const [sum, st, prop] = await Promise.all([
        postJSON('/summary', { transcript: transcriptRef.current.slice(-30), mode:'live' }),
        postJSON('/state',   { transcript: transcriptRef.current.filter(t=>t.role==='user').slice(-30), mode:'live' }),
        postJSON('/propose', { transcript: transcriptRef.current.slice(-30), focus: defPackRef.current||'', mode:'live' })
      ]);
      if (sum?.summary){ setSummary(sum.summary); summaryRef.current = sum.summary; }
      if (st?.state) { applyStatePatch({ add: st.state }); } // safe no-op if dup
      if (prop?.proposals?.length) enqueueProposals(prop.proposals.map(p=>({ ...p, source:'scout' })));
    } catch(e){ log('[turn helpers err]', e?.message||e); }
  
    // 3) single reply path via Realtime (TEXT path only creates an item)
    const policy = speakPolicyRef.current; // 'confirm' | 'auto' | 'text'
    const mods = policy==='auto' ? ['text','audio'] : ['text'];

    safeSend({
      type: 'conversation.item.create',
      item: {
        type: 'message',            // <<< REQUIRED
        role: 'user',
        content: [{ type:'input_text', text }]
      }
    });

    expectResponseRef.current = true;
    safeSend({ type:'response.create', response:{ modalities:mods, instructions: buildSystemCtx() } });

  }
  function buildSystemCtx(){
    const grid = gridMDRef.current;
     const gridSnapshot = {
       options: Array.from(grid.options),
       criteria: Array.from(grid.criteria),
       cells: Array.from(grid.cells.entries())
               .map(([k,v]) => ({ key:k, weight:v.weight, conf:v.conf, anchors:v.anchors||[] }))
     };
    return [
      'You are the Objective Accomplisher Coach. Use one concise reply.',
      'Context Summary:', summaryRef.current,
      'State JSON:', JSON.stringify(stateRef.current).slice(0,2000),
      'Grid Snapshot:', JSON.stringify(gridSnapshot).slice(0,2000),
      'If a small add/remove helps, CALL update_state tool; keep reply short.',
      'Your job is not to decide for me but to uncover the top missing facts, goals, constraints, and options to populate the objective map.'
    ].join('\n');
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
  async function handleServerEvent(ev){
    if(!ev || typeof ev!=='object') return;
  
    switch(ev.type){
  
      case 'response.created': {
        const rid = ev?.response?.id || ev?.id || null;
  
        // Block unsolicited replies unless we asked for one
        if (!expectResponseRef.current && rid) {
          log('[gate] cancel unsolicited response', rid);
          safeSend({ type:'response.cancel', response_id: rid });
          return;
        }
  
        // If the user is still talking (pre-commit), cancel any auto reply
        if (pttActiveRef.current || !turnCommittedRef.current) {
          if (rid) {
            log('[cancel auto response]', rid);
            setAssistantMuted(true);
            unmuteWhenClearedRef.current = true;
            safeSend({ type:'response.cancel', response_id: rid });
          }
          return;
        }
  
        // Gate: only allow intended replies
        if (!gateOpenRef.current && speakGateRef.current && !performingSpeakRef.current && !expectResponseRef.current && rid) {
          log('[gate] cancel unexpected response.created', rid);
          safeSend({ type:'response.cancel', response_id: rid });
          return;
        }
  
        currentResponseIdRef.current = rid || null;
        respPendingRef.current = true;
        expectResponseRef.current = false;
        voiceTextBufRef.current = '';
        currentAssistantMsgIdRef.current = null;
        break;
      }
  
      // Assistant streaming text (we reuse this for audio transcript deltas too)
      case 'response.text.delta':
      case 'response.output_text.delta':
      case 'response.audio_transcript.delta': {
        const rid = ev?.response_id || ev?.response?.id || null;
        if (!rid || rid !== currentResponseIdRef.current) break;
        voiceTextBufRef.current = (voiceTextBufRef.current || '') + (ev?.delta || '');
        upsertAssistantStream();
        break;
      }
  
      case 'response.text.done':
      case 'response.output_text.done':
      case 'response.completed': {
        const rid = ev?.response_id || ev?.response?.id || null;
        if (!rid || rid !== currentResponseIdRef.current) break;
  
        const text = (voiceTextBufRef.current || '').trim();
        if (currentAssistantMsgIdRef.current) finalizeAssistantStream();
        else if (text) addMessage('assistant', text);
        if (text) transcriptRef.current.push({ role:'assistant', text, ts:Date.now() });
        voiceTextBufRef.current = '';
  
        if (respPendingRef.current) {
          respPendingRef.current = false;
          currentResponseIdRef.current = null;
          finalizeTurn();
        }
        break;
      }
  
      // We ignore deltas for our user-voice turn; we only act on the "completed" event below
      case 'conversation.item.input_audio_transcription.delta': {
        break;
      }
  
      // SERVER transcript completed (only accept if it's the one from our keyup-commit window)
      case 'conversation.item.input_audio_transcription.completed':
      case 'input_audio_transcription.completed': {
        const raw = (ev?.transcript || ev?.text) || (ev?.item?.transcript) || '';
        const text = (Array.isArray(raw) ? raw.join(' ') : raw || '').trim();
        if (!text) break;
  
        // Accept only if: NOT holding + we marked this as our manual commit + still within window
        const inWindow = Date.now() <= (commitWindowUntilRef.current || 0);
        if (pttActiveRef.current || !manualCommitRef.current || !inWindow) {
          log('[voice] ignoring transcript (still holding or server-committed)');
          break;
        }
  
        // Consume the window immediately so nothing else can slip in
        manualCommitRef.current = false;
        commitWindowUntilRef.current = 0;
        turnCommittedRef.current = false;
  
        // 1) Show user bubble first
        addMessage('user', text);
        transcriptRef.current.push({ role:'user', text, ts:Date.now() });
        lastUserTextRef.current = text;
  
        // Ensure bubble is painted before assistant starts
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  
        // 2) Update visuals (summary/state/proposals)
        addAndReconcileForUserTurn(text, 'live').catch(()=>{});
        try {
          const [sum, st, prop] = await Promise.all([
            postJSON('/summary', { transcript: transcriptRef.current.slice(-30), mode:'live' }),
            postJSON('/state',   { transcript: transcriptRef.current.filter(t=>t.role==='user').slice(-30), mode:'live' }),
            postJSON('/propose', { transcript: transcriptRef.current.slice(-30), focus: defPackRef.current||'', mode:'live' })
          ]);
          if (sum?.summary){ setSummary(sum.summary); summaryRef.current = sum.summary; }
          if (st?.state)    { applyStatePatch({ add: st.state }); }
          if (prop?.proposals?.length) enqueueProposals(prop.proposals.map(p=>({ ...p, source:'scout' })));
        } catch(e){ log('[turn helpers err]', e?.message||e); }
  
        // 3) Now ask the assistant to reply (same policy as typed turns)
        const policy = speakPolicyRef.current;  // 'confirm' | 'auto' | 'text'
        // If the user explicitly said "go ahead", treat it like auto for this turn
        const shouldSpeakThisTurn = isVoiceConfirmation(text) || policy === 'auto';
        const modalities = shouldSpeakThisTurn ? ['text','audio'] : ['text'];

        // We already have a conversation item for the audio turn, so we can directly request a response.
        expectResponseRef.current = true;
        safeSend({
          type:'response.create',
          response:{ modalities, instructions: buildSystemCtx() }
        });

        // If policy is 'confirm', also stage the confirm button to allow a follow-up *voice* turn later.
        if (policy === 'confirm') {
          pendingSpeakRef.current = { kind:'follow_up', instructions: buildSystemCtx() };
          setConfirmUI(true, '✅ Confirm & Speak');
        }
        break;
      }
  
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
        upsertAssistantStream();
        break;
      }
  
      case 'input_audio_buffer.speech_started': {
        turnCommittedRef.current = false;
        break;
      }
  
      case 'input_audio_buffer.committed': {
        turnCommittedRef.current = true;
        break;
      }
  
      // Tool streaming — no-op ACKs (avoid tool_outputs errors on Realtime)
      case 'response.function_call_arguments.delta': {
        // swallow; we don't need to build args for this app flow
        break;
      }
      case 'response.function_call_arguments.done': {
        // If you want, inspect ev.name / ev.call_id here and update state directly;
        // we intentionally avoid sending tool_outputs back on Realtime to prevent 400s.
        break;
      }
  
      case 'response.audio_transcript.done': {
        const text = (voiceTextBufRef.current || '').trim();
        if (text) {
          if (!currentAssistantMsgIdRef.current) upsertAssistantStream();
          finalizeAssistantStream();
          transcriptRef.current.push({ role: 'assistant', text, ts: Date.now() });
          voiceTextBufRef.current = '';
          refreshFinalSummary().catch(()=>{});
        }
        break;
      }
  
      case 'response.done': {
        const rid = ev?.response_id || ev?.id || null;
        if (!respPendingRef.current) break;
        if (currentResponseIdRef.current && rid && rid !== currentResponseIdRef.current) break;
  
        finalizeAssistantStream();
        respPendingRef.current = false;
        currentResponseIdRef.current = null;
  
        if (unmuteWhenClearedRef.current && !pttActiveRef.current) {
          setAssistantMuted(false);
          unmuteWhenClearedRef.current = false;
        }
  
        finalizeTurn();
        break;
      }
  
      case 'error': {
        const msg = ev?.error?.message || '';
        if (ev?.error?.code === 'input_audio_buffer_commit_empty') {
          manualCommitRef.current = false;
          log('[commit] ignored empty buffer');
        } else {
          log('[event error]', ev);
        }
        break;
      }
  
      default: {
        if (ev.type) log('[event]', ev.type);
      }
    }
  
    flushOutbox();
  }
  

  // --- PTT ---

  const speakPolicyRef = useRef('confirm'); // 'confirm' | 'auto' | 'text'
  useEffect(()=>{
    const sel = document.getElementById('speak-policy');
    if (sel) sel.onchange = () => { speakPolicyRef.current = sel.value; };
  },[]);

  const chatRef = useRef([]); // [{id, role:'user'|'assistant', text, ts, turn_id}]

  function renderChat(){
    const el = document.getElementById('chat'); if (!el) return;
    el.innerHTML = chatRef.current.map(m => `
      <div style="margin:6px 0; display:flex; ${m.role==='user'?'justify-content:flex-end':''}">
        <div style="max-width:70%; border:1px solid #ddd; border-radius:12px; padding:8px 10px; background:${m.role==='user'?'#e8f0fe':'#fff'}">
          <div class="small" style="color:#666;margin-bottom:2px">${m.role==='user'?'You':'Assistant'} • ${new Date(m.ts).toLocaleTimeString()}</div>
          <div>${escapeHtml(m.text)}</div>
        </div>
      </div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  function addMessage(role, text, turn_id=null){
    chatRef.current.push({ id: genId('m'), role, text, ts: Date.now(), turn_id });
    renderChat();
  }

  // ---- Assistant streaming helpers ----
  const currentAssistantMsgIdRef = React.useRef(null);

  function upsertAssistantStream() {
    // create a bubble once, then update its text on each delta
    if (!currentAssistantMsgIdRef.current) {
      const id = genId('m');
      chatRef.current.push({
        id,
        role: 'assistant',
        text: '',
        ts: Date.now(),
        streaming: true,
        turn_id: currentResponseIdRef.current || null
      });
      currentAssistantMsgIdRef.current = id;
    }
    const msg = chatRef.current.find(m => m.id === currentAssistantMsgIdRef.current);
    if (msg) {
      msg.text = (voiceTextBufRef.current || '');
      renderChat();
    }
  }

  function finalizeAssistantStream() {
    if (!currentAssistantMsgIdRef.current) return;
    const msg = chatRef.current.find(m => m.id === currentAssistantMsgIdRef.current);
    if (msg) {
      msg.streaming = false;
      msg.ts = Date.now();
    }
    currentAssistantMsgIdRef.current = null;
    renderChat();
  }


  function openPropagationPanel(claimId){
    console.warn('[propagation] openPropagationPanel not implemented yet', claimId);
    // TODO: implement modal listing usages (in-sync / pinned / out-of-scope) with apply checkboxes
  }

  useEffect(()=>{
    const box = document.getElementById('chat-input');
    const send = document.getElementById('chat-send');
    if (send) send.onclick = () => { const t=box.value.trim(); if(t){ onUserTextSend(t); box.value=''; } };
    if (box) box.onkeydown = (e)=>{ if(e.key==='Enter'){ const t=box.value.trim(); if(t){ onUserTextSend(t); box.value=''; } } };
  },[]);

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

      pttActiveRef.current = true;
      pttStartAtRef.current = Date.now();
      manualCommitRef.current = false;           // not our commit yet
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

      pttActiveRef.current = false;
      setPTTActiveUI(false);


      // ignore very short taps to avoid 0ms buffer errors
      if (Date.now() - pttStartAtRef.current < MIN_PTT_MS) {
        setAssistantMuted(false);
        return;
      }

      manualCommitRef.current = true;            // next COMMIT is ours
      commitWindowUntilRef.current = Date.now() + COMMIT_WINDOW_MS;

      // FORCE a commit of the server's audio buffer BEFORE detaching mic
      log('[ptt] committing input_audio_buffer');
      safeSend({ type:'input_audio_buffer.commit' });

            // Stop local SR first
      stopSpeech();

      // small tail for prosody and to let commit enqueue cleanly
      await new Promise(r=>setTimeout(r,150));

      try{ micSenderRef.current?.replaceTrack(null); }catch{}

      // log local text right away (if any)
      const text = (pttBufferRef.current||'').trim();
      pttBufferRef.current='';
      if (text) {
        log('[ptt local text]', text);
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
 // ---- onConnect (sets up session and triggers greeting) ----
async function onConnect(){
  setStatus('Connecting…');
  try{
    const conn = await connectRealtime();
    connRef.current = conn;

    micTrackRef.current  = conn.micTrack;
    micSenderRef.current = conn.micSender;

    renderViz(document.getElementById('viz'), stateRef.current);
    if (typeof updateCoverageCounters === 'function') updateCoverageCounters();

    conn.setHandler(handleServerEvent);
    try { micSenderRef.current?.replaceTrack(null); } catch {}

    const arm = () => {
      if (onConnect.didConfig) return;
      onConnect.didConfig = true;

      log('[session.update] voice+transcription');
      // Manual-commit PTT (omit turn_detection entirely)
      safeSend({
        type: 'session.update',
        session: {
          voice: 'alloy',
          input_audio_transcription: { model: 'whisper-1' }
        }
      });

      // Don’t let the assistant hear itself
      try { micSenderRef.current?.replaceTrack(null); } catch {}
      setAssistantMuted(false);

      // Open the definition-gate UX
      gateOpenRef.current = true;
      consentRef.current  = false;
      defPackRef.current  = null;

      setStatus('Connected. Define the decision to begin.');

      // ✅ Make the router allow the greeting:
      // mark a “committed” moment and set expected reply BEFORE sending
      turnCommittedRef.current  = true;
      expectResponseRef.current = true;

      // Fire the greeting
      sendDefinitionGreeter();

      flushOutbox();
    };

    if (conn.dc?.readyState === 'open') { arm(); }
    else { conn.dc?.addEventListener('open', arm); }

    const flusher = setInterval(flushOutbox, 200);
    conn.pc.onconnectionstatechange = () => {
      if (['failed','closed','disconnected'].includes(conn.pc.connectionState)) clearInterval(flusher);
    };
  } catch (err){
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

