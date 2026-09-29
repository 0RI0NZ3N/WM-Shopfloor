/* MEII Shop Floor - jobs, product lists with department sign-off, receiving,
   material matching, dashboard and reports. Local-first: everything lives on
   the tablet (IndexedDB); Backup exports a JSON file. */

// Bump this together with VERSION in sw.js on every deploy. Shown in the
// header so it's visible at a glance whether a tablet has picked up the
// latest push, without digging into browser dev tools.
const APP_VERSION = 'v8';

/* ================= model helpers ================= */
const Model = (() => {
  const DEPTS = [['laser', 'Laser'], ['weld', 'Weld'], ['brake', 'Brake Press'], ['paint', 'Paint'], ['assy', 'Assembly']];
  const DK = DEPTS.map(d => d[0]);
  const GROUPS = ['G1', 'G2', 'G3', 'ENT', 'CAB'];
  function groupKey(title){
    const t = String(title || '').toUpperCase();
    for(const g of GROUPS) if(new RegExp('\\b' + g + '\\b').test(t)) return g;
    return 'X';
  }
  function lineStatus(ln){
    const st = ln.st || {};
    const bo = +ln.boQty > 0;
    const allDepts = DK.every(k => st[k] && st[k].on);
    if(allDepts && ln.qcInit && !bo) return 'done';
    if(bo) return 'bo';
    if(DK.some(k => st[k] && st[k].on) || ln.pkQty || ln.pkInit || ln.qcInit) return 'partial';
    return 'none';
  }
  function listStats(list){
    const s = { total: 0, done: 0, bo: 0, boPcs: 0, partial: 0, none: 0 };
    for(const ln of list.items){
      s.total++;
      const st = lineStatus(ln);
      s[st]++;
      if(+ln.boQty > 0) s.boPcs += +ln.boQty;
    }
    s.pct = s.total ? s.done / s.total : 0;
    return s;
  }
  const jobKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  function sameJob(a, b){
    const ka = jobKey(a), kb = jobKey(b);
    if(!ka || !kb) return false;
    if(ka === kb) return true;
    const da = ka.replace(/\D/g, ''), db = kb.replace(/\D/g, '');
    return da.length >= 3 && da === db && (!/[A-Z]/.test(ka) || !/[A-Z]/.test(kb));
  }
  return { DEPTS, DK, groupKey, lineStatus, listStats, jobKey, sameJob };
})();
window.Model = Model;

/* ================= state ================= */
const S = {
  jobs: [], lists: [], receipts: [], spools: [],
  set: { staff: ['M.I', 'Y.S', 'N.P', 'Z.M'], pin: '', openTabs: [], label: { w: 2, h: 1, dpi: 203 }, bins: [] },
  view: { name: 'dash' },
  ui: { dashFilter: 'active', dashQ: '', listFilter: {}, recvFilter: 'all', recvQ: '', editLines: {}, recvType: 'job', draftPhoto: null, lastRecv: {}, spoolQ: '', spoolFilter: 'all' }
};
/* ---- spool / reel length units ---- */
const SPOOL_UNITS = [['ft', 'ft'], ['in', 'in'], ['yd', 'yd'], ['m', 'm'], ['cm', 'cm']];
const UNIT_FT = { ft: 1, in: 1 / 12, yd: 3, m: 3.280839895013123, cm: 0.03280839895013123 };
const toFt = (qty, unit) => (+qty || 0) * (UNIT_FT[unit] || 1);
const fmtFt = ft => (Math.round((+ft || 0) * 100) / 100).toLocaleString() + ' ft';
const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const nowIso = () => new Date().toISOString();
const pct = x => Math.round(x * 100) + '%';
const ZONES = ['RECEIVING / HOLD', 'MISC / PROJECT STORAGE', 'BULK STORAGE', 'SHIPPING / STAGING', 'PRODUCTION'];
function code8(){
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; const r = crypto.getRandomValues(new Uint8Array(8));
  for(const b of r) s += A[b % A.length];
  return s;
}
function rel(iso){
  if(!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if(d < 60) return 'just now';
  if(d < 3600) return Math.floor(d / 60) + ' min ago';
  if(d < 86400) return Math.floor(d / 3600) + ' h ago';
  if(d < 86400 * 14) return Math.floor(d / 86400) + ' d ago';
  return new Date(iso).toLocaleDateString();
}
const when = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
function toast(msg, err){
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, err ? 5000 : 2600);
}

/* ================= persistence ================= */
async function load(){
  [S.jobs, S.lists, S.receipts, S.spools] = await Promise.all([DB.all('jobs'), DB.all('lists'), DB.all('receipts'), DB.all('spools')]);
  const st = await DB.all('settings');
  for(const r of st) S.set[r.k] = r.v;
  try{ if(navigator.storage && navigator.storage.persist) S.persisted = await navigator.storage.persist(); }catch(e){}
}
const saveSet = k => DB.setSetting(k, S.set[k]);
async function saveList(list){ list.updatedAt = nowIso(); await DB.put('lists', list); const j = job(list.jobId); if(j){ j.updatedAt = list.updatedAt; await DB.put('jobs', j); } }
async function saveJob(j){ j.updatedAt = nowIso(); await DB.put('jobs', j); }
async function saveReceipt(r){ r.updatedAt = nowIso(); await DB.put('receipts', r); }
async function saveSpool(sp){ sp.updatedAt = nowIso(); await DB.put('spools', sp); }
const masterSpools = () => S.spools.filter(s => s.kind === 'master').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
const fieldSpoolsOf = masterId => S.spools.filter(s => s.parentId === masterId);
const spoolsForJob = j => S.spools.filter(s => s.kind === 'field' && s.jobNo && Model.sameJob(s.jobNo, j.jobNo));
const stockFieldSpools = () => S.spools.filter(s => s.kind === 'field' && !s.jobNo);

const job = id => S.jobs.find(j => j.id === id);
const listsOf = jobId => S.lists.filter(l => l.jobId === jobId).sort((a, b) => (a.title + a.carNo).localeCompare(b.title + b.carNo));
function lineRef(listId, lineId){
  const l = S.lists.find(x => x.id === listId);
  return l ? { list: l, line: l.items.find(x => x.id === lineId) } : {};
}
function receiptsForJob(j){
  const listIds = new Set(listsOf(j.id).map(l => l.id));
  return S.receipts.filter(r => (r.type !== 'stock' && Model.sameJob(r.jobNo, j.jobNo)) || (r.matches || []).some(m => listIds.has(m.listId)))
    .sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
}
const recvFor = (listId, lineId) => S.receipts.filter(r => (r.matches || []).some(m => m.listId === listId && m.lineId === lineId));
function jobStats(j){
  const s = { total: 0, done: 0, bo: 0, boPcs: 0, partial: 0, none: 0, lists: [] };
  for(const l of listsOf(j.id)){
    const ls = Model.listStats(l);
    s.lists.push({ list: l, s: ls });
    for(const k of ['total', 'done', 'bo', 'boPcs', 'partial', 'none']) s[k] += ls[k];
  }
  s.pct = s.total ? s.done / s.total : 0;
  const recs = receiptsForJob(j);
  s.recv = recs.length; s.unmatched = recs.filter(r => !(r.matches || []).length).length;
  s.last = [j.updatedAt, ...s.lists.map(x => x.list.updatedAt), ...recs.map(r => r.updatedAt)].filter(Boolean).sort().pop();
  return s;
}
const gColor = g => 'var(--g-' + g + ')', gInk = g => 'var(--g-' + g + '-ink)';

/* ---- crate/skid standardization log ---- */
const PKG_TYPES = [
  { k: 'skid-32x96', label: 'Skid 32×96', kind: 'skid', era: 'new' },
  { k: 'skid-32x48', label: 'Skid 32×48', kind: 'skid', era: 'new' },
  { k: 'skid-48x48', label: 'Skid 48×48', kind: 'skid', era: 'old' },
  { k: 'skid-96x48', label: 'Skid 96×48', kind: 'skid', era: 'old' },
  { k: 'crate-32x96x30', label: 'Crate 32×96×30', kind: 'crate', era: 'new' },
  { k: 'crate-door50', label: 'Door crate (50" tall)', kind: 'crate', era: 'new' },
  { k: 'crate-48x48x30', label: 'Crate 48×48×30 (knock-down)', kind: 'crate', era: 'old' },
  { k: 'crate-cabceiling', label: 'Cab-ceiling crate (in-house)', kind: 'crate', era: 'new' }
];
const pkgType = k => PKG_TYPES.find(t => t.k === k) || { k, label: k, kind: '', era: '' };
function allPackaging(){
  const out = [];
  for(const j of S.jobs) for(const p of (j.packaging || [])) out.push({ j, p });
  return out.sort((a, b) => (b.p.at || '').localeCompare(a.p.at || ''));
}

/* ---- back order rollup across jobs ---- */
function allBoLines(){
  const out = [];
  for(const j of S.jobs) for(const l of listsOf(j.id)) for(const ln of l.items) if(+ln.boQty > 0) out.push({ j, l, ln });
  return out.sort((a, b) => (b.ln.boTs || '').localeCompare(a.ln.boTs || ''));
}

/* ================= PIN ================= */
function askPin(reason){
  return new Promise(resolve => {
    if(!S.set.pin) return resolve(true);
    let v = '';
    const draw = () => {
      openSheet('<h2>Enter PIN</h2><p class="muted">' + esc(reason) + '</p><div class="pindots">' + ('•'.repeat(v.length) || '&nbsp;') + '</div>' +
        '<div class="pinpad">' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, 'OK'].map(k => '<button data-k="' + k + '">' + k + '</button>').join('') + '</div>' +
        '<div class="row"><span class="sp"></span><button class="btn" data-k="X">Cancel</button></div>');
      $('#sheet').onclick = e => {
        const b = e.target.closest('[data-k]'); if(!b) return;
        const k = b.dataset.k;
        if(k === 'X'){ closeSheet(); resolve(false); }
        else if(k === 'C'){ v = ''; draw(); }
        else if(k === 'OK'){
          if(v === S.set.pin){ closeSheet(); resolve(true); }
          else { v = ''; draw(); toast('Wrong PIN', true); }
        } else { v += k; draw(); if(v.length === S.set.pin.length && v === S.set.pin){ closeSheet(); resolve(true); } }
      };
    };
    draw();
  });
}

/* ================= sheet / drawer ================= */
function openSheet(html){ $('#sheet').innerHTML = html; $('#sheet').onclick = null; $('#sheetWrap').hidden = false; }
function closeSheet(){ $('#sheetWrap').hidden = true; $('#sheet').innerHTML = ''; $('#sheet').onclick = null; }
$('#sheetWrap').addEventListener('click', e => { if(e.target.id === 'sheetWrap') closeSheet(); });
function confirmSheet(title, body, okLabel, danger){
  return new Promise(res => {
    openSheet('<h2>' + esc(title) + '</h2><p>' + body + '</p><div class="row"><span class="sp"></span><button class="btn" data-c="0">Cancel</button><button class="btn ' + (danger ? 'danger' : 'dark') + '" data-c="1">' + esc(okLabel || 'OK') + '</button></div>');
    $('#sheet').onclick = e => { const b = e.target.closest('[data-c]'); if(b){ closeSheet(); res(b.dataset.c === '1'); } };
  });
}

/* ================= navigation ================= */
function go(view){ S.view = view; closeDrawer(); render(); window.scrollTo(0, 0); }
function openJobTab(jobId, listId){
  if(!S.set.openTabs.includes(jobId)){ S.set.openTabs.push(jobId); saveSet('openTabs'); }
  const ls = listsOf(jobId);
  go({ name: 'job', jobId, sub: listId || (S.view.jobId === jobId && S.view.sub) || (ls[0] ? ls[0].id : 'material') });
}
function renderTabs(){
  const v = S.view;
  let h = '<button class="tab' + (v.name === 'dash' ? ' on' : '') + '" data-act="goDash">Dashboard</button>' +
    '<button class="tab' + (v.name === 'recv' ? ' on' : '') + '" data-act="goRecv">Receiving</button>' +
    '<button class="tab' + (v.name === 'spools' ? ' on' : '') + '" data-act="goSpools">Spools</button>';
  S.set.openTabs = S.set.openTabs.filter(id => job(id));
  for(const id of S.set.openTabs){
    const j = job(id), s = jobStats(j), g = listsOf(id)[0];
    h += '<div class="tab' + (v.name === 'job' && v.jobId === id ? ' on' : '') + '" data-act="goJob" data-id="' + esc(id) + '">' +
      '<span class="dot" style="background:' + gColor(g ? g.groupKey : 'X') + '"></span>' + esc(j.jobNo) +
      ' <span class="pct">' + pct(s.pct) + '</span><button class="x" data-act="closeTab" data-id="' + esc(id) + '" aria-label="Close tab">×</button></div>';
  }
  $('#tabs').innerHTML = h;
}
function render(){
  renderTabs();
  const v = S.view;
  const m = $('#main');
  if(v.name === 'dash') m.innerHTML = viewDash();
  else if(v.name === 'job') m.innerHTML = job(v.jobId) ? viewJob() : viewDash();
  else if(v.name === 'recv') m.innerHTML = viewRecv();
  else if(v.name === 'spools') m.innerHTML = viewSpools();
  else if(v.name === 'import') m.innerHTML = viewImport();
  else if(v.name === 'settings') m.innerHTML = viewSettings();
  afterRender();
}
function afterRender(){
  const d = $('#recvDesc'); if(d && S.view.focusDesc){ d.focus(); S.view.focusDesc = false; }
}

/* ================= dashboard ================= */
function viewDash(){
  const q = S.ui.dashQ.trim().toUpperCase();
  let jobs = S.jobs.filter(j => S.ui.dashFilter === 'all' || (S.ui.dashFilter === 'closed' ? j.status === 'closed' : j.status !== 'closed'));
  if(q) jobs = jobs.filter(j => (j.jobNo + ' ' + j.jobName + ' ' + j.customer).toUpperCase().includes(q));
  const rows = jobs.map(j => ({ j, s: jobStats(j) })).sort((a, b) => b.s.pct - a.s.pct || (b.s.done - a.s.done) || (b.s.last || '').localeCompare(a.s.last || ''));
  const active = S.jobs.filter(j => j.status !== 'closed').map(j => jobStats(j));
  const T = active.reduce((a, s) => ({ total: a.total + s.total, done: a.done + s.done, bo: a.bo + s.bo, un: a.un + s.unmatched }), { total: 0, done: 0, bo: 0, un: 0 });
  const unassigned = S.receipts.filter(r => r.type !== 'stock' && !S.jobs.some(j => Model.sameJob(r.jobNo, j.jobNo))).length;
  const pkgRows = allPackaging();
  const pkgNew = pkgRows.reduce((a, { p }) => a + (pkgType(p.type).era === 'new' ? (+p.qty || 0) : 0), 0);
  const pkgOld = pkgRows.reduce((a, { p }) => a + (pkgType(p.type).era === 'old' ? (+p.qty || 0) : 0), 0);
  let h = '<div class="row"><h1>Jobs</h1><span class="sp"></span>' +
    '<input class="search" placeholder="Search job #, name, customer" value="' + esc(S.ui.dashQ) + '" data-in="dashQ">' +
    '<button class="btn" data-act="printPackaging">Packaging report</button>' +
    '<button class="btn" data-act="printAll" data-detail="0">Print summary</button>' +
    '<button class="btn" data-act="printAll" data-detail="1">Print full report</button>' +
    '<button class="btn" data-act="goSettings">Settings</button></div>';
  h += '<div class="stats">' +
    '<div class="stat"><b>' + active.length + '</b><span>Active jobs</span></div>' +
    '<div class="stat"><b>' + (T.total ? pct(T.done / T.total) : '—') + '</b><span>Lines done (' + T.done + '/' + T.total + ')</span></div>' +
    '<button class="stat click" data-act="boRollup"><b style="color:var(--red)">' + T.bo + '</b><span>Lines on back order</span></button>' +
    '<div class="stat"><b>' + T.un + '</b><span>Received, not matched</span></div>' +
    '<div class="stat"><b>' + unassigned + '</b><span>Received for jobs not imported</span></div>' +
    '<div class="stat"><b>' + (pkgNew + pkgOld ? pct(pkgNew / (pkgNew + pkgOld)) : '—') + '</b><span>Packaging on new standard</span></div></div>';
  h += '<div class="row" style="margin-bottom:10px"><div class="chips">' +
    [['active', 'Active'], ['closed', 'Closed'], ['all', 'All']].map(([k, t]) => '<button class="chip' + (S.ui.dashFilter === k ? ' on' : '') + '" data-act="dashFilter" data-k="' + k + '">' + t + '</button>').join('') +
    '</div><span class="sp"></span><span class="legend">Sorted closest to completion. A line is done when all five departments and QC are signed and nothing is on back order.</span></div>';
  if(!rows.length){
    return h + '<div class="empty card"><h2>' + (S.jobs.length ? 'No jobs match' : 'No jobs yet') + '</h2><p>Import a product list PDF to create a job tab.</p>' +
      '<button class="btn primary" data-act="importList">+ Import product list</button></div>';
  }
  h += '<div class="grid">' + rows.map(({ j, s }, i) => {
    const w = x => (s.total ? x / s.total * 100 : 0).toFixed(1) + '%';
    return '<div class="jcard" data-act="goJob" data-id="' + esc(j.id) + '"><span class="rank">#' + (i + 1) + '</span>' +
      '<div><div class="jn">' + esc(j.jobNo) + (j.status === 'closed' ? ' <span class="tag">closed</span>' : '') + '</div><div class="muted">' + esc(j.jobName || '') + (j.customer ? ' · ' + esc(j.customer) : '') + '</div></div>' +
      '<div class="row"><span class="big">' + pct(s.pct) + '</span><span class="muted small">' + s.done + ' of ' + s.total + ' lines done</span></div>' +
      '<div class="bar"><i class="d" style="width:' + w(s.done) + '"></i><i class="p" style="width:' + w(s.partial) + '"></i><i class="b" style="width:' + w(s.bo) + '"></i></div>' +
      '<div class="lchips">' + s.lists.map(x => '<span class="lchip" style="background:' + gColor(x.list.groupKey) + ';color:' + gInk(x.list.groupKey) + '">' + esc(x.list.groupKey === 'X' ? x.list.title : x.list.groupKey) + (x.list.carNo ? ' · ' + esc(x.list.carNo) : '') + ' ' + pct(x.s.pct) + '</span>').join('') + '</div>' +
      '<div class="meta"><span>B/O lines <b style="color:' + (s.bo ? 'var(--red)' : 'inherit') + '">' + s.bo + '</b></span><span>Material <b>' + s.recv + '</b>' + (s.unmatched ? ' (<b>' + s.unmatched + '</b> unmatched)' : '') + '</span><span>' + rel(s.last) + '</span></div></div>';
  }).join('') + '</div>';
  return h;
}

/* ================= job view ================= */
function viewJob(){
  const j = job(S.view.jobId), s = jobStats(j), ls = listsOf(j.id);
  let sub = S.view.sub;
  if(sub !== 'material' && sub !== 'info' && !ls.some(l => l.id === sub)) sub = S.view.sub = ls[0] ? ls[0].id : 'material';
  const recs = receiptsForJob(j);
  let h = '<div class="card jhead"><div><div class="row"><h1 class="mono">' + esc(j.jobNo) + '</h1>' + (j.status === 'closed' ? '<span class="tag">closed</span>' : '') + '</div>' +
    '<div class="kv"><span>Job name</span><b>' + esc(j.jobName || '—') + '</b><span>Customer</span><b>' + esc(j.customer || '—') + '</b>' +
    (j.shipAddr ? '<span>Ship to</span><b>' + esc(j.shipAddr).replace(/\n/g, ', ') + '</b>' : '') + '</div></div>' +
    '<div class="jpct"><b>' + pct(s.pct) + '</b><div class="muted small">' + s.done + '/' + s.total + ' lines done · ' + s.bo + ' on B/O</div>' +
    '<div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn sm" data-act="printJob">Print job report</button><button class="btn sm" data-act="jobInfo">Job info</button></div></div></div>';
  h += '<div class="subtabs">' + ls.map(l => {
    const st = Model.listStats(l);
    return '<button class="subtab' + (sub === l.id ? ' on' : '') + '" data-act="sub" data-k="' + l.id + '"><span class="sw" style="background:' + gColor(l.groupKey) + '"></span>' +
      esc(l.title || 'PRODUCT LIST') + (l.carNo ? ' · CAR ' + esc(l.carNo) : '') + ' <span class="muted mono">' + pct(st.pct) + '</span></button>';
  }).join('') +
    '<button class="subtab' + (sub === 'material' ? ' on' : '') + '" data-act="sub" data-k="material">Material (' + recs.length + (s.unmatched ? ' · ' + s.unmatched + ' unmatched' : '') + ')</button>' +
    '<button class="subtab" data-act="importList" data-job="' + esc(j.id) + '">+ Add list</button></div>';
  h += '<div class="panel">' + (sub === 'material' ? viewMaterial(j, recs) : viewList(j, S.lists.find(l => l.id === sub))) + '</div>';
  return h;
}

function stampHtml(list, ln, k, qc){
  const v = qc ? (ln[k] ? { on: true, by: ln[k] } : null) : (ln.st && ln.st[k]);
  const on = v && v.on;
  return '<button class="stamp' + (qc ? ' qc' : '') + (on ? ' on' : '') + (on && !v.by ? ' bare' : '') + '" data-act="pick" data-l="' + ln.id + '" data-k="' + k + '" aria-label="' + k + '">' + (on && v.by ? esc(v.by) : '') + '</button>';
}
function rowHtml(list, ln, edit){
  const st = Model.lineStatus(ln);
  const cls = [st === 'done' ? 'done' : '', st === 'bo' ? 'bo' : '', ln.conf < 0.75 ? 'low' : '', ln.revNote ? 'rev' : ''].join(' ');
  const mats = recvFor(list.id, ln.id).length;
  let h = '<tr class="' + cls + '" data-row="' + ln.id + '">' +
    '<td class="gb"><span>' + esc((ln.g || '').replace('GROUP ', 'G')) + '</span></td><td class="n">' + esc(ln.n || '') + '</td>';
  if(edit){
    h += '<td class="edit"><input data-lf="p" data-l="' + ln.id + '" value="' + esc(ln.p) + '"></td><td class="edit"><input data-lf="q" data-l="' + ln.id + '" value="' + esc(ln.q) + '" inputmode="numeric"></td><td class="edit"><input data-lf="d" data-l="' + ln.id + '" value="' + esc(ln.d) + '"></td>';
  } else {
    h += '<td class="part"><button data-act="line" data-l="' + ln.id + '">' + esc(ln.p) + '</button></td><td class="q">' + esc(ln.q) + '</td><td class="d">' + esc(ln.d) + '</td>';
  }
  for(const k of Model.DK) h += '<td class="st">' + stampHtml(list, ln, k) + '</td>';
  h += '<td class="inp"><input data-lf="pkQty" data-l="' + ln.id + '" value="' + esc(ln.pkQty) + '" placeholder=" " inputmode="numeric" aria-label="Packaged qty"></td>' +
    '<td class="st">' + stampHtml(list, ln, 'pkInit', true) + '</td><td class="st">' + stampHtml(list, ln, 'qcInit', true) + '</td>' +
    '<td class="inp"><input data-lf="skid" data-l="' + ln.id + '" value="' + esc(ln.skid) + '" placeholder=" " aria-label="Skid"></td>' +
    '<td class="inp boc"><input data-lf="boQty" data-l="' + ln.id + '" value="' + esc(ln.boQty) + '" placeholder=" " inputmode="numeric" aria-label="Back order qty"></td>' +
    '<td class="mat"><button class="matbtn' + (mats ? ' has' : '') + '" data-act="line" data-l="' + ln.id + '" data-sec="mat">' + (mats ? '▣ ' + mats : '+') + '</button></td>';
  if(edit) h += '<td class="del"><button data-act="delLine" data-l="' + ln.id + '" aria-label="Delete line">✕</button></td>';
  return h + '</tr>';
}
function viewList(j, list){
  if(!list) return '<div class="empty"><h2>No product list yet</h2><button class="btn primary" data-act="importList" data-job="' + esc(j.id) + '">+ Import product list</button></div>';
  const st = Model.listStats(list);
  const f = S.ui.listFilter[list.id] || 'all';
  const edit = !!S.ui.editLines[list.id];
  const items = list.items.filter(ln => {
    const s = Model.lineStatus(ln);
    return f === 'all' || (f === 'open' && s !== 'done') || (f === 'bo' && s === 'bo') || (f === 'done' && s === 'done');
  });
  let h = '<div class="titlebar" style="background:' + gColor(list.groupKey) + '">' + esc(list.title || 'PRODUCT LIST') + '</div>' +
    '<div class="ltool"><span class="muted small">CAR ' + esc(list.carNo || '—') + ' · REV ' + esc(list.rev || '—') + (list.formRev ? ' · ' + esc(list.formRev) : '') +
    ' · imported ' + esc(when(list.importedAt)) + (list.hasPdf ? '' : ' · no original PDF') + '</span><span class="sp"></span>' +
    '<button class="btn sm" data-act="exportPdf">Export filled PDF</button>' +
    '<button class="btn sm" data-act="importList" data-job="' + esc(j.id) + '" data-list="' + list.id + '">Update from PDF</button>' +
    '<button class="btn sm" data-act="listInfo">Signatures</button>' +
    '<button class="btn sm' + (edit ? ' dark' : '') + '" data-act="editLines">' + (edit ? 'Done editing' : 'Edit lines') + '</button></div>';
  h += '<div class="ltool"><div class="chips" id="lchips">' + [['all', 'All', st.total], ['open', 'Open', st.total - st.done], ['bo', 'Back order', st.bo], ['done', 'Done', st.done]]
    .map(([k, t, n]) => '<button class="chip' + (f === k ? ' on' : '') + '" data-act="lfilter" data-k="' + k + '">' + t + ' <b>' + n + '</b></button>').join('') + '</div>' +
    '<span class="sp"></span><span class="muted small">Tap a part # for history, material and back-order details. Tap a box to sign.</span></div>';
  h += '<div class="twrap"><table class="sheet"><thead><tr class="h1"><th colspan="2"></th><th colspan="3">Product details</th><th colspan="5" class="dept">Departments</th>' +
    '<th colspan="2" class="pk">Packaging</th><th colspan="2" class="qc">QC check / pkg details</th><th class="bo">Back order</th><th></th>' + (edit ? '<th></th>' : '') + '</tr>' +
    '<tr><th>Grp</th><th>#</th><th>Part #</th><th>Qty</th><th>Description</th>' + Model.DEPTS.map(d => '<th>' + d[1] + '</th>').join('') +
    '<th>Qty</th><th>Init.</th><th>Init.</th><th>Skid #</th><th>B/O</th><th>Mat.</th>' + (edit ? '<th></th>' : '') + '</tr></thead><tbody>' +
    items.map(ln => rowHtml(list, ln, edit)).join('') + '</tbody></table></div>';
  if(edit) h += '<div class="row" style="margin-top:10px"><button class="btn" data-act="addLine">+ Add line</button><span class="sp"></span><button class="btn danger" data-act="delList">Delete this list</button></div>';
  if(!items.length) h += '<p class="muted" style="text-align:center;padding:20px">No lines in this filter.</p>';
  return h;
}
function curList(){ return S.lists.find(l => l.id === S.view.sub); }
function refreshRow(list, lineId){
  const tr = document.querySelector('tr[data-row="' + lineId + '"]');
  const ln = list.items.find(x => x.id === lineId);
  if(!tr || !ln){ render(); return; }
  const a = document.activeElement;
  const refocus = a && tr.contains(a) && a.dataset ? a.dataset.lf : null;
  const tmp = document.createElement('tbody');
  tmp.innerHTML = rowHtml(list, ln, !!S.ui.editLines[list.id]);
  tr.replaceWith(tmp.firstElementChild);
  if(refocus){ const n = document.querySelector('tr[data-row="' + lineId + '"] [data-lf="' + refocus + '"]'); if(n) n.focus(); }
  // header percentages without a full re-render
  renderTabs();
  const ls = Model.listStats(list);
  const subOn = document.querySelector('.subtab.on .mono'); if(subOn) subOn.textContent = pct(ls.pct);
  const lc = document.getElementById('lchips');
  if(lc){ const n = { all: ls.total, open: ls.total - ls.done, bo: ls.bo, done: ls.done }; lc.querySelectorAll('[data-k]').forEach(c => { const x = c.querySelector('b'); if(x) x.textContent = n[c.dataset.k]; }); }
  const j = job(list.jobId), s = jobStats(j), jp = document.querySelector('.jpct');
  if(jp){ jp.querySelector('b').textContent = pct(s.pct); jp.querySelector('div').textContent = s.done + '/' + s.total + ' lines done · ' + s.bo + ' on B/O'; }
}

/* ---- sign-off logic ---- */
function setStamp(ln, k, by){
  ln.st = ln.st || {};
  if(by === null) delete ln.st[k];
  else ln.st[k] = { on: true, by, ts: nowIso() };
}
function setPkInit(ln, by){
  if(!by){ ln.pkInit = ''; ln.pkTs = null; return; }
  ln.pkInit = by; ln.pkTs = nowIso();
  // packaging means it went through every department before it
  for(const k of Model.DK) if(!(ln.st && ln.st[k] && ln.st[k].on)) setStamp(ln, k, '');
}
function setPkQty(ln, v){
  ln.pkQty = String(v).trim();
  const q = parseFloat(ln.q), p = parseFloat(ln.pkQty);
  if(ln.pkQty === '' || isNaN(p) || isNaN(q)) return;
  if(p < q){ ln.boQty = String(q - p); ln.boTs = ln.boTs || nowIso(); }
  else { ln.boQty = ''; }
}
function pickSheet(list, ln, k){
  const qc = k === 'pkInit' || k === 'qcInit' || k === 'boInit';
  const cur = qc ? ln[k] : (ln.st && ln.st[k] && ln.st[k].on ? (ln.st[k].by || '✓') : '');
  const name = { pkInit: 'Packaging', qcInit: 'QC check', boInit: 'Back order' }[k] || Model.DEPTS.find(d => d[0] === k)[1];
  let h = '<h2>' + esc(name) + '</h2><div class="muted">Line ' + esc(ln.n || '') + ' · <span class="mono">' + esc(ln.p) + '</span> · ' + esc(ln.d) + '</div>' +
    '<div class="pick">' + S.set.staff.map(s => '<button data-v="' + esc(s) + '" class="' + (cur === s ? 'cur' : '') + '">' + esc(s) + '</button>').join('');
  if(!qc) h += '<button data-v="" class="alt' + (cur === '✓' ? ' cur' : '') + '">✓ Done, no initials</button>';
  h += '</div>' + (k === 'pkInit' ? '<p class="muted small">Signing packaging also checks any department not yet signed on this line.</p>' : '') +
    '<div class="row"><button class="btn danger" data-v="__clear">Clear</button><span class="sp"></span><button class="btn" data-v="__x">Cancel</button></div>';
  openSheet(h);
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-v]'); if(!b) return;
    const v = b.dataset.v;
    if(v === '__x') return closeSheet();
    if(k === 'pkInit') setPkInit(ln, v === '__clear' ? '' : v);
    else if(k === 'qcInit'){ ln.qcInit = v === '__clear' ? '' : v; ln.qcTs = ln.qcInit ? nowIso() : null; }
    else if(k === 'boInit'){ ln.boInit = v === '__clear' ? '' : v; }
    else setStamp(ln, k, v === '__clear' ? null : v);
    closeSheet();
    await saveList(list);
    if($('#drawer').hidden) refreshRow(list, ln.id); else { openLine(list, ln.id); refreshRow(list, ln.id); }
  };
}

/* ---- line drawer ---- */
function closeDrawer(){ $('#drawer').hidden = true; $('#drawer').innerHTML = ''; }
function openLine(list, lineId, sec){
  const ln = list.items.find(x => x.id === lineId); if(!ln) return;
  const st = Model.lineStatus(ln);
  const recs = recvFor(list.id, ln.id);
  const hist = [];
  for(const [k, t] of Model.DEPTS){ const v = ln.st && ln.st[k]; hist.push([t, v && v.on ? (v.by || '✓') : '—', v && v.on ? when(v.ts) : '']); }
  hist.push(['Packaging', ln.pkInit ? ln.pkInit + (ln.pkQty ? ' · ' + ln.pkQty + ' pcs' : '') : '—', when(ln.pkTs)]);
  hist.push(['QC check', ln.qcInit || '—', when(ln.qcTs)]);
  let h = '<div class="row"><h2>' + esc(ln.p) + '</h2><span class="sp"></span><button class="btn sm" data-act="closeDrawer">Close</button></div>' +
    '<div class="muted">Line ' + esc(ln.n || '') + ' · ' + esc(ln.g || '') + ' · ' + esc(list.title) + (list.carNo ? ' · CAR ' + esc(list.carNo) : '') + '</div>' +
    '<p style="font-weight:600">' + esc(ln.d) + '</p><div class="row"><span class="tag ' + ({ done: 'ok', bo: 'red', partial: 'warn' }[st] || '') + '">' + ({ done: 'Done', bo: 'Back order', partial: 'In progress', none: 'Not started' }[st]) + '</span>' +
    '<span class="muted">Qty <b>' + esc(ln.q) + '</b></span>' + (ln.revNote ? '<span class="tag red">' + esc(ln.revNote) + '</span>' : '') + '</div>' +
    '<div class="dsec"><h3>Sign-off history</h3><div class="hist">' + hist.map(r => '<span>' + r[0] + '</span><b class="mono">' + esc(r[1]) + '</b><span class="w">' + esc(r[2]) + '</span>').join('') + '</div></div>' +
    '<div class="dsec"><h3>Packaging &amp; back order</h3><div class="form">' +
    '<div class="two"><label>Skid #<input data-df="skid" value="' + esc(ln.skid) + '"></label><label>Box ID<input data-df="boxId" value="' + esc(ln.boxId) + '"></label></div>' +
    '<div class="two"><label>B/O qty<input data-df="boQty" inputmode="numeric" value="' + esc(ln.boQty) + '"></label><label>B/O date<input type="date" data-df="boDate" value="' + esc(ln.boDate) + '"></label></div>' +
    '<div class="row"><span class="small muted">B/O initials</span><button class="stamp qc' + (ln.boInit ? ' on' : '') + '" data-act="pickDrawer" data-k="boInit">' + esc(ln.boInit || '') + '</button><span class="sp"></span></div>' +
    '<label>Note<textarea data-df="note">' + esc(ln.note || '') + '</textarea></label></div></div>' +
    '<div class="dsec" id="dmat"><h3>Received material linked to this line</h3>' +
    (recs.length ? '<div class="links">' + recs.map(r => '<div class="link"><span class="mono">' + esc(r.code) + '</span><span>' + esc(r.description) + ' · ' + esc(r.qty) + ' ' + esc(r.uom || 'EA') + ' · <b>' + esc(r.bin || 'no bin') + '</b></span>' +
      '<button class="x" data-act="unlink" data-r="' + r.id + '" data-l="' + ln.id + '" aria-label="Unlink">✕</button></div>').join('') + '</div>' : '<p class="muted small">Nothing linked yet.</p>') +
    '<button class="btn" style="margin-top:8px" data-act="linkFromLine" data-l="' + ln.id + '">Link received material</button></div>';
  const d = $('#drawer');
  d.innerHTML = h; d.hidden = false; d.dataset.list = list.id; d.dataset.line = ln.id;
  if(sec === 'mat') setTimeout(() => $('#dmat').scrollIntoView({ block: 'start' }), 30);
}

/* ---- matching (user decides; suggestions only order the list) ---- */
const words = s => String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length > 1);
function sim(r, ln){
  const a = new Set(words(r.description + ' ' + (r.partNo || ''))), b = words(ln.d + ' ' + ln.p);
  if(!a.size || !b.length) return 0;
  let hit = 0; for(const w of b) if(a.has(w)) hit++;
  let s = hit / Math.max(b.length, 1);
  if(r.partNo && Model.jobKey(r.partNo) === Model.jobKey(ln.p)) s += 2;
  if(String(r.description || '').toUpperCase().includes(String(ln.p).toUpperCase())) s += 1;
  return s;
}
function matchFromReceipt(r, j){
  const cands = [];
  for(const l of listsOf(j.id)) for(const ln of l.items) cands.push({ l, ln, s: sim(r, ln) });
  cands.sort((a, b) => b.s - a.s);
  const draw = q => {
    const Q = q.trim().toUpperCase();
    const list = cands.filter(c => !Q || (c.ln.p + ' ' + c.ln.d).toUpperCase().includes(Q));
    $('#mlist').innerHTML = list.map((c, i) => {
      const linked = (r.matches || []).some(m => m.lineId === c.ln.id);
      return '<button class="opt' + (i === 0 && c.s > 0.3 && !Q ? ' best' : '') + '" data-m="' + c.l.id + '|' + c.ln.id + '"><span class="lchip" style="background:' + gColor(c.l.groupKey) + '">' + esc(c.l.groupKey === 'X' ? 'LIST' : c.l.groupKey) + (c.l.carNo ? ' · ' + esc(c.l.carNo) : '') + '</span>' +
        '<span><b class="mono">#' + esc(c.ln.n || '') + ' ' + esc(c.ln.p) + '</b> ×' + esc(c.ln.q) + '<br><span class="small">' + esc(c.ln.d) + '</span></span>' + (linked ? '<span class="sc">linked</span>' : '') + '</button>';
    }).join('') || '<p class="muted">No lines match.</p>';
  };
  openSheet('<h2>Match to a product list line</h2><div class="muted"><span class="mono">' + esc(r.code) + '</span> · ' + esc(r.description) + ' · ' + esc(r.qty) + ' ' + esc(r.uom || 'EA') + ' · bin ' + esc(r.bin || '—') + '</div>' +
    '<p class="small muted">Closest wording first — you pick the line.</p><input class="search" style="width:100%" placeholder="Filter by part # or description" id="mq"><div class="opts" id="mlist"></div>' +
    '<div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-m="__x">Cancel</button></div>');
  draw('');
  $('#mq').oninput = e => draw(e.target.value);
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-m]'); if(!b) return;
    if(b.dataset.m === '__x') return closeSheet();
    const [listId, lineId] = b.dataset.m.split('|');
    r.matches = (r.matches || []).filter(m => m.lineId !== lineId);
    r.matches.push({ listId, lineId, at: nowIso() });
    if(r.type === 'stock' && !r.jobNo) r.allocatedJob = j.jobNo;
    await saveReceipt(r);
    closeSheet(); toast('Matched to ' + lineRef(listId, lineId).line.p); render();
  };
}
function linkFromLine(list, ln){
  const j = job(list.jobId);
  const own = receiptsForJob(j);
  const stock = S.receipts.filter(r => r.type === 'stock' && !own.includes(r));
  const opt = (r, sc) => '<button class="opt" data-r="' + r.id + '">' + (r.photo ? '<img src="' + r.photo + '" style="width:44px;height:44px;object-fit:cover;border-radius:5px">' : '') +
    '<span><b class="mono">' + esc(r.code) + '</b> ' + esc(r.description) + '<br><span class="small">' + esc(r.qty) + ' ' + esc(r.uom || 'EA') + ' · bin ' + esc(r.bin || '—') + ' · ' + esc(when(r.receivedAt)) + '</span></span>' +
    '<span class="sc">' + (r.type === 'stock' ? 'STOCK' : (r.matches || []).length ? 'matched' : 'unmatched') + '</span></button>';
  const ownSorted = own.slice().sort((a, b) => ((a.matches || []).length - (b.matches || []).length) || (sim(b, ln) - sim(a, ln)));
  const stockSorted = stock.slice().sort((a, b) => sim(b, ln) - sim(a, ln)).slice(0, 40);
  openSheet('<h2>Link received material</h2><div class="muted">Line ' + esc(ln.n) + ' · <span class="mono">' + esc(ln.p) + '</span> · ' + esc(ln.d) + '</div>' +
    '<h3 class="small muted" style="margin-top:12px">RECEIVED FOR ' + esc(j.jobNo) + '</h3><div class="opts">' + (ownSorted.map(r => opt(r)).join('') || '<p class="muted">Nothing received for this job yet.</p>') + '</div>' +
    (stockSorted.length ? '<h3 class="small muted" style="margin-top:12px">FROM STOCK</h3><div class="opts">' + stockSorted.map(r => opt(r)).join('') + '</div>' : '') +
    '<div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-r="__x">Cancel</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === '__x') return closeSheet();
    const r = S.receipts.find(x => x.id === b.dataset.r);
    r.matches = (r.matches || []).filter(m => m.lineId !== ln.id);
    r.matches.push({ listId: list.id, lineId: ln.id, at: nowIso() });
    if(r.type === 'stock') r.allocatedJob = j.jobNo;
    await saveReceipt(r);
    closeSheet(); openLine(list, ln.id, 'mat'); refreshRow(list, ln.id); toast('Linked ' + r.code);
  };
}

/* ---- material tab ---- */
function recCard(r, j){
  const ms = (r.matches || []).map(m => ({ m, ...lineRef(m.listId, m.lineId) })).filter(x => x.line);
  return '<div class="rec' + (ms.length || r.type === 'stock' ? '' : ' unm') + '">' + (r.photo ? '<img src="' + r.photo + '" alt="">' : '<div class="noimg">no photo</div>') +
    '<div><div class="row" style="gap:6px"><span class="mono small">' + esc(r.code) + '</span>' + (r.type === 'stock' ? '<span class="tag stock">stock</span>' : '') +
    (ms.length ? '<span class="tag ok">matched</span>' : '<span class="tag warn">unmatched</span>') + (r.source === 'move-app' ? '<span class="tag">move app</span>' : '') + '</div>' +
    '<div class="t">' + esc(r.description) + '</div><div class="m">' + esc(r.qty) + ' ' + esc(r.uom || 'EA') + ' · bin <b>' + esc(r.bin || '—') + '</b> · ' + esc(when(r.receivedAt)) + (r.receivedBy ? ' · ' + esc(r.receivedBy) : '') + '</div>' +
    ((r.supplier || r.po) ? '<div class="m">' + esc(r.supplier || '') + (r.po ? ' · PO ' + esc(r.po) : '') + '</div>' : '') +
    (ms.length ? '<div class="links">' + ms.map(x => '<div class="link"><span class="lchip" style="background:' + gColor(x.list.groupKey) + '">' + esc(x.list.groupKey === 'X' ? 'LIST' : x.list.groupKey) + '</span><span class="mono">#' + esc(x.line.n) + ' ' + esc(x.line.p) + '</span>' +
      '<button class="x" data-act="unlink" data-r="' + r.id + '" data-l="' + x.line.id + '" aria-label="Unlink">✕</button></div>').join('') + '</div>' : '') +
    '<div class="row" style="margin-top:8px"><button class="btn sm" data-act="matchRec" data-r="' + r.id + '">' + (ms.length ? 'Match another line' : 'Match to line') + '</button><button class="btn sm ghost" data-act="editRec" data-r="' + r.id + '">Details</button></div></div></div>';
}
function spoolMatCard(sp){
  const par = S.spools.find(x => x.id === sp.parentId);
  const neg = (sp.remainingFt || 0) < 0;
  return '<div class="rec"><div class="noimg">SPOOL</div><div><div class="row" style="gap:6px"><span class="mono small">' + esc(sp.tag) + '</span><span class="tag stock">spool</span></div>' +
    '<div class="t">' + esc(sp.material) + '</div><div class="m"><span style="' + (neg ? 'color:var(--red);font-weight:700' : '') + '">' + fmtFt(sp.remainingFt) + '</span> remaining of ' + fmtFt(sp.lengthFt) + (par ? ' · from ' + esc(par.tag) : '') + '</div>' +
    '<div class="row" style="margin-top:8px"><button class="btn sm" data-act="fieldSpool" data-id="' + sp.id + '">Details</button></div></div></div>';
}
function viewMaterial(j, recs){
  const un = recs.filter(r => !(r.matches || []).length), m = recs.filter(r => (r.matches || []).length);
  const sps = spoolsForJob(j);
  let h = '<div class="ltool"><h2>Received material for ' + esc(j.jobNo) + '</h2><span class="sp"></span>' +
    '<button class="btn sm" data-act="recvForJob">+ Receive for this job</button><button class="btn sm" data-act="stockForJob">Allocate from stock</button></div>' +
    '<p class="muted small">Everything received against this job number shows here. Nothing is matched automatically — tap <b>Match to line</b> and choose the product list line it belongs to.</p>';
  if(!recs.length && !sps.length) return h + '<div class="empty"><h2>Nothing received yet</h2><p>Receive material in the Receiving tab with job # ' + esc(j.jobNo) + ', or import the move app file.</p></div>';
  if(sps.length) h += '<h3>Spooled material (' + sps.length + ')</h3><div class="recs">' + sps.map(sp => spoolMatCard(sp)).join('') + '</div>';
  if(un.length) h += '<h3 style="margin-top:16px">Unmatched (' + un.length + ')</h3><div class="recs">' + un.map(r => recCard(r, j)).join('') + '</div>';
  if(m.length) h += '<h3 style="margin-top:16px">Matched (' + m.length + ')</h3><div class="recs">' + m.map(r => recCard(r, j)).join('') + '</div>';
  return h;
}

/* ================= receiving ================= */
function binOptions(){
  const seen = new Set([...ZONES, ...(S.set.bins || [])]);
  for(const r of S.receipts) if(r.bin) seen.add(r.bin);
  return [...seen].map(b => '<option value="' + esc(b) + '">').join('');
}
function viewRecv(){
  const d = S.ui.lastRecv;
  const t = S.ui.recvType;
  let h = '<div class="row" style="margin-bottom:12px"><h1>Receiving</h1><span class="sp"></span>' +
    ('BarcodeDetector' in window ? '<button class="btn" data-act="scanLabel">Scan label</button>' : '') +
    '<button class="btn" data-act="importMove" title="Accepts the move app\'s JSON/CSV export, or its Print / Save PDF list export">Import move app file</button></div><div class="recvgrid">';
  h += '<div class="card"><h2>Receive material</h2><div class="form" style="margin-top:10px" id="recvForm">' +
    '<div class="seg"><button data-act="recvType" data-k="job" class="' + (t === 'job' ? 'on' : '') + '">For a job</button><button data-act="recvType" data-k="stock" class="' + (t === 'stock' ? 'on' : '') + '">Stock</button></div>' +
    (t === 'job' ? '<label>Job #<input id="recvJob" list="dlJobs" autocomplete="off" value="' + esc(d.jobNo || '') + '" placeholder="MEII-3181"></label><datalist id="dlJobs">' + S.jobs.map(j => '<option value="' + esc(j.jobNo) + '">' + esc(j.jobName) + '</option>').join('') + '</datalist>' : '') +
    '<label>Description<input id="recvDesc" autocomplete="off" placeholder="What came in"></label>' +
    '<div class="two"><label>Part # (if marked)<input id="recvPart" autocomplete="off"></label><label>Qty<div class="row" style="gap:6px;flex-wrap:nowrap"><input id="recvQty" inputmode="decimal" style="min-width:0;flex:1" value="1"><select id="recvUom" style="width:78px"><option>EA</option><option>BOX</option><option>SKID</option><option>FT</option><option>LB</option><option>SET</option></select></div></label></div>' +
    '<div class="two"><label>Supplier<input id="recvSup" autocomplete="off" value="' + esc(d.supplier || '') + '"></label><label>PO #<input id="recvPo" autocomplete="off" value="' + esc(d.po || '') + '"></label></div>' +
    '<div class="two"><label>Packing slip #<input id="recvSlip" autocomplete="off" value="' + esc(d.slip || '') + '"></label><label>Location / bin<input id="recvBin" list="dlBins" autocomplete="off" value="' + esc(d.bin || '') + '"></label></div><datalist id="dlBins">' + binOptions() + '</datalist>' +
    '<label>Received by<select id="recvBy">' + S.set.staff.map(s => '<option' + (d.by === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></label>' +
    '<div class="photo">' + (S.ui.draftPhoto ? '<img src="' + S.ui.draftPhoto + '" alt="">' : '') + '<button class="btn" data-act="photo">' + (S.ui.draftPhoto ? 'Retake photo' : 'Take photo') + '</button>' + (S.ui.draftPhoto ? '<button class="btn ghost" data-act="dropPhoto">Remove</button>' : '') + '</div>' +
    '<label>Notes<textarea id="recvNote" placeholder="Damage, shortages, anything to flag"></textarea></label>' +
    '<div class="row"><button class="btn dark" data-act="saveRecv" data-print="0">Save</button><button class="btn primary" data-act="saveRecv" data-print="1">Save &amp; print label</button></div>' +
    '<p class="muted small">Job, supplier, PO, slip and bin stay filled for the next item from the same delivery.</p></div></div>';
  // list
  const f = S.ui.recvFilter, Q = S.ui.recvQ.trim().toUpperCase();
  let rs = S.receipts.slice().sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
  rs = rs.filter(r => f === 'all' || (f === 'job' && r.type !== 'stock') || (f === 'stock' && r.type === 'stock') || (f === 'un' && r.type !== 'stock' && !(r.matches || []).length) || (f === 'np' && !r.labelPrinted));
  if(Q) rs = rs.filter(r => [r.code, r.jobNo, r.description, r.bin, r.supplier, r.po, r.partNo, r.slip].join(' ').toUpperCase().includes(Q));
  const cnt = k => S.receipts.filter(r => k === 'all' || (k === 'job' && r.type !== 'stock') || (k === 'stock' && r.type === 'stock') || (k === 'un' && r.type !== 'stock' && !(r.matches || []).length) || (k === 'np' && !r.labelPrinted)).length;
  h += '<div><div class="row" style="margin-bottom:8px"><input class="search" placeholder="Search code, job, description, bin, PO" data-in="recvQ" value="' + esc(S.ui.recvQ) + '"><div class="chips">' +
    [['all', 'All'], ['job', 'Job'], ['stock', 'Stock'], ['un', 'Unmatched'], ['np', 'No label']].map(([k, t2]) => '<button class="chip' + (f === k ? ' on' : '') + '" data-act="recvFilter" data-k="' + k + '">' + t2 + ' <b>' + cnt(k) + '</b></button>').join('') + '</div></div>' +
    '<div class="card" style="padding:0;overflow:auto;max-height:calc(100vh - 210px)"><table class="list"><thead><tr><th>Received</th><th>Code</th><th>Job</th><th>Description</th><th>Qty</th><th>Bin</th><th>Status</th></tr></thead><tbody>' +
    (rs.slice(0, 400).map(r => {
      const jb = r.type === 'stock' ? '<span class="tag stock">stock</span>' + (r.allocatedJob ? ' → ' + esc(r.allocatedJob) : '') : esc(r.jobNo || '');
      const known = r.type === 'stock' || S.jobs.some(j => Model.sameJob(r.jobNo, j.jobNo));
      const stt = (r.matches || []).length ? '<span class="tag ok">matched</span>' : r.type === 'stock' ? '' : known ? '<span class="tag warn">unmatched</span>' : '<span class="tag">job not imported</span>';
      return '<tr class="click" data-act="editRec" data-r="' + r.id + '"><td class="small">' + esc(when(r.receivedAt)) + '</td><td class="mono small">' + esc(r.code) + '</td><td>' + jb + '</td><td>' + esc(r.description) + '</td><td>' + esc(r.qty) + ' ' + esc(r.uom || '') + '</td><td>' + esc(r.bin || '') + '</td><td>' + stt + (r.labelPrinted ? '' : ' <span class="tag">no label</span>') + '</td></tr>';
    }).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">Nothing received yet.</td></tr>') + '</tbody></table></div></div>';
  return h + '</div>';
}
async function saveRecv(print){
  const g = id => ($('#' + id) || {}).value || '';
  const type = S.ui.recvType;
  const r = {
    id: uid(), code: code8(), type, jobNo: type === 'job' ? g('recvJob').trim().toUpperCase() : '', description: g('recvDesc').trim(),
    partNo: g('recvPart').trim(), qty: g('recvQty').trim(), uom: g('recvUom'), supplier: g('recvSup').trim(), po: g('recvPo').trim(),
    slip: g('recvSlip').trim(), bin: g('recvBin').trim().toUpperCase(), receivedBy: g('recvBy'), note: g('recvNote').trim(),
    photo: S.ui.draftPhoto || null, receivedAt: nowIso(), labelPrinted: false, matches: [], source: 'app'
  };
  if(type === 'job' && !r.jobNo) return toast('Enter the job # (or switch to Stock)', true);
  if(!r.description) return toast('Enter a description', true);
  if(!r.qty) return toast('Enter a quantity', true);
  S.receipts.push(r); await saveReceipt(r);
  S.ui.lastRecv = { jobNo: r.jobNo, supplier: r.supplier, po: r.po, slip: r.slip, bin: r.bin, by: r.receivedBy };
  S.ui.draftPhoto = null;
  S.view.focusDesc = true;
  render();
  toast('Received ' + r.code + (r.jobNo && !S.jobs.some(j => Model.sameJob(r.jobNo, j.jobNo)) ? ' — job ' + r.jobNo + ' not imported yet; it will attach when it is' : ''));
  if(print) printLabel(r);
}
function printLabel(r){
  const p = $('#print');
  p.className = 'label';
  p.innerHTML = '<style>@page{size:' + (+S.set.label.w || 2) + 'in ' + (+S.set.label.h || 1) + 'in;margin:0}</style>' + Zebra.labelHtml(r, S.set.label);
  setTimeout(() => { window.print(); r.labelPrinted = true; saveReceipt(r); if(S.view.name === 'recv') render(); }, 50);
}
function editRec(r){
  const ms = (r.matches || []).map(m => lineRef(m.listId, m.lineId)).filter(x => x.line);
  const j = r.type === 'stock' ? (r.allocatedJob ? S.jobs.find(x => Model.sameJob(x.jobNo, r.allocatedJob)) : null) : S.jobs.find(x => Model.sameJob(x.jobNo, r.jobNo));
  openSheet('<div class="row"><h2 class="mono">' + esc(r.code) + '</h2><span class="sp"></span>' + (r.type === 'stock' ? '<span class="tag stock">stock</span>' : '') + '</div>' +
    '<div class="muted small">Received ' + esc(when(r.receivedAt)) + (r.receivedBy ? ' by ' + esc(r.receivedBy) : '') + (r.source === 'move-app' ? ' · imported from move app' : '') + '</div>' +
    (r.photo ? '<img src="' + r.photo + '" style="max-width:100%;max-height:260px;border-radius:8px;margin:10px 0;display:block">' : '') +
    '<div class="form" id="erf">' +
    (r.type === 'stock' ? '' : '<label>Job #<input data-rf="jobNo" value="' + esc(r.jobNo) + '"></label>') +
    '<label>Description<input data-rf="description" value="' + esc(r.description) + '"></label>' +
    '<div class="two"><label>Part #<input data-rf="partNo" value="' + esc(r.partNo || '') + '"></label><label>Qty<input data-rf="qty" value="' + esc(r.qty) + '"></label></div>' +
    '<div class="two"><label>Supplier<input data-rf="supplier" value="' + esc(r.supplier || '') + '"></label><label>PO #<input data-rf="po" value="' + esc(r.po || '') + '"></label></div>' +
    '<div class="two"><label>Packing slip #<input data-rf="slip" value="' + esc(r.slip || '') + '"></label><label>Location / bin<input data-rf="bin" list="dlBins2" value="' + esc(r.bin || '') + '"></label></div><datalist id="dlBins2">' + binOptions() + '</datalist>' +
    '<label>Notes<textarea data-rf="note">' + esc(r.note || '') + '</textarea></label></div>' +
    (ms.length ? '<p class="small"><b>Matched to:</b> ' + ms.map(x => esc(x.list.groupKey) + ' #' + esc(x.line.n) + ' ' + esc(x.line.p)).join(', ') + '</p>' : '') +
    '<div class="row" style="margin-top:12px"><button class="btn danger" data-e="del">Delete</button><span class="sp"></span>' +
    (j ? '<button class="btn" data-e="match">Match to line</button>' : '') +
    '<button class="btn" data-e="label">Print label</button><button class="btn dark" data-e="save">Save</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-e]'); if(!b) return;
    const act = b.dataset.e;
    const collect = () => document.querySelectorAll('#erf [data-rf]').forEach(i => r[i.dataset.rf] = i.dataset.rf === 'jobNo' || i.dataset.rf === 'bin' ? i.value.trim().toUpperCase() : i.value.trim());
    if(act === 'save'){ collect(); await saveReceipt(r); closeSheet(); render(); toast('Saved'); }
    else if(act === 'label'){ collect(); await saveReceipt(r); closeSheet(); printLabel(r); }
    else if(act === 'match'){ collect(); await saveReceipt(r); matchFromReceipt(r, j); }
    else if(act === 'del'){
      closeSheet();
      if(!(await askPin('Delete received item ' + r.code))) return;
      if(!(await confirmSheet('Delete ' + r.code + '?', 'This removes the receipt and any line matches.', 'Delete', true))) return;
      S.receipts = S.receipts.filter(x => x !== r); await DB.del('receipts', r.id); render(); toast('Deleted');
    }
  };
}
function stockForJob(j){
  const stock = S.receipts.filter(r => r.type === 'stock');
  openSheet('<h2>Allocate stock to ' + esc(j.jobNo) + '</h2><p class="muted small">Pick a stock item, then choose the line it covers.</p><div class="opts">' +
    (stock.map(r => '<button class="opt" data-r="' + r.id + '"><span><b class="mono">' + esc(r.code) + '</b> ' + esc(r.description) + '<br><span class="small">' + esc(r.qty) + ' ' + esc(r.uom || 'EA') + ' · bin ' + esc(r.bin || '—') + '</span></span><span class="sc">' + (r.allocatedJob ? esc(r.allocatedJob) : '') + '</span></button>').join('') || '<p class="muted">No stock items received.</p>') +
    '</div><div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-r="__x">Cancel</button></div>');
  $('#sheet').onclick = e => {
    const b = e.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === '__x') return closeSheet();
    matchFromReceipt(S.receipts.find(x => x.id === b.dataset.r), j);
  };
}
async function takePhoto(file){
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}
async function scanLabel(){
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch(e){ return toast('Camera not available: ' + e.message, true); }
  openSheet('<h2>Scan a receiving label</h2><video id="scanv" playsinline muted style="width:100%;max-height:60vh;background:#000;border-radius:8px"></video><div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-s="x">Cancel</button></div>');
  const v = $('#scanv'); v.srcObject = stream; await v.play();
  const det = new BarcodeDetector({ formats: ['qr_code', 'code_128'] });
  let live = true;
  const stop = () => { live = false; stream.getTracks().forEach(t => t.stop()); };
  $('#sheet').onclick = e => { if(e.target.closest('[data-s]')){ stop(); closeSheet(); } };
  while(live){
    try{
      const codes = await det.detect(v);
      if(codes.length){
        const raw = codes[0].rawValue;
        let c = raw; try{ c = JSON.parse(raw).c || raw; }catch(e){}
        const r = S.receipts.find(x => x.code === c || x.moveCode === c);
        stop(); closeSheet();
        if(r) editRec(r); else toast('Label ' + c + ' is not in this tablet’s receiving log', true);
        return;
      }
    }catch(e){}
    await new Promise(r => setTimeout(r, 250));
  }
}

/* ---- move app import (tolerant: JSON or CSV) ---- */
function parseCsv(text){
  const rows = []; let row = [], f = '', q = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(q){ if(c === '"'){ if(text[i + 1] === '"'){ f += '"'; i++; } else q = false; } else f += c; }
    else if(c === '"') q = true;
    else if(c === ','){ row.push(f); f = ''; }
    else if(c === '\n' || c === '\r'){ if(c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if(f || row.length){ row.push(f); rows.push(row); }
  const hdr = (rows.shift() || []).map(h => h.trim());
  return rows.filter(r => r.some(x => x.trim())).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i]])));
}
function findRecords(o){
  if(Array.isArray(o)) return o;
  let best = null;
  const walk = (x, d) => {
    if(!x || typeof x !== 'object' || d > 3) return;
    for(const v of Object.values(x)){
      if(Array.isArray(v) && v.length && typeof v[0] === 'object' && (!best || v.length > best.length) && v.some(e => e && ('description' in e || 'job_number' in e || 'item_id' in e))) best = v;
      else if(v && typeof v === 'object') walk(v, d + 1);
    }
  };
  walk(o, 0);
  return best || [];
}
// Simple deterministic string hash (djb2) - used to make a stable receipt id
// for PDF-sourced rows, which carry no item_id of their own, so re-importing
// the same PDF twice skips the items already brought in instead of
// duplicating them.
function djb2(s){
  let h = 5381;
  for(let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
async function importMove(file){
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  let recs;
  if(isPdf){
    try{
      const rows = await MoveParse.parse(new Uint8Array(await file.arrayBuffer()));
      recs = rows.map(r => ({
        item_id: 'pdf-' + djb2([r.jobNo, r.type, r.description, r.qty, r.bin, r.capturedIso, r.status].join('|')),
        capture_type: r.type, job_number: r.jobNo, description: r.group ? '[' + r.group + '] ' + r.description : r.description,
        qty: r.qty, box_count: r.boxes, destination_bin: r.bin, captured_by: r.by,
        captured_at: r.capturedIso || nowIso(), status: r.status
      }));
      if(!recs.length) return toast('No items found in that PDF - is it a move app "Print / Save PDF list" export?', true);
    }catch(e){ return toast('Could not read that PDF: ' + (e.message || e), true); }
  }else{
    const text = await file.text();
    try{ recs = /\.csv$/i.test(file.name) ? parseCsv(text) : findRecords(JSON.parse(text)); }
    catch(e){ return toast('Could not read that file: ' + e.message, true); }
  }
  const pick = (o, ...ks) => { for(const k of ks){ const hit = Object.keys(o).find(x => x.toLowerCase().replace(/[\s-]/g, '_') === k); if(hit && o[hit] != null && o[hit] !== '') return o[hit]; } return ''; };
  let added = 0, skipped = 0;
  const batch = [];
  for(const o of recs){
    if(!o || typeof o !== 'object') continue;
    const mid = pick(o, 'item_id', 'id', 'uuid');
    const id = 'mv-' + (mid || pick(o, 'label_code', 'code') || uid());
    if(S.receipts.some(r => r.id === id)){ skipped++; continue; }
    const typeRaw = String(pick(o, 'capture_type', 'type')).toLowerCase();
    const jobNo = String(pick(o, 'job_number', 'job_no', 'jobno', 'job')).trim().toUpperCase();
    const type = typeRaw === 'stock' || (!jobNo && typeRaw !== 'job') ? 'stock' : 'job';
    let photo = pick(o, 'photo', 'photo_data', 'image');
    if(photo && !/^data:/.test(photo) && photo.length > 200) photo = 'data:image/jpeg;base64,' + photo;
    const r = {
      id, code: String(pick(o, 'label_code', 'code') || code8()).toUpperCase(), moveCode: pick(o, 'label_code', 'code') || '',
      type, jobNo: type === 'job' ? jobNo : '', description: String(pick(o, 'description', 'desc', 'item_description')).trim(),
      partNo: String(pick(o, 'part_number', 'part_no', 'part')).trim(), qty: String(pick(o, 'qty', 'quantity') || ''), uom: 'EA',
      bin: String(pick(o, 'destination_bin', 'bin', 'location')).trim().toUpperCase(), receivedBy: String(pick(o, 'captured_by', 'received_by', 'by')),
      receivedAt: pick(o, 'captured_at', 'received_at', 'created_at') || nowIso(), labelPrinted: /true|1|yes/i.test(String(pick(o, 'label_printed'))),
      photo: photo || null, matches: [], source: 'move-app', moveStatus: pick(o, 'status'), note: ''
    };
    if(!r.description && !r.jobNo) { skipped++; continue; }
    batch.push(r); S.receipts.push(r); added++;
  }
  for(const r of batch) r.updatedAt = nowIso();
  await DB.putMany('receipts', batch);
  const jobs = new Set(batch.filter(r => r.jobNo).map(r => r.jobNo));
  render();
  openSheet('<h2>Move app import</h2><p><b>' + added + '</b> items added' + (skipped ? ', <b>' + skipped + '</b> skipped (already imported or empty)' : '') + '.</p>' +
    '<p>' + jobs.size + ' job numbers: ' + [...jobs].slice(0, 30).map(esc).join(', ') + (jobs.size > 30 ? '…' : '') + '</p>' +
    '<p class="muted small">Each job tab shows its received items under <b>Material</b>. Match them to product list lines there.</p><div class="row"><span class="sp"></span><button class="btn dark" data-x>OK</button></div>');
  $('#sheet').onclick = e => { if(e.target.closest('[data-x]')) closeSheet(); };
}

/* ================= import product list ================= */
let IMP = null;
async function startImport(files, target){
  IMP = { status: 'Reading…', busy: true, target: target || {} };
  go({ name: 'import' });
  try{
    const res = await Parse.read(files, msg => { IMP.status = msg; const e = $('#impStatus'); if(e) e.textContent = msg; });
    IMP.res = res; IMP.busy = false; IMP.files = files.map(f => f.name).join(', ');
    const h = res.header;
    IMP.h = { title: h.title || '', jobNo: (h.jobNo || '').toUpperCase(), jobName: h.jobName || '', customer: h.customer || '', shipAddr: h.shipAddr || '', attn: h.attn || '',
      carNo: h.carNo || '', rev: h.rev || '', shipDate: h.shipDate || '', formRev: h.formRev || '', printed: h.printed || '' };
    if(IMP.target.listId){
      const l = S.lists.find(x => x.id === IMP.target.listId), j = job(l.jobId);
      if(!IMP.h.jobNo) IMP.h.jobNo = j.jobNo;
    }
    IMP.mode = 'auto';
  }catch(err){
    IMP.busy = false; IMP.error = err.message || String(err);
  }
  render();
}
function existingFor(h){
  const j = S.jobs.find(x => Model.sameJob(x.jobNo, h.jobNo) && Model.jobKey(x.jobNo) === Model.jobKey(h.jobNo)) || S.jobs.find(x => Model.sameJob(x.jobNo, h.jobNo));
  const l = j && listsOf(j.id).find(x => Model.groupKey(x.title) === Model.groupKey(h.title) && (x.title || '').toUpperCase() === (h.title || '').toUpperCase() && String(x.carNo || '').toUpperCase() === String(h.carNo || '').toUpperCase());
  return { j, l };
}
function viewImport(){
  if(!IMP) return viewDash();
  if(IMP.busy) return '<div class="card"><div class="progress"><span class="spin"></span><span id="impStatus">' + esc(IMP.status) + '</span></div><p class="muted small">Digital product lists read instantly. Scans and photos use OCR and take longer.</p></div>';
  if(IMP.error) return '<div class="card"><h2>Could not read the product list</h2><p>' + esc(IMP.error) + '</p><button class="btn" data-act="goDash">Back</button></div>';
  const r = IMP.res, h = IMP.h;
  const filledN = r.lines.reduce((a, l) => a + Object.keys(l.filled || {}).length, 0);
  const low = r.lines.filter(l => l.conf < 0.75).length;
  const ex = IMP.target.listId ? { l: S.lists.find(x => x.id === IMP.target.listId) } : existingFor(h);
  if(ex.l && !ex.j) ex.j = job(ex.l.jobId);
  let html = '<div class="row"><h1>Review import</h1><span class="sp"></span><button class="btn" data-act="goDash">Cancel</button><button class="btn primary" data-act="commitImport">' +
    (ex.l && IMP.mode !== 'new' ? 'Update ' + esc(ex.j.jobNo) + ' list' : ex.j ? 'Add list to ' + esc(ex.j.jobNo) : 'Create job tab') + '</button></div>';
  html += '<p class="muted">' + esc(IMP.files) + ' · ' + (r.mode === 'text' ? '<b>read exactly from the PDF text</b>' : '<b>read with OCR</b> — check highlighted lines') + ' · ' + r.lines.length + ' lines</p>';
  for(const n of r.notes) html += '<div class="note">' + esc(n) + '</div>';
  if(filledN) html += '<div class="note">Found <b>' + filledN + '</b> filled-in values in the Packaging / QC / Back order cells of this document. They will be applied to the matching lines.</div>';
  if(low) html += '<div class="note warn"><b>' + low + '</b> lines were hard to read — highlighted in yellow. Fix them before saving.</div>';
  if(ex.l){
    html += '<div class="note">This matches the existing list <b>' + esc(ex.l.title) + (ex.l.carNo ? ' · CAR ' + esc(ex.l.carNo) : '') + '</b> on job <b>' + esc(ex.j.jobNo) + '</b>. ' +
      '<div class="chips" style="margin-top:6px"><button class="chip' + (IMP.mode !== 'new' ? ' on' : '') + '" data-act="impMode" data-k="auto">Update it (keeps all sign-offs)</button>' +
      '<button class="chip' + (IMP.mode === 'new' ? ' on' : '') + '" data-act="impMode" data-k="new">Add as a separate list</button></div></div>';
  } else if(ex.j) html += '<div class="note">Job <b>' + esc(ex.j.jobNo) + '</b> already has a tab — this list will be added to it.</div>';
  html += '<div class="card" style="margin:10px 0"><div class="form"><div class="two">' +
    [['jobNo', 'Job #'], ['jobName', 'Job name'], ['customer', 'Customer'], ['title', 'List title'], ['carNo', 'Car #'], ['rev', 'Rev'], ['shipDate', 'Ship date'], ['attn', 'Attn']]
      .map(([k, t]) => '<label>' + t + '<input data-ih="' + k + '" value="' + esc(h[k]) + '"></label>').join('') +
    '</div><label>Shipping address<textarea data-ih="shipAddr">' + esc(h.shipAddr) + '</textarea></label></div></div>';
  html += '<div class="card"><table class="rev"><thead><tr><th style="width:30px">#</th><th style="width:90px">Group</th><th style="width:200px">Part #</th><th style="width:60px">Qty</th><th>Description</th><th style="width:170px">Filled on document</th><th style="width:40px"></th></tr></thead><tbody>' +
    r.lines.map((l, i) => '<tr class="' + (l.conf < 0.75 ? 'low' : '') + '"><td class="small muted">' + (i + 1) + '</td>' +
      '<td><input data-il="' + i + '" data-k="g" value="' + esc(l.g) + '"></td><td><input class="mono" data-il="' + i + '" data-k="p" value="' + esc(l.p) + '"></td>' +
      '<td><input data-il="' + i + '" data-k="q" value="' + esc(l.q) + '"></td><td><input data-il="' + i + '" data-k="d" value="' + esc(l.d) + '"></td>' +
      '<td class="small">' + esc(Object.entries(l.filled || {}).map(([k, v]) => k + ' ' + v).join(', ')) + '</td><td><button class="btn sm ghost" data-act="impDel" data-i="' + i + '">✕</button></td></tr>').join('') +
    '</tbody></table><button class="btn sm" style="margin-top:8px" data-act="impAdd">+ Add line</button></div>';
  return html;
}
function newLine(src, n){
  const ln = { id: uid(), n: n, g: src.g || '', p: (src.p || '').trim(), q: String(src.q || '').trim(), d: (src.d || '').trim(), conf: src.conf == null ? 1 : src.conf,
    fieldRects: src.fieldRects || null, pageIndex: src.pageIndex == null ? null : src.pageIndex, st: {}, pkQty: '', pkInit: '', pkTs: null, qcInit: '', qcTs: null,
    skid: '', boxId: '', boQty: '', boInit: '', boDate: '', note: '' };
  return ln;
}
function applyFilled(ln, filled){
  let n = 0;
  for(const [k, v0] of Object.entries(filled || {})){
    const v = String(v0).trim(); if(!v) continue;
    if(k === 'pkInit'){ if(ln.pkInit !== v){ setPkInit(ln, v.toUpperCase()); n++; } }
    else if(k === 'qcInit'){ if(ln.qcInit !== v){ ln.qcInit = v.toUpperCase(); ln.qcTs = nowIso(); n++; } }
    else if(k === 'pkQty'){ if(ln.pkQty !== v){ setPkQty(ln, v); n++; } }
    else if(ln[k] !== v){ ln[k] = k === 'boInit' ? v.toUpperCase() : v; n++; }
  }
  return n;
}
async function commitImport(){
  const r = IMP.res, h = IMP.h;
  h.jobNo = h.jobNo.trim().toUpperCase();
  if(!h.jobNo) return toast('Enter the job #', true);
  const lines = r.lines.filter(l => (l.p || '').trim() || (l.d || '').trim());
  if(!lines.length) return toast('No lines to import', true);
  let ex = IMP.target.listId ? { l: S.lists.find(x => x.id === IMP.target.listId) } : existingFor(h);
  if(ex.l && !ex.j) ex.j = job(ex.l.jobId);
  let j = ex.j;
  if(!j){
    j = { id: uid(), jobNo: h.jobNo, jobName: h.jobName, customer: h.customer, shipAddr: h.shipAddr, attn: h.attn, status: 'active', createdAt: nowIso() };
    S.jobs.push(j);
  } else {
    for(const k of ['jobName', 'customer', 'shipAddr', 'attn']) if(h[k] && !j[k]) j[k] = h[k];
    if(j.status === 'closed') j.status = 'active';
  }
  await saveJob(j);
  let list, applied = 0, carried = 0, dropped = 0;
  if(ex.l && IMP.mode !== 'new'){
    list = ex.l;
    const old = list.items.slice();
    const used = new Set();
    const keyOf = l => Model.jobKey(l.p);
    const items = lines.map((src, i) => {
      const prev = old.find(o => !used.has(o) && keyOf(o) === keyOf(src) && keyOf(src));
      let ln;
      if(prev){
        used.add(prev); carried++;
        ln = prev; ln.n = src.n || i + 1; ln.g = src.g || ln.g; ln.q = String(src.q || ln.q); ln.d = src.d || ln.d;
        if(src.fieldRects){ ln.fieldRects = src.fieldRects; ln.pageIndex = src.pageIndex; }
        delete ln.revNote;
      } else ln = newLine(src, src.n || i + 1);
      applied += applyFilled(ln, src.filled);
      return ln;
    });
    for(const o of old) if(!used.has(o)){ o.revNote = 'Not on REV ' + (h.rev || '?'); items.push(o); dropped++; }
    list.items = items;
    Object.assign(list, { title: h.title || list.title, groupKey: Model.groupKey(h.title || list.title), carNo: h.carNo, rev: h.rev, shipDate: h.shipDate, formRev: h.formRev, printed: h.printed, importedAt: nowIso(), mode: r.mode });
  } else {
    list = { id: uid(), jobId: j.id, title: (h.title || 'PRODUCT LIST').toUpperCase(), groupKey: Model.groupKey(h.title), carNo: h.carNo, rev: h.rev, shipDate: h.shipDate,
      formRev: h.formRev, printed: h.printed, orderType: {}, sig: {}, importedAt: nowIso(), mode: r.mode, items: lines.map((src, i) => newLine(src, src.n || i + 1)) };
    list.items.forEach((ln, i) => applied += applyFilled(ln, lines[i].filled));
    S.lists.push(list);
  }
  if(r.pdfBytes){
    // keep the ORIGINAL form, not a re-feed of an exported copy (its fields would stack)
    const isReturn = r.lines.some(l => Object.keys(l.filled || {}).length) && list.hasPdf;
    if(!isReturn){ await DB.put('pdfs', { id: list.id, bytes: new Blob([r.pdfBytes], { type: 'application/pdf' }), name: IMP.files }); list.hasPdf = true; }
  }
  await saveList(list);
  const msg = (ex.l && IMP.mode !== 'new' ? 'Updated ' : 'Imported ') + list.items.length + ' lines' + (carried ? ' · ' + carried + ' kept their sign-offs' : '') + (applied ? ' · ' + applied + ' values from the document' : '') + (dropped ? ' · ' + dropped + ' not on this revision (kept, marked red)' : '');
  IMP = null;
  openJobTab(j.id, list.id);
  toast(msg);
}

/* ================= settings / backup ================= */
function viewSettings(){
  const L = S.set.label;
  return '<div class="row"><h1>Settings</h1><span class="sp"></span><button class="btn" data-act="goDash">Back</button></div>' +
    '<div class="grid" style="margin-top:12px">' +
    '<div class="card"><h2>Staff initials</h2><p class="muted small">Shown as the tap-to-sign choices.</p><div class="chips" style="margin:8px 0">' +
    S.set.staff.map((s, i) => '<span class="chip">' + esc(s) + ' <button class="btn sm ghost" data-act="staffDel" data-i="' + i + '">✕</button></span>').join('') + '</div>' +
    '<div class="row"><input class="search" id="staffNew" placeholder="e.g. A.B" style="min-width:120px"><button class="btn" data-act="staffAdd">Add</button></div></div>' +
    '<div class="card"><h2>PIN</h2><p class="muted small">Needed to edit part # / qty / description, delete jobs, lists and received items, and restore backups. ' + (S.set.pin ? 'A PIN is set.' : 'No PIN set.') + '</p>' +
    '<div class="row"><input class="search" id="pinNew" inputmode="numeric" placeholder="New PIN (4+ digits)" style="min-width:160px"><button class="btn" data-act="pinSet">' + (S.set.pin ? 'Change' : 'Set') + ' PIN</button>' + (S.set.pin ? '<button class="btn danger" data-act="pinClear">Remove</button>' : '') + '</div></div>' +
    '<div class="card"><h2>Receiving labels</h2><div class="form"><div class="two"><label>Width (in)<input id="lw" value="' + esc(L.w) + '"></label><label>Height (in)<input id="lh" value="' + esc(L.h) + '"></label></div>' +
    '<div class="row"><button class="btn" data-act="labelSave">Save</button><button class="btn" data-act="labelTest">Test print</button></div>' +
    '<p class="muted small">Print label opens the standard Android print dialog — pick any printer on the tablet, or save as PDF. The label carries a QR code with the item record (code, job, description, qty, bin, PO).</p></div></div>' +
    '<div class="card"><h2>Backup</h2><p class="muted small">Everything lives on this tablet. Export a backup file regularly and keep it on the network drive.' + (S.persisted === false ? ' <b>Storage is not marked persistent on this browser — back up often.</b>' : '') + '</p>' +
    '<div class="row"><button class="btn dark" data-act="backupExport">Export backup</button><button class="btn" data-act="backupImport">Restore / merge backup</button></div>' +
    '<p class="small muted" style="margin-top:8px">' + S.jobs.length + ' jobs · ' + S.lists.length + ' lists · ' + S.receipts.length + ' received items</p></div>' +
    '<div class="card"><h2>Erase this tablet</h2><p class="muted small">Deletes every job, list and receipt on this device. Export a backup first.</p><button class="btn danger" data-act="eraseAll">Erase all data</button></div>' +
    '</div>';
}
async function blobToB64(b){
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = ''; for(let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
function download(blob, name){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
async function backupExport(){
  const pdfs = await DB.all('pdfs');
  const out = { app: 'meii-shopfloor', version: 1, exportedAt: nowIso(), jobs: S.jobs, lists: S.lists, receipts: S.receipts, spools: S.spools,
    settings: Object.entries(S.set).map(([k, v]) => ({ k, v })), pdfs: await Promise.all(pdfs.map(async p => ({ id: p.id, name: p.name, b64: await blobToB64(p.bytes) }))) };
  download(new Blob([JSON.stringify(out)], { type: 'application/json' }), 'MEII_ShopFloor_backup_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json');
  toast('Backup exported');
}
async function backupImport(file){
  let d;
  try{ d = JSON.parse(await file.text()); }catch(e){ return toast('Not a backup file', true); }
  if(d.app !== 'meii-shopfloor') return toast('That file is not a Shop Floor backup (for move app files use Receiving → Import move app file)', true);
  if(!(await askPin('Restore a backup'))) return;
  openSheet('<h2>Restore backup</h2><p>' + (d.jobs || []).length + ' jobs, ' + (d.lists || []).length + ' lists, ' + (d.receipts || []).length + ' received items, ' + (d.spools || []).length + ' spools from ' + esc(when(d.exportedAt)) + '.</p>' +
    '<p class="small muted"><b>Merge</b> keeps what is on this tablet and takes the newer copy of anything in both. <b>Replace</b> wipes this tablet first.</p>' +
    '<div class="row"><span class="sp"></span><button class="btn" data-b="x">Cancel</button><button class="btn danger" data-b="replace">Replace</button><button class="btn dark" data-b="merge">Merge</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-b]'); if(!b) return;
    const mode = b.dataset.b; closeSheet(); if(mode === 'x') return;
    if(mode === 'replace') for(const s of DB.STORES) await DB.clear(s);
    const newer = (store, arr) => arr.filter(x => { const cur = (S[store] || []).find(y => y.id === x.id); return mode === 'replace' || !cur || (x.updatedAt || '') > (cur.updatedAt || ''); });
    await DB.putMany('jobs', newer('jobs', d.jobs || []));
    await DB.putMany('lists', newer('lists', d.lists || []));
    await DB.putMany('receipts', newer('receipts', d.receipts || []));
    await DB.putMany('spools', newer('spools', d.spools || []));
    if(mode === 'replace') await DB.putMany('settings', d.settings || []);
    for(const p of d.pdfs || []){
      const bin = atob(p.b64), u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      await DB.put('pdfs', { id: p.id, name: p.name, bytes: new Blob([u], { type: 'application/pdf' }) });
    }
    await load(); render(); toast('Backup ' + (mode === 'replace' ? 'restored' : 'merged'));
  };
}

/* ================= reports (print) ================= */
function stampTxt(v){ return v && v.on ? (v.by || '✓') : ''; }
function jobReportHtml(j, first){
  const s = jobStats(j);
  let h = '<section class="pr-job' + (first ? ' first' : '') + '"><div class="pr-h"><h1>' + esc(j.jobNo) + ' — ' + esc(j.jobName || '') + '</h1><span>' + pct(s.pct) + ' complete · ' + s.done + '/' + s.total + ' lines</span></div>' +
    '<div class="kv"><span><b>Customer:</b> ' + esc(j.customer || '') + '</span><span><b>Ship to:</b> ' + esc((j.shipAddr || '').replace(/\n/g, ', ')) + '</span><span><b>B/O lines:</b> ' + s.bo + ' (' + s.boPcs + ' pcs)</span>' +
    (j.weightKg ? '<span><b>Weight:</b> ' + esc(j.weightKg) + ' kg</span>' : '') + (j.freight ? '<span><b>Freight:</b> $' + esc(j.freight) + '</span>' : '') +
    '<span><b>Printed:</b> ' + esc(new Date().toLocaleString()) + '</span></div>';
  if((j.packaging || []).length){
    h += '<p class="small"><b>Packaging:</b> ' + j.packaging.map(p => pkgType(p.type).label + ' ×' + p.qty).join(', ') + '</p>';
  }
  for(const { list, s: ls } of s.lists){
    h += '<h2>' + esc(list.title) + (list.carNo ? ' · CAR ' + esc(list.carNo) : '') + ' · REV ' + esc(list.rev || '') + ' — ' + pct(ls.pct) + ' (' + ls.done + '/' + ls.total + ')</h2>' +
      '<table><thead><tr><th class="c">#</th><th>Part #</th><th class="c">Qty</th><th>Description</th>' + Model.DEPTS.map(d => '<th class="c">' + d[1].split(' ')[0] + '</th>').join('') +
      '<th class="c">Pkg qty</th><th class="c">Pkg</th><th class="c">QC</th><th class="c">Skid</th><th class="c">Box</th><th class="c">B/O</th><th class="c">B/O init</th><th class="c">B/O date</th><th>Material</th><th>Status</th></tr></thead><tbody>' +
      list.items.map(ln => {
        const st = Model.lineStatus(ln);
        const mats = recvFor(list.id, ln.id).map(r => r.code + (r.bin ? ' @' + r.bin : '')).join(', ');
        return '<tr class="' + (st === 'done' ? 'done' : st === 'bo' ? 'bo' : '') + '"><td class="c">' + esc(ln.n) + '</td><td class="pn">' + esc(ln.p) + '</td><td class="c">' + esc(ln.q) + '</td><td>' + esc(ln.d) + '</td>' +
          Model.DK.map(k => '<td class="c">' + esc(stampTxt(ln.st && ln.st[k])) + '</td>').join('') +
          '<td class="c">' + esc(ln.pkQty) + '</td><td class="c">' + esc(ln.pkInit) + '</td><td class="c">' + esc(ln.qcInit) + '</td><td class="c">' + esc(ln.skid) + '</td><td class="c">' + esc(ln.boxId) + '</td>' +
          '<td class="c">' + esc(ln.boQty) + '</td><td class="c">' + esc(ln.boInit) + '</td><td class="c">' + esc(ln.boDate) + '</td><td>' + esc(mats) + '</td><td>' + ({ done: 'Done', bo: 'B/O', partial: 'In progress', none: '' }[st]) + (ln.revNote ? ' · ' + esc(ln.revNote) : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  const recs = receiptsForJob(j);
  if(recs.length){
    h += '<h2>Received material (' + recs.length + ')</h2><table><thead><tr><th>Code</th><th>Received</th><th>By</th><th>Description</th><th class="c">Qty</th><th>Bin</th><th>Supplier / PO</th><th>Matched to</th></tr></thead><tbody>' +
      recs.map(r => '<tr><td>' + esc(r.code) + '</td><td>' + esc(when(r.receivedAt)) + '</td><td>' + esc(r.receivedBy || '') + '</td><td>' + esc(r.description) + '</td><td class="c">' + esc(r.qty) + ' ' + esc(r.uom || '') + '</td><td>' + esc(r.bin || '') + '</td><td>' + esc([r.supplier, r.po && 'PO ' + r.po].filter(Boolean).join(' · ')) + '</td><td>' +
        esc((r.matches || []).map(m => lineRef(m.listId, m.lineId)).filter(x => x.line).map(x => x.list.groupKey + ' #' + x.line.n + ' ' + x.line.p).join(', ') || 'UNMATCHED') + '</td></tr>').join('') + '</tbody></table>';
  }
  return h + '</section>';
}
function doPrint(html){
  const p = $('#print');
  p.className = '';
  p.innerHTML = '<style>@page{size:letter landscape;margin:.4in}</style>' + html.replace(/<div class="pr-h"><h1>/g, '<div class="pr-h"><h1><img class="pr-logo" src="icons/logo-dark.png" alt="Modern Elevator">');
  setTimeout(() => window.print(), 60);
}
function printAll(detail){
  const jobs = S.jobs.filter(j => j.status !== 'closed').map(j => ({ j, s: jobStats(j) })).sort((a, b) => b.s.pct - a.s.pct);
  let h = '<section><div class="pr-h"><h1>MEII Shop Floor — Job status report</h1><span>' + esc(new Date().toLocaleString()) + '</span></div>' +
    '<p>Active jobs, closest to completion first. A line is done when all five departments and QC are signed and nothing is on back order.</p>' +
    '<table><thead><tr><th>#</th><th>Job #</th><th>Job name</th><th>Customer</th><th>Lists</th><th class="c">Lines</th><th class="c">Done</th><th class="c">% done</th><th class="c">In progress</th><th class="c">B/O lines</th><th class="c">B/O pcs</th><th class="c">Received</th><th class="c">Unmatched</th><th>Last activity</th></tr></thead><tbody>' +
    jobs.map(({ j, s }, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(j.jobNo) + '</td><td>' + esc(j.jobName || '') + '</td><td>' + esc(j.customer || '') + '</td><td>' + esc(s.lists.map(x => (x.list.groupKey === 'X' ? x.list.title : x.list.groupKey) + (x.list.carNo ? '/' + x.list.carNo : '') + ' ' + pct(x.s.pct)).join(', ')) + '</td>' +
      '<td class="c">' + s.total + '</td><td class="c">' + s.done + '</td><td class="c"><b>' + pct(s.pct) + '</b></td><td class="c">' + s.partial + '</td><td class="c">' + s.bo + '</td><td class="c">' + s.boPcs + '</td><td class="c">' + s.recv + '</td><td class="c">' + s.unmatched + '</td><td>' + esc(when(s.last)) + '</td></tr>').join('') +
    '</tbody></table></section>';
  if(detail) h += jobs.map(({ j }) => jobReportHtml(j, false)).join('');
  doPrint(h);
}

/* ---- packaging report ---- */
function printPackaging(){
  const rows = allPackaging();
  const sum = { old: 0, new: 0 }, byType = {};
  for(const { p } of rows){
    const t = pkgType(p.type), qty = +p.qty || 0;
    if(t.era) sum[t.era] += qty;
    byType[t.k] = (byType[t.k] || 0) + qty;
  }
  const totalAll = sum.old + sum.new;
  let h = '<section><div class="pr-h"><h1>MEII Shop Floor — Packaging report</h1><span>' + esc(new Date().toLocaleString()) + '</span></div>' +
    '<p>' + rows.length + ' logged entr' + (rows.length === 1 ? 'y' : 'ies') + ' · ' + sum.new + ' pcs on the new standard · ' + sum.old + ' pcs on the old standard' +
    (totalAll ? ' (' + pct(sum.new / totalAll) + ' new)' : '') + '.</p>' +
    '<table><thead><tr><th>Type</th><th class="c">Era</th><th class="c">Total qty</th></tr></thead><tbody>' +
    PKG_TYPES.map(t => byType[t.k] ? '<tr><td>' + esc(t.label) + '</td><td class="c">' + esc(t.era) + '</td><td class="c">' + byType[t.k] + '</td></tr>' : '').join('') +
    '</tbody></table>' +
    '<table style="margin-top:14px"><thead><tr><th>Date</th><th>Job #</th><th>Type</th><th class="c">Qty</th><th>Note</th></tr></thead><tbody>' +
    (rows.map(({ j, p }) => { const t = pkgType(p.type); return '<tr><td>' + esc(when(p.at)) + '</td><td>' + esc(j.jobNo) + '</td><td>' + esc(t.label) + '</td><td class="c">' + esc(p.qty) + '</td><td>' + esc(p.note || '') + '</td></tr>'; }).join('') || '<tr><td colspan="5">Nothing logged yet.</td></tr>') +
    '</tbody></table></section>';
  doPrint(h);
}

/* ---- freight split by weight ---- */
function freightSplit(){
  const jobsWithW = S.jobs.filter(j => +j.weightKg > 0);
  const rowsHtml = jobsWithW.map(j => '<label class="opt" style="cursor:pointer"><input type="checkbox" data-fj="' + j.id + '" style="margin-right:8px">' +
    '<span><b class="mono">' + esc(j.jobNo) + '</b> ' + esc(j.jobName || '') + '<br><span class="small muted">' + esc(j.weightKg) + ' kg</span></span></label>').join('');
  openSheet('<h2>Freight split</h2><p class="muted small">Pick the jobs sharing this truck, enter the total freight cost — it splits proportionally by weight, per the customs filing rule.</p>' +
    '<label>Total freight for this load ($ CAD)<input id="fsTotal" inputmode="decimal" value="0"></label>' +
    (jobsWithW.length ? '<div class="opts" id="fsList" style="margin-top:8px">' + rowsHtml + '</div>' : '<p class="muted small">No jobs have a BOL weight entered yet. Add one in each job’s Job info.</p>') +
    '<div id="fsSplit"></div>' +
    '<div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-fa="x">Close</button><button class="btn dark" data-fa="save">Save split to jobs</button></div>');
  const chosen = () => {
    const ids = [...document.querySelectorAll('#fsList [data-fj]:checked')].map(c => c.dataset.fj);
    return jobsWithW.filter(j => ids.includes(j.id));
  };
  const calc = () => {
    const total = +($('#fsTotal').value) || 0;
    const cj = chosen(), sumW = cj.reduce((a, j) => a + (+j.weightKg || 0), 0);
    if(!cj.length || sumW <= 0){ $('#fsSplit').innerHTML = ''; return; }
    $('#fsSplit').innerHTML = '<h3 class="small muted" style="margin-top:12px">SPLIT</h3><table class="list"><thead><tr><th>Job</th><th class="c">Weight</th><th class="c">Share</th><th class="c">Freight</th></tr></thead><tbody>' +
      cj.map(j => { const share = (+j.weightKg || 0) / sumW; return '<tr><td>' + esc(j.jobNo) + '</td><td class="c">' + esc(j.weightKg) + ' kg</td><td class="c">' + pct(share) + '</td><td class="c">$' + (total * share).toFixed(2) + '</td></tr>'; }).join('') + '</tbody></table>';
  };
  calc();
  $('#sheet').oninput = e => { if(e.target.id === 'fsTotal') calc(); };
  $('#sheet').addEventListener('change', e => { if(e.target.dataset.fj) calc(); });
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-fa]'); if(!b) return;
    if(b.dataset.fa === 'x') return closeSheet();
    if(b.dataset.fa === 'save'){
      const total = +($('#fsTotal').value) || 0;
      const cj = chosen(), sumW = cj.reduce((a, j) => a + (+j.weightKg || 0), 0);
      if(!cj.length || sumW <= 0) return toast('Pick at least one job with a weight entered', true);
      for(const j of cj){ j.freight = (total * (+j.weightKg || 0) / sumW).toFixed(2); await saveJob(j); }
      closeSheet(); render(); toast('Freight split saved to ' + cj.length + ' job' + (cj.length === 1 ? '' : 's'));
    }
  };
}

/* ---- back order rollup across jobs ---- */
function boRollup(){
  const rows = allBoLines();
  const totalPcs = rows.reduce((a, r) => a + (+r.ln.boQty || 0), 0);
  openSheet('<div class="row"><h2>Back order rollup</h2><span class="sp"></span>' + (rows.length ? '<button class="btn sm" data-bo="print">Print</button>' : '') + '</div>' +
    '<p class="muted small">' + rows.length + ' line' + (rows.length === 1 ? '' : 's') + ' on back order across all jobs · ' + totalPcs + ' pcs total.</p>' +
    (rows.length ? '<div class="card" style="padding:0;overflow:auto;max-height:60vh"><table class="list"><thead><tr><th>Job</th><th>Part #</th><th>Description</th><th class="c">B/O qty</th><th>Init</th><th>Date</th><th></th></tr></thead><tbody>' +
      rows.map(({ j, l, ln }) => '<tr><td class="mono small">' + esc(j.jobNo) + '</td><td class="mono small">' + esc(ln.p) + '</td><td>' + esc(ln.d) + '</td><td class="c"><b style="color:var(--red)">' + esc(ln.boQty) + '</b></td><td>' + esc(ln.boInit || '') + '</td><td>' + esc(ln.boDate || '') + '</td>' +
        '<td><button class="btn sm ghost" data-bo="go" data-j="' + j.id + '" data-l="' + l.id + '">Open</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty"><h2>Nothing on back order</h2></div>') +
    '<div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-bo="x">Close</button></div>');
  $('#sheet').onclick = e => {
    const b = e.target.closest('[data-bo]'); if(!b) return;
    if(b.dataset.bo === 'x') return closeSheet();
    if(b.dataset.bo === 'go'){ closeSheet(); openJobTab(b.dataset.j, b.dataset.l); }
    else if(b.dataset.bo === 'print') printBoRollup(rows);
  };
}
function printBoRollup(rows){
  const totalPcs = rows.reduce((a, r) => a + (+r.ln.boQty || 0), 0);
  const h = '<section><div class="pr-h"><h1>MEII Shop Floor — Back order rollup</h1><span>' + esc(new Date().toLocaleString()) + '</span></div>' +
    '<p>' + rows.length + ' line(s) on back order across all jobs · ' + totalPcs + ' pcs total.</p>' +
    '<table><thead><tr><th>Job #</th><th>Part #</th><th>Description</th><th class="c">B/O qty</th><th>Init</th><th>Date</th></tr></thead><tbody>' +
    rows.map(({ j, ln }) => '<tr><td>' + esc(j.jobNo) + '</td><td>' + esc(ln.p) + '</td><td>' + esc(ln.d) + '</td><td class="c">' + esc(ln.boQty) + '</td><td>' + esc(ln.boInit || '') + '</td><td>' + esc(ln.boDate || '') + '</td></tr>').join('') +
    '</tbody></table></section>';
  doPrint(h);
}

/* ---- job info (name, customer, ship-to, weight/freight, packaging log) ---- */
function jobInfo(){
  const j = job(S.view.jobId);
  j.packaging = j.packaging || [];
  const draw = () => {
    openSheet('<h2>Job ' + esc(j.jobNo) + '</h2><div class="form" id="jf">' +
      '<label>Job name<input data-jf="jobName" value="' + esc(j.jobName || '') + '"></label><label>Customer<input data-jf="customer" value="' + esc(j.customer || '') + '"></label>' +
      '<label>Ship to<textarea data-jf="shipAddr">' + esc(j.shipAddr || '') + '</textarea></label><label>Attn<input data-jf="attn" value="' + esc(j.attn || '') + '"></label>' +
      '<div class="two"><label>BOL weight (kg)<input data-jf="weightKg" inputmode="decimal" value="' + esc(j.weightKg || '') + '"></label><label>Freight to border ($ CAD)<input data-jf="freight" inputmode="decimal" value="' + esc(j.freight || '') + '"></label></div></div>' +
      '<h3 class="small muted" style="margin-top:14px">PACKAGING LOG (' + j.packaging.length + ')</h3>' +
      (j.packaging.length ? '<div class="opts">' + j.packaging.slice().sort((a, b) => (b.at || '').localeCompare(a.at || '')).map(p => {
        const t = pkgType(p.type);
        return '<div class="opt" style="cursor:default"><span><b>' + esc(t.label) + '</b> ×' + esc(p.qty) + (p.note ? '<br><span class="small muted">' + esc(p.note) + '</span>' : '') + '<br><span class="small muted">' + esc(when(p.at)) + '</span></span>' +
          '<button class="x" data-pk="del" data-id="' + p.id + '" aria-label="Delete" style="border:0;background:transparent;color:var(--red);font-size:15px;cursor:pointer">✕</button></div>';
      }).join('') + '</div>' : '<p class="muted small">Nothing logged yet.</p>') +
      '<div class="two" style="margin-top:8px"><label>Type<select id="pkType">' + PKG_TYPES.map(t => '<option value="' + t.k + '">' + esc(t.label) + '</option>').join('') + '</select></label><label>Qty<input id="pkQtyIn" inputmode="numeric" value="1"></label></div>' +
      '<label>Note (optional)<input id="pkNote" autocomplete="off"></label>' +
      '<div class="row" style="margin-top:6px"><span class="sp"></span><button class="btn sm" data-pk="add">+ Add to log</button></div>' +
      '<div class="row" style="margin-top:12px"><button class="btn danger" data-g="del">Delete job</button><button class="btn" data-g="close">' + (j.status === 'closed' ? 'Reopen job' : 'Close job (shipped)') + '</button><span class="sp"></span><button class="btn" data-g="x">Cancel</button><button class="btn dark" data-g="s">Save</button></div>');
    $('#sheet').onclick = async e => {
      const pk = e.target.closest('[data-pk]');
      if(pk){
        if(pk.dataset.pk === 'add'){
          const type = $('#pkType').value, qty = ($('#pkQtyIn').value || '').trim() || '1', note = ($('#pkNote').value || '').trim();
          j.packaging.push({ id: uid(), type, qty, note, at: nowIso() });
          await saveJob(j); draw(); toast('Logged');
        } else if(pk.dataset.pk === 'del'){
          j.packaging = j.packaging.filter(p => p.id !== pk.dataset.id);
          await saveJob(j); draw();
        }
        return;
      }
      const b = e.target.closest('[data-g]'); if(!b) return;
      const g = b.dataset.g;
      if(g === 's'){ document.querySelectorAll('#jf [data-jf]').forEach(i => j[i.dataset.jf] = i.value.trim()); await saveJob(j); closeSheet(); render(); }
      else if(g === 'close'){ j.status = j.status === 'closed' ? 'active' : 'closed'; await saveJob(j); closeSheet(); render(); toast(j.status === 'closed' ? 'Job closed' : 'Job reopened'); }
      else if(g === 'del'){
        closeSheet();
        if(!(await askPin('Delete job ' + j.jobNo))) return;
        if(!(await confirmSheet('Delete job ' + j.jobNo + '?', 'Deletes its product lists and sign-offs. Received material stays in Receiving (unmatched).', 'Delete job', true))) return;
        for(const l of listsOf(j.id)){ await DB.del('lists', l.id); await DB.del('pdfs', l.id); }
        const ids = new Set(listsOf(j.id).map(l => l.id));
        S.lists = S.lists.filter(l => l.jobId !== j.id);
        for(const r of S.receipts) if((r.matches || []).some(m => ids.has(m.listId))){ r.matches = r.matches.filter(m => !ids.has(m.listId)); await saveReceipt(r); }
        S.jobs = S.jobs.filter(x => x !== j); await DB.del('jobs', j.id);
        S.set.openTabs = S.set.openTabs.filter(x => x !== j.id); saveSet('openTabs');
        go({ name: 'dash' }); toast('Job deleted');
      } else closeSheet();
    };
  };
  draw();
}

/* ================= spools / reels ================= */
/* Master spool = the big reel as it's received. Field spool = wire pulled off
   the master onto a smaller spool, tracked as its own item with its own label
   and its own remaining-length balance. Over-pulling warns but is allowed —
   footage on a real reel is rarely exact. */
function spoolFieldCard(sp){
  const par = S.spools.find(x => x.id === sp.parentId);
  const neg = (sp.remainingFt || 0) < 0;
  return '<div class="jcard" data-act="fieldSpool" data-id="' + sp.id + '"><div><div class="jn">' + esc(sp.tag) + '</div><div class="muted">' + esc(sp.material) + '</div></div>' +
    '<div class="row"><span class="big" style="font-size:22px' + (neg ? ';color:var(--red)' : '') + '">' + fmtFt(sp.remainingFt) + '</span><span class="muted small">of ' + fmtFt(sp.lengthFt) + (par ? ' · from ' + esc(par.tag) : '') + '</span></div>' +
    '<div class="meta"><span>' + rel(sp.createdAt) + '</span></div></div>';
}
function viewSpools(){
  const Q = S.ui.spoolQ.trim().toUpperCase(), f = S.ui.spoolFilter;
  let ms = masterSpools();
  if(f === 'active') ms = ms.filter(s => (s.remainingFt || 0) > 0.001);
  else if(f === 'empty') ms = ms.filter(s => (s.remainingFt || 0) <= 0.001);
  if(Q) ms = ms.filter(s => (s.tag + ' ' + s.material).toUpperCase().includes(Q));
  const stockField = stockFieldSpools();
  let h = '<div class="row" style="margin-bottom:12px"><h1>Spools</h1><span class="sp"></span>' +
    '<input class="search" placeholder="Search tag or material" data-in="spoolQ" value="' + esc(S.ui.spoolQ) + '">' +
    '<button class="btn primary" data-act="newSpool">+ Receive spool</button></div>';
  h += '<div class="row" style="margin-bottom:10px"><div class="chips">' +
    [['all', 'All'], ['active', 'In stock'], ['empty', 'Empty']].map(([k, t]) => '<button class="chip' + (f === k ? ' on' : '') + '" data-act="spoolFilter" data-k="' + k + '">' + t + '</button>').join('') +
    '</div><span class="sp"></span><span class="legend">Master reels as received. Tap one to pull wire off it onto a field spool.</span></div>';
  if(!ms.length){
    h += '<div class="empty card"><h2>' + (S.spools.length ? 'No spools match' : 'No spools yet') + '</h2><p>Receive a large reel of wire or cable to start tracking footage.</p>' +
      '<button class="btn primary" data-act="newSpool">+ Receive spool</button></div>';
  } else {
    h += '<div class="grid">' + ms.map(sp => {
      const kids = fieldSpoolsOf(sp.id);
      const used = (sp.lengthFt || 0) - (sp.remainingFt || 0);
      const usedPct = sp.lengthFt ? Math.max(0, Math.min(100, used / sp.lengthFt * 100)) : 0;
      const neg = (sp.remainingFt || 0) < 0;
      return '<div class="jcard" data-act="spoolDetail" data-id="' + sp.id + '"><div><div class="jn">' + esc(sp.tag) + '</div><div class="muted">' + esc(sp.material) + '</div></div>' +
        '<div class="row"><span class="big" style="' + (neg ? 'color:var(--red)' : '') + '">' + fmtFt(sp.remainingFt) + '</span><span class="muted small">of ' + fmtFt(sp.lengthFt) + ' received</span></div>' +
        '<div class="bar"><i class="d" style="width:' + (100 - usedPct) + '%"></i><i class="b" style="width:' + usedPct + '%"></i></div>' +
        '<div class="meta"><span>Pulled to <b>' + kids.length + '</b> spool' + (kids.length === 1 ? '' : 's') + '</span><span>' + rel(sp.createdAt) + '</span></div></div>';
    }).join('') + '</div>';
  }
  if(stockField.length) h += '<h2 style="margin-top:20px">Field spools in stock (' + stockField.length + ')</h2><div class="grid">' + stockField.map(spoolFieldCard).join('') + '</div>';
  return h;
}
function newSpool(){
  openSheet('<h2>Receive spool</h2><div class="form" id="nsf">' +
    '<label>Material / wire type<input id="nsMat" autocomplete="off" placeholder="e.g. 14/2 THHN"></label>' +
    '<label>Tag / ID (optional — auto if blank)<input id="nsTag" autocomplete="off"></label>' +
    '<div class="two"><label>Length received<input id="nsQty" inputmode="decimal" value="500"></label><label>Unit<select id="nsUnit">' + SPOOL_UNITS.map(([k, t]) => '<option value="' + k + '">' + t + '</option>').join('') + '</select></label></div>' +
    '<div class="two"><label>Supplier<input id="nsSup" autocomplete="off"></label><label>PO #<input id="nsPo" autocomplete="off"></label></div>' +
    '<label>Received by<select id="nsBy">' + S.set.staff.map(s => '<option>' + esc(s) + '</option>').join('') + '</select></label></div>' +
    '<div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-n="x">Cancel</button><button class="btn dark" data-n="s">Save</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-n]'); if(!b) return;
    if(b.dataset.n === 'x') return closeSheet();
    const g = id => ($('#' + id) || {}).value || '';
    const material = g('nsMat').trim(), unit = g('nsUnit'), qty = g('nsQty').trim();
    if(!material) return toast('Enter the material / wire type', true);
    if(!qty || +qty <= 0) return toast('Enter a length', true);
    const lengthFt = toFt(qty, unit), by = g('nsBy');
    const sp = { id: uid(), kind: 'master', parentId: null, tag: g('nsTag').trim().toUpperCase() || 'SP-' + code8().slice(0, 6),
      material, enteredQty: qty, enteredUnit: unit, lengthFt, remainingFt: lengthFt, jobNo: '',
      supplier: g('nsSup').trim(), po: g('nsPo').trim(), receivedBy: by, createdAt: nowIso(),
      hist: [{ at: nowIso(), type: 'received', ft: lengthFt, by }] };
    S.spools.push(sp); await saveSpool(sp); closeSheet(); go({ name: 'spools' }); toast('Spool ' + sp.tag + ' received — ' + fmtFt(lengthFt));
  };
}
function spoolDetail(id){
  const sp = S.spools.find(x => x.id === id); if(!sp) return;
  const kids = fieldSpoolsOf(sp.id), neg = (sp.remainingFt || 0) < 0;
  openSheet('<div class="row"><h2 class="mono">' + esc(sp.tag) + '</h2><span class="sp"></span><span class="tag">master spool</span></div>' +
    '<div class="muted small">' + esc(sp.material) + ' · received ' + esc(when(sp.createdAt)) + (sp.receivedBy ? ' by ' + esc(sp.receivedBy) : '') + (sp.supplier ? ' · ' + esc(sp.supplier) : '') + '</div>' +
    '<div class="row" style="margin-top:10px"><span class="big" style="' + (neg ? 'color:var(--red)' : '') + '">' + fmtFt(sp.remainingFt) + '</span><span class="muted small">remaining of ' + fmtFt(sp.lengthFt) + ' received</span></div>' +
    (neg ? '<div class="note" style="border-color:var(--red);background:var(--bofill)">More has been pulled from this spool than it had — check the footage.</div>' : '') +
    (kids.length ? '<h3 class="small muted" style="margin-top:12px">PULLED TO</h3><div class="opts">' + kids.map(k => '<button class="opt" data-act="fieldSpool" data-id="' + k.id + '"><span><b class="mono">' + esc(k.tag) + '</b>' + (k.jobNo ? ' → ' + esc(k.jobNo) : ' (in stock)') + '<br><span class="small">' + fmtFt(k.remainingFt) + ' of ' + fmtFt(k.lengthFt) + '</span></span></button>').join('') + '</div>' : '') +
    '<div class="row" style="margin-top:12px"><button class="btn danger" data-sd="del">Delete</button><span class="sp"></span><button class="btn" data-sd="label">Print label</button><button class="btn dark" data-sd="pull">Pull to new spool</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-sd]'); if(!b) return;
    if(b.dataset.sd === 'pull'){ closeSheet(); pullSpool(sp.id); }
    else if(b.dataset.sd === 'label') printSpoolLabel(sp);
    else if(b.dataset.sd === 'del'){
      closeSheet();
      if(!(await askPin('Delete spool ' + sp.tag))) return;
      if(!(await confirmSheet('Delete ' + sp.tag + '?', kids.length ? kids.length + ' field spool(s) were pulled from this one. They will stay, but lose their link back to it.' : 'This removes the spool record.', 'Delete', true))) return;
      S.spools = S.spools.filter(x => x !== sp); await DB.del('spools', sp.id);
      for(const k of kids){ k.parentId = null; await saveSpool(k); }
      render(); toast('Deleted');
    }
  };
}
function pullSpool(masterId){
  const sp = S.spools.find(x => x.id === masterId); if(!sp) return;
  let dest = 'stock';
  const draw = () => {
    openSheet('<h2>Pull from ' + esc(sp.tag) + '</h2><div class="muted small">' + esc(sp.material) + ' · ' + fmtFt(sp.remainingFt) + ' remaining</div>' +
      '<div class="form" id="pf" style="margin-top:10px">' +
      '<div class="seg"><button data-pd="stock" class="' + (dest === 'stock' ? 'on' : '') + '">To stock</button><button data-pd="job" class="' + (dest === 'job' ? 'on' : '') + '">To a job</button></div>' +
      (dest === 'job' ? '<label>Job #<input id="pJob" list="dlJobs2" autocomplete="off" placeholder="MEII-3181"></label><datalist id="dlJobs2">' + S.jobs.map(j => '<option value="' + esc(j.jobNo) + '">' + esc(j.jobName) + '</option>').join('') + '</datalist>' : '') +
      '<div class="two"><label>Length to pull<input id="pQty" inputmode="decimal" value="1"></label><label>Unit<select id="pUnit">' + SPOOL_UNITS.map(([k, t]) => '<option value="' + k + '">' + t + '</option>').join('') + '</select></label></div>' +
      '<label>New spool tag (optional)<input id="pTag" autocomplete="off"></label></div>' +
      '<div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-pa="x">Cancel</button><button class="btn dark" data-pa="s0">Pull</button><button class="btn primary" data-pa="s">Pull &amp; print label</button></div>');
    $('#sheet').onclick = async e => {
      const bd = e.target.closest('[data-pd]');
      if(bd){ dest = bd.dataset.pd; return draw(); }
      const b = e.target.closest('[data-pa]'); if(!b) return;
      if(b.dataset.pa === 'x') return closeSheet();
      const g = id => ($('#' + id) || {}).value || '';
      const qty = g('pQty').trim(), unit = g('pUnit');
      if(!qty || +qty <= 0) return toast('Enter a length', true);
      const jobNo = dest === 'job' ? g('pJob').trim().toUpperCase() : '';
      if(dest === 'job' && !jobNo) return toast('Enter the job #', true);
      const ft = toFt(qty, unit);
      if(ft > (sp.remainingFt || 0) + 0.001){
        const ok = await confirmSheet('Only ' + fmtFt(sp.remainingFt) + ' left on ' + sp.tag, 'Pulling ' + fmtFt(ft) + ' will take this spool negative. Continue anyway?', 'Pull anyway', true);
        if(!ok) return;
      }
      const child = { id: uid(), kind: 'field', parentId: sp.id, tag: g('pTag').trim().toUpperCase() || 'SP-' + code8().slice(0, 6),
        material: sp.material, enteredQty: qty, enteredUnit: unit, lengthFt: ft, remainingFt: ft, jobNo,
        receivedBy: sp.receivedBy, createdAt: nowIso(), hist: [{ at: nowIso(), type: 'pulled', ft, from: sp.tag }] };
      sp.remainingFt = (sp.remainingFt || 0) - ft;
      sp.hist = sp.hist || []; sp.hist.push({ at: nowIso(), type: 'pull-out', ft, to: child.tag, job: jobNo || null });
      S.spools.push(child);
      await saveSpool(sp); await saveSpool(child);
      closeSheet(); go({ name: 'spools' });
      toast('Pulled ' + fmtFt(ft) + ' to ' + child.tag + (jobNo ? ' for ' + jobNo : ''));
      if(b.dataset.pa === 's') printSpoolLabel(child);
    };
  };
  draw();
}
function fieldSpool(id){
  const sp = S.spools.find(x => x.id === id); if(!sp) return;
  const par = S.spools.find(x => x.id === sp.parentId), neg = (sp.remainingFt || 0) < 0;
  openSheet('<div class="row"><h2 class="mono">' + esc(sp.tag) + '</h2><span class="sp"></span>' + (sp.jobNo ? '' : '<span class="tag stock">stock</span>') + '</div>' +
    '<div class="muted small">' + esc(sp.material) + (par ? ' · pulled from ' + esc(par.tag) : '') + ' · ' + esc(when(sp.createdAt)) + '</div>' +
    '<div class="row" style="margin-top:10px"><span class="big" style="' + (neg ? 'color:var(--red)' : '') + '">' + fmtFt(sp.remainingFt) + '</span><span class="muted small">of ' + fmtFt(sp.lengthFt) + ' on this spool' + (sp.jobNo ? ' · job ' + esc(sp.jobNo) : '') + '</span></div>' +
    (neg ? '<div class="note" style="border-color:var(--red);background:var(--bofill)">More has been used than this spool had.</div>' : '') +
    '<div class="form" id="fsf" style="margin-top:10px"><label>Job # (blank = stock)<input id="fsJob" list="dlJobs3" value="' + esc(sp.jobNo || '') + '"></label></div><datalist id="dlJobs3">' + S.jobs.map(j => '<option value="' + esc(j.jobNo) + '">' + esc(j.jobName) + '</option>').join('') + '</datalist>' +
    '<div class="two" style="margin-top:6px"><label>Log used<input id="fsUse" inputmode="decimal" placeholder="0"></label><label>Unit<select id="fsUnit">' + SPOOL_UNITS.map(([k, t]) => '<option value="' + k + '">' + t + '</option>').join('') + '</select></label></div>' +
    '<div class="row" style="margin-top:12px">' +
    (par && (sp.remainingFt || 0) > 0.001 ? '<button class="btn" data-fs="return">Return to ' + esc(par.tag) + '</button>' : '') +
    '<button class="btn danger" data-fs="del">Delete</button><span class="sp"></span><button class="btn" data-fs="label">Print label</button><button class="btn" data-fs="use">Log use</button><button class="btn dark" data-fs="save">Save</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-fs]'); if(!b) return;
    const act = b.dataset.fs;
    if(act === 'save'){
      sp.jobNo = ($('#fsJob').value || '').trim().toUpperCase();
      await saveSpool(sp); closeSheet(); render(); toast('Saved');
    } else if(act === 'use'){
      const qty = ($('#fsUse').value || '').trim(), unit = ($('#fsUnit') || {}).value;
      if(!qty || +qty <= 0) return toast('Enter a length used', true);
      const ft = toFt(qty, unit);
      if(ft > (sp.remainingFt || 0) + 0.001){
        const ok = await confirmSheet('Only ' + fmtFt(sp.remainingFt) + ' left on ' + sp.tag, 'Logging ' + fmtFt(ft) + ' used will take this spool negative. Continue anyway?', 'Log anyway', true);
        if(!ok) return;
      }
      sp.jobNo = ($('#fsJob').value || sp.jobNo || '').trim().toUpperCase();
      sp.remainingFt = (sp.remainingFt || 0) - ft;
      sp.hist = sp.hist || []; sp.hist.push({ at: nowIso(), type: 'used', ft, job: sp.jobNo || null });
      await saveSpool(sp); closeSheet(); render(); toast('Logged ' + fmtFt(ft) + ' used on ' + sp.tag);
    } else if(act === 'return'){
      if(!par) return;
      const ok = await confirmSheet('Return ' + fmtFt(sp.remainingFt) + ' to ' + par.tag + '?', 'The remaining footage on this field spool goes back to the master spool, and this spool is emptied.', 'Return');
      if(!ok) return;
      par.remainingFt = (par.remainingFt || 0) + (sp.remainingFt || 0);
      par.hist = par.hist || []; par.hist.push({ at: nowIso(), type: 'returned', ft: sp.remainingFt, from: sp.tag });
      sp.hist = sp.hist || []; sp.hist.push({ at: nowIso(), type: 'returned-to-parent', ft: sp.remainingFt });
      sp.remainingFt = 0;
      await saveSpool(par); await saveSpool(sp); closeSheet(); render(); toast('Returned to ' + par.tag);
    } else if(act === 'label') printSpoolLabel(sp);
    else if(act === 'del'){
      closeSheet();
      if(!(await askPin('Delete spool ' + sp.tag))) return;
      if(!(await confirmSheet('Delete ' + sp.tag + '?', 'This removes the spool record. It won’t change the master spool’s remaining footage.', 'Delete', true))) return;
      S.spools = S.spools.filter(x => x !== sp); await DB.del('spools', sp.id); render(); toast('Deleted');
    }
  };
}
function printSpoolLabel(sp){
  const stub = { code: sp.tag, type: sp.jobNo ? 'job' : 'stock', jobNo: sp.jobNo || '', description: sp.material + ' — ' + fmtFt(sp.remainingFt),
    qty: fmtFt(sp.remainingFt), uom: '', bin: '', po: sp.po || '', supplier: sp.supplier || '', receivedAt: sp.createdAt };
  const p = $('#print');
  p.className = 'label';
  p.innerHTML = '<style>@page{size:' + (+S.set.label.w || 2) + 'in ' + (+S.set.label.h || 1) + 'in;margin:0}</style>' + Zebra.labelHtml(stub, S.set.label);
  setTimeout(() => { window.print(); sp.labelPrinted = true; saveSpool(sp); }, 50);
}

/* ================= events ================= */
const A = {
  goDash: () => go({ name: 'dash' }),
  goRecv: () => go({ name: 'recv' }),
  goSpools: () => go({ name: 'spools' }),
  goSettings: () => go({ name: 'settings' }),
  newSpool: () => newSpool(),
  spoolFilter: b => { S.ui.spoolFilter = b.dataset.k; render(); },
  spoolDetail: b => spoolDetail(b.dataset.id),
  fieldSpool: b => fieldSpool(b.dataset.id),
  printPackaging: () => printPackaging(),
  freightSplit: () => freightSplit(),
  boRollup: () => boRollup(),
  goJob: b => openJobTab(b.dataset.id),
  closeTab: (b, e) => { e.stopPropagation(); S.set.openTabs = S.set.openTabs.filter(x => x !== b.dataset.id); saveSet('openTabs'); if(S.view.jobId === b.dataset.id) go({ name: 'dash' }); else renderTabs(); },
  dashFilter: b => { S.ui.dashFilter = b.dataset.k; render(); },
  sub: b => { S.view.sub = b.dataset.k; closeDrawer(); render(); },
  lfilter: b => { S.ui.listFilter[S.view.sub] = b.dataset.k; render(); },
  importList: b => { IMP_TARGET = { jobId: b.dataset.job, listId: b.dataset.list }; $('#fileList').value = ''; $('#fileList').click(); },
  pick: b => { const l = curList(); pickSheet(l, l.items.find(x => x.id === b.dataset.l), b.dataset.k); },
  pickDrawer: b => { const l = S.lists.find(x => x.id === $('#drawer').dataset.list); pickSheet(l, l.items.find(x => x.id === $('#drawer').dataset.line), b.dataset.k); },
  line: b => openLine(curList(), b.dataset.l, b.dataset.sec),
  closeDrawer: () => closeDrawer(),
  editLines: async () => {
    const l = curList();
    if(!S.ui.editLines[l.id] && !(await askPin('Edit part #, qty and description'))) return;
    S.ui.editLines[l.id] = !S.ui.editLines[l.id]; render();
  },
  addLine: async () => { const l = curList(); const n = Math.max(0, ...l.items.map(x => +x.n || 0)) + 1; l.items.push(newLine({ g: (l.items[l.items.length - 1] || {}).g }, n)); await saveList(l); render(); },
  delLine: async b => {
    const l = curList(), ln = l.items.find(x => x.id === b.dataset.l);
    if(!(await confirmSheet('Delete line ' + (ln.n || '') + '?', esc(ln.p) + ' — ' + esc(ln.d), 'Delete', true))) return;
    l.items = l.items.filter(x => x !== ln); await saveList(l); render();
  },
  delList: async () => {
    const l = curList();
    if(!(await askPin('Delete list ' + l.title))) return;
    if(!(await confirmSheet('Delete ' + l.title + '?', 'All sign-offs on this list are lost. Received material stays in Receiving.', 'Delete list', true))) return;
    S.lists = S.lists.filter(x => x !== l); await DB.del('lists', l.id); await DB.del('pdfs', l.id);
    for(const r of S.receipts) if((r.matches || []).some(m => m.listId === l.id)){ r.matches = r.matches.filter(m => m.listId !== l.id); await saveReceipt(r); }
    S.view.sub = null; render();
  },
  listInfo: () => {
    const l = curList(); l.sig = l.sig || {}; l.orderType = l.orderType || {};
    openSheet('<h2>Signatures &amp; order type</h2><div class="form" id="sigf"><div class="chips">' + ['warranty', 'chargeable', 'rma', 'stock'].map(k => '<label class="chip"><input type="checkbox" data-ot="' + k + '"' + (l.orderType[k] ? ' checked' : '') + '> ' + k.toUpperCase() + '</label>').join('') + '</div>' +
      '<div class="two"><label>Shipping manager<input data-sg="shipMgr" value="' + esc(l.sig.shipMgr || '') + '"></label><label>Date<input type="date" data-sg="shipDate" value="' + esc(l.sig.shipDate || '') + '"></label></div>' +
      '<div class="two"><label>Quality manager<input data-sg="qcMgr" value="' + esc(l.sig.qcMgr || '') + '"></label><label>Date<input type="date" data-sg="qcDate" value="' + esc(l.sig.qcDate || '') + '"></label></div>' +
      '<label>Ship date<input data-sg="listShip" value="' + esc(l.shipDate || '') + '"></label></div><div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-g="x">Cancel</button><button class="btn dark" data-g="s">Save</button></div>');
    $('#sheet').onclick = async e => {
      const b = e.target.closest('[data-g]'); if(!b) return;
      if(b.dataset.g === 's'){
        document.querySelectorAll('#sigf [data-ot]').forEach(i => l.orderType[i.dataset.ot] = i.checked);
        document.querySelectorAll('#sigf [data-sg]').forEach(i => { if(i.dataset.sg === 'listShip') l.shipDate = i.value; else l.sig[i.dataset.sg] = i.value; });
        await saveList(l); toast('Saved');
      }
      closeSheet();
    };
  },
  jobInfo: () => jobInfo(),
  exportPdf: async b => {
    const l = curList(), j = job(l.jobId);
    b.disabled = true; const t = b.textContent; b.textContent = 'Building…';
    try{
      const rec = l.hasPdf ? await DB.get('pdfs', l.id) : null;
      const bytes = rec ? new Uint8Array(await rec.bytes.arrayBuffer()) : null;
      const out = await PdfExport.build(j, l, bytes);
      download(new Blob([out.bytes], { type: 'application/pdf' }), (j.jobNo + '_' + (l.title || 'LIST') + '_' + (l.carNo || '') + '_filled').replace(/\s+/g, '_').replace(/[^\w.-]/g, '') + '.pdf');
      toast(out.original ? 'Filled PDF on the original form' : 'Filled PDF (generated layout — no original form stored)');
    }catch(e){ toast('PDF failed: ' + e.message, true); }
    b.disabled = false; b.textContent = t;
  },
  printJob: () => doPrint(jobReportHtml(job(S.view.jobId), true)),
  printAll: b => printAll(b.dataset.detail === '1'),
  unlink: async b => {
    const r = S.receipts.find(x => x.id === b.dataset.r);
    r.matches = (r.matches || []).filter(m => m.lineId !== b.dataset.l);
    await saveReceipt(r);
    if(!$('#drawer').hidden){ const l = S.lists.find(x => x.id === $('#drawer').dataset.list); openLine(l, $('#drawer').dataset.line, 'mat'); refreshRow(l, b.dataset.l); }
    else render();
  },
  linkFromLine: b => { const l = S.lists.find(x => x.id === $('#drawer').dataset.list); linkFromLine(l, l.items.find(x => x.id === b.dataset.l)); },
  matchRec: b => matchFromReceipt(S.receipts.find(x => x.id === b.dataset.r), job(S.view.jobId)),
  editRec: b => editRec(S.receipts.find(x => x.id === b.dataset.r)),
  recvForJob: () => { S.ui.recvType = 'job'; S.ui.lastRecv = { ...S.ui.lastRecv, jobNo: job(S.view.jobId).jobNo }; go({ name: 'recv', focusDesc: true }); },
  stockForJob: () => stockForJob(job(S.view.jobId)),
  recvType: b => { S.ui.recvType = b.dataset.k; keepForm(render); },
  recvFilter: b => { S.ui.recvFilter = b.dataset.k; render(); },
  saveRecv: b => saveRecv(b.dataset.print === '1'),
  photo: () => { $('#filePhoto').value = ''; $('#filePhoto').click(); },
  dropPhoto: () => { S.ui.draftPhoto = null; keepForm(render); },
  importMove: () => { $('#fileMove').value = ''; $('#fileMove').click(); },
  scanLabel: () => scanLabel(),
  impMode: b => { IMP.mode = b.dataset.k; render(); },
  impDel: b => { IMP.res.lines.splice(+b.dataset.i, 1); render(); },
  impAdd: () => { IMP.res.lines.push({ p: '', q: '', d: '', g: (IMP.res.lines[IMP.res.lines.length - 1] || {}).g || '', conf: 1, filled: {} }); render(); },
  commitImport: () => commitImport(),
  staffAdd: () => { const v = $('#staffNew').value.trim().toUpperCase(); if(!v) return; if(!S.set.staff.includes(v)) S.set.staff.push(v); saveSet('staff'); render(); },
  staffDel: b => { S.set.staff.splice(+b.dataset.i, 1); saveSet('staff'); render(); },
  pinSet: async () => {
    const v = $('#pinNew').value.trim();
    if(!/^\d{4,8}$/.test(v)) return toast('PIN must be 4–8 digits', true);
    if(S.set.pin && !(await askPin('Enter the current PIN to change it'))) return;
    S.set.pin = v; saveSet('pin'); render(); toast('PIN set');
  },
  pinClear: async () => { if(!(await askPin('Remove the PIN'))) return; S.set.pin = ''; saveSet('pin'); render(); },
  labelSave: () => { S.set.label = { w: +$('#lw').value || 2, h: +$('#lh').value || 1 }; saveSet('label'); toast('Saved'); },
  labelTest: () => printLabel({ code: 'TEST0001', type: 'job', jobNo: 'MEII-0000', description: 'TEST LABEL', qty: '1', uom: 'EA', bin: 'RECEIVING', receivedAt: nowIso() }),
  backupExport: () => backupExport(),
  backupImport: () => { $('#fileBackup').value = ''; $('#fileBackup').click(); },
  eraseAll: async () => {
    if(!(await askPin('Erase all data on this tablet'))) return;
    if(!(await confirmSheet('Erase everything?', 'Every job, product list and received item on this tablet will be deleted. This cannot be undone.', 'Erase all', true))) return;
    for(const s of DB.STORES) if(s !== 'settings') await DB.clear(s);
    S.jobs = []; S.lists = []; S.receipts = []; S.spools = []; S.set.openTabs = []; saveSet('openTabs'); go({ name: 'dash' }); toast('Erased');
  }
};
let IMP_TARGET = null;
// keep typed-but-unsaved receiving form values across a re-render
function keepForm(fn){
  const vals = {}; document.querySelectorAll('#recvForm [id]').forEach(i => { if('value' in i) vals[i.id] = i.value; });
  fn();
  for(const [id, v] of Object.entries(vals)){ const n = document.getElementById(id); if(n && 'value' in n) n.value = v; }
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if(!b || b.disabled) return;
  const f = A[b.dataset.act];
  if(f){ e.preventDefault(); f(b, e); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if(t.dataset.in){ S.ui[t.dataset.in] = t.value; const pos = t.selectionStart; render(); const n = document.querySelector('[data-in="' + t.dataset.in + '"]'); if(n){ n.focus(); try{ n.setSelectionRange(pos, pos); }catch(x){} } }
  else if(t.dataset.ih != null && IMP){ IMP.h[t.dataset.ih] = t.value; }
  else if(t.dataset.il != null && IMP){ IMP.res.lines[+t.dataset.il][t.dataset.k] = t.value; }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if(t.dataset.lf){
    const l = curList(); const ln = l && l.items.find(x => x.id === t.dataset.l); if(!ln) return;
    const k = t.dataset.lf, v = t.value.trim();
    if(k === 'pkQty') setPkQty(ln, v);
    else if(k === 'boQty'){ ln.boQty = v; if(+v > 0 && !ln.boTs) ln.boTs = nowIso(); }
    else ln[k] = k === 'skid' ? v.toUpperCase() : v;
    await saveList(l);
    setTimeout(() => refreshRow(l, ln.id), 40);
  } else if(t.dataset.df){
    const l = S.lists.find(x => x.id === $('#drawer').dataset.list), ln = l.items.find(x => x.id === $('#drawer').dataset.line);
    const k = t.dataset.df;
    if(k === 'boQty'){ ln.boQty = t.value.trim(); if(+ln.boQty > 0 && !ln.boTs) ln.boTs = nowIso(); }
    else ln[k] = k === 'note' || k === 'boDate' ? t.value : t.value.trim().toUpperCase();
    await saveList(l); refreshRow(l, ln.id);
  }
});
$('#fileList').addEventListener('change', e => {
  const files = [...e.target.files]; if(!files.length) return;
  const t = IMP_TARGET || {}; IMP_TARGET = null;
  startImport(files, t);
});
$('#fileMove').addEventListener('change', e => { const f = e.target.files[0]; if(f) importMove(f); });
$('#fileBackup').addEventListener('change', e => { const f = e.target.files[0]; if(f) backupImport(f); });
$('#filePhoto').addEventListener('change', async e => {
  const f = e.target.files[0]; if(!f) return;
  S.ui.draftPhoto = await takePhoto(f);
  keepForm(render);
});
// #print is hidden on screen and overwritten by the next print, so it is never cleared on 'afterprint'
// (Android Chrome fires afterprint before the print preview has rendered, which would print a blank page).

(async () => {
  const verEl = $('#appVersion'); if(verEl) verEl.textContent = APP_VERSION;
  await load();
  S.set.label = Object.assign({ w: 2, h: 1, dpi: 203 }, S.set.label);
  render();
})();
