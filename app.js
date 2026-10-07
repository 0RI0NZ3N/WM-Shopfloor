/* MEII Shop Floor - jobs, product lists with department sign-off, receiving,
   material matching, dashboard and reports. Local-first: everything lives on
   the tablet (IndexedDB); Backup exports a JSON file. */

// Bump this together with VERSION in sw.js on every deploy. Shown in the
// header so it's visible at a glance whether a tablet has picked up the
// latest push, without digging into browser dev tools.
const APP_VERSION='v25';

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
  set: { staff: ['M.I', 'Y.S', 'N.P', 'Z.M'], pin: '', openTabs: [], label: { w: 2, h: 1, dpi: 203 }, bins: [],
    shipFrom: ['1149 Pioneer Rd, Burlington, ON', '3230 Mainway, Burlington, ON'], contacts: [], role: 'wl', packingSlipSeq: 0, accountingEmail: '' },
  view: { name: 'dash' },
  ui: { dashFilter: 'active', dashSort: 'ship', dashQ: '', listFilter: {}, recvFilter: 'all', recvQ: '', recvView: 'stock', editLines: {}, recvType: 'job', draftPhoto: null, lastRecv: {}, spoolQ: '', spoolFilter: 'all', recvUomSheet: false }
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
// Two roles share this one app: "Warehousing & Logistics" is everything built
// up to this point; "Laser" is a cut-down view for the laser operator - view
// product lists + Inventory, sign off only the laser column, and work with
// laser cut lists. isLaser() gates both the nav (render/renderTabs) and what
// a product-list row lets you touch (rowHtml's laserOnly param).
const ROLES = [['wl', 'Warehousing & Logistics'], ['laser', 'Laser']];
const isLaser = () => S.set.role === 'laser';

/* ---- laser cut lists: sheet-area math (standard stock sheet sizes the laser can run) ---- */
const SHEET_SIZES = [
  { key: '48x96', label: '48x96', w: 48, l: 96 },
  { key: '60x120', label: '60x120', w: 60, l: 120 }
];
const sheetSizeInfo = k => SHEET_SIZES.find(s => s.key === k) || SHEET_SIZES[0];
const sheetSizeArea = k => { const s = sheetSizeInfo(k); return s.w * s.l; };
// Material+thickness identity only (no size - size is an ordering choice, not
// a property of the parts). Used to group cut-list rows and as the stable
// part of any stock-matching key.
function sheetGroupKey(material, thick){
  return (material || '').trim().toUpperCase().replace(/\s+/g, ' ') + '|' + (parseFloat(thick) || 0).toFixed(3);
}
// Material+thickness+size - what actually identifies a distinct stock item,
// since a 48x96 and a 60x120 sheet of the same material aren't interchangeable.
function sheetStockKey(material, thick, size){
  return sheetGroupKey(material, thick) + '|' + (size || SHEET_SIZES[0].key);
}
function sheetDesc(material, thick, size){
  const s = sheetSizeInfo(size);
  return (material || '').trim().toUpperCase() + ' ' + (parseFloat(thick) || 0).toFixed(3) + '" SHEET (' + s.label + ')';
}
// Picks the better of the standard sheet sizes for one material+thickness
// group, automatically - no one has to choose. Scores each size by current
// on-hand stock of that exact material+thickness+size (live against
// S.receipts, so this shifts on its own as stock comes in or gets used,
// never pinned by hand): prefers whichever size leaves the smallest
// shortfall against what's actually on the shelf, tie-broken by whichever
// needs fewer total sheets (less to buy/waste), tie-broken by whichever has
// more on hand (use up what's already there first).
function pickSheetSizeFor(material, thick, totalArea){
  const groupKey = sheetGroupKey(material, thick);
  const options = SHEET_SIZES.map(s => {
    const sheetsNeeded = totalArea ? Math.ceil(totalArea / sheetSizeArea(s.key)) : 0;
    const onHand = S.receipts.filter(r => r.type === 'stock' && r.uom === 'SHEET' && sheetGroupKey(r.sheetMaterial, r.sheetThick) === groupKey && (r.sheetSize || SHEET_SIZES[0].key) === s.key)
      .reduce((a, r) => a + onHandQty(r), 0);
    return { size: s.key, sheetsNeeded, onHand, shortfall: Math.max(0, sheetsNeeded - onHand) };
  });
  options.sort((a, b) => a.shortfall - b.shortfall || a.sheetsNeeded - b.sheetsNeeded || b.onHand - a.onHand);
  return options[0];
}
// One row per material+thickness combo found on the cut list: how much area
// it all adds up to, which standard sheet size is the best fit for it right
// now (see pickSheetSizeFor), how many whole sheets of that size it naively
// takes (no real nesting - just total area / sheet area, rounded up), and
// what's left over on the last sheet once rounded. Deliberately rough, per
// the ask.
function computeSheetGroups(items){
  const groups = {};
  for(const it of items){
    const area = (parseFloat(it.width) || 0) * (parseFloat(it.length) || 0);
    it.area = area;
    const key = it.sheetKey = sheetGroupKey(it.material, it.thick);
    if(!groups[key]) groups[key] = { key, material: (it.material || '').trim().toUpperCase(), thick: parseFloat(it.thick) || 0, totalArea: 0, parts: [] };
    groups[key].totalArea += area * (parseFloat(it.qty) || 0);
    groups[key].parts.push(it);
  }
  return Object.values(groups).map(g => {
    const pick = pickSheetSizeFor(g.material, g.thick, g.totalArea);
    g.sheetSize = pick.size;
    g.sheetsNeeded = pick.sheetsNeeded;
    g.onHand = pick.onHand;
    g.shortfall = pick.shortfall;
    const area1 = sheetSizeArea(pick.size);
    g.leftoverArea = g.sheetsNeeded ? g.sheetsNeeded * area1 - g.totalArea : 0;
    return g;
  }).sort((a, b) => b.totalArea - a.totalArea);
}
// A rough drop-piece hint, scoped to this one cut list (so it never suggests
// using one job's offcut on another job's part): once a sheet type is
// rounded up to a whole sheet, how many of its OWN smallest part could
// plausibly still fit in what's left on that last sheet.
function dropPieceHint(g){
  if(!g.sheetsNeeded || g.leftoverArea < 1) return '';
  const smallest = g.parts.slice().sort((a, b) => a.area - b.area)[0];
  if(!smallest || !smallest.area) return '';
  const n = Math.floor(g.leftoverArea / smallest.area);
  if(n < 1) return '';
  return '~' + Math.round(g.leftoverArea).toLocaleString() + ' in² left on the last sheet - could fit roughly ' + n + ' more of "' + (smallest.description || smallest.productNo || 'the smallest part') + '" (' + Math.round(smallest.area) + ' in² each).';
}
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
// Packing slip numbers are assigned once per shipment (the first time its
// packing slip is printed) and never reassigned on reprint - a fresh
// counter starting at 1, shared across the one tablet this app runs on.
function nextPackingSlipNo(){
  S.set.packingSlipSeq = (S.set.packingSlipSeq || 0) + 1;
  saveSet('packingSlipSeq');
  return S.set.packingSlipSeq;
}
async function saveList(list){ list.updatedAt = nowIso(); await DB.put('lists', list); const j = job(list.jobId); if(j){ j.updatedAt = list.updatedAt; await DB.put('jobs', j); } }
async function saveJob(j){ j.updatedAt = nowIso(); await DB.put('jobs', j); }
async function saveReceipt(r){ r.updatedAt = nowIso(); await DB.put('receipts', r); }
async function saveSpool(sp){ sp.updatedAt = nowIso(); await DB.put('spools', sp); }
const masterSpools = () => S.spools.filter(s => s.kind === 'master').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
const fieldSpoolsOf = masterId => S.spools.filter(s => s.parentId === masterId);
const spoolsForJob = j => S.spools.filter(s => s.kind === 'field' && s.jobNo && Model.sameJob(s.jobNo, j.jobNo));
const stockFieldSpools = () => S.spools.filter(s => s.kind === 'field' && !s.jobNo);

const job = id => S.jobs.find(j => j.id === id);
const listsOf = jobId => S.lists.filter(l => l.jobId === jobId && l.kind !== 'laser').sort((a, b) => (a.title + a.carNo).localeCompare(b.title + b.carNo));
const laserListsOf = jobId => S.lists.filter(l => l.jobId === jobId && l.kind === 'laser').sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
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

/* ---- ship date (lives per product list - each car/list can ship separately) ---- */
// The PDF header's own "SHIP DATE:" field is usually blank on the ERP form
// (filled in here once scheduling is known), but normalize it if present so
// it can seed the <input type="date">; anything unparseable is dropped
// rather than breaking the date picker.
function normalizeDateStr(s){
  s = String(s || '').trim();
  if(!s) return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if(m){
    let [, mo, d, y] = m;
    if(y.length === 2) y = (+y < 70 ? '20' : '19') + y;
    const dt = new Date(+y, +mo - 1, +d);
    if(!isNaN(dt)) return y + '-' + String(+mo).padStart(2, '0') + '-' + String(+d).padStart(2, '0');
  }
  return '';
}
// A list can go out in more than one shipment - e.g. most lines ship now,
// whatever's on back order follows later as its own truck/RFQ once it comes
// in. So shipping info lives in list.shipments[], not flat on the list.
function newShipment(overrides){
  return Object.assign({ id: uid(), label: '', shipDate: '', weightKg: '', skidCount: '', shipFrom: '', contactName: '', contactPhone: '',
    bookedCarrier: '', bookedRate: '', bookedBol: '', bolFile: null, lastRfqEmail: '', rfqLog: [], shippedAt: null,
    poNum: '', fob: '', freightTerms: '', customerPickup: false, specialInstruction: '', packingSlipNo: null }, overrides || {});
}
// Remembers a site contact's phone number the first time it's typed on any
// shipment, so the next product list's shipment form can suggest it instead
// of someone having to look the number up again.
function rememberContact(name, phone){
  name = (name || '').trim(); phone = (phone || '').trim();
  if(!name) return;
  S.set.contacts = S.set.contacts || [];
  const c = S.set.contacts.find(x => x.name.toLowerCase() === name.toLowerCase());
  if(c){ if(phone) c.phone = phone; }
  else S.set.contacts.push({ name, phone });
  saveSet('contacts');
}
// All shipments across every list on a job, in one flat list - used for the
// per-job shipment count badge and the combined shipments sheet, since
// shipments themselves live per-list (a job's cars can ship separately).
function jobShipmentsAll(j){
  const out = [];
  for(const l of listsOf(j.id)) for(const sp of (l.shipments || [])) out.push({ l, sp });
  return out.sort((a, b) => (a.sp.shipDate || '9999-99-99').localeCompare(b.sp.shipDate || '9999-99-99'));
}
function jobShipStats(j){
  const all = jobShipmentsAll(j);
  const shipped = all.filter(x => x.sp.shippedAt).length;
  return { total: all.length, shipped, pending: all.length - shipped };
}
function openJobShipments(j){
  const rows = jobShipmentsAll(j);
  openSheet('<h2>Shipments — ' + esc(j.jobNo) + '</h2>' +
    (rows.length ? '<div class="opts">' + rows.map(({ l, sp }) => {
      const badge = sp.shippedAt ? '<span class="tag ok">Shipped</span>' : (sp.shipDate ? shipBadge(sp.shipDate) : '<span class="tag">No date</span>');
      return '<button class="opt" data-l="' + l.id + '" data-sp="' + sp.id + '"><span><b>' + esc(l.groupKey === 'X' ? (l.title || 'LIST') : l.groupKey) + (l.carNo ? ' · CAR ' + esc(l.carNo) : '') + '</b> — ' + esc(sp.label || 'Shipment') + (sp.shipDate ? ' · ' + esc(fmtDateLong(sp.shipDate)) : '') + (sp.bookedCarrier ? ' · ' + esc(sp.bookedCarrier) : '') + (sp.bolFile ? ' · BOL on file' : '') + '</span><span class="sc">' + badge + '</span></button>';
    }).join('') + '</div>' : '<p class="muted">No shipments scheduled yet on any list for this job.</p>') +
    '<div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-sp="__x">Close</button></div>');
  $('#sheet').onclick = e => {
    const row = e.target.closest('[data-l]');
    if(row){ const l = S.lists.find(x => x.id === row.dataset.l); const sp = l && l.shipments.find(x => x.id === row.dataset.sp); if(l && sp) editShipment(l, j, sp); return; }
    if(e.target.closest('[data-sp="__x"]')) closeSheet();
  };
}
function fmtBytes(n){
  n = +n || 0;
  if(n < 1024) return n + ' B';
  if(n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function readAsDataUrl(file){
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
}
function pendingShipments(l){
  return (l.shipments || []).filter(sp => !sp.shippedAt).sort((a, b) => (a.shipDate || '9999-99-99').localeCompare(b.shipDate || '9999-99-99'));
}
function jobNextShip(j){
  const ds = [];
  for(const l of listsOf(j.id)) for(const sp of pendingShipments(l)) if(sp.shipDate) ds.push(sp.shipDate);
  ds.sort();
  return ds[0] || null;
}
function shipSummaryHtml(list){
  const sps = list.shipments || [];
  if(!sps.length) return '<span class="tag">No shipment scheduled</span>';
  const pending = pendingShipments(list);
  const shippedCount = sps.length - pending.length;
  if(!pending.length) return '<span class="tag ok">All ' + sps.length + ' shipment' + (sps.length > 1 ? 's' : '') + ' shipped</span>';
  const next = pending[0];
  return (next.shipDate ? 'Ship ' + esc(fmtDateLong(next.shipDate)) + ' ' + shipBadge(next.shipDate) : '<span class="tag">Date TBD</span>') +
    (next.label ? ' · ' + esc(next.label) : '') +
    (next.weightKg ? ' · ' + esc(next.weightKg) + ' kg' : '') + (next.skidCount ? ' · ' + esc(next.skidCount) + ' skids' : '') +
    (next.bookedCarrier ? ' · booked ' + esc(next.bookedCarrier) : '') +
    (pending.length > 1 ? ' · +' + (pending.length - 1) + ' more pending' : '') + (shippedCount ? ' · ' + shippedCount + ' shipped' : '');
}
function fmtDateLong(iso){
  if(!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function shipBadge(dateStr){
  if(!dateStr) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  if(isNaN(d)) return '';
  const days = Math.round((d - today) / 86400000);
  const cls = days <= 2 ? 'red' : days <= 7 ? 'warn' : '';
  const txt = days < 0 ? 'Overdue ' + (-days) + 'd' : days === 0 ? 'Ships today' : days === 1 ? 'Ships tomorrow' : 'Ships in ' + days + 'd';
  return '<span class="tag' + (cls ? ' ' + cls : '') + '">' + txt + '</span>';
}
// Shared by the dashboard and the print summary so both sort/group jobs the
// same way. 'ship' mode: jobs with an upcoming ship date first (earliest
// first), everything with no ship date set on any of its lists grouped
// separately as "unscheduled". 'pct' mode: the original closest-to-complete
// sort, no grouping.
function sortedJobRows(jobs){
  const oldSort = (a, b) => b.s.pct - a.s.pct || (b.s.done - a.s.done) || (b.s.last || '').localeCompare(a.s.last || '');
  const rows = jobs.map(j => ({ j, s: jobStats(j), ship: jobNextShip(j) }));
  if(S.ui.dashSort === 'ship'){
    const scheduled = rows.filter(r => r.ship).sort((a, b) => a.ship.localeCompare(b.ship) || oldSort(a, b));
    const unscheduled = rows.filter(r => !r.ship).sort(oldSort);
    return { scheduled, unscheduled };
  }
  return { scheduled: rows.slice().sort(oldSort), unscheduled: [] };
}

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
    '<button class="tab' + (v.name === 'recv' ? ' on' : '') + '" data-act="goRecv">Inventory</button>' +
    (isLaser() ? '' : '<button class="tab' + (v.name === 'spools' ? ' on' : '') + '" data-act="goSpools">Spools</button>');
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
  // Laser is a restricted role app-wide - there's no Spools/Settings/Import
  // for it to land on, so bounce back to the Dashboard rather than render a
  // view it shouldn't have reached (e.g. a stale tab from switching roles).
  if(isLaser() && ['spools', 'settings', 'import'].includes(S.view.name)) S.view = { name: 'dash' };
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
  const { scheduled, unscheduled } = sortedJobRows(jobs);
  const active = S.jobs.filter(j => j.status !== 'closed').map(j => jobStats(j));
  const T = active.reduce((a, s) => ({ total: a.total + s.total, done: a.done + s.done, bo: a.bo + s.bo, un: a.un + s.unmatched }), { total: 0, done: 0, bo: 0, un: 0 });
  const unassigned = S.receipts.filter(r => r.type !== 'stock' && !S.jobs.some(j => Model.sameJob(r.jobNo, j.jobNo))).length;
  const pkgRows = allPackaging();
  const pkgNew = pkgRows.reduce((a, { p }) => a + (pkgType(p.type).era === 'new' ? (+p.qty || 0) : 0), 0);
  const pkgOld = pkgRows.reduce((a, { p }) => a + (pkgType(p.type).era === 'old' ? (+p.qty || 0) : 0), 0);
  let h = '<div class="row"><h1>Jobs</h1><div class="chips" style="margin-left:10px">' +
    ROLES.map(([k, t]) => '<button class="chip' + (S.set.role === k ? ' on' : '') + '" data-act="setRole" data-k="' + k + '">' + t + '</button>').join('') +
    '</div><span class="sp"></span>' +
    '<input class="search" placeholder="Search job #, name, customer" value="' + esc(S.ui.dashQ) + '" data-in="dashQ">' +
    (isLaser() ? '' :
      '<button class="btn" data-act="printPackaging">Packaging report</button>' +
      '<button class="btn" data-act="printAll" data-detail="0">Print summary</button>' +
      '<button class="btn" data-act="printAll" data-detail="1">Print full report</button>' +
      '<button class="btn" data-act="goSettings">Settings</button>') + '</div>';
  h += '<div class="stats">' +
    '<div class="stat"><b>' + active.length + '</b><span>Active jobs</span></div>' +
    '<div class="stat"><b>' + (T.total ? pct(T.done / T.total) : '—') + '</b><span>Lines done (' + T.done + '/' + T.total + ')</span></div>' +
    '<button class="stat click" data-act="boRollup"><b style="color:var(--red)">' + T.bo + '</b><span>Lines on back order</span></button>' +
    '<div class="stat"><b>' + T.un + '</b><span>Received, not matched</span></div>' +
    '<div class="stat"><b>' + unassigned + '</b><span>Received for jobs not imported</span></div>' +
    '<div class="stat"><b>' + (pkgNew + pkgOld ? pct(pkgNew / (pkgNew + pkgOld)) : '—') + '</b><span>Packaging on new standard</span></div></div>';
  h += '<div class="row" style="margin-bottom:10px"><div class="chips">' +
    [['active', 'Active'], ['closed', 'Closed'], ['all', 'All']].map(([k, t]) => '<button class="chip' + (S.ui.dashFilter === k ? ' on' : '') + '" data-act="dashFilter" data-k="' + k + '">' + t + '</button>').join('') +
    '</div><span class="sp"></span><div class="chips">' +
    [['ship', 'Next to ship'], ['pct', 'Closest to done']].map(([k, t]) => '<button class="chip' + (S.ui.dashSort === k ? ' on' : '') + '" data-act="dashSort" data-k="' + k + '">' + t + '</button>').join('') + '</div></div>';
  if(!scheduled.length && !unscheduled.length){
    return h + '<div class="empty card"><h2>' + (S.jobs.length ? 'No jobs match' : 'No jobs yet') + '</h2><p>Import a product list PDF to create a job tab.</p>' +
      '<button class="btn primary" data-act="importList">+ Import product list</button></div>';
  }
  const cardHtml = (j, s, i) => {
    const w = x => (s.total ? x / s.total * 100 : 0).toFixed(1) + '%';
    const ship = jobNextShip(j);
    const shipStats = jobShipStats(j);
    return '<div class="jcard" data-act="goJob" data-id="' + esc(j.id) + '"><span class="rank">#' + (i + 1) + '</span>' +
      '<div><div class="jn">' + esc(j.jobNo) + (j.status === 'closed' ? ' <span class="tag">closed</span>' : '') + (j.stickerNo ? ' <span class="tag">sticker #' + esc(j.stickerNo) + '</span>' : '') + '</div><div class="muted">' + esc(j.jobName || '') + (j.customer ? ' · ' + esc(j.customer) : '') + '</div></div>' +
      '<div class="row"><span class="big">' + pct(s.pct) + '</span><span class="muted small">' + s.done + ' of ' + s.total + ' lines done</span></div>' +
      '<div class="bar"><i class="d" style="width:' + w(s.done) + '"></i><i class="p" style="width:' + w(s.partial) + '"></i><i class="b" style="width:' + w(s.bo) + '"></i></div>' +
      '<div class="lchips">' + s.lists.map(x => '<span class="lchip" style="background:' + gColor(x.list.groupKey) + ';color:' + gInk(x.list.groupKey) + '">' + esc(x.list.groupKey === 'X' ? x.list.title : x.list.groupKey) + (x.list.carNo ? ' · ' + esc(x.list.carNo) : '') + ' ' + pct(x.s.pct) + '</span>').join('') + (ship ? ' ' + shipBadge(ship) : '') +
      (shipStats.total ? ' <button class="tag click" data-act="jobShipments" data-id="' + esc(j.id) + '">' + shipStats.shipped + '/' + shipStats.total + ' shipped</button>' : '') + '</div>' +
      '<div class="meta"><span>B/O lines <b style="color:' + (s.bo ? 'var(--red)' : 'inherit') + '">' + s.bo + '</b></span><span>Material <b>' + s.recv + '</b>' + (s.unmatched ? ' (<b>' + s.unmatched + '</b> unmatched)' : '') + '</span><span>' + rel(s.last) + '</span></div></div>';
  };
  let i = 0;
  if(scheduled.length) h += '<div class="grid">' + scheduled.map(({ j, s }) => cardHtml(j, s, i++)).join('') + '</div>';
  if(unscheduled.length){
    h += '<h3 class="dashgroup">Unscheduled</h3><div class="grid">' + unscheduled.map(({ j, s }) => cardHtml(j, s, i++)).join('') + '</div>';
  }
  return h;
}

/* ================= job view ================= */
/* ---- skids: per-job sticker # + printable skid tags ----
   j.stickerNo: the number on the little stickers put on this job's skids as
   they come out of production (the loader grabs every skid with that number).
   j.skids[]: {no, size, weight, packedAt} per skid #, keyed by the Skid # typed
   on product list lines (ln.skid). A skid's contents are every line, across
   the job's product lists, whose Skid # matches. */
const SKID_SIZES = ['32" x 96"', '32" x 48"', '48" x 48"', '96" x 48"'];
function skidQty(ln){
  const q = parseFloat(ln.q) || 0, bo = parseFloat(ln.boQty) || 0, pk = parseFloat(ln.pkQty);
  return bo > 0 ? Math.max(0, q - bo) : (!isNaN(pk) && pk > 0 && pk < q ? pk : q);
}
const fmtQ = q => String(Math.round(q * 100) / 100);
function jobSkids(j){
  const map = new Map();
  for(const l of listsOf(j.id)) for(const ln of l.items){
    const no = (ln.skid || '').trim().toUpperCase(); if(!no) continue;
    if(!map.has(no)) map.set(no, { no, rows: [] });
    map.get(no).rows.push({ ln, l });
  }
  return [...map.values()].sort((a, b) => a.no.localeCompare(b.no, undefined, { numeric: true }));
}
function skidContents(sk){
  const m = new Map();
  for(const { ln } of sk.rows){
    const q = skidQty(ln); if(q <= 0) continue;
    const key = (ln.p || '') + '|' + (ln.d || '');
    if(m.has(key)) m.get(key).q += q; else m.set(key, { p: ln.p || '', d: ln.d || '', q });
  }
  return [...m.values()];
}
const skidRecRead = (j, no) => (j.skids || []).find(x => x.no === no) || {};
function skidRecWrite(j, no){
  j.skids = j.skids || [];
  let r = j.skids.find(x => x.no === no);
  if(!r){ r = { no, size: '', weight: '', packedAt: '' }; j.skids.push(r); }
  return r;
}
const todayIso = () => new Date().toLocaleDateString('en-CA');
const fmtMDY = iso => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso || ''); return m ? m[2] + '/' + m[3] + '/' + m[1] : (iso || ''); };
function stickerClash(j){
  const n = String(j.stickerNo || '').trim(); if(!n) return [];
  return S.jobs.filter(x => x.id !== j.id && x.status !== 'closed' && String(x.stickerNo || '').trim() === n);
}
function viewSkids(j){
  const sk = jobSkids(j), clash = stickerClash(j);
  let h = '<div class="card"><h2>Skid sticker #</h2><p class="muted small">The number on the little stickers put on this job\'s skids as they come out of production. ' +
    'Your loader grabs every skid with this number. It is printed big on every skid tag.</p>' +
    '<div class="row"><input class="search" id="stickerNo" inputmode="numeric" maxlength="3" value="' + esc(j.stickerNo || '') + '" placeholder="1-10" aria-label="Skid sticker number" style="width:90px;min-width:90px;font-size:22px;text-align:center">' +
    '<button class="btn dark" data-act="stickerSave">Save</button>' + (j.stickerNo ? '<button class="btn" data-act="stickerClear">Clear</button>' : '') + '</div>' +
    '<div class="chips" style="margin-top:8px">' + Array.from({ length: 10 }, (_, i) => {
      const n = String(i + 1), use = S.jobs.find(x => x.id !== j.id && x.status !== 'closed' && String(x.stickerNo || '').trim() === n);
      return '<button class="chip' + (String(j.stickerNo || '') === n ? ' on' : '') + '" data-act="stickerPick" data-n="' + n + '">' + n + (use ? ' <span class="small muted">' + esc(use.jobNo) + '</span>' : '') + '</button>';
    }).join('') + '</div>' +
    (clash.length ? '<div class="note warn" style="margin-top:8px">Sticker <b>' + esc(j.stickerNo) + '</b> is also on active job ' + clash.map(x => '<b>' + esc(x.jobNo) + '</b>').join(', ') + '. The loader could grab the wrong skids.</div>' : '') + '</div>';
  h += '<div class="row" style="margin:12px 0 6px"><h2 style="margin:0">Skids (' + sk.length + ')</h2><span class="sp"></span>' +
    (sk.length ? '<button class="btn dark" data-act="skidPrintAll">Print all tags</button>' : '') + '</div>';
  if(!sk.length) return h + '<div class="card empty"><p>No skid #s yet. Type a Skid # in the <b>Skid #</b> column on a product list line and that skid shows up here, ready to print a tag.</p></div>';
  h += '<datalist id="skSizes">' + SKID_SIZES.map(z => '<option value="' + esc(z) + '">').join('') + '</datalist><div class="grid">';
  for(const s of sk){
    const rec = skidRecRead(j, s.no), rows = skidContents(s);
    const cars = [...new Set(s.rows.map(r => String(r.l.carNo || '').trim()).filter(Boolean))];
    h += '<div class="card"><div class="row"><b class="mono" style="font-size:20px">SKID ' + esc(s.no) + '</b><span class="sp"></span><button class="btn sm dark" data-act="skidPrint" data-no="' + esc(s.no) + '">Print tag</button></div>' +
      '<p class="muted small" style="margin:4px 0 8px">' + rows.length + ' part' + (rows.length === 1 ? '' : 's') + ' · ' + fmtQ(rows.reduce((a, r) => a + r.q, 0)) + ' pcs' + (cars.length ? ' · ' + esc(cars.join(', ')) : '') + '</p>' +
      '<div class="form"><div class="two"><label>Skid size<input data-sk="size" data-no="' + esc(s.no) + '" list="skSizes" value="' + esc(rec.size || '') + '" placeholder="32&quot; x 96&quot;"></label>' +
      '<label>Skid weight<input data-sk="weight" data-no="' + esc(s.no) + '" value="' + esc(rec.weight || '') + '" placeholder="e.g. 450 kg"></label></div>' +
      '<label>Date packed<input type="date" data-sk="packedAt" data-no="' + esc(s.no) + '" value="' + esc(rec.packedAt || '') + '"></label></div>' +
      '<p class="small muted" style="margin-top:8px">' + (rows.slice(0, 6).map(r => esc(r.p || r.d) + ' ×' + fmtQ(r.q)).join(' · ') || 'Nothing packed on this skid yet') + (rows.length > 6 ? ' · +' + (rows.length - 6) + ' more' : '') + '</p></div>';
  }
  return h + '</div>';
}
function skidTagHtml(j, sk){
  const rec = skidRecRead(j, sk.no), rows = skidContents(sk);
  const cars = [...new Set(sk.rows.map(r => String(r.l.carNo || '').trim()).filter(Boolean))];
  const total = rows.reduce((a, r) => a + r.q, 0);
  const FIRST = 26, CONT = 50;
  const pages = [rows.slice(0, FIRST)];
  for(let i = FIRST; i < rows.length; i += CONT) pages.push(rows.slice(i, i + CONT));
  const tier = n => n <= 8 ? 14 : n <= 13 ? 11.5 : n <= 19 ? 10 : n <= 26 ? 8.5 : n <= 38 ? 8 : 7;
  const head = '<div class="sk-top"><img class="sk-logo" src="icons/logo-dark.png" alt="Modern Elevator"><div class="sk-sticker"><span>STICKER #</span><b>' + esc(j.stickerNo || '') + '</b></div></div>';
  return pages.map((pg, i) => {
    const last = i === pages.length - 1;
    const tbl = '<table class="sk-items" style="font-size:' + tier(pg.length) + 'pt"><thead><tr><th>PART NAME:</th><th class="q">PART QTY:</th></tr></thead><tbody>' +
      pg.map(r => '<tr><td>' + (r.p ? '<b class="mono">' + esc(r.p) + '</b> ' : '') + esc(r.d) + '</td><td class="q">' + esc(fmtQ(r.q)) + '</td></tr>').join('') +
      (rows.length ? '' : '<tr><td>&nbsp;</td><td class="q"></td></tr>') + '</tbody></table>' +
      (pages.length > 1 ? '<div class="sk-note">' + (last ? 'END OF LIST' : 'CONTINUED ON NEXT SHEET') + ' - sheet ' + (i + 1) + ' of ' + pages.length + '</div>' : '') +
      (last ? '<div class="sk-total">' + rows.length + ' part' + (rows.length === 1 ? '' : 's') + ' · ' + esc(fmtQ(total)) + ' pcs on this skid</div>' : '');
    if(i === 0) return '<section class="sk-page">' + head +
      '<table class="sk-info"><tr><td class="l">JOB NAME &amp; No.</td><td><b>' + esc(j.jobNo) + '</b>' + (j.jobName ? '<div class="sub">' + esc(j.jobName) + '</div>' : '') + '</td></tr>' +
      '<tr><td class="l">ELEVATOR #</td><td>' + esc(cars.join(', ')) + '</td></tr></table>' +
      '<div class="sk-grow">' + tbl + '</div>' +
      '<table class="sk-info"><tr><td class="l">SKID#</td><td><b>' + esc(sk.no) + '</b></td></tr>' +
      '<tr><td class="l">SKID SIZE:</td><td>' + esc(rec.size || '') + '</td></tr>' +
      '<tr><td class="l">SKID WEIGHT:</td><td>' + esc(rec.weight || '') + '</td></tr>' +
      '<tr><td class="l">DATE PACKED:</td><td>' + esc(fmtMDY(rec.packedAt)) + '</td></tr></table></section>';
    return '<section class="sk-page">' + head +
      '<table class="sk-info"><tr><td class="l">JOB NAME &amp; No.</td><td><b>' + esc(j.jobNo) + '</b></td></tr><tr><td class="l">SKID#</td><td><b>' + esc(sk.no) + '</b> (contents continued)</td></tr></table>' +
      '<div class="sk-grow">' + tbl + '</div></section>';
  }).join('');
}
async function printSkidTags(nos){
  const j = job(S.view.jobId), all = jobSkids(j);
  const picked = all.filter(s => nos.includes(s.no)); if(!picked.length) return;
  for(const s of picked){ const r = skidRecWrite(j, s.no); if(!r.packedAt) r.packedAt = todayIso(); }
  await saveJob(j);
  doPrint(picked.map(s => skidTagHtml(j, s)).join(''), 'portrait');
}

function viewJob(){
  const j = job(S.view.jobId), s = jobStats(j), ls = listsOf(j.id), laser = isLaser();
  // Cut lists work exactly like product lists - one per upload, its own
  // subtab, its own "Update from PDF" - not one combined list per job. A
  // job can have a laser list per group (G1/G2/G3...) just like it can
  // have a product list per group.
  const laserLists = laserListsOf(j.id);
  let sub = S.view.sub;
  const allIds = new Set([...ls.map(l => l.id), ...laserLists.map(l => l.id)]);
  const validSubs = sub === 'material' || sub === 'info' || sub === 'skids' || allIds.has(sub);
  if(!validSubs || (laser && (sub === 'material' || sub === 'info' || sub === 'skids'))) sub = S.view.sub = ls[0] ? ls[0].id : (laserLists[0] ? laserLists[0].id : null);
  const recs = receiptsForJob(j);
  let h = '<div class="card jhead"><div><div class="row"><h1 class="mono">' + esc(j.jobNo) + '</h1>' + (j.status === 'closed' ? '<span class="tag">closed</span>' : '') + '</div>' +
    '<div class="kv"><span>Job name</span><b>' + esc(j.jobName || '—') + '</b><span>Customer</span><b>' + esc(j.customer || '—') + '</b>' +
    (j.shipAddr ? '<span>Ship to</span><b>' + esc(j.shipAddr).replace(/\n/g, ', ') + '</b>' : '') + (j.stickerNo ? '<span>Skid sticker #</span><b>' + esc(j.stickerNo) + '</b>' : '') + '</div></div>' +
    '<div class="jpct"><b>' + pct(s.pct) + '</b><div class="muted small">' + s.done + '/' + s.total + ' lines done · ' + s.bo + ' on B/O' + (jobNextShip(j) ? ' · next ship ' + esc(fmtDateLong(jobNextShip(j))) + ' ' + shipBadge(jobNextShip(j)) : '') + '</div>' +
    (laser ? '' : '<div class="row" style="justify-content:flex-end;margin-top:8px">' +
    (jobShipStats(j).total ? '<button class="btn sm" data-act="jobShipments" data-id="' + esc(j.id) + '">Shipments (' + jobShipStats(j).shipped + '/' + jobShipStats(j).total + ' shipped)</button>' : '') +
    '<button class="btn sm" data-act="printJob">Print job report</button><button class="btn sm" data-act="jobInfo">Job info</button></div>') + '</div></div>';
  h += '<div class="subtabsRow"><div class="subtabs">' + ls.map(l => {
    const st = Model.listStats(l);
    return '<button class="subtab' + (sub === l.id ? ' on' : '') + '" data-act="sub" data-k="' + l.id + '"><span class="sw" style="background:' + gColor(l.groupKey) + '"></span>' +
      esc(l.title || 'PRODUCT LIST') + (l.carNo ? ' · CAR ' + esc(l.carNo) : '') + ' <span class="muted mono">' + pct(st.pct) + '</span></button>';
  }).join('') +
    (laser ? '' : '<button class="subtab' + (sub === 'material' ? ' on' : '') + '" data-act="sub" data-k="material">Material (' + recs.length + (s.unmatched ? ' · ' + s.unmatched + ' unmatched' : '') + ')</button>') +
    (laser ? '' : '<button class="subtab' + (sub === 'skids' ? ' on' : '') + '" data-act="sub" data-k="skids">Skids (' + jobSkids(j).length + ')' + (j.stickerNo ? ' · #' + esc(j.stickerNo) : '') + '</button>') +
    laserLists.map(l => '<button class="subtab' + (sub === l.id ? ' on' : '') + '" data-act="sub" data-k="' + l.id + '"><span class="sw" style="background:' + gColor('LASER') + '"></span>' +
      esc(l.title || 'LASER CUT LIST') + ' <span class="muted mono">' + l.items.length + ' pcs</span></button>').join('') +
    '</div><div class="subtabActions">' +
    (laser ? '' : '<button class="subtab addbtn" data-act="importList" data-job="' + esc(j.id) + '">+ Add list</button>') +
    '<button class="subtab addbtn" data-act="uploadLaser" data-job="' + esc(j.id) + '">+ Add cut list</button></div></div>';
  const curLaser = laserLists.find(l => l.id === sub);
  h += '<div class="panel">' + (sub === 'material' ? viewMaterial(j, recs) : sub === 'skids' ? viewSkids(j) : curLaser ? viewLaserList(j, curLaser) : viewList(j, S.lists.find(l => l.id === sub), laser)) + '</div>';
  return h;
}

function stampHtml(list, ln, k, qc, locked){
  const v = qc ? (ln[k] ? { on: true, by: ln[k] } : null) : (ln.st && ln.st[k]);
  const on = v && v.on;
  if(locked) return '<span class="stamp locked' + (qc ? ' qc' : '') + (on ? ' on' : '') + '">' + (on ? (v.by ? esc(v.by) : '✓') : '—') + '</span>';
  return '<button class="stamp' + (qc ? ' qc' : '') + (on ? ' on' : '') + (on && !v.by ? ' bare' : '') + '" data-act="pick" data-l="' + ln.id + '" data-k="' + k + '" aria-label="' + k + '">' + (on && v.by ? esc(v.by) : '') + '</button>';
}
function rowHtml(list, ln, edit, laserOnly){
  const st = Model.lineStatus(ln);
  const cls = [st === 'done' ? 'done' : '', st === 'bo' ? 'bo' : '', ln.conf < 0.75 ? 'low' : '', ln.revNote ? 'rev' : ''].join(' ');
  const mats = recvFor(list.id, ln.id).length;
  let h = '<tr class="' + cls + '" data-row="' + ln.id + '">' +
    '<td class="gb"><span>' + esc((ln.g || '').replace('GROUP ', 'G')) + '</span></td><td class="n">' + esc(ln.n || '') + '</td>';
  if(edit){
    h += '<td class="edit"><input data-lf="p" data-l="' + ln.id + '" value="' + esc(ln.p) + '"></td><td class="edit"><input data-lf="q" data-l="' + ln.id + '" value="' + esc(ln.q) + '" inputmode="numeric"></td><td class="edit"><input data-lf="d" data-l="' + ln.id + '" value="' + esc(ln.d) + '"></td>';
  } else if(laserOnly){
    h += '<td class="part">' + esc(ln.p) + '</td><td class="q">' + esc(ln.q) + '</td><td class="d">' + esc(ln.d) + '</td>';
  } else {
    h += '<td class="part"><button data-act="line" data-l="' + ln.id + '">' + esc(ln.p) + '</button></td><td class="q">' + esc(ln.q) + '</td><td class="d">' + esc(ln.d) + '</td>';
  }
  for(const k of Model.DK) h += '<td class="st">' + stampHtml(list, ln, k, false, laserOnly && k !== 'laser') + '</td>';
  if(laserOnly){
    h += '<td class="inp">' + esc(ln.pkQty) + '</td><td class="st">' + stampHtml(list, ln, 'pkInit', true, true) + '</td><td class="st">' + stampHtml(list, ln, 'qcInit', true, true) + '</td>' +
      '<td class="inp">' + esc(ln.skid) + '</td><td class="inp boc">' + esc(ln.boQty) + '</td>' +
      '<td class="mat">' + (mats ? '▣ ' + mats : '') + '</td>';
  } else {
    h += '<td class="inp"><input data-lf="pkQty" data-l="' + ln.id + '" value="' + esc(ln.pkQty) + '" placeholder=" " inputmode="numeric" aria-label="Packaged qty"></td>' +
      '<td class="st">' + stampHtml(list, ln, 'pkInit', true) + '</td><td class="st">' + stampHtml(list, ln, 'qcInit', true) + '</td>' +
      '<td class="inp"><input data-lf="skid" data-l="' + ln.id + '" value="' + esc(ln.skid) + '" placeholder=" " aria-label="Skid"></td>' +
      '<td class="inp boc"><input data-lf="boQty" data-l="' + ln.id + '" value="' + esc(ln.boQty) + '" placeholder=" " inputmode="numeric" aria-label="Back order qty"></td>' +
      '<td class="mat"><button class="matbtn' + (mats ? ' has' : '') + '" data-act="line" data-l="' + ln.id + '" data-sec="mat">' + (mats ? '▣ ' + mats : '+') + '</button></td>';
  }
  if(edit) h += '<td class="del"><button data-act="delLine" data-l="' + ln.id + '" aria-label="Delete line">✕</button></td>';
  return h + '</tr>';
}
function viewList(j, list, laserOnly){
  if(!list) return '<div class="empty"><h2>No product list yet</h2>' + (laserOnly ? '' : '<button class="btn primary" data-act="importList" data-job="' + esc(j.id) + '">+ Import product list</button>') + '</div>';
  const st = Model.listStats(list);
  const f = S.ui.listFilter[list.id] || 'all';
  const edit = !laserOnly && !!S.ui.editLines[list.id];
  const items = list.items.filter(ln => {
    const s = Model.lineStatus(ln);
    return f === 'all' || (f === 'open' && s !== 'done') || (f === 'bo' && s === 'bo') || (f === 'done' && s === 'done');
  });
  let h = '<div class="titlebar" style="background:' + gColor(list.groupKey) + '">' + esc(list.title || 'PRODUCT LIST') + '</div>' +
    '<div class="ltool"><span class="muted small">CAR ' + esc(list.carNo || '—') + ' · REV ' + esc(list.rev || '—') + (list.formRev ? ' · ' + esc(list.formRev) : '') +
    ' · imported ' + esc(when(list.importedAt)) + (list.hasPdf ? '' : ' · no original PDF') + '</span><span class="sp"></span>' +
    (laserOnly ? '<span class="tag">View only - sign the Laser column</span>' :
    '<button class="btn sm" data-act="exportPdf">Export filled PDF</button>' +
    '<button class="btn sm" data-act="importList" data-job="' + esc(j.id) + '" data-list="' + list.id + '">Update from PDF</button>' +
    '<button class="btn sm" data-act="importList" data-job="' + esc(j.id) + '" data-list="' + list.id + '" data-append="1">+ Add pages</button>' +
    '<button class="btn sm" data-act="mergeList">Merge list…</button>' +
    '<button class="btn sm danger" data-act="delList">Delete list</button>' +
    '<button class="btn sm" data-act="listInfo">Signatures</button>' +
    '<button class="btn sm' + (edit ? ' dark' : '') + '" data-act="editLines">' + (edit ? 'Done editing' : 'Edit lines') + '</button>') + '</div>';
  if(!laserOnly) h += '<div class="ltool"><span class="muted small">' + shipSummaryHtml(list) + '</span><span class="sp"></span><button class="btn sm" data-act="listShip">Shipping</button></div>';
  h += '<div class="ltool"><div class="chips" id="lchips">' + [['all', 'All', st.total], ['open', 'Open', st.total - st.done], ['bo', 'Back order', st.bo], ['done', 'Done', st.done]]
    .map(([k, t, n]) => '<button class="chip' + (f === k ? ' on' : '') + '" data-act="lfilter" data-k="' + k + '">' + t + ' <b>' + n + '</b></button>').join('') + '</div>' +
    '<span class="sp"></span><span class="muted small">Tap a part # for history, material and back-order details. Tap a box to sign.</span></div>';
  h += '<div class="twrap"><table class="sheet"><thead><tr class="h1"><th colspan="2"></th><th colspan="3">Product details</th><th colspan="5" class="dept">Departments</th>' +
    '<th colspan="2" class="pk">Packaging</th><th colspan="2" class="qc">QC check / pkg details</th><th class="bo">Back order</th><th></th>' + (edit ? '<th></th>' : '') + '</tr>' +
    '<tr><th>Grp</th><th>#</th><th>Part #</th><th>Qty</th><th>Description</th>' + Model.DEPTS.map(d => '<th>' + d[1] + '</th>').join('') +
    '<th>Qty</th><th>Init.</th><th>Init.</th><th>Skid #</th><th>B/O</th><th>Mat.</th>' + (edit ? '<th></th>' : '') + '</tr></thead><tbody>' +
    items.map(ln => rowHtml(list, ln, edit, laserOnly)).join('') + '</tbody></table></div>';
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
  tmp.innerHTML = rowHtml(list, ln, !isLaser() && !!S.ui.editLines[list.id], isLaser());
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

/* ================= laser cut lists ================= */
// A laser cut list is its own kind of list (list.kind === 'laser'), kept out
// of listsOf()/jobStats() entirely since it has no department sign-off model
// and shouldn't skew the job's "lines done" rollup. One per job for now -
// re-uploading the PDF updates it in place (sign-offs on existing product #s
// carry forward) rather than creating a second one.
function viewLaserList(j, list){
  if(!list){
    return '<div class="empty"><h2>No laser cut list yet</h2><p class="muted">Upload the laser cut list PDF for this job to work out sheet material needed.</p>' +
      '<button class="btn primary" data-act="uploadLaser" data-job="' + esc(j.id) + '">+ Upload cut list</button></div>';
  }
  const groups = computeSheetGroups(list.items);
  const areaByGroup = {}; groups.forEach(g => { areaByGroup[g.key] = sheetSizeArea(g.sheetSize); });
  const h0 = list.header || {};
  let h = '<div class="titlebar" style="background:' + gColor('LASER') + ';color:' + gInk('LASER') + '">' + esc(list.title || 'LASER CUT LIST') + '</div>' +
    '<div class="ltool"><span class="muted small">' + (h0.by ? 'By ' + esc(h0.by) + ' · ' : '') + (h0.elevatorNo ? 'Elevator ' + esc(h0.elevatorNo) + ' · ' : '') +
    'REV ' + esc(h0.rev || '—') + ' · imported ' + esc(when(list.importedAt)) + ' · ' + list.items.length + ' lines</span><span class="sp"></span>' +
    '<button class="btn sm" data-act="uploadLaser" data-job="' + esc(j.id) + '" data-list="' + list.id + '">Update from PDF</button>' +
    '<button class="btn sm" data-act="pullSheets" data-list="' + list.id + '">Re-check stock</button>' +
    '<button class="btn sm" data-act="printSheetOrder" data-list="' + list.id + '">Download order list (PDF)</button></div>';
  h += '<div class="card" style="margin:10px 0"><h3 style="margin:0 0 4px">Sheet requirements <span class="muted small">(total area ÷ sheet area, rounded up; not real nesting)</span></h3>' +
    '<p class="muted small" style="margin:0 0 10px">Sheet size is picked automatically per material, based on what\'s on hand right now - whichever standard size leaves the smallest shortfall, so it shifts on its own as stock changes. Click Re-check stock after receiving more to re-evaluate.</p>' +
    '<table class="list"><thead><tr><th>Material</th><th>Thick (in)</th><th>Total area (in²)</th><th>Sheet size</th><th>Sheets needed</th><th>On hand (that size)</th><th>Pulled from stock</th><th>Status</th><th>Drop-piece suggestion</th></tr></thead><tbody>' +
    (groups.length ? groups.map(g => {
      const pullKey = g.key + '|' + g.sheetSize;
      const pulled = ((list.sheetPulls || {})[pullKey] || {}).totalPulled || 0;
      const short = Math.max(0, g.sheetsNeeded - pulled);
      return '<tr><td>' + esc(g.material || '—') + '</td><td>' + g.thick.toFixed(3) + '</td><td>' + Math.round(g.totalArea).toLocaleString() + '</td><td><b>' + esc(sheetSizeInfo(g.sheetSize).label) + '</b></td><td><b>' + g.sheetsNeeded + '</b></td><td>' + g.onHand + '</td><td>' + pulled + '</td>' +
        '<td>' + (short ? '<span class="tag warn">' + short + ' short - buy more</span>' : '<span class="tag ok">covered</span>') + '</td>' +
        '<td class="small muted">' + esc(dropPieceHint(g) || '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="9" class="muted" style="text-align:center;padding:20px">No parts with a material/thickness yet.</td></tr>') + '</tbody></table></div>';
  h += '<div class="twrap"><table class="sheet"><thead><tr><th>Grp</th><th>Product #</th><th>Description</th><th>Qty</th><th>Width</th><th>Length</th><th>Thick</th><th>Gauge</th><th>Material</th><th>Finish</th><th>Area ea (in²)</th><th>Sheets (this line)</th><th>Laser</th></tr></thead><tbody>' +
    list.items.map(it => {
      const qty = parseFloat(it.qty) || 0, area = it.area || 0;
      const lineSheets = area && qty ? (area * qty / (areaByGroup[it.sheetKey] || sheetSizeArea(SHEET_SIZES[0].key))) : 0;
      const on = !!it.laserOn;
      return '<tr data-row="' + it.id + '"><td>' + esc((it.group || '').replace('Group ', 'G')) + '</td><td class="mono small">' + esc(it.productNo || '') + '</td><td>' + esc(it.description || '') + '</td><td>' + esc(it.qty || '') + '</td>' +
        '<td>' + esc(it.width || '') + '</td><td>' + esc(it.length || '') + '</td><td>' + esc(it.thick || '') + '</td><td>' + esc(it.gauge || '') + '</td><td>' + esc(it.material || '') + '</td><td>' + esc(it.finish || '') + '</td>' +
        '<td>' + Math.round(area) + '</td><td>' + lineSheets.toFixed(2) + '</td>' +
        '<td class="st"><button class="stamp' + (on ? ' on' : '') + '" data-act="laserPick" data-l="' + it.id + '">' + (on ? esc(it.laserBy || '✓') : '') + '</button></td></tr>';
    }).join('') + '</tbody></table></div>';
  return h;
}
function pickLaserSign(list, ln){
  const cur = ln.laserOn ? (ln.laserBy || '✓') : '';
  let h = '<h2>Laser</h2><div class="muted"><span class="mono">' + esc(ln.productNo || '') + '</span> · ' + esc(ln.description || '') + '</div>' +
    '<div class="pick">' + S.set.staff.map(s => '<button data-v="' + esc(s) + '" class="' + (cur === s ? 'cur' : '') + '">' + esc(s) + '</button>').join('') +
    '<button data-v="" class="alt' + (cur === '✓' ? ' cur' : '') + '">✓ Done, no initials</button></div>' +
    '<div class="row"><button class="btn danger" data-v="__clear">Clear</button><span class="sp"></span><button class="btn" data-v="__x">Cancel</button></div>';
  openSheet(h);
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-v]'); if(!b) return;
    const v = b.dataset.v;
    if(v === '__x') return closeSheet();
    if(v === '__clear'){ ln.laserOn = false; ln.laserBy = ''; ln.laserTs = null; }
    else { ln.laserOn = true; ln.laserBy = v; ln.laserTs = nowIso(); }
    closeSheet();
    await saveList(list);
    render();
  };
}
// Draws down sheet stock (Inventory > stock receipts with uom SHEET) to
// cover what this cut list's sheet groups need, oldest sheets first - same
// withdrawal-log mechanism as taking any other stock out. Only ever pulls
// the DELTA beyond what's already been pulled for this list (so re-checking
// after an edit, or re-importing the same PDF, never double-withdraws), and
// never withdraws more than what's on hand - the gap is reported as a
// shortfall so buying and job priority can be decided from it.
async function pullSheetsFromStock(list){
  const groups = computeSheetGroups(list.items);
  list.sheetPulls = list.sheetPulls || {};
  let anyPulled = false, anyShort = false;
  for(const g of groups){
    const pullKey = g.key + '|' + g.sheetSize;
    const rec = list.sheetPulls[pullKey] || { totalPulled: 0 };
    const need = g.sheetsNeeded - rec.totalPulled;
    if(need <= 0) continue;
    const stock = S.receipts.filter(r => r.type === 'stock' && r.uom === 'SHEET' && sheetGroupKey(r.sheetMaterial, r.sheetThick) === g.key && (r.sheetSize || SHEET_SIZES[0].key) === g.sheetSize && onHandQty(r) > 0)
      .sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''));
    let remaining = need; const touched = [];
    for(const r of stock){
      if(remaining <= 0) break;
      const avail = onHandQty(r); if(!avail) continue;
      const take = Math.min(avail, remaining);
      r.withdrawals = r.withdrawals || [];
      r.withdrawals.push({ id: uid(), qty: take, by: 'Laser cut list', note: 'Pulled for ' + (job(list.jobId) || {}).jobNo, at: nowIso() });
      touched.push(r);
      remaining -= take;
    }
    for(const r of touched) await saveReceipt(r);
    const pulled = need - remaining;
    if(pulled > 0){ rec.totalPulled += pulled; anyPulled = true; }
    if(remaining > 0) anyShort = true;
    list.sheetPulls[pullKey] = rec;
  }
  await saveList(list);
  if(anyShort) toast('Pulled sheets from stock - some sheet types are short. Buy more to cover the shortfall.', true);
  else if(anyPulled) toast('Pulled the needed sheets from stock.');
  else toast('Stock already covers this cut list.');
}
// One laser cut list per job (re-uploading updates it in place). Matches
// rows to the existing list by Product # so laser sign-offs already done
// aren't lost on a re-import/revision.
async function importLaserList(file, target){
  const j = job(target.jobId);
  if(!j) return toast('Open the job first, then upload its cut list', true);
  toast('Reading laser cut list…');
  let r;
  try{ r = await Parse.readLaser(file); }catch(err){ return toast('Could not read that PDF: ' + (err && err.message || err), true); }
  if(!r.rows.length) return toast('No laser cut list rows found in that PDF', true);
  // No target.listId = "+ Add cut list": always a new one, same as "+ Add
  // list" does for product lists, so a job can carry a separate cut list
  // per group instead of one list forced to cover the whole job.
  let list = target.listId ? S.lists.find(x => x.id === target.listId) : null;
  const prevItems = list ? list.items : [];
  const items = r.rows.map(row => {
    const prev = row.productNo && prevItems.find(p => p.productNo === row.productNo);
    return {
      id: prev ? prev.id : uid(), group: row.group || '', subGroup: row.subGroup || '', production: row.production || '',
      productNo: row.productNo || '', description: row.description || '', qty: row.qty || '', width: row.width || '', length: row.length || '',
      thick: row.thick || '', gauge: row.gauge || '', stockNo: row.stockNo || '', weight: row.weight || '', material: row.material || '', finish: row.finish || '', notes: row.notes || '',
      laserOn: prev ? !!prev.laserOn : false, laserBy: prev ? prev.laserBy || '' : '', laserTs: prev ? prev.laserTs || null : null
    };
  });
  if(!list){
    list = { id: uid(), jobId: j.id, kind: 'laser', title: r.header.title || 'LASER CUT LIST', carNo: '', groupKey: 'LASER', rev: r.header.rev || '',
      header: r.header, items, sheetPulls: {}, importedAt: nowIso(), mode: 'laser' };
    S.lists.push(list);
  } else {
    list.header = r.header; list.title = r.header.title || list.title; list.rev = r.header.rev || list.rev; list.items = items; list.importedAt = nowIso();
  }
  computeSheetGroups(list.items);
  await saveList(list);
  await pullSheetsFromStock(list);
  go({ name: 'job', jobId: j.id, sub: list.id });
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
  // Belt-and-suspenders: the row itself only renders a clickable stamp for
  // the Laser column under the Laser role, but guard here too in case a
  // stale drawer/row from before a role switch still points at another dept.
  if(isLaser() && k !== 'laser') return toast("The Laser role can only sign off the Laser column", true);
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
  if(!recs.length && !sps.length) return h + '<div class="empty"><h2>Nothing received yet</h2><p>Receive material in the Inventory tab with job # ' + esc(j.jobNo) + ', or import the move app file.</p></div>';
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
// Stock withdrawals: each stock receipt keeps its own received qty untouched
// (that's history) plus a withdrawals[] log; on-hand = received - withdrawn.
// A receipt whose qty isn't a plain number (e.g. "several") can still be
// taken out, just without a quantity - that one withdrawal empties it.
function qtyNum(r){ const n = parseFloat(r.qty); return isNaN(n) ? null : n; }
function withdrawnQty(r){ return (r.withdrawals || []).reduce((a, w) => a + (+w.qty || 0), 0); }
function onHandQty(r){ const n = qtyNum(r); return n === null ? null : Math.max(0, n - withdrawnQty(r)); }
function onHandHtml(r){
  const n = onHandQty(r), uom = esc(r.uom || 'EA');
  if(n === null) return esc(r.qty || '') + ' ' + uom;
  const rec = qtyNum(r), out = Math.round(n * 100) / 100;
  return (withdrawnQty(r) > 0 ? out + ' / ' + rec : String(out)) + ' ' + uom;
}
function takeStockSheet(r){
  const n = onHandQty(r);
  if(n !== null && n <= 0){
    openSheet('<h2>Take out of stock</h2><p class="muted">' + esc(r.description) + ' has nothing left on hand.</p>' +
      '<div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-tk="x">Close</button></div>');
    $('#sheet').onclick = e => { if(e.target.closest('[data-tk]')) closeSheet(); };
    return;
  }
  if(n === null){
    openSheet('<h2>Take out of stock</h2><p>' + esc(r.description) + ' · ' + esc(r.qty || '') + ' ' + esc(r.uom || '') + '</p>' +
      '<p class="muted small">This item isn\'t tracked by quantity, so taking it out marks it fully used.</p>' +
      '<div class="row" style="margin-top:10px"><button class="btn danger" data-tk="all">Mark fully taken</button><span class="sp"></span><button class="btn" data-tk="x">Cancel</button></div>');
    $('#sheet').onclick = async e => {
      const b = e.target.closest('[data-tk]'); if(!b) return;
      if(b.dataset.tk === 'x') return closeSheet();
      if(b.dataset.tk === 'all'){
        r.withdrawals = r.withdrawals || [];
        r.withdrawals.push({ id: uid(), qty: r.qty || '1', by: S.set.staff[0] || '', note: '', at: nowIso() });
        await saveReceipt(r); closeSheet(); render(); toast('Marked taken out');
      }
    };
    return;
  }
  openSheet('<h2>Take out of stock</h2><p>' + esc(r.description) + ' · bin ' + esc(r.bin || '—') + '</p>' +
    '<p class="small"><b>On hand:</b> ' + onHandHtml(r) + '</p>' +
    '<div class="form" id="tkf">' +
    '<label>Quantity taken<input id="tkQty" inputmode="decimal" value="' + n + '"></label>' +
    '<label>Taken by<select id="tkBy">' + S.set.staff.map(s => '<option>' + esc(s) + '</option>').join('') + '</select></label>' +
    '<label>Note (optional)<input id="tkNote" placeholder="e.g. job # or reason"></label></div>' +
    '<div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-tk="x">Cancel</button><button class="btn dark" data-tk="go">Take out</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-tk]'); if(!b) return;
    if(b.dataset.tk === 'x') return closeSheet();
    if(b.dataset.tk === 'go'){
      let q = parseFloat($('#tkQty').value);
      if(isNaN(q) || q <= 0) return toast('Enter a quantity greater than 0', true);
      const avail = onHandQty(r);
      if(q > avail){ q = avail; toast('Only ' + avail + ' on hand - taking all of it', true); }
      r.withdrawals = r.withdrawals || [];
      r.withdrawals.push({ id: uid(), qty: q, by: $('#tkBy').value, note: $('#tkNote').value.trim(), at: nowIso() });
      await saveReceipt(r);
      closeSheet(); render(); toast('Took ' + q + ' ' + (r.uom || 'EA') + ' out of stock');
    }
  };
}
// Groups stock (non-job) receipts by description + bin so the Inventory tab
// can show what's actually on the shelf instead of a flat log. Totals here
// are ON-HAND (received minus any withdrawals), not just everything ever
// received.
function stockGroups(){
  const map = new Map();
  for(const r of S.receipts){
    if(r.type !== 'stock') continue;
    const descKey = (r.description || '').trim().toUpperCase() || '(NO DESCRIPTION)';
    const binKey = (r.bin || '').trim().toUpperCase() || 'NO BIN';
    const key = descKey + '|' + binKey;
    if(!map.has(key)) map.set(key, { description: r.description || '(no description)', bin: r.bin || '', uomTotals: {}, receipts: [], anyAllocated: false });
    const g = map.get(key);
    g.receipts.push(r);
    const uom = r.uom || 'EA';
    const oh = onHandQty(r);
    g.uomTotals[uom] = (g.uomTotals[uom] || 0) + (oh === null ? 0 : oh);
    if(r.allocatedJob) g.anyAllocated = true;
  }
  return [...map.values()].sort((a, b) => a.description.localeCompare(b.description) || a.bin.localeCompare(b.bin));
}
let STOCK_GROUPS = [];
function stockGroupQtyHtml(g){
  const parts = Object.entries(g.uomTotals).filter(([, n]) => n > 0).map(([u, n]) => (Math.round(n * 100) / 100) + ' ' + u);
  return parts.length ? parts.join(', ') : g.receipts.length + ' item' + (g.receipts.length > 1 ? 's' : '');
}
function stockGroupDetail(i){
  const g = STOCK_GROUPS[i]; if(!g) return;
  openSheet('<h2>' + esc(g.description) + '</h2><div class="muted small">Bin ' + esc(g.bin || '—') + ' · ' + stockGroupQtyHtml(g) + ' on hand · ' + g.receipts.length + ' receipt' + (g.receipts.length > 1 ? 's' : '') + '</div>' +
    '<div class="row" style="margin-top:8px"><span class="sp"></span><button class="btn dark" data-g="take">Take out of stock</button></div>' +
    '<div class="opts" style="margin-top:10px">' + g.receipts.slice().sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || '')).map(r =>
      '<div class="opt" data-r="' + r.id + '"><span><b class="mono">' + esc(r.code) + '</b> ' + onHandHtml(r) + '<br><span class="small muted">' + esc(when(r.receivedAt)) + (r.allocatedJob ? ' · → ' + esc(r.allocatedJob) : '') + '</span></span><span class="sc"><button class="btn sm" data-tkr="' + r.id + '">Take out</button></span></div>'
    ).join('') + '</div>' +
    '<div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-r="__x">Close</button></div>');
  $('#sheet').onclick = e => {
    const tkr = e.target.closest('[data-tkr]');
    if(tkr){ e.stopPropagation(); return takeStockSheet(S.receipts.find(x => x.id === tkr.dataset.tkr)); }
    const g2 = e.target.closest('[data-g="take"]'); if(g2) return takeStockGroupSheet(i);
    const b = e.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === '__x') return closeSheet();
    editRec(S.receipts.find(x => x.id === b.dataset.r));
  };
}
function takeStockGroupSheet(i){
  const g = STOCK_GROUPS[i]; if(!g) return;
  const receipts = g.receipts.filter(r => onHandQty(r) !== null && onHandQty(r) > 0).sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''));
  const totalOnHand = receipts.reduce((a, r) => a + onHandQty(r), 0);
  if(!receipts.length){
    openSheet('<h2>Take out of stock</h2><p class="muted">Nothing quantified left on hand in this group - open an individual receipt to take it out.</p>' +
      '<div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-tk="x">Close</button></div>');
    $('#sheet').onclick = e => { if(e.target.closest('[data-tk]')) closeSheet(); };
    return;
  }
  openSheet('<h2>Take out of stock</h2><p>' + esc(g.description) + ' · bin ' + esc(g.bin || '—') + '</p>' +
    '<p class="small"><b>On hand:</b> ' + stockGroupQtyHtml(g) + '</p>' +
    '<div class="form" id="tkf">' +
    '<label>Quantity taken<input id="tkQty" inputmode="decimal" placeholder="e.g. 10"></label>' +
    '<label>Taken by<select id="tkBy">' + S.set.staff.map(s => '<option>' + esc(s) + '</option>').join('') + '</select></label>' +
    '<label>Note (optional)<input id="tkNote" placeholder="e.g. job # or reason"></label></div>' +
    '<p class="muted small">Taken from the oldest receipts first.</p>' +
    '<div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-tk="x">Cancel</button><button class="btn dark" data-tk="go">Take out</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-tk]'); if(!b) return;
    if(b.dataset.tk === 'x') return closeSheet();
    if(b.dataset.tk === 'go'){
      let want = parseFloat($('#tkQty').value);
      if(isNaN(want) || want <= 0) return toast('Enter a quantity greater than 0', true);
      if(want > totalOnHand){ want = totalOnHand; toast('Only ' + totalOnHand + ' on hand - taking all of it', true); }
      const by = $('#tkBy').value, note = $('#tkNote').value.trim(), batchId = uid(), at = nowIso();
      let remaining = want; const touched = [];
      for(const r of receipts){
        if(remaining <= 0) break;
        const avail = onHandQty(r); if(!avail) continue;
        const take = Math.min(avail, remaining);
        r.withdrawals = r.withdrawals || [];
        r.withdrawals.push({ id: uid(), qty: take, by, note, at, batch: batchId });
        touched.push(r);
        remaining -= take;
      }
      for(const r of touched) await saveReceipt(r);
      closeSheet(); render(); toast('Took ' + (want - remaining) + ' out of stock');
    }
  };
}
function viewRecv(){
  const d = S.ui.lastRecv;
  const t = S.ui.recvType;
  let h = '<div class="row" style="margin-bottom:12px"><h1>Inventory</h1><span class="sp"></span>' +
    '<button class="btn" data-act="scanLabel">Scan label</button>' +
    '<button class="btn" data-act="importMove" title="Accepts the move app\'s JSON/CSV export, or its Print / Save PDF list export">Import move app file</button></div><div class="recvgrid">';
  h += '<div class="card"><h2>Receive material</h2><div class="form" style="margin-top:10px" id="recvForm">' +
    '<div class="seg"><button data-act="recvType" data-k="job" class="' + (t === 'job' ? 'on' : '') + '">For a job</button><button data-act="recvType" data-k="stock" class="' + (t === 'stock' ? 'on' : '') + '">Stock</button></div>' +
    (t === 'job' ? '<label>Job #<input id="recvJob" list="dlJobs" autocomplete="off" value="' + esc(d.jobNo || '') + '" placeholder="MEII-3181"></label><datalist id="dlJobs">' + S.jobs.map(j => '<option value="' + esc(j.jobNo) + '">' + esc(j.jobName) + '</option>').join('') + '</datalist>' : '') +
    (S.ui.recvUomSheet ? '' : '<label>Description<input id="recvDesc" autocomplete="off" placeholder="What came in"></label>') +
    '<div class="two"><label>Part # (if marked)<input id="recvPart" autocomplete="off"></label><label>Qty<div class="row" style="gap:6px;flex-wrap:nowrap"><input id="recvQty" inputmode="decimal" style="min-width:0;flex:1" value="1"><select id="recvUom" style="width:78px"><option>EA</option><option>BOX</option><option>SKID</option><option>FT</option><option>LB</option><option>SET</option><option>SHEET</option></select></div></label></div>' +
    (S.ui.recvUomSheet ? '<div class="two"><label>Sheet material<input id="recvSheetMat" autocomplete="off" placeholder="e.g. CRS"></label><label>Thickness (in)<input id="recvSheetThick" inputmode="decimal" placeholder="e.g. 0.075"></label></div>' +
      '<label>Sheet size<select id="recvSheetSize">' + SHEET_SIZES.map(s => '<option value="' + s.key + '">' + s.label + '</option>').join('') + '</select></label>' +
      '<p class="muted small">Description is filled in from material + thickness + size.</p>' : '') +
    '<div class="two"><label>Supplier<input id="recvSup" autocomplete="off" value="' + esc(d.supplier || '') + '"></label><label>PO #<input id="recvPo" autocomplete="off" value="' + esc(d.po || '') + '"></label></div>' +
    '<div class="two"><label>Packing slip #<input id="recvSlip" autocomplete="off" value="' + esc(d.slip || '') + '"></label><label>Location / bin<input id="recvBin" list="dlBins" autocomplete="off" value="' + esc(d.bin || '') + '"></label></div><datalist id="dlBins">' + binOptions() + '</datalist>' +
    '<label>Received by<select id="recvBy">' + S.set.staff.map(s => '<option' + (d.by === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></label>' +
    '<div class="photo">' + (S.ui.draftPhoto ? '<img src="' + S.ui.draftPhoto + '" alt="">' : '') + '<button class="btn" data-act="photo">' + (S.ui.draftPhoto ? 'Retake photo' : 'Take photo') + '</button>' + (S.ui.draftPhoto ? '<button class="btn ghost" data-act="dropPhoto">Remove</button>' : '') + '</div>' +
    '<label>Notes<textarea id="recvNote" placeholder="Damage, shortages, anything to flag"></textarea></label>' +
    '<div class="row"><button class="btn dark" data-act="saveRecv" data-print="0">Save</button><button class="btn primary" data-act="saveRecv" data-print="1">Save &amp; print label</button></div>' +
    '<p class="muted small">Job, supplier, PO, slip and bin stay filled for the next item from the same delivery.</p></div></div>';
  // list
  const view = S.ui.recvView;
  h += '<div><div class="row" style="margin-bottom:8px"><h2 style="margin:0">' + (view === 'stock' ? 'Stock on hand' : 'All receipts') + '</h2><span class="sp"></span><div class="chips">' +
    [['stock', 'Stock on hand'], ['log', 'All receipts']].map(([k, t2]) => '<button class="chip' + (view === k ? ' on' : '') + '" data-act="recvView" data-k="' + k + '">' + t2 + '</button>').join('') + '</div></div>';
  if(view === 'stock'){
    STOCK_GROUPS = stockGroups();
    h += '<div class="card" style="padding:0;overflow:auto;max-height:calc(100vh - 210px)"><table class="list"><thead><tr><th>Description</th><th>Bin</th><th>On hand</th><th>Receipts</th><th></th><th></th></tr></thead><tbody>' +
      (STOCK_GROUPS.map((g, i) => '<tr class="click" data-act="stockGroup" data-i="' + i + '"><td>' + esc(g.description) + '</td><td>' + esc(g.bin || '—') + '</td><td>' + esc(stockGroupQtyHtml(g)) + '</td><td>' + g.receipts.length + '</td><td>' + (g.anyAllocated ? '<span class="tag stock">earmarked</span>' : '') + '</td><td><button class="btn sm" data-act="takeStockGroup" data-i="' + i + '">Take out</button></td></tr>').join('') ||
        '<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">No stock received yet.</td></tr>') + '</tbody></table></div></div>';
  } else {
    const f = S.ui.recvFilter, Q = S.ui.recvQ.trim().toUpperCase();
    let rs = S.receipts.slice().sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
    rs = rs.filter(r => f === 'all' || (f === 'job' && r.type !== 'stock') || (f === 'stock' && r.type === 'stock') || (f === 'un' && r.type !== 'stock' && !(r.matches || []).length) || (f === 'np' && !r.labelPrinted));
    if(Q) rs = rs.filter(r => [r.code, r.jobNo, r.description, r.bin, r.supplier, r.po, r.partNo, r.slip].join(' ').toUpperCase().includes(Q));
    const cnt = k => S.receipts.filter(r => k === 'all' || (k === 'job' && r.type !== 'stock') || (k === 'stock' && r.type === 'stock') || (k === 'un' && r.type !== 'stock' && !(r.matches || []).length) || (k === 'np' && !r.labelPrinted)).length;
    h += '<div class="row" style="margin-bottom:8px"><input class="search" placeholder="Search code, job, description, bin, PO" data-in="recvQ" value="' + esc(S.ui.recvQ) + '"><div class="chips">' +
      [['all', 'All'], ['job', 'Job'], ['stock', 'Stock'], ['un', 'Unmatched'], ['np', 'No label']].map(([k, t2]) => '<button class="chip' + (f === k ? ' on' : '') + '" data-act="recvFilter" data-k="' + k + '">' + t2 + ' <b>' + cnt(k) + '</b></button>').join('') + '</div></div>' +
      '<div class="card" style="padding:0;overflow:auto;max-height:calc(100vh - 210px)"><table class="list"><thead><tr><th>Received</th><th>Code</th><th>Job</th><th>Description</th><th>Qty</th><th>Bin</th><th>Status</th></tr></thead><tbody>' +
      (rs.slice(0, 400).map(r => {
        const jb = r.type === 'stock' ? '<span class="tag stock">stock</span>' + (r.allocatedJob ? ' → ' + esc(r.allocatedJob) : '') : esc(r.jobNo || '');
        const known = r.type === 'stock' || S.jobs.some(j => Model.sameJob(r.jobNo, j.jobNo));
        const stt = (r.matches || []).length ? '<span class="tag ok">matched</span>' : r.type === 'stock' ? '' : known ? '<span class="tag warn">unmatched</span>' : '<span class="tag">job not imported</span>';
        const depleted = r.type === 'stock' && onHandQty(r) === 0;
        return '<tr class="click" data-act="editRec" data-r="' + r.id + '"><td class="small">' + esc(when(r.receivedAt)) + '</td><td class="mono small">' + esc(r.code) + '</td><td>' + jb + '</td><td>' + esc(r.description) + '</td><td>' + (r.type === 'stock' ? onHandHtml(r) : esc(r.qty) + ' ' + esc(r.uom || '')) + '</td><td>' + esc(r.bin || '') + '</td><td>' + stt + (r.labelPrinted ? '' : ' <span class="tag">no label</span>') + (depleted ? ' <span class="tag warn">depleted</span>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">Nothing received yet.</td></tr>') + '</tbody></table></div>';
  }
  return h + '</div></div>';
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
  if(r.uom === 'SHEET'){
    r.sheetMaterial = g('recvSheetMat').trim().toUpperCase();
    r.sheetThick = parseFloat(g('recvSheetThick')) || 0;
    r.sheetSize = g('recvSheetSize') || SHEET_SIZES[0].key;
    if(!r.sheetMaterial) return toast('Enter the sheet material', true);
    if(!r.sheetThick) return toast('Enter the sheet thickness', true);
    r.description = sheetDesc(r.sheetMaterial, r.sheetThick, r.sheetSize);
  }
  if(type === 'job' && !r.jobNo) return toast('Enter the job # (or switch to Stock)', true);
  if(!r.description) return toast('Enter a description', true);
  if(!r.qty) return toast('Enter a quantity', true);
  S.receipts.push(r); await saveReceipt(r);
  S.ui.lastRecv = { jobNo: r.jobNo, supplier: r.supplier, po: r.po, slip: r.slip, bin: r.bin, by: r.receivedBy };
  S.ui.draftPhoto = null;
  S.ui.recvUomSheet = false;
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
    (r.type === 'stock' ? '<p class="small"><b>Job:</b> ' + (r.allocatedJob ? esc(r.allocatedJob) : '<span class="muted">not associated yet</span>') + '</p>' : '') +
    (r.type === 'stock' ? '<p class="small"><b>On hand:</b> ' + onHandHtml(r) + '</p>' : '') +
    (ms.length ? '<p class="small"><b>Matched to:</b> ' + ms.map(x => esc(x.list.groupKey) + ' #' + esc(x.line.n) + ' ' + esc(x.line.p)).join(', ') + '</p>' : '') +
    (r.type === 'stock' && (r.withdrawals || []).length ? '<h3 class="small muted" style="margin-top:10px">TAKEN OUT</h3><div class="opts">' +
      r.withdrawals.slice().sort((a, b) => (b.at || '').localeCompare(a.at || '')).map(w => '<div class="opt" style="cursor:default"><span>' + esc(w.qty) + ' ' + esc(r.uom || 'EA') + (w.by ? ' · ' + esc(w.by) : '') + (w.note ? ' · ' + esc(w.note) : '') + '<br><span class="small muted">' + esc(when(w.at)) + '</span></span></div>').join('') + '</div>' : '') +
    '<div class="row" style="margin-top:12px"><button class="btn danger" data-e="del">Delete</button><span class="sp"></span>' +
    (r.type === 'stock' ? '<button class="btn" data-e="take">Take out of stock</button>' : '') +
    (r.type === 'stock' ? '<button class="btn" data-e="assign">' + (r.allocatedJob ? 'Change job' : 'Associate with job') + '</button>' : '') +
    (j ? '<button class="btn" data-e="match">Match to line</button>' : '') +
    '<button class="btn" data-e="label">Print label</button><button class="btn dark" data-e="save">Save</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-e]'); if(!b) return;
    const act = b.dataset.e;
    const collect = () => document.querySelectorAll('#erf [data-rf]').forEach(i => r[i.dataset.rf] = i.dataset.rf === 'jobNo' || i.dataset.rf === 'bin' ? i.value.trim().toUpperCase() : i.value.trim());
    if(act === 'save'){ collect(); await saveReceipt(r); closeSheet(); render(); toast('Saved'); }
    else if(act === 'label'){ collect(); await saveReceipt(r); closeSheet(); printLabel(r); }
    else if(act === 'match'){ collect(); await saveReceipt(r); matchFromReceipt(r, j); }
    else if(act === 'assign'){ collect(); await saveReceipt(r); pickJobForStock(r); }
    else if(act === 'take'){ collect(); await saveReceipt(r); takeStockSheet(r); }
    else if(act === 'del'){
      closeSheet();
      if(!(await askPin('Delete received item ' + r.code))) return;
      if(!(await confirmSheet('Delete ' + r.code + '?', 'This removes the receipt and any line matches.', 'Delete', true))) return;
      S.receipts = S.receipts.filter(x => x !== r); await DB.del('receipts', r.id); render(); toast('Deleted');
    }
  };
}
// Scan-to-associate: a stock item received before its job was known (or one
// that just needs re-assigning) gets tied to a job here, straight from a
// scanned label - no need to go find it from the job's own dashboard.
function pickJobForStock(r){
  const draw = q => {
    const Q = q.trim().toUpperCase();
    const list = S.jobs.filter(j => !Q || (j.jobNo + ' ' + (j.jobName || '')).toUpperCase().includes(Q));
    $('#pjlist').innerHTML = list.map(j => '<button class="opt" data-j="' + esc(j.jobNo) + '"><span><b class="mono">' + esc(j.jobNo) + '</b>' + (j.jobName ? '<br><span class="small">' + esc(j.jobName) + '</span>' : '') + '</span></button>').join('') || '<p class="muted">No jobs imported yet.</p>';
  };
  openSheet('<h2>Associate with a job</h2><div class="muted"><span class="mono">' + esc(r.code) + '</span> · ' + esc(r.description) + ' · ' + esc(r.qty) + ' ' + esc(r.uom || 'EA') + '</div>' +
    '<input class="search" style="width:100%;margin-top:8px" placeholder="Filter by job #" id="pjq"><div class="opts" id="pjlist"></div>' +
    '<div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-j="__x">Cancel</button></div>');
  draw('');
  $('#pjq').oninput = e => draw(e.target.value);
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-j]'); if(!b) return;
    if(b.dataset.j === '__x') return closeSheet();
    r.allocatedJob = b.dataset.j;
    await saveReceipt(r);
    closeSheet();
    toast('Associated with ' + r.allocatedJob);
    const j = S.jobs.find(x => Model.sameJob(x.jobNo, r.allocatedJob));
    if(j && listsOf(j.id).length) matchFromReceipt(r, j); else render();
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
  // Decoded with jsQR (pure JS, works in any browser) rather than the native
  // BarcodeDetector API, which Samsung Internet and most non-desktop-Chrome
  // browsers don't implement — that API silently doing nothing was why
  // scanning never worked on the shop tablets.
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let live = true;
  const stream_ = stream;
  const stop = () => { live = false; stream_.getTracks().forEach(t => t.stop()); };
  $('#sheet').onclick = e => { if(e.target.closest('[data-s]')){ stop(); closeSheet(); } };
  while(live){
    if(v.videoWidth){
      c.width = v.videoWidth; c.height = v.videoHeight;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      let code = null;
      try{ code = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height); }catch(e){}
      if(code && code.data){
        const raw = code.data;
        let cd = raw; try{ cd = JSON.parse(raw).c || raw; }catch(e){}
        const r = S.receipts.find(x => x.code === cd || x.moveCode === cd);
        stop(); closeSheet();
        if(r) editRec(r); else toast('Label ' + cd + ' is not in this tablet’s receiving log', true);
        return;
      }
    }
    await new Promise(res => setTimeout(res, 180));
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
    (IMP.target.append && ex.l ? 'Add to ' + esc(ex.j.jobNo) + ' list' : ex.l && IMP.mode !== 'new' ? 'Update ' + esc(ex.j.jobNo) + ' list' : ex.j ? 'Add list to ' + esc(ex.j.jobNo) : 'Create job tab') + '</button></div>';
  html += '<p class="muted">' + esc(IMP.files) + ' · ' + (r.mode === 'text' ? '<b>read exactly from the PDF text</b>' : '<b>read with OCR</b> — check highlighted lines') + ' · ' + r.lines.length + ' lines</p>';
  for(const n of r.notes) html += '<div class="note">' + esc(n) + '</div>';
  if(filledN) html += '<div class="note">Found <b>' + filledN + '</b> filled-in values in the Packaging / QC / Back order cells of this document. They will be applied to the matching lines.</div>';
  if(low) html += '<div class="note warn"><b>' + low + '</b> lines were hard to read — highlighted in yellow. Fix them before saving.</div>';
  if(IMP.target.append && ex.l){
    html += '<div class="note">These <b>' + r.lines.length + '</b> lines will be <b>added to the end of</b> <b>' + esc(ex.l.title) + (ex.l.carNo ? ' · CAR ' + esc(ex.l.carNo) : '') + '</b> (' + ex.l.items.length + ' lines now). Existing lines and sign-offs are not touched. Delete any duplicate lines below before saving.</div>';
  } else if(ex.l){
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
    skid: '', boxId: '', boQty: '', boInit: '', boDate: '', note: '', shipHistory: [] };
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
  if(IMP.target.append && ex.l){
    // Add pages: new lines go on the end, numbered on from the last line.
    // Nothing already on the list (sign-offs, shipments, header) is changed.
    list = ex.l;
    let n = Math.max(0, ...list.items.map(x => +x.n || 0));
    for(const src of lines){ const ln = newLine(src, ++n); applied += applyFilled(ln, src.filled); list.items.push(ln); }
    if(list.hasPdf){ list.hasPdf = false; await DB.del('pdfs', list.id); }
    await saveList(list);
    const added = lines.length;
    IMP = null;
    openJobTab(j.id, list.id);
    return toast('Added ' + added + ' lines to the end of ' + list.title + ' (now ' + list.items.length + ')');
  }
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
    // Shipments (ship date, weight, carrier, etc.) are scheduled here in the
    // app and can be split across more than one truck (e.g. back order
    // follows later) - re-importing/updating from a fresh PDF never touches
    // them, so nothing already scheduled is ever lost.
    Object.assign(list, { title: h.title || list.title, groupKey: Model.groupKey(h.title || list.title), carNo: h.carNo, rev: h.rev, formRev: h.formRev, printed: h.printed, importedAt: nowIso(), mode: r.mode });
  } else {
    list = { id: uid(), jobId: j.id, title: (h.title || 'PRODUCT LIST').toUpperCase(), groupKey: Model.groupKey(h.title), carNo: h.carNo, rev: h.rev, shipments: [],
      formRev: h.formRev, printed: h.printed, orderType: {}, sig: {}, importedAt: nowIso(), mode: r.mode, items: lines.map((src, i) => newLine(src, src.n || i + 1)) };
    // The PDF's own "SHIP DATE:" field is normally blank on the ERP form, but
    // seed a first shipment with it when it's actually filled in.
    const seedDate = normalizeDateStr(h.shipDate);
    if(seedDate) list.shipments.push(newShipment({ shipDate: seedDate }));
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

/* Merge another list on the same job into the open one (e.g. a 2-page
   product list that was photographed as two separate lists). Lines keep their
   sign-offs, shipment history and received-material matches. */
function mergeListSheet(){
  const l = curList(); if(!l) return;
  const others = listsOf(l.jobId).filter(x => x.id !== l.id);
  if(!others.length) return toast('There is no other list on this job to merge in', true);
  openSheet('<h2>Merge a list into ' + esc(l.title) + '</h2><p class="muted small">Pick the list to pull in. Its lines are added to the end of this one, then that list is removed.</p>' +
    '<div class="opts">' + others.map(o => '<button class="opt" data-m="' + o.id + '"><b>' + esc(o.title) + '</b>' + (o.carNo ? ' · CAR ' + esc(o.carNo) : '') + ' · ' + o.items.length + ' lines</button>').join('') + '</div>' +
    '<div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-m="x">Cancel</button></div>');
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-m]'); if(!b) return;
    closeSheet(); if(b.dataset.m === 'x') return;
    const src = S.lists.find(x => x.id === b.dataset.m); if(!src) return;
    if(!(await askPin('Merge lists'))) return;
    if(!(await confirmSheet('Merge ' + src.title + ' into ' + l.title + '?', src.items.length + ' lines will be added to the end of this list and ' + esc(src.title) + ' will be removed.', 'Merge', true))) return;
    let n = Math.max(0, ...l.items.map(x => +x.n || 0));
    for(const ln of src.items){ ln.n = ++n; l.items.push(ln); }
    l.shipments = (l.shipments || []).concat(src.shipments || []);
    if(l.hasPdf){ l.hasPdf = false; await DB.del('pdfs', l.id); }
    for(const r of S.receipts) if((r.matches || []).some(m => m.listId === src.id)){ r.matches.forEach(m => { if(m.listId === src.id) m.listId = l.id; }); await saveReceipt(r); }
    S.lists = S.lists.filter(x => x !== src); await DB.del('lists', src.id); await DB.del('pdfs', src.id);
    await saveList(l);
    S.view.sub = l.id; render();
    toast('Merged ' + src.items.length + ' lines into ' + l.title + ' (now ' + l.items.length + ')');
  };
}

/* ================= settings / backup ================= */
function viewSettings(){
  const L = S.set.label;
  return '<div class="row"><h1>Settings</h1><span class="sp"></span><button class="btn" data-act="goDash">Back</button></div>' +
    '<div class="grid" style="margin-top:12px">' +
    '<div class="card"><h2>Staff initials</h2><p class="muted small">Shown as the tap-to-sign choices.</p><div class="chips" style="margin:8px 0">' +
    S.set.staff.map((s, i) => '<span class="chip">' + esc(s) + ' <button class="btn sm ghost" data-act="staffDel" data-i="' + i + '">✕</button></span>').join('') + '</div>' +
    '<div class="row"><input class="search" id="staffNew" placeholder="e.g. A.B" style="min-width:120px"><button class="btn" data-act="staffAdd">Add</button></div></div>' +
    '<div class="card"><h2>Ship-from addresses</h2><p class="muted small">Offered as the pickup address when building a freight RFQ.</p><div class="chips" style="margin:8px 0">' +
    (S.set.shipFrom || []).map((a, i) => '<span class="chip">' + esc(a) + ' <button class="btn sm ghost" data-act="shipFromDel" data-i="' + i + '">✕</button></span>').join('') + '</div>' +
    '<div class="row"><input class="search" id="shipFromNew" placeholder="e.g. 123 Example Rd, City, ON" style="min-width:220px"><button class="btn" data-act="shipFromAdd">Add</button></div></div>' +
    '<div class="card"><h2>Accounting email</h2><p class="muted small">Shown on each shipment\'s "Send to Accounting" step as the suggested To: address for the product list / BOL / packing slip PDFs.</p>' +
    '<div class="row"><input class="search" id="acctEmail" value="' + esc(S.set.accountingEmail || '') + '" placeholder="accounting@modernelevator.com" style="min-width:220px"><button class="btn" data-act="acctEmailSave">Save</button></div></div>' +
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
  if(d.app !== 'meii-shopfloor') return toast('That file is not a Shop Floor backup (for move app files use Inventory → Import move app file)', true);
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
    const nextSp = pendingShipments(list)[0];
    h += '<h2>' + esc(list.title) + (list.carNo ? ' · CAR ' + esc(list.carNo) : '') + ' · REV ' + esc(list.rev || '') + (nextSp && nextSp.shipDate ? ' · SHIP ' + esc(nextSp.shipDate) + (nextSp.label ? ' (' + esc(nextSp.label) + ')' : '') : '') + ' — ' + pct(ls.pct) + ' (' + ls.done + '/' + ls.total + ')</h2>' +
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
function doPrint(html, orientation){
  const p = $('#print');
  p.className = '';
  p.innerHTML = '<style>@page{size:letter ' + (orientation || 'landscape') + ';margin:.4in}</style>' + html.replace(/<div class="pr-h"><h1>/g, '<div class="pr-h"><h1><img class="pr-logo" src="icons/logo-dark.png" alt="Modern Elevator">');
  setTimeout(() => window.print(), 60);
}
// Which lines belong on a given shipment's packing slip, and how much of
// each. "Checked off" is Packaging + QC sign-off (pkInit/qcInit) - the
// same floor-level gate the paper process already uses before something
// goes on a truck - deliberately NOT the full department stamp set, so a
// line doesn't need every department individually re-ticked here; it
// needs to actually be packed and QC'd for what's shipping today.
//
// A line can ship across more than one shipment (e.g. 3 of 6 pieces now,
// the other 3 once their back order clears), so each line keeps a
// shipHistory[] log ({spId, qty, at}) rather than a single shipped flag.
// "Shippable today" is: the back-order math if a formal back order qty is
// set (qty - boQty), else the packaged qty (pkQty) if that's been entered
// lower than the line qty, else the full line qty. Whatever's shippable
// minus whatever's already been logged on an earlier shipment is what's
// left to show - so a line reappears on a later shipment once more of it
// becomes ready, instead of being excluded forever after its first slip.
//
// Once a slip is first printed for a shipment, the exact lines-and-qtys it
// showed are frozen onto the shipment (sp.psLines) and logged into each
// line's shipHistory - so a reprint always shows the same thing even as
// the live state moves on, and deleting a shipment (see the "del" click
// handler below) rolls its shipHistory entries back out so that quantity
// becomes available to ship again.
function shippedQtyFor(ln){
  return (ln.shipHistory || []).reduce((a, h) => a + (parseFloat(h.qty) || 0), 0);
}
function shippableQtyFor(ln){
  if(!(ln.pkInit && ln.qcInit)) return 0;
  const q = parseFloat(ln.q) || 0, bo = parseFloat(ln.boQty) || 0, pk = parseFloat(ln.pkQty);
  const total = bo > 0 ? Math.max(0, q - bo) : (!isNaN(pk) && pk > 0 && pk < q ? pk : q);
  return Math.max(0, total - shippedQtyFor(ln));
}
function packingSlipItems(l, sp){
  if(sp.psLines){
    const byId = new Map(l.items.map(ln => [ln.id, ln]));
    return sp.psLines.map(e => { const ln = byId.get(e.id); return ln ? Object.assign({}, ln, { _qtyShipped: e.qty, _bo: e.bo }) : null; }).filter(Boolean);
  }
  return l.items.map(ln => {
    const qty = shippableQtyFor(ln);
    return qty > 0 ? Object.assign({}, ln, { _qtyShipped: qty, _bo: ln.boQty || '' }) : null;
  }).filter(Boolean);
}
function markPackingSlipShipped(l, sp, items){
  sp.psLines = items.map(ln => ({ id: ln.id, qty: ln._qtyShipped, bo: ln._bo }));
  const byId = new Map(l.items.map(ln => [ln.id, ln]));
  const ts = nowIso();
  for(const e of items){
    const ln = byId.get(e.id); if(!ln) continue;
    ln.shipHistory = ln.shipHistory || [];
    ln.shipHistory.push({ spId: sp.id, qty: e._qtyShipped, at: ts });
  }
}
// Undoes markPackingSlipShipped for a deleted shipment, so any quantity it
// had logged as shipped becomes available to ship again.
function unmarkPackingSlipShipped(l, sp){
  for(const ln of l.items){
    if(!Array.isArray(ln.shipHistory)) continue;
    ln.shipHistory = ln.shipHistory.filter(h => h.spId !== sp.id);
  }
}
// Builds the packing slip for one shipment (portrait, matching the paper
// MEII packing slip pad) and sends it through the same print-to-PDF flow
// as every other report - "Save as PDF" in the print dialog is how it
// becomes a file to send out. Only lines that are packaged+QC'd and have
// a shippable quantity appear (see packingSlipItems above) - not every
// line on the product list, and not more of a line than is actually ready
// today. Fields the app doesn't capture (Invoice To address detail,
// per-line verification initials, print name/signature) are left blank
// for hand fill, same as the rest of this app's printed paperwork.
function packingSlipHtml(j, l, sp){
  const items = packingSlipItems(l, sp);
  const qtyShipped = ln => ln._qtyShipped != null ? ln._qtyShipped : (ln.q || '');
  return '<section class="ps">' +
    '<div class="ps-top">' +
    '<div class="ps-brand"><img class="ps-logo" src="icons/logo-dark.png" alt=""><div><div class="ps-co">MODERN ELEVATOR</div>' +
    '<div class="ps-addr">1149 Pioneer Road, Burlington, ON L7M 1K5<br>tf: 1-866-448-6667&nbsp;&nbsp;t: 905-523-0040&nbsp;&nbsp;f: 905-523-0096</div></div></div>' +
    '<div class="ps-no"><div class="ps-no-lbl">Packing Slip #:</div><div class="ps-no-val">' + esc(sp.packingSlipNo || '') + '</div></div></div>' +
    '<div class="ps-twobox">' +
    '<div class="ps-box"><div class="ps-boxhead">Invoice To:</div><div class="ps-lines">' + esc(j.customer || '') + '</div></div>' +
    '<div class="ps-box"><div class="ps-boxhead">Ship To:</div><div class="ps-lines">' + esc(j.shipAddr || '').replace(/\n/g, '<br>') + '</div><div class="ps-tel">Tel#: ' + esc(sp.contactPhone || '') + '</div></div>' +
    '</div>' +
    '<table class="ps-info"><tbody><tr><th>CUSTOMER</th><th>PROJECT NAME</th><th>P.O#</th><th>M.E.I.#</th></tr>' +
    '<tr><td>' + esc(j.customer || '') + '</td><td>' + esc(j.jobName || '') + '</td><td>' + esc(sp.poNum || '') + '</td><td>' + esc(j.jobNo || '') + '</td></tr>' +
    '<tr><th>CONTACT</th><th>F.O.B.</th><th>DATE SHIPPED</th><th>SHIP VIA</th></tr>' +
    '<tr><td>' + esc(sp.contactName || j.attn || '') + '</td><td>' + esc(sp.fob || '') + '</td><td>' + esc(sp.shipDate ? fmtDateLong(sp.shipDate) : '') + '</td><td>' + esc(sp.bookedCarrier || '') + '</td></tr></tbody></table>' +
    '<div class="ps-freight"><b>FREIGHT TERMS:</b> ' + esc(sp.freightTerms || '') + '</div>' +
    '<table class="ps-items"><thead><tr><th>Product #</th><th class="c">Qty</th><th>Description</th><th class="c">Qty Shipped</th><th>Verified By</th><th class="c">Qty B.O.</th></tr></thead><tbody>' +
    (items.length ? items.map(ln => '<tr><td class="mono">' + esc(ln.p || '') + '</td><td class="c">' + esc(ln.q || '') + '</td><td>' + esc(ln.d || '') + '</td><td class="c">' + esc(qtyShipped(ln)) + '</td><td></td><td class="c">' + esc(ln._bo || '') + '</td></tr>').join('') :
      '<tr><td colspan="6" class="c">No lines shipping on this slip</td></tr>') +
    '</tbody></table>' +
    '<div class="ps-bottom2"><label class="ps-check">' + (sp.customerPickup ? '☑' : '☐') + ' Customer Pickup</label><div>Print Name:</div><div>Signature:</div></div>' +
    '<div class="ps-special"><div class="ps-boxhead">Special Instruction</div><div>' + esc(sp.specialInstruction || '') + '</div></div>' +
    '<table class="ps-info"><tbody><tr><th>WEIGHT</th><th># of SKIDS</th><th>Shipped by: (Print Name)</th><th>Signature</th></tr>' +
    '<tr><td>' + esc(sp.weightKg ? sp.weightKg + ' kg' : '') + '</td><td>' + esc(sp.skidCount || '') + '</td><td></td><td></td></tr></tbody></table>' +
    '<table class="ps-qa"><tbody><tr><td class="ps-qalabel">QA: Product List</td><td>Verified and Signed, included in attached envelope.</td><td class="c">Yes ☐</td><td class="c">No ☐</td></tr>' +
    '<tr><td class="ps-qalabel">QA: Pictures</td><td>Digital Images have been taken for this Shipment.</td><td class="c">Yes ☐</td><td class="c">No ☐</td></tr></tbody></table>' +
    '<div class="ps-claims"><b>CLAIMS:</b> No claims allowed in regards to quality and quantity unless made within 30 days of receipt of goods. Any claim is limited to the replacement of goods. Title of goods remains with seller until payment received. No goods will be accepted for return without authorization.</div>' +
    '<div class="ps-copies">Accounting (White) &nbsp;&nbsp; Project File (Yellow) &nbsp;&nbsp; Customer (Pink)</div>' +
    '</section>';
}
function printPackingSlip(j, l, sp){
  doPrint(packingSlipHtml(j, l, sp), 'portrait');
}
async function dataUrlToBlob(dataUrl){
  const r = await fetch(dataUrl);
  return r.blob();
}
function pdfFileName(parts){
  return parts.filter(Boolean).join('_').replace(/\s+/g, '_').replace(/[^\w.-]/g, '') + '.pdf';
}
// Builds the three documents accounting needs for a shipment (product
// list, BOL, packing slip) as real PDF files and hands them to the
// tablet's native share sheet so they land pre-attached in whatever mail
// app is picked (Web Share can't address/subject-line an email itself,
// so the To: field still needs a tap - the accounting address from
// Settings is included in the shared text as a reminder). Falls back to
// just downloading the three files when Web Share (or file sharing) isn't
// available on this browser/device.
async function sendToAccounting(j, l, sp){
  toast('Building PDFs…');
  try{
    const items = packingSlipItems(l, sp);
    const slipBytes = await PdfExport.buildPackingSlip(j, l, sp, items);
    const files = [
      new File([await (async () => {
        const rec = l.hasPdf ? await DB.get('pdfs', l.id) : null;
        const srcBytes = rec ? new Uint8Array(await rec.bytes.arrayBuffer()) : null;
        return (await PdfExport.build(j, l, srcBytes)).bytes;
      })()], pdfFileName([j.jobNo, l.title || 'LIST', l.carNo]), { type: 'application/pdf' }),
      new File([slipBytes], pdfFileName([j.jobNo, 'PACKING_SLIP', sp.packingSlipNo]), { type: 'application/pdf' })
    ];
    if(sp.bolFile && sp.bolFile.dataUrl){
      const blob = await dataUrlToBlob(sp.bolFile.dataUrl);
      files.splice(1, 0, new File([blob], sp.bolFile.name || 'BOL.pdf', { type: sp.bolFile.type || blob.type || 'application/pdf' }));
    }
    const subject = 'Shipment paperwork - ' + j.jobNo + (sp.label ? ' (' + sp.label + ')' : '') + ' - Packing Slip #' + (sp.packingSlipNo || '');
    const body = subject + '\n\nProduct list' + (sp.bolFile ? ', BOL' : ' (no BOL on file)') + ' and packing slip attached for ' + j.jobNo + ' - ' + (j.jobName || '') +
      (S.set.accountingEmail ? '\n\nTo: ' + S.set.accountingEmail : '');
    if(navigator.canShare && navigator.canShare({ files })){
      await navigator.share({ title: subject, text: body, files });
      toast('Share sheet opened - pick Mail, fill in To:, and send');
    } else {
      for(const f of files) download(f, f.name);
      toast('Sharing attachments isn’t supported on this browser - PDFs downloaded instead' + (S.set.accountingEmail ? '; attach them to an email to ' + S.set.accountingEmail : ''), true);
    }
  }catch(e){
    toast('Could not prepare the PDFs: ' + e.message, true);
  }
}
// A short, purchasing-ready page (via the same print-to-PDF flow as every
// other report in this app) for one laser cut list's sheet stock: just the
// sheet types actually short, with a qty to order, plus the full
// requirement detail underneath for reference. Each row's sheet size is
// whichever standard size that material/thickness is currently best
// matched to (see pickSheetSizeFor) - not a single size for the whole list.
function printSheetOrder(list){
  const j = job(list.jobId);
  const rows = computeSheetGroups(list.items).filter(g => g.sheetsNeeded > 0).map(g => {
    const pulled = ((list.sheetPulls || {})[g.key + '|' + g.sheetSize] || {}).totalPulled || 0;
    return { ...g, pulled, short: Math.max(0, g.sheetsNeeded - pulled) };
  });
  const toOrder = rows.filter(g => g.short > 0);
  let h = '<section><div class="pr-h"><h1>MEII Shop Floor — Material order list</h1><span>' + esc(new Date().toLocaleString()) + '</span></div>' +
    '<p>' + esc((j ? j.jobNo + (j.jobName ? ' — ' + j.jobName : '') : 'Job not found') + ' · ' + (list.title || 'LASER CUT LIST')) + ' · sheet size picked automatically per material, based on current stock</p>' +
    '<table><thead><tr><th>Material</th><th class="c">Thickness (in)</th><th class="c">Sheet size</th><th class="c">Qty to order</th></tr></thead><tbody>' +
    (toOrder.length ? toOrder.map(g => '<tr><td>' + esc(g.material || '—') + '</td><td class="c">' + g.thick.toFixed(3) + '</td><td class="c">' + esc(sheetSizeInfo(g.sheetSize).label) + '</td><td class="c"><b>' + g.short + '</b></td></tr>').join('') :
      '<tr><td colspan="4">Nothing to order - stock covers every sheet type on this list.</td></tr>') +
    '</tbody></table>' +
    (rows.length ? '<h2 style="margin-top:20px">Full requirement detail</h2><table><thead><tr><th>Material</th><th class="c">Thickness (in)</th><th class="c">Sheet size</th><th class="c">Sheets needed</th><th class="c">Pulled from stock</th><th class="c">Short</th></tr></thead><tbody>' +
      rows.map(g => '<tr><td>' + esc(g.material || '—') + '</td><td class="c">' + g.thick.toFixed(3) + '</td><td class="c">' + esc(sheetSizeInfo(g.sheetSize).label) + '</td><td class="c">' + g.sheetsNeeded + '</td><td class="c">' + g.pulled + '</td><td class="c">' + g.short + '</td></tr>').join('') +
      '</tbody></table>' : '') +
    '</section>';
  doPrint(h);
}
function printAll(detail){
  const { scheduled, unscheduled } = sortedJobRows(S.jobs.filter(j => j.status !== 'closed'));
  const jobs = [...scheduled, ...unscheduled];
  const sortNote = S.ui.dashSort === 'ship' ? 'next to ship first, unscheduled jobs last' : 'closest to completion first';
  let h = '<section><div class="pr-h"><h1>MEII Shop Floor — Job status report</h1><span>' + esc(new Date().toLocaleString()) + '</span></div>' +
    '<p>Active jobs, ' + sortNote + '. A line is done when all five departments and QC are signed and nothing is on back order.</p>' +
    '<table><thead><tr><th>#</th><th>Job #</th><th>Job name</th><th>Customer</th><th>Next ship</th><th>Lists</th><th class="c">Lines</th><th class="c">Done</th><th class="c">% done</th><th class="c">In progress</th><th class="c">B/O lines</th><th class="c">B/O pcs</th><th class="c">Received</th><th class="c">Unmatched</th><th>Last activity</th></tr></thead><tbody>' +
    jobs.map(({ j, s, ship }, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(j.jobNo) + '</td><td>' + esc(j.jobName || '') + '</td><td>' + esc(j.customer || '') + '</td><td>' + esc(ship || '—') + '</td><td>' + esc(s.lists.map(x => (x.list.groupKey === 'X' ? x.list.title : x.list.groupKey) + (x.list.carNo ? '/' + x.list.carNo : '') + ' ' + pct(x.s.pct)).join(', ')) + '</td>' +
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

/* ---- shipping: ship date, weight/skids, carrier RFQ, booked info ----
   A list can go out in more than one shipment (most lines now, whatever's on
   back order later, once it's in) so each list holds shipments[], and every
   shipment carries its own date/weight/skids/carrier/RFQ log/booked info. */
// Pure: builds the mailto: URL for one shipment. Kept separate from
// sendRfq's side effects (logging, saving, navigating) so it's easy to test
// and to tweak the wording without touching anything stateful.
// A plain "Hi," read cold to a carrier dispatcher - a time-of-day greeting
// reads like it came from a person, not a form letter.
function timeGreeting(){
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
function rfqMailto(l, j, sp, email){
  const autoSkid = new Set(l.items.map(x => (x.skid || '').trim()).filter(Boolean)).size;
  const skids = sp.skidCount || autoSkid;
  const subject = 'Freight RFQ - ' + j.jobNo + (l.carNo ? ' CAR ' + l.carNo : (l.title ? ' ' + l.title : '')) + (sp.label ? ' - ' + sp.label : '') + (sp.shipDate ? ' - ship ' + sp.shipDate : '');
  const body = [
    timeGreeting() + ',', '',
    'Could you please quote freight for the following shipment:', '',
    'Pickup: ' + (sp.shipFrom || '—'),
    'Delivery: ' + (j.shipAddr || '—').replace(/\n/g, ', '),
    'Ready to ship: ' + (fmtDateLong(sp.shipDate) || 'TBD'),
    'Skids: ' + (skids || 'TBD'),
    'Weight: ' + (sp.weightKg ? sp.weightKg + ' kg' : 'TBD'),
    'Site contact: ' + (sp.contactName || j.attn || '—') + (sp.contactPhone ? ' · ' + sp.contactPhone : ''),
    'Reference: ' + j.jobNo + (l.carNo ? ' / CAR ' + l.carNo : '') + (sp.label ? ' / ' + sp.label : ''),
    '', 'Please confirm rate and transit time at your earliest convenience.', '', 'Thank you,'
  ].join('\r\n');
  return 'mailto:' + email.trim() + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}
async function sendRfq(l, j, sp, email){
  const url = rfqMailto(l, j, sp, email);
  sp.rfqLog = sp.rfqLog || [];
  sp.rfqLog.push({ id: uid(), at: nowIso(), email });
  sp.lastRfqEmail = email;
  await saveList(l);
  closeSheet();
  toast('Opening email to ' + email);
  window.location.href = url;
}
function listShip(){
  const l = curList(), j = job(l.jobId);
  l.shipments = l.shipments || [];
  // The common case (one shipment) jumps straight to the form, same feel as
  // before; a second+ shipment (e.g. the B/O follow-up) goes through the
  // overview so existing shipments are never edited by accident.
  if(!l.shipments.length){
    const sp = newShipment();
    l.shipments.push(sp);
    editShipment(l, j, sp);
  } else drawShipList(l, j);
}
function drawShipList(l, j){
  const rows = l.shipments.slice().sort((a, b) => (a.shipDate || '9999-99-99').localeCompare(b.shipDate || '9999-99-99'));
  openSheet('<h2>Shipments — ' + esc(l.title || 'PRODUCT LIST') + (l.carNo ? ' · CAR ' + esc(l.carNo) : '') + '</h2>' +
    '<p class="muted small">A list can ship in more than one load — add another when part of it (like a back order) goes out separately.</p>' +
    '<div class="opts">' + rows.map(sp => {
      const badge = sp.shippedAt ? '<span class="tag ok">Shipped</span>' : (sp.shipDate ? shipBadge(sp.shipDate) : '<span class="tag">No date</span>');
      return '<button class="opt" data-sp="' + sp.id + '"><span><b>' + esc(sp.label || 'Shipment') + '</b>' + (sp.shipDate ? ' · ' + esc(fmtDateLong(sp.shipDate)) : '') + (sp.bookedCarrier ? ' · ' + esc(sp.bookedCarrier) : '') + '</span><span class="sc">' + badge + '</span></button>';
    }).join('') + '</div>' +
    '<div class="row" style="margin-top:10px"><span class="sp"></span><button class="btn" data-sp="__new">+ Add shipment</button><button class="btn" data-sp="__x">Close</button></div>');
  $('#sheet').onclick = e => {
    const b = e.target.closest('[data-sp]'); if(!b) return;
    if(b.dataset.sp === '__x') return closeSheet();
    if(b.dataset.sp === '__new'){ const sp = newShipment(); l.shipments.push(sp); editShipment(l, j, sp); return; }
    const sp = l.shipments.find(x => x.id === b.dataset.sp);
    if(sp) editShipment(l, j, sp);
  };
}
function editShipment(l, j, sp){
  sp.rfqLog = sp.rfqLog || [];
  const autoSkid = new Set(l.items.map(x => (x.skid || '').trim()).filter(Boolean)).size;
  openSheet('<h2>' + esc(sp.label || 'Shipment') + ' — ' + esc(l.title || 'PRODUCT LIST') + (l.carNo ? ' · CAR ' + esc(l.carNo) : '') + '</h2>' +
    '<div class="form" id="shf">' +
    '<label>Label (optional)<input data-sf="label" value="' + esc(sp.label || '') + '" placeholder="e.g. Main shipment, B/O follow-up"></label>' +
    '<div class="two"><label>Ship date<input type="date" data-sf="shipDate" value="' + esc(sp.shipDate || '') + '"></label>' +
    '<label>Weight (kg)<input data-sf="weightKg" inputmode="decimal" value="' + esc(sp.weightKg || '') + '"></label></div>' +
    '<div class="two"><label>Skid count' + (autoSkid ? ' <span class="muted small">(suggest ' + autoSkid + ' from skid #s logged)</span>' : '') +
    '<input data-sf="skidCount" inputmode="numeric" value="' + esc(sp.skidCount || '') + '" placeholder="' + (autoSkid || '') + '"></label>' +
    '<label>Ship from<select data-sf="shipFrom"><option value="">—</option>' + S.set.shipFrom.map(a => '<option' + (sp.shipFrom === a ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select></label></div>' +
    '<div class="two"><label>Site contact name<input data-sf="contactName" list="dlContacts" autocomplete="off" value="' + esc(sp.contactName || '') + '" placeholder="' + esc(j.attn || '') + '"></label>' +
    '<label>Site contact phone<input data-sf="contactPhone" value="' + esc(sp.contactPhone || '') + '"></label></div>' +
    '<datalist id="dlContacts">' + (S.set.contacts || []).map(c => '<option value="' + esc(c.name) + '">').join('') + '</datalist></div>' +
    '<h3 class="small muted" style="margin-top:14px">BOOKED</h3><div class="form">' +
    '<div class="two"><label>Carrier<input data-sf="bookedCarrier" value="' + esc(sp.bookedCarrier || '') + '"></label>' +
    '<label>Rate ($ CAD)<input data-sf="bookedRate" inputmode="decimal" value="' + esc(sp.bookedRate || '') + '"></label></div>' +
    '<label>BOL / PRO #<input data-sf="bookedBol" value="' + esc(sp.bookedBol || '') + '"></label></div>' +
    '<h3 class="small muted" style="margin-top:14px">BILL OF LADING</h3>' +
    (sp.bolFile ?
      '<div class="row" style="align-items:center;flex-wrap:wrap;gap:8px"><span class="small">' + esc(sp.bolFile.name) + ' · ' + fmtBytes(sp.bolFile.size) + '</span><span class="sp"></span>' +
      '<a class="btn sm" href="' + sp.bolFile.dataUrl + '" target="_blank" rel="noopener" download="' + esc(sp.bolFile.name) + '">View</a>' +
      '<button class="btn sm danger" data-g="bolDel">Remove</button></div>'
      : '<div class="row"><button class="btn" data-g="bol">Attach BOL (photo or PDF)</button></div>') +
    '<h3 class="small muted" style="margin-top:14px">PACKING SLIP' + (sp.packingSlipNo ? ' <span class="mono">#' + esc(sp.packingSlipNo) + '</span>' : '') + '</h3><div class="form">' +
    '<div class="two"><label>P.O. #<input data-sf="poNum" value="' + esc(sp.poNum || '') + '"></label>' +
    '<label>F.O.B.<input data-sf="fob" value="' + esc(sp.fob || '') + '"></label></div>' +
    '<label>Freight terms<input data-sf="freightTerms" value="' + esc(sp.freightTerms || '') + '"></label>' +
    '<label>Special instruction<textarea data-sf="specialInstruction" placeholder="e.g. Refer to product list for detail">' + esc(sp.specialInstruction || '') + '</textarea></label>' +
    '<label class="chip" style="cursor:pointer;width:fit-content"><input type="checkbox" id="spPickup"' + (sp.customerPickup ? ' checked' : '') + '> Customer pickup</label></div>' +
    '<div class="row" style="margin-top:4px"><span class="sp"></span><button class="btn" data-g="packSlip">Print packing slip (PDF)</button></div>' +
    '<h3 class="small muted" style="margin-top:14px">SEND TO ACCOUNTING</h3>' +
    '<p class="small muted">Builds the product list, BOL and packing slip as PDFs and hands them to your tablet\'s share sheet, ready to attach to an email' +
    (S.set.accountingEmail ? ' to <b>' + esc(S.set.accountingEmail) + '</b>' : '') + ' — pick Mail/Gmail and fill in the To: field, everything else is ready.' +
    (S.set.accountingEmail ? '' : ' <a href="javascript:void 0" data-g="goAcctSet">Set the accounting address</a> in Settings.') + '</p>' +
    '<div class="row"><span class="sp"></span><button class="btn dark" data-g="sendAcct">Send to Accounting</button></div>' +
    '<h3 class="small muted" style="margin-top:14px">REQUEST A QUOTE</h3><div class="form">' +
    '<label>Carrier email<input id="rfqEmail" value="' + esc(sp.lastRfqEmail || '') + '" placeholder="dispatch@carrier.com" autocomplete="off"></label></div>' +
    '<div class="row" style="margin-top:4px"><span class="sp"></span><button class="btn" data-g="rfq">Email RFQ</button></div>' +
    (sp.rfqLog.length ? '<h3 class="small muted" style="margin-top:14px">RFQ LOG</h3><div class="opts">' +
      sp.rfqLog.slice().sort((a, b) => (b.at || '').localeCompare(a.at || '')).map(x => '<div class="opt" style="cursor:default"><span>' + esc(x.email) + '<br><span class="small muted">' + esc(when(x.at)) + '</span></span></div>').join('') + '</div>' : '') +
    '<div class="row" style="margin-top:14px"><label class="chip" style="cursor:pointer"><input type="checkbox" id="spShipped"' + (sp.shippedAt ? ' checked' : '') + '> Mark this shipment as shipped</label></div>' +
    '<div class="row" style="margin-top:12px"><button class="btn danger" data-g="del">Delete shipment</button><span class="sp"></span><button class="btn" data-g="back">Back</button><button class="btn dark" data-g="s">Save</button></div>');
  const cnEl = document.querySelector('#sheet [data-sf="contactName"]');
  if(cnEl) cnEl.addEventListener('input', () => {
    const match = (S.set.contacts || []).find(c => c.name.toLowerCase() === cnEl.value.trim().toLowerCase());
    const phEl = document.querySelector('#sheet [data-sf="contactPhone"]');
    if(match && match.phone && phEl && !phEl.value) phEl.value = match.phone;
  });
  $('#sheet').onclick = async e => {
    const b = e.target.closest('[data-g]'); if(!b) return;
    const collect = () => {
      document.querySelectorAll('#sheet [data-sf]').forEach(i => sp[i.dataset.sf] = i.value.trim());
      const pickupEl = $('#spPickup'); if(pickupEl) sp.customerPickup = pickupEl.checked;
      rememberContact(sp.contactName, sp.contactPhone);
    };
    if(b.dataset.g === 's'){
      collect();
      sp.shippedAt = $('#spShipped').checked ? (sp.shippedAt || nowIso()) : null;
      await saveList(l); closeSheet(); render(); toast('Saved');
    } else if(b.dataset.g === 'back'){ drawShipList(l, j); }
    else if(b.dataset.g === 'del'){
      if(!(await confirmSheet('Delete this shipment?', 'Its RFQ log and booked info are lost.', 'Delete', true))) return;
      unmarkPackingSlipShipped(l, sp);
      l.shipments = l.shipments.filter(x => x !== sp);
      await saveList(l);
      if(l.shipments.length) drawShipList(l, j); else { closeSheet(); render(); }
    } else if(b.dataset.g === 'goAcctSet'){
      collect(); await saveList(l); closeSheet(); go({ name: 'settings' });
    } else if(b.dataset.g === 'rfq'){
      collect();
      const email = ($('#rfqEmail').value || '').trim();
      if(!email) return toast('Enter a carrier email first', true);
      await sendRfq(l, j, sp, email);
      editShipment(l, j, sp);
    } else if(b.dataset.g === 'bol'){
      collect();
      BOL_TARGET = { l, j, sp };
      $('#fileBol').value = '';
      $('#fileBol').click();
    } else if(b.dataset.g === 'bolDel'){
      collect();
      sp.bolFile = null;
      await saveList(l);
      editShipment(l, j, sp);
    } else if(b.dataset.g === 'packSlip'){
      collect();
      if(!sp.packingSlipNo){
        sp.packingSlipNo = nextPackingSlipNo();
        markPackingSlipShipped(l, sp, packingSlipItems(l, sp));
      }
      await saveList(l);
      printPackingSlip(j, l, sp);
      editShipment(l, j, sp);
    } else if(b.dataset.g === 'sendAcct'){
      collect();
      if(!sp.packingSlipNo){
        sp.packingSlipNo = nextPackingSlipNo();
        markPackingSlipShipped(l, sp, packingSlipItems(l, sp));
      }
      await saveList(l);
      await sendToAccounting(j, l, sp);
      editShipment(l, j, sp);
    }
  };
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
        if(!(await confirmSheet('Delete job ' + j.jobNo + '?', 'Deletes its product lists and sign-offs. Received material stays in Inventory (unmatched).', 'Delete job', true))) return;
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
  setRole: b => { S.set.role = b.dataset.k; saveSet('role'); go({ name: 'dash' }); },
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
  dashSort: b => { S.ui.dashSort = b.dataset.k; render(); },
  sub: b => { S.view.sub = b.dataset.k; closeDrawer(); render(); },
  lfilter: b => { S.ui.listFilter[S.view.sub] = b.dataset.k; render(); },
  importList: b => { IMP_TARGET = { jobId: b.dataset.job, listId: b.dataset.list, append: !!b.dataset.append }; $('#fileList').value = ''; $('#fileList').click(); },
  mergeList: () => mergeListSheet(),
  stickerSave: async () => {
    const j = job(S.view.jobId), v = ($('#stickerNo').value || '').trim();
    if(v && !/^\d{1,3}$/.test(v)) return toast('Enter the sticker number, e.g. 4', true);
    j.stickerNo = v; await saveJob(j); render(); toast(v ? 'Sticker # ' + v + ' saved' : 'Sticker # cleared');
  },
  stickerPick: async b => { const j = job(S.view.jobId); j.stickerNo = b.dataset.n; await saveJob(j); render(); },
  stickerClear: async () => { const j = job(S.view.jobId); j.stickerNo = ''; await saveJob(j); render(); },
  skidPrint: b => printSkidTags([b.dataset.no]),
  skidPrintAll: () => printSkidTags(jobSkids(job(S.view.jobId)).map(s => s.no)),
  uploadLaser: b => { LASER_TARGET = { jobId: b.dataset.job, listId: b.dataset.list }; $('#fileLaser').value = ''; $('#fileLaser').click(); },
  pullSheets: async b => { const l = S.lists.find(x => x.id === b.dataset.list); if(l) await pullSheetsFromStock(l); render(); },
  printSheetOrder: b => { const l = S.lists.find(x => x.id === b.dataset.list); if(l) printSheetOrder(l); },
  laserPick: b => { const l = S.lists.find(x => x.id === S.view.sub && x.kind === 'laser'); if(l) pickLaserSign(l, l.items.find(x => x.id === b.dataset.l)); },
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
    if(!(await confirmSheet('Delete ' + l.title + '?', 'All sign-offs on this list are lost. Received material stays in Inventory.', 'Delete list', true))) return;
    S.lists = S.lists.filter(x => x !== l); await DB.del('lists', l.id); await DB.del('pdfs', l.id);
    for(const r of S.receipts) if((r.matches || []).some(m => m.listId === l.id)){ r.matches = r.matches.filter(m => m.listId !== l.id); await saveReceipt(r); }
    S.view.sub = null; render();
  },
  listShip: () => listShip(),
  jobShipments: b => openJobShipments(job(b.dataset.id)),
  listInfo: () => {
    const l = curList(); l.sig = l.sig || {}; l.orderType = l.orderType || {};
    openSheet('<h2>Signatures &amp; order type</h2><div class="form" id="sigf"><div class="chips">' + ['warranty', 'chargeable', 'rma', 'stock'].map(k => '<label class="chip"><input type="checkbox" data-ot="' + k + '"' + (l.orderType[k] ? ' checked' : '') + '> ' + k.toUpperCase() + '</label>').join('') + '</div>' +
      '<div class="two"><label>Shipping manager<input data-sg="shipMgr" value="' + esc(l.sig.shipMgr || '') + '"></label><label>Date<input type="date" data-sg="shipDate" value="' + esc(l.sig.shipDate || '') + '"></label></div>' +
      '<div class="two"><label>Quality manager<input data-sg="qcMgr" value="' + esc(l.sig.qcMgr || '') + '"></label><label>Date<input type="date" data-sg="qcDate" value="' + esc(l.sig.qcDate || '') + '"></label></div></div>' +
      '<div class="row" style="margin-top:12px"><span class="sp"></span><button class="btn" data-g="x">Cancel</button><button class="btn dark" data-g="s">Save</button></div>');
    $('#sheet').onclick = async e => {
      const b = e.target.closest('[data-g]'); if(!b) return;
      if(b.dataset.g === 's'){
        document.querySelectorAll('#sigf [data-ot]').forEach(i => l.orderType[i.dataset.ot] = i.checked);
        document.querySelectorAll('#sigf [data-sg]').forEach(i => l.sig[i.dataset.sg] = i.value);
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
  recvView: b => { S.ui.recvView = b.dataset.k; render(); },
  stockGroup: b => stockGroupDetail(+b.dataset.i),
  takeStockGroup: b => takeStockGroupSheet(+b.dataset.i),
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
  shipFromAdd: () => { const v = $('#shipFromNew').value.trim(); if(!v) return; S.set.shipFrom = S.set.shipFrom || []; if(!S.set.shipFrom.includes(v)) S.set.shipFrom.push(v); saveSet('shipFrom'); render(); },
  shipFromDel: b => { S.set.shipFrom.splice(+b.dataset.i, 1); saveSet('shipFrom'); render(); },
  acctEmailSave: () => { S.set.accountingEmail = ($('#acctEmail').value || '').trim(); saveSet('accountingEmail'); toast('Saved'); },
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
let LASER_TARGET = null;
let BOL_TARGET = null;
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
  if(t.id === 'recvUom'){
    S.ui.recvUomSheet = t.value === 'SHEET';
    keepForm(render);
  } else if(t.dataset.lf){
    const l = curList(); const ln = l && l.items.find(x => x.id === t.dataset.l); if(!ln) return;
    const k = t.dataset.lf, v = t.value.trim();
    if(k === 'pkQty') setPkQty(ln, v);
    else if(k === 'boQty'){ ln.boQty = v; if(+v > 0 && !ln.boTs) ln.boTs = nowIso(); }
    else ln[k] = k === 'skid' ? v.toUpperCase() : v;
    await saveList(l);
    setTimeout(() => refreshRow(l, ln.id), 40);
  } else if(t.dataset.sk){
    const j = job(S.view.jobId); if(!j) return;
    skidRecWrite(j, t.dataset.no)[t.dataset.sk] = t.value.trim(); await saveJob(j);
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
$('#fileLaser').addEventListener('change', e => {
  const f = e.target.files[0]; if(!f) return;
  const t = LASER_TARGET || {}; LASER_TARGET = null;
  importLaserList(f, t);
});
$('#fileMove').addEventListener('change', e => { const f = e.target.files[0]; if(f) importMove(f); });
$('#fileBackup').addEventListener('change', e => { const f = e.target.files[0]; if(f) backupImport(f); });
$('#fileBol').addEventListener('change', async e => {
  const f = e.target.files[0]; const t = BOL_TARGET; BOL_TARGET = null;
  if(!f || !t) return;
  if(f.size > 10 * 1024 * 1024) return toast('That file is too large (max 10 MB)', true);
  let dataUrl;
  try{ dataUrl = await readAsDataUrl(f); }catch(err){ return toast('Could not read that file', true); }
  t.sp.bolFile = { name: f.name, type: f.type || '', size: f.size, dataUrl, addedAt: nowIso() };
  await saveList(t.l);
  toast('BOL attached');
  editShipment(t.l, t.j, t.sp);
});
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
