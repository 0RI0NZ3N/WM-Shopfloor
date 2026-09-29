/* Reads the move app's "Print / Save PDF list" export (Export PDF button) so
   receiving items can be pulled in straight from that PDF when the JSON
   backup isn't practical to get off the tablet. That PDF is plain browser-
   printed HTML (a real text layer, not a scan), grouped as:
     Jobs
       Job <job #>
         [optional group sub-heading, all-caps]
         table: Description | Qty | Boxes | Bin | By | Captured | Status
     Stock
       [same table shape]
   Every row prints as separate text fragments in a fixed left-to-right
   column order, so columns are found the same way parse.js finds them for
   product lists: by column-header x position, then nearest-column lookup
   for each data token. */
const MoveParse = (() => {
  let pdfjs = null;
  async function lib(){
    if(!pdfjs){
      pdfjs = await import('./vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
    }
    return pdfjs;
  }

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const HEADERS = [
    ['description', /^DESCRIPTION$/i], ['qty', /^QTY$/i], ['boxes', /^BOXES$/i],
    ['bin', /^BIN$/i], ['by', /^BY$/i], ['captured', /^CAPTURED$/i], ['status', /^STATUS$/i]
  ];

  function itemsByLine(tcItems){
    const flat = tcItems.filter(i => i.str && i.str.trim()).map(i => {
      const [a, b, c, d, e, f] = i.transform;
      return { s: norm(i.str), x: e, y: f, w: i.width };
    });
    // group into lines: same y (within a small tolerance), keep original PDF
    // top-to-bottom order (descending y)
    const lines = [];
    for(const it of flat.sort((p, q) => q.y - p.y || p.x - q.x)){
      const last = lines[lines.length - 1];
      if(last && Math.abs(last.y - it.y) < 2) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    return lines.map(l => ({ y: l.y, items: l.items.sort((a, b) => a.x - b.x) }));
  }

  function buildCols(headerItems){
    const cols = [];
    for(const it of headerItems){
      const h = HEADERS.find(([, re]) => re.test(it.s));
      if(h) cols.push({ key: h[0], xc: it.x + it.w / 2 });
    }
    cols.sort((a, b) => a.xc - b.xc);
    for(let k = 0; k < cols.length; k++){
      const prev = cols[k - 1], next = cols[k + 1];
      cols[k].l = prev ? (prev.xc + cols[k].xc) / 2 : -Infinity;
      cols[k].r = next ? (cols[k].xc + next.xc) / 2 : Infinity;
    }
    return cols;
  }
  function nearestCol(cols, xc){
    return cols.find(c => xc >= c.l && xc < c.r) || null;
  }

  const isHeaderLine = line => line.items.some(it => /^DESCRIPTION$/i.test(it.s)) && line.items.some(it => /^QTY$/i.test(it.s));
  const hasAnyCol = rec => rec.qty || rec.boxes || rec.bin || rec.by || rec.captured || rec.status;

  // A long description wraps onto extra lines inside its table cell, and
  // each of those continuation lines prints as a single lone text fragment —
  // exactly what a group sub-heading (e.g. "ENT") also looks like. A group
  // heading is told apart by what immediately follows it (its own header
  // row); a wrap continuation is not.
  //
  // Browsers vertically CENTER a table cell's content by default. For an ODD
  // number of wrapped lines, the row's other cells (qty/bin/etc) line up
  // with the middle description line, so that anchor still carries real
  // description text. For an EVEN number of wrapped lines there's no single
  // middle line, so the other cells render on a virtual line that falls
  // exactly between two description lines and carries no description text
  // of its own — an anchor with data but an empty description is therefore
  // unambiguous proof that the lone lines immediately touching it are its
  // own wrap, regardless of which side of it they fall on. Those get
  // claimed first, symmetrically outward. Whatever lone lines are left over
  // (only possible with an odd-length wrap sitting next to another row that
  // already has its own text) are attached to whichever anchor is
  // geometrically closer — a best effort, since nothing in the text layer
  // can fully disambiguate that case.
  function resolveContinuations(nodes){
    // Phase 1: anchors with data but no description text of their own claim
    // their immediately adjacent lone lines first (unambiguous case).
    for(let i = 0; i < nodes.length; i++){
      const n = nodes[i];
      if(n.kind !== 'anchor' || n.rec.description || !hasAnyCol(n.rec)) continue;
      const before = [];
      for(let j = i - 1; j >= 0 && nodes[j].kind === 'lone' && !nodes[j].claimed; j--) before.unshift(nodes[j]);
      const after = [];
      for(let j = i + 1; j < nodes.length && nodes[j].kind === 'lone' && !nodes[j].claimed; j++) after.push(nodes[j]);
      for(const b of before) b.claimed = true;
      for(const a of after) a.claimed = true;
      n.rec.description = [...before, ...after].map(x => x.text).join(' ');
    }
    // Phase 2: leftover lone lines (odd-length wraps beside a row that
    // already has text) go to whichever anchor is geometrically closer.
    const anchors = nodes.filter(n => n.kind === 'anchor');
    for(let i = 0; i < nodes.length; i++){
      const n = nodes[i];
      if(n.kind !== 'lone' || n.claimed) continue;
      const prev = [...anchors].reverse().find(a => a.y > n.y);
      const next = anchors.find(a => a.y < n.y);
      const target = prev && next ? ((prev.y - n.y) <= (n.y - next.y) ? prev : next) : (prev || next);
      if(target) (target.pending = target.pending || []).push(n);
    }
    for(const a of anchors){
      if(!a.pending || !a.pending.length) continue;
      const before = a.pending.filter(p => p.y > a.y).sort((x, y) => y.y - x.y).map(p => p.text);
      const after = a.pending.filter(p => p.y < a.y).sort((x, y) => y.y - x.y).map(p => p.text);
      a.rec.description = [...before, a.rec.description, ...after].filter(Boolean).join(' ');
    }
    return nodes.filter(n => n.kind === 'anchor' && (n.rec.description || hasAnyCol(n.rec))).map(n => n.rec);
  }

  // Parses the full text layer (all pages already concatenated, in reading
  // order) into rows shaped like the move app's own item records.
  function parseLines(lines){
    const rows = [];
    let jobNo = '', type = 'job', cols = null, group = '', started = false;
    let spanNodes = [];
    const flushSpan = () => { rows.push(...resolveContinuations(spanNodes)); spanNodes = []; };

    for(let i = 0; i < lines.length; i++){
      const line = lines[i];
      const only = line.items.length === 1 ? line.items[0].s : null;
      if(only === 'Jobs') continue;
      if(only === 'Stock'){ flushSpan(); type = 'stock'; jobNo = ''; group = ''; cols = null; started = true; continue; }
      const jobM = only && only.match(/^Job\s+(.+)$/);
      if(jobM){ flushSpan(); type = 'job'; jobNo = jobM[1].trim().toUpperCase(); group = ''; cols = null; started = true; continue; }
      if(isHeaderLine(line)){ flushSpan(); cols = buildCols(line.items); continue; }
      if(only && !started) continue; // stray text (title/meta) before the first Job/Stock section
      if(only){
        const next = lines[i + 1];
        if(next && isHeaderLine(next)){ group = only; continue; } // a fresh group sub-heading
        spanNodes.push({ kind: 'lone', text: only, y: line.y }); // wrap fragment - resolved once the span ends
        continue;
      }
      if(!cols) continue; // shouldn't happen, but don't misfile a row with no known columns
      const rec = { description: '', qty: '', boxes: '', bin: '', by: '', captured: '', status: '' };
      for(const it of line.items){
        const c = nearestCol(cols, it.x + it.w / 2);
        if(!c) continue;
        rec[c.key] = rec[c.key] ? rec[c.key] + ' ' + it.s : it.s;
      }
      if(!rec.description && !hasAnyCol(rec)) continue; // a genuinely blank line
      spanNodes.push({ kind: 'anchor', y: line.y, rec: { jobNo, type, group, ...rec } });
    }
    flushSpan();
    return rows;
  }

  // "09/25/2026 08:15" (as printed by the move app's own fmtDate) -> ISO
  function toIso(captured){
    const m = String(captured || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if(!m) return null;
    const [, mo, d, y, h, mi] = m;
    const dt = new Date(+y, +mo - 1, +d, +h, +mi);
    return isNaN(dt) ? null : dt.toISOString();
  }

  async function parse(bytes){
    const pj = await lib();
    const doc = await pj.getDocument({ data: bytes }).promise;
    let lines = [];
    for(let p = 1; p <= doc.numPages; p++){
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      lines = lines.concat(itemsByLine(tc.items));
    }
    return parseLines(lines).map(r => ({
      jobNo: r.jobNo, type: r.type, group: r.group,
      description: r.description, qty: r.qty, boxes: r.boxes, bin: r.bin,
      by: r.by, capturedIso: toIso(r.captured), capturedRaw: r.captured, status: r.status
    }));
  }

  return { parse };
})();
