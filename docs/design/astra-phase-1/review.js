/* Standalone design prototype. All records and asynchronous events are synthetic. */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const statuses = ['Paid','Unpaid','Pending','Confirmed','Dispatched','Delivered','RTO','Cancelled','Junk'];
  const pill = (s) => `<span class="pill ${s.toLowerCase()}">${s}</span>`;
  // Small stroke-based icon set, same visual language as production
  // lucide-react (shadcn/ui's default icon library). Used sparingly — only
  // where an icon aids scanning a dense row, never as decoration.
  const ICON = {
    chevron: '<svg class="icon icon-sm icon-chevron" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>',
    lock: '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    eye: '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="2.6"/></svg>',
    openLink: '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><line x1="20" y1="4" x2="11" y2="13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
    sun: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="7" y2="7"/><line x1="17" y1="17" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="7" y2="17"/><line x1="17" y1="7" x2="19.1" y2="4.9"/></svg>',
    moon: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>',
  };
  const names = ['Rohit Verma','Imran Sheikh','Suresh Nair','Mahesh Patil','Arun Kumar','Vivek Shah','Deepak Yadav','Amit Sinha','Rahul Mehta','Nitin Joshi','Karan Malhotra','Sanjay Rao','Pranav Desai','Manoj Singh','Akash Gupta','Vikas Sharma','Rajesh Das','Ajay Menon','Sameer Khan','Dinesh Jain','Harish Bhat','Anil Kapoor','Varun Sethi','Rakesh Tiwari','Sunil Thomas'];
  const columns = [
    {key:'select',label:'Selection',width:34}, {key:'name',label:'Customer'},
    {key:'phone',label:'Phone',width:145}, {key:'status',label:'Status',width:106},
    {key:'due',label:'Follow-up',width:116}, {key:'owner',label:'Owner',width:102},
    {key:'activity',label:'Collaboration',width:176}, {key:'action',label:'Action',width:88}
  ];
  let records, focusId, expandedId, editingId, failNext = false, failDetail = false, loading = false;
  let selected = new Set(), hidden = new Set(), detail = new Map(), pending = new Set();
  let sort = {key:'status',direction:1}, view = 'grid', epoch = 0, draft = '', invalid = false;
  let timers = new Set();
  const later = (fn, ms) => { const e = epoch; const id = setTimeout(() => {timers.delete(id); if(e === epoch) fn();}, ms); timers.add(id); return id; };
  const announce = (text) => { $('#announcer').textContent = text; };
  function reset() {
    epoch++; timers.forEach(clearTimeout); timers.clear();
    records = Array.from({length:50}, (_,i) => ({id:1042+i, name:names[i%25] + (i>=25 ? ' · '+(i+1) : ''), phone:i===0?'+919876543210':i===1?'+919812345678':`+9198${String(10000000+i*73129).slice(-8)}`, status:i<18?'Paid':statuses[(i-18)%9], due:i<4?`${i+1}d overdue`:i<22?'Today · 16:30':'09 Sep · 10:00', owner:i===4||i%11===0&&i>0?'Unclaimed':i%5===0?'Riya':'Ananya', lockUntil:i===2?Date.now()+600000:0, presence:i===1?'Dev viewing':'', saving:false, rolledBack:false, updated:false, archived:false}));
    selected.clear(); detail.clear(); pending.clear(); hidden.clear();
    focusId = records[0].id; expandedId = editingId = null; sort = {key:'status',direction:1};
    failNext = failDetail = loading = invalid = false;
    $('#search').value = ''; $('#filter').value = 'all'; $('#toast-region').replaceChildren(); records.sort(compare); render();
  }
  const locked = (r) => r.lockUntil > Date.now();
  function filtered() {
    const q = $('#search').value.trim().toLowerCase(), f = $('#filter').value;
    return records.filter(r => {
      const snapshot = r.filterSnapshot || r;
      return !r.archived && (!q || `${r.name} ${r.owner==='Unclaimed'?'98••••4773':r.phone} ${r.id}`.toLowerCase().includes(q)) && (f==='all'||f==='paid'&&snapshot.status==='Paid'||f==='mine'&&snapshot.owner==='Ananya'||f==='unclaimed'&&snapshot.owner==='Unclaimed');
    });
  }
  function compare(a,b) {
    const key = sort.key;
    const av = key==='status'?statuses.indexOf(a.status):a[key];
    const bv = key==='status'?statuses.indexOf(b.status):b[key];
    return (typeof av==='number'?av-bv:String(av).localeCompare(String(bv)))*sort.direction || a.id-b.id;
  }
  function applySort() { records.sort(compare); pending.clear(); records.forEach(r=>{r.updated=false;delete r.filterSnapshot;}); render(); }
  function visibleColumns() { return columns.filter(c=>!hidden.has(c.key)); }
  function lockTime(r) { const seconds=Math.max(0,Math.ceil((r.lockUntil-Date.now())/1000)); return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`; }
  function cell(r,key) {
    if(key==='select') return `<input type="checkbox" data-select="${r.id}" aria-label="Select ${esc(r.name)}" ${selected.has(r.id)?'checked':''} ${locked(r)?'disabled':''}>`;
    if(key==='name') return `<button class="name-button" data-open="${r.id}" aria-expanded="${expandedId===r.id}" ${expandedId===r.id?`aria-controls="detail-${r.id}"`:''}><span class="name-text">${esc(r.name)}</span>${ICON.chevron}</button>`;
    if(key==='phone') return r.owner==='Unclaimed'?'<span class="muted" title="Unclaimed. Claim this record to reveal the phone number.">98••••4773</span>':esc(r.phone);
    if(key==='status') return pill(r.status);
    if(key==='due') return `<span class="${r.due.includes('overdue')?'overdue':''}">${r.due}</span>`;
    if(key==='owner') {
      if(editingId===r.id) return `<form class="cell-editor" id="owner-form"><input id="owner-input" aria-label="Owner for ${esc(r.name)}" aria-describedby="edit-help" aria-invalid="${invalid}" value="${esc(draft)}" autocomplete="off"><button aria-label="Save owner">↵</button></form>`;
      return `<button class="owner-button ${r.rolledBack?'invalid-cell':''}" data-edit="${r.id}" ${locked(r)||r.saving?'disabled':''} title="${r.rolledBack?'Save failed. Previous value restored. Press E to retry.':'Edit owner · E'}">${esc(r.owner)}</button>`;
    }
    if(key==='activity') {
      if(editingId===r.id) return `<span id="edit-help" class="edit-caption">${invalid?'Required: Ananya, Riya or Dev':draft.trim()&&['Ananya','Riya','Dev'].includes(draft.trim())?'Valid · Enter to save':'Enter owner · Esc cancels'}</span>`;
      if(r.saving) return '<span class="edit-caption">Saving… · updated locally</span>';
      if(r.rolledBack) return '<span class="edit-caption">Save failed · restored</span>';
      if(locked(r)) return `<span class="lock-label" title="Riya started a call. Editing and claiming are unavailable for up to 10 minutes.">${ICON.lock}In call · Riya <span data-lock="${r.id}">${lockTime(r)}</span></span>`;
      if(r.updated) return '<span class="live-mark">Dev updated · just now</span>';
      if(r.presence) return `<span class="presence">${ICON.eye}${r.presence}</span>`;
      return '<span class="muted">—</span>';
    }
    if(key==='action') return locked(r)?`<span class="lock-label">${ICON.lock}Read only</span>`:r.owner==='Unclaimed'?`<button class="row-action" data-claim="${r.id}">Claim</button>`:`<button class="row-action" data-open="${r.id}">Open ${ICON.openLink}</button>`;
    return '';
  }
  function detailRow(r) {
    const state=detail.get(r.id);
    let body;
    if(state==='loading') body='<p role="status">Loading full record…</p><div class="detail-fields" style="margin-top:16px"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>';
    else if(state==='error') body=`<h3>Record could not load</h3><p>Your place in the list is unchanged.</p><button data-retry-detail="${r.id}">Retry loading record</button>`;
    else body=`<div class="detail-heading"><h3>${esc(r.name)} <span class="muted">/ KM-${r.id}</span></h3>${pill(r.status)}<button data-close-record>Close <kbd>Esc</kbd></button></div><div class="detail-fields"><dl><dt>Contact</dt><dd>${r.owner==='Unclaimed'?'98••••4773 · claim to reveal':esc(r.phone)}</dd><dt>Assigned executive</dt><dd>${esc(r.owner)}</dd></dl><dl><dt>Consultation</dt><dd>Completed · 08 Sep, 11:30</dd><dt>Next follow-up</dt><dd>${r.due}</dd></dl><dl><dt>Last activity</dt><dd>Customer requested an evening callback.</dd><dt>Record source</dt><dd>Website · sample record</dd></dl></div><p>${locked(r)?'Riya is on a call. This record is available to read; editing resumes when the lock expires.':'Full details load only when opened. Closing returns keyboard focus to this row.'}</p>`;
    return `<tr class="detail-row"><td colspan="${visibleColumns().length}"><div id="detail-${r.id}" class="detail-panel" role="region" aria-label="Full record for ${esc(r.name)}" aria-busy="${state==='loading'}">${body}</div></td></tr>`;
  }
  function render() {
    const cols=visibleColumns(), rows=filtered();
    if(!rows.some(r=>r.id===focusId)) focusId=rows[0]?.id;
    $('#grid-columns').innerHTML=cols.map(c=>`<col${c.width?` style="width:${c.width}px"`:''}>`).join('');
    $('#grid-head').innerHTML='<tr>'+cols.map(c=>`<th scope="col" ${['name','status','owner','due'].includes(c.key)?`aria-sort="${sort.key===c.key?(sort.direction===1?'ascending':'descending'):'none'}"`:''}>${c.key==='select'?'<input id="select-all" type="checkbox" aria-label="Select all available visible records">':['name','status','owner','due'].includes(c.key)?`<button data-sort="${c.key}">${c.label} <span aria-hidden="true">${sort.key===c.key?(sort.direction===1?'↑':'↓'):'↕'}</span></button>`:c.label}</th>`).join('')+'</tr>';
    $('#records-table').setAttribute('aria-busy', String(loading));
    $('#grid-body').innerHTML=loading?Array.from({length:20},(_,i)=>`<tr class="skeleton-record" aria-hidden="true">${cols.map((c,j)=>`<td><span class="skeleton ${(i+j)%3?'':'short'}"></span></td>`).join('')}</tr>`).join(''):rows.map(r=>`<tr id="row-${r.id}" class="record-row ${focusId===r.id?'keyboard':''} ${selected.has(r.id)?'selected':''}" data-row="${r.id}">${cols.map(c=>`<td data-cell="${c.key}">${cell(r,c.key)}</td>`).join('')}</tr>${expandedId===r.id?detailRow(r):''}`).join('');
    $('#record-count').textContent=rows.length;
    $('#grid-summary').textContent=loading?'Loading records…':`${rows.length} records · ${selected.size} selected`;
    $('#grid-empty').hidden=loading||rows.length>0;
    $('#standard-tools').hidden=selected.size>0; $('#bulk-tools').hidden=selected.size===0;
    $('#selection-count').textContent=`${selected.size} selected`;
    $('#apply-updates').hidden=pending.size===0; $('#apply-updates').textContent=`${pending.size} update${pending.size===1?'':'s'} · apply sort`;
    const selectable=rows.filter(r=>!locked(r));
    $('#select-all').disabled=loading||selectable.length===0;
    $('#select-all').checked=selectable.length>0&&selectable.every(r=>selected.has(r.id));
    $('#select-all').indeterminate=selectable.some(r=>selected.has(r.id))&&!$('#select-all').checked;
  }
  function focusGrid(scroll=false) { $('#table-scroll').focus({preventScroll:true}); if(scroll) $(`#row-${focusId}`)?.scrollIntoView({block:'nearest'}); }
  function beginEdit(id) {
    const r=records.find(r=>r.id===id); if(!r||locked(r)||r.saving||loading) return;
    hidden.delete('owner'); hidden.delete('activity'); focusId=id; editingId=id; draft=r.owner==='Unclaimed'?'':r.owner; invalid=false;
    render(); $('#owner-input').focus(); $('#owner-input').select(); announce(`Editing owner for ${r.name}. Enter Ananya, Riya or Dev.`);
  }
  function saveOwner() {
    const value=$('#owner-input').value.trim();
    if(!['Ananya','Riya','Dev'].includes(value)) { draft=value; invalid=true; render(); $('#owner-input').focus(); announce('Owner must be Ananya, Riya or Dev.'); return; }
    const r=records.find(r=>r.id===editingId), previous=r.owner, shouldFail=failNext;
    failNext=false; editingId=null; r.owner=value; r.saving=true; r.rolledBack=false; render(); focusGrid();
    later(()=>{r.saving=false; if(shouldFail) {r.owner=previous;r.rolledBack=true;toast('Couldn’t save owner',`${r.name}: restored ${previous}. Your attempted value was ${value}.`,'Retry',()=>{beginEdit(r.id);draft=value;render();$('#owner-input').focus();}); announce(`Save failed. ${previous} restored.`);} else {toast('Owner saved',`${r.name} is assigned to ${value}.`);announce('Owner saved.');} render();},1100);
  }
  function openRecord(id,retry=false) {
    if(loading) return;
    focusId=id; editingId=null;
    if(expandedId===id&&!retry) {expandedId=null;render();focusGrid();return;}
    expandedId=id;
    if(!detail.has(id)||retry) {detail.set(id,'loading');const failure=failDetail;failDetail=false;later(()=>{detail.set(id,failure?'error':'ready');if(expandedId===id){render();announce(failure?'Full record could not load. Retry is available.':'Full record loaded.');}},650);}
    render(); focusGrid();
  }
  function toast(title,message,actionLabel,action,undoSeconds=0) {
    const el=document.createElement('div');el.className='toast';
    el.innerHTML=`<button class="toast-close" aria-label="Dismiss notification">×</button><strong>${esc(title)}</strong><p>${esc(message)}</p>${action?`<div class="toast-actions"><button class="toast-action">${esc(actionLabel)}</button>${undoSeconds?'<span class="muted timer">10s remaining</span>':''}</div>`:''}${undoSeconds?'<div class="undo-track"><div class="undo-progress"></div></div>':''}`;
    $('#toast-region').append(el); el.querySelector('.toast-close').onclick=()=>el.remove();
    if(action) el.querySelector('.toast-action').onclick=()=>{action();el.remove();};
    if(undoSeconds) {const until=Date.now()+undoSeconds*1000;const tick=()=>{const left=Math.max(0,until-Date.now());el.querySelector('.timer').textContent=`${Math.ceil(left/1000)}s remaining`;el.querySelector('.undo-progress').style.width=`${left/(undoSeconds*10)}%`;if(left>0&&el.isConnected)later(tick,200);else el.remove();};tick();}
    else if(!action) later(()=>el.remove(),5000);
    return el;
  }
  function bulk(kind) {
    const affected=records.filter(r=>selected.has(r.id)&&!locked(r)&&!r.saving);
    if(!affected.length) return;
    const previous=affected.map(r=>({id:r.id,owner:r.owner}));
    affected.forEach(r=>{if(kind==='archive')r.archived=true;else r.owner='Ananya';});selected.clear();render();focusGrid();
    if(kind==='archive') toast(`${affected.length} records archived`,'Removed from this view. You can restore them for 10 seconds.','Undo',()=>{affected.forEach(r=>r.archived=false);render();announce('Archived records restored.');},10);
    else toast(`${affected.length} records assigned`,'Assigned to Ananya in this local demo.','Undo',()=>{previous.forEach(p=>records.find(r=>r.id===p.id).owner=p.owner);render();});
  }
  function claim(id) {const r=records.find(r=>r.id===id);if(locked(r)||r.owner!=='Unclaimed')return;r.owner='Ananya';render();toast('Record claimed',`${r.name} is now yours. The phone number is visible.`);}
  function changeView(next) {view=next;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==`${next}-view`);document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===next);if(b.dataset.view===next)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});}
  function toggleTheme() {const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';$('#theme-toggle').innerHTML=`<span class="btn-label">${dark?ICON.sun:ICON.moon}Switch to ${dark?'light':'dark'}</span>`;}
  function scenario(which) {
    $('#scenarios-dialog').close();changeView('grid');
    if(which==='reset'){reset();return;}
    if(which==='loading'){editingId=null;loading=true;render();announce('Loading records.');later(()=>{loading=false;render();announce('50 records loaded.');},1500);}
    if(which==='failure'){failNext=true;beginEdit(focusId);toast('Next save will fail','Change the owner to Riya or Dev, then press Enter to see the rollback.');}
    if(which==='detail-failure'){failDetail=true;detail.delete(focusId);openRecord(focusId,true);}
    if(which==='live'){const r=records.find(r=>r.id===focusId)||records[0];r.filterSnapshot??={status:r.status,owner:r.owner};r.status=r.status==='Paid'?'Confirmed':'Paid';r.updated=true;pending.add(r.id);render();if(editingId)$('#owner-input')?.focus();announce(`${r.name}: Dev changed status to ${r.status}. Row position preserved. Apply sort when ready.`);}
  }
  const commandItems=[['Open colour system',()=>changeView('colours')],['Open interactive grid',()=>{changeView('grid');focusGrid();}],['Review all grid states',()=>changeView('states')],['Switch light / dark theme',toggleTheme],['Search records',()=>{changeView('grid');$('#search').focus();}],['Show loading rows',()=>scenario('loading')],['Demonstrate failed save',()=>scenario('failure')],['Receive a live update',()=>scenario('live')]];
  function renderCommands() {const q=$('#command-search').value.toLowerCase();$('#commands').innerHTML=commandItems.map(([label],i)=>label.toLowerCase().includes(q)?`<button data-command="${i}">${label}</button>`:'').join('')||'<p class="muted">No matching commands.</p>';}
  function openCommands() {renderCommands();$('#command-dialog').showModal();$('#command-search').focus();}
  document.addEventListener('click',(event)=>{
    const b=event.target.closest('button');
    if(b?.dataset.view)changeView(b.dataset.view);
    if(b?.dataset.close)document.getElementById(b.dataset.close).close();
    if(b?.dataset.open)openRecord(Number(b.dataset.open));
    if(b?.dataset.edit)beginEdit(Number(b.dataset.edit));
    if(b?.dataset.claim)claim(Number(b.dataset.claim));
    if(b?.hasAttribute('data-close-record')){expandedId=null;render();focusGrid();}
    if(b?.dataset.retryDetail)openRecord(Number(b.dataset.retryDetail),true);
    if(b?.dataset.sort){sort={key:b.dataset.sort,direction:sort.key===b.dataset.sort?-sort.direction:1};editingId=null;applySort();}
    if(b?.dataset.scenario)scenario(b.dataset.scenario);
    if(b?.dataset.command){$('#command-dialog').close();commandItems[Number(b.dataset.command)][1]();}
    const row=event.target.closest('[data-row]');if(row&&!event.target.closest('button,input,form')){focusId=Number(row.dataset.row);editingId=null;render();focusGrid();}
  });
  document.addEventListener('change',(event)=>{
    const el=event.target;
    if(el.matches('[data-select]')){const id=Number(el.dataset.select);el.checked?selected.add(id):selected.delete(id);focusId=id;render();focusGrid();}
    if(el.id==='select-all'){filtered().filter(r=>!locked(r)).forEach(r=>el.checked?selected.add(r.id):selected.delete(r.id));render();focusGrid();}
    if(el.matches('[data-column]')){el.checked?hidden.delete(el.dataset.column):hidden.add(el.dataset.column);render();}
    if(el.id==='filter'){selected.clear();expandedId=editingId=null;render();}
  });
  document.addEventListener('input',(event)=>{
    if(event.target.id==='search'){selected.clear();expandedId=editingId=null;render();}
    if(event.target.id==='command-search')renderCommands();
    if(event.target.id==='owner-input'){draft=event.target.value;invalid=false;event.target.setAttribute('aria-invalid','false');$('#edit-help').textContent=['Ananya','Riya','Dev'].includes(draft.trim())?'Valid · Enter to save':'Required: Ananya, Riya or Dev';}
  });
  document.addEventListener('submit',(event)=>{if(event.target.id==='owner-form'){event.preventDefault();saveOwner();}});
  document.addEventListener('keydown',(event)=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!document.querySelector('dialog[open]'))openCommands();return;}
    if(document.querySelector('dialog[open]'))return;
    const typing=event.target.matches('input,select,textarea');
    if(event.key==='Escape'){if(editingId){editingId=null;render();focusGrid();}else if(expandedId){expandedId=null;render();focusGrid();}else if(selected.size){selected.clear();render();focusGrid();}else if(typing){event.target.blur();focusGrid();}return;}
    if(typing||event.ctrlKey||event.metaKey||event.altKey||view!=='grid'||loading)return;
    if(event.key==='/'){event.preventDefault();selected.clear();render();$('#search').focus();return;}
    if(['j','k'].includes(event.key)){event.preventDefault();const rows=filtered();const i=rows.findIndex(r=>r.id===focusId);focusId=rows[Math.max(0,Math.min(rows.length-1,i+(event.key==='j'?1:-1)))]?.id;render();focusGrid(true);announce(`${records.find(r=>r.id===focusId)?.name||'No records'}`);}
    if(event.key==='e'){event.preventDefault();beginEdit(focusId);}
    if(event.key==='Enter'&&!event.target.closest('button')){event.preventDefault();if(focusId)openRecord(focusId);}
    if(event.key===' '&&!event.target.closest('button')){event.preventDefault();const r=records.find(r=>r.id===focusId);if(r&&!locked(r)){selected.has(focusId)?selected.delete(focusId):selected.add(focusId);render();focusGrid();}}
  });
  $('#theme-toggle').onclick=toggleTheme;
  $('#command-trigger').onclick=openCommands;
  $('#columns-trigger').onclick=()=>{$('#column-options').innerHTML=columns.filter(c=>!['select','name'].includes(c.key)).map(c=>`<label><input type="checkbox" data-column="${c.key}" ${hidden.has(c.key)?'':'checked'}>${c.label}</label>`).join('');$('#columns-dialog').showModal();};
  $('#scenarios-trigger').onclick=()=>$('#scenarios-dialog').showModal();
  $('#bulk-assign').onclick=()=>bulk('assign');$('#bulk-archive').onclick=()=>bulk('archive');
  $('#clear-selection').onclick=()=>{selected.clear();render();focusGrid();};
  $('#apply-updates').onclick=applySort;
  $('#reset-filter').onclick=()=>{$('#search').value='';$('#filter').value='all';render();$('#search').focus();};
  setInterval(()=>{records.filter(r=>r.lockUntil).forEach(r=>{const el=$(`[data-lock="${r.id}"]`);if(!locked(r)){r.lockUntil=0;if(!editingId)render();announce(`${r.name} is available to edit again.`);}else if(el)el.textContent=lockTime(r);});},1000);

  // Ratios use the W3C sRGB relative-luminance formula; the stylesheet is the source of truth.
  function ratio(a,b) {const lum=hex=>{const rgb=hex.replace('#','').match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;};const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
  const tokenNames=['bg','surface','border','border-str','text','text-dim','accent','accent-bg','on-accent','hover','paid','paid-bg','pend','pend-bg','stop','stop-bg'];
  function themeTokens(theme){const el=document.createElement('div');el.dataset.theme=theme;document.body.append(el);const styles=getComputedStyle(el);const result=Object.fromEntries(tokenNames.map(k=>[k,styles.getPropertyValue(`--${k}`).trim()]));el.remove();return result;}
  const palettes={light:themeTokens('light'),dark:themeTokens('dark')};
  const ratios=[['Body / surface','text','surface'],['Body / app','text','bg'],['Secondary / surface','text-dim','surface'],['Secondary / app','text-dim','bg'],['Secondary / hover','text-dim','hover'],['Secondary / selection','text-dim','accent-bg'],['Accent / surface','accent','surface'],['Accent / selection','accent','accent-bg'],['Primary button','on-accent','accent'],['Positive / fill','paid','paid-bg'],['Positive / surface','paid','surface'],['Attention / fill','pend','pend-bg'],['Attention / surface','pend','surface'],['Critical / fill','stop','stop-bg'],['Critical / surface','stop','surface']];
  const header=(num,title,description)=>`<header class="document-header"><p class="eyebrow">KAMOUR / FOUNDATION ${num}</p><h1>${title}</h1><p>${description}</p></header>`;
  function renderColours(){
    $('#colours-view').innerHTML=header('01','Quiet colour. Clear meaning.','Graphite surfaces, a single cobalt accent, and three business-state pairs. Contrast is deliberately stronger than a typical muted dashboard: this is a tool for long shifts on ordinary office monitors.')+
      `<div class="theme-pair">${Object.entries(palettes).map(([theme,t])=>`<article class="theme-sheet" data-theme="${theme}"><div class="sheet-heading"><h2>${theme==='light'?'Light / paper & graphite':'Dark / graphite & ink'}</h2><small>13px · AA text pairs</small></div><div class="palette-strip">${['bg','border-str','accent','text-dim','text'].map(k=>`<span style="background:${t[k]}" title="--${k}: ${t[k]}"></span>`).join('')}</div><div class="swatches">${statuses.map(pill).join('')}</div><p>Paid is filled and semibold. Unpaid is outlined and regular. State names remain readable without colour.</p></article>`).join('')}</div>`+
      '<h2>Tokens ready to lift</h2><table class="token-table"><thead><tr><th>CSS property</th><th>Light</th><th>Dark</th><th>Role</th></tr></thead><tbody>'+tokenNames.map(k=>`<tr><td><code>--${k}</code></td>${Object.values(palettes).map(t=>`<td><span class="colour-dot" style="background:${t[k]}"></span>${t[k]}</td>`).join('')}<td>${({'bg':'App chrome / neutral pill','surface':'Tables, inputs, dialogs','border':'Quiet row separators (not a control boundary)','border-str':'Control boundaries / table header rule','text':'Primary text','text-dim':'Secondary text; never lower opacity','accent':'Focus, selection, primary actions','accent-bg':'Selected rows / current navigation','on-accent':'Primary button text','hover':'Neutral pointer hover','paid':'Paid, delivered, confirmed','paid-bg':'Positive pill fill','pend':'Pending, unpaid, awaiting payment','pend-bg':'Attention pill fill','stop':'RTO, cancelled, SLA breach','stop-bg':'Critical pill fill'})[k]}</td></tr>`).join('')+'</tbody></table>'+
      '<h2>Measured text contrast</h2><p class="muted">Every pair below must exceed 4.5:1. Ratios shown to two decimals; passing uses the unrounded value.</p><table class="token-table"><thead><tr><th>Usage</th><th>Light</th><th>Dark</th></tr></thead><tbody>'+ratios.map(([label,fg,bg])=>`<tr><td>${label}</td>${Object.values(palettes).map(t=>`<td>${ratio(t[fg],t[bg]).toFixed(2)}:1 · ${ratio(t[fg],t[bg])>=4.5?'Pass':'FAIL'}</td>`).join('')}</tr>`).join('')+'</tbody></table>'+
      `<div class="note">Exactly three semantic pairs. Dispatched is a neutral progress state; Junk is neutral and dashed, because disqualification is not a delivery or payment failure. Validation, saving, presence and generic network failures use neutral text and explicit labels. They never borrow a business-status colour.</div><p class="muted">Calculation: <a href="https://www.w3.org/TR/WCAG22/#dfn-relative-luminance">W3C relative luminance</a> and <a href="https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html">minimum text contrast</a>. Row separators are decorative; interactive boundaries and focus are checked separately in the handoff report. This is a colour-pair audit, not a complete WCAG certification.</p>`;
  }
  function renderStates(){
    const samples=[
      ['Normal','','Rohit Verma',pill('Paid'),'Ananya','No extra decoration'],
      ['Hover','example-hover','Imran Sheikh',pill('Paid'),'Ananya','Neutral surface only'],
      ['Keyboard focus','example-keyboard','Suresh Nair',pill('Pending'),'Ananya','2px inset accent perimeter'],
      ['Selected','example-selected','Mahesh Patil',pill('Unpaid'),'✓ Selected','Checkbox + accent surface'],
      ['Multi-selected 1','example-selected','Arun Kumar',pill('Unpaid'),'✓ Selected','Toolbar replaces filters'],
      ['Multi-selected 2','example-selected','Vivek Shah',pill('Paid'),'✓ Selected','No new vertical space'],
      ['Entering edit','','Rohit Verma',pill('Paid'),'<input class="sample-input editing" value="Ananya" readonly aria-label="Entering owner edit">','Caret, selection, Enter / Esc'],
      ['Valid edit','','Rohit Verma',pill('Paid'),'<input class="sample-input editing" value="Riya" readonly aria-label="Valid owner edit">','Valid · Enter to save'],
      ['Invalid edit','','Rohit Verma',pill('Paid'),'<input class="sample-input invalid" placeholder="Owner" readonly aria-invalid="true" aria-label="Invalid owner edit">','Required: Ananya, Riya or Dev'],
      ['Saving','','Rohit Verma',pill('Paid'),'Riya','Saving… · local value visible'],
      ['Failed / rolled back','','Rohit Verma',pill('Paid'),'<span class="invalid-cell">Ananya</span>','Restored · retry retains draft'],
      ['Soft lock · 10 min','','Suresh Nair',pill('Pending'),'Riya · in call','Read only · 09:42 remaining'],
      ['Presence','','Imran Sheikh',pill('Paid'),'Ananya','<span class="presence">Dev viewing</span>'],
      ['Live update','','Mahesh Patil',pill('Confirmed'),'Ananya','<span class="live-mark">Dev updated · just now</span>'],
      ['Loading','','<span class="skeleton"></span>','<span class="skeleton"></span>','<span class="skeleton"></span>','<span class="skeleton"></span>']
    ];
    $('#states-view').innerHTML=header('02','One grid. Every working state.','The same tokens and row geometry in both themes. These specimens pin transient states for review; the interactive grid lets you try selection, edit validation, rollback, loading, presence, locks and stable live updates.')+
      ['light','dark'].map(theme=>`<article class="theme-sheet state-sheet" data-theme="${theme}"><div class="sheet-heading"><h2>${theme==='light'?'Light':'Dark'} / grid state inventory</h2><small>32px rows · 36px header</small></div><table><thead><tr><th>State</th><th aria-sort="ascending">Customer ↑</th><th>Status ↕</th><th>Owner</th><th>Visible feedback</th></tr></thead><tbody>${samples.map(([label,cls,name,status,owner,note])=>`<tr class="${cls}"><td>${label}</td><td>${name}</td><td>${status}</td><td>${owner}</td><td>${note}</td></tr>`).join('')}<tr class="detail-row"><td colspan="5"><div class="detail-panel"><div class="detail-heading"><h3>Expanded record / KM-1042</h3><span class="muted">Summary remains above</span></div><div class="detail-fields"><div><small>Contact</small><p>+919876543210</p></div><div><small>Last activity</small><p>Requested evening callback</p></div><div><small>Next follow-up</small><p>Today · 16:30</p></div></div><p style="margin-top:12px">In-place skeleton → full details. Failure stays inside this panel with Retry.</p></div></td></tr></tbody></table></article>`).join('')+
      '<div class="note">Live events patch values in place. A narrow accent mark and “Dev updated” identify the change. The footer offers “apply sort”; only that explicit action reorders the list. Never insert a banner above the table, auto-resort, or overwrite an active editor.</div>'+
      '<h2 class="section-title">Try the interactions</h2><ul><li>Use J / K, Enter, E, Space, /, Esc and Ctrl+K. Keyboard focus has a perimeter; selection has a checkbox and tint.</li><li>Enter an invalid owner, then Ananya, Riya or Dev. “Try a state” can fail the next save; Retry keeps the attempted value.</li><li>Select multiple rows to reveal bulk actions. Archive offers Undo with a visible 10-second countdown.</li><li>Open Columns or a saved filter. Loading preserves the header and fills the body with skeleton rows.</li><li>Open the locked row to read; its owner editor and selection are disabled. The lock expires 10 minutes after demo reset.</li></ul>';
  }
  function renderSpec(){
    const specs=[['Base type','13px / 19px · Inter, Segoe UI fallback · 400 body, 500 labels, 600 headings'],['Numbers','Tabular numerals inherited across the entire prototype, including IDs, dates, phones and timers'],['Grid body','32px including 1px bottom rule · 6px 10px cell padding · 19px content line'],['Grid header','36px including 1px bottom rule · 12px / 500 label'],['Pill','18px high · 11px type / 16px line · 0 6px padding · 1px border · 3px radius'],['Controls','28px input / select · 26px toolbar button · 24px inline editor · 4px radius'],['Focus','2px accent outline · 2px offset on controls · inset-equivalent cell borders on row'],['Rules','1px row rule (--border); 1px control and header rule (--border-str)'],['Shell','184px navigation · 28px title bar · 40px toolbar · 24px footer'],['Density budget','768 − 28 − 40 − 36 − 24 = 640px = 20 × 32px rows at 100% zoom'],['Window','1366 × 768 design target; 1180 × 700 proposed minimum. Smaller heights or OS/browser scaling show fewer rows; scrolling remains available.'],['Movement','120ms button colour transitions only · no skeleton shimmer · reduced motion removes transitions'],['Record expansion','In-place, below summary; local skeleton and local Retry. Extra height is intentional only after explicit expansion.']];
    $('#spec-view').innerHTML=header('HANDOFF','Precision is the design.','Phase 1: colour system and reusable grid only. This standalone HTML/CSS review uses invented records. It does not connect to the CRM, authenticate users, or mutate customer data.')+
      '<table class="spec-table"><tbody>'+specs.map(([a,b])=>`<tr><th scope="row">${a}</th><td>${b}</td></tr>`).join('')+'</tbody></table>'+
      '<h2 class="section-title">What changes in the shell</h2><p class="muted">Keep the existing 184px navigation. Remove the main region’s 16px outer gutter for grid routes, let the table meet the shell edges, and combine heading, search and filters into one 40px toolbar. Bulk selection replaces that toolbar. A 24px footer carries shortcuts and pending live updates. The review navigation stands in for the existing role-filtered module links.</p>'+
      '<h2 class="section-title">Implementation contract</h2><ul><li>Override shadcn TableCell padding, line height and TableRow hover. Its default spacing will break this density budget. Preserve native table semantics and real labelled checkboxes; keyboard row focus is separate from selection.</li><li>Keep TanStack row IDs stable. Cache only summary fields in the list, fetch full details on explicit expansion, and subscribe only to authorized filtered realtime channels.</li><li>Never auto-sort incoming updates. Stage out-of-filter rows until explicit refresh. Do not overwrite a dirty editor; a version conflict must retain the draft and offer a deliberate reload/retry.</li><li>Use server-authoritative lock expiry and atomic claim enforcement in production. This prototype simulates the 10-minute clock locally. Presence grants no permissions.</li><li>Optimistically patch the cell; on rejected save restore the prior value, announce the rollback and keep the attempted value available to Retry. Do not silently drop failed drafts.</li><li>Archive requires a reversible backend operation or delayed commit. The prototype changes local memory only. The Undo window is 10 seconds.</li><li>The title strip is a visual density allowance. Actual Tauri drag regions, native window controls and accessible window behaviour remain platform work.</li><li>Production fonts should be bundled locally. No external fonts, analytics or network requests are required by this prototype.</li></ul>'+
      '<div class="note">Review checkpoint: approve or adjust colour and grid before Today, module screens, order forms and the remaining dialogs. This checkpoint comes directly from the final “Deliverables, in order” section of <code>docs/astra-prompt.md</code>.</div>';
  }
  renderColours();renderStates();renderSpec();reset();
})();
