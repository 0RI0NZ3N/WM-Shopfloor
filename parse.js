/* Product list PDF reader.
   1. Text layer (Excel-printed PDFs from the ERP): exact values and exact cell
      positions, no OCR. This is the normal path.
   2. OCR fallback (ocr.js) for scans and photos with no text layer.
   Also reads values already filled in on the right-hand columns (Packaging,
   QC, Back Orders) - either typed text or PDF form fields - so a filled PDF
   exported from this app, edited on a phone, can be fed back in. */
const Parse = (() => {
  let pdfjs = null;
  async function lib(){
    if(!pdfjs){
      pdfjs = await import('./vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
    }
    return pdfjs;
  }

  const RIGHT_COLS = [
    ['pkQty', /^qty$/i], ['pkInit', /^init\.?$/i], ['qcInit', /^init\.?$/i],
    ['skid', /^skid/i], ['boxId', /^box/i], ['boQty', /^b\/?o$/i],
    ['boInit', /^init\.?$/i], ['boDate', /^date$/i]
  ];

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

  function textItems(tc){
    return tc.items.filter(i => i.str && i.str.trim()).map(i => {
      const [a, b, c, d, e, f] = i.transform;
      const rot = Math.abs(b) > Math.abs(a);
      const h = rot ? Math.abs(b) : Math.abs(d);
      const w = i.width;
      return {
        s: norm(i.str), x: e, y: f, w, h, rot,
        x1: rot ? e : e + w,
        xc: rot ? e : e + w / 2,
        yc: rot ? f + w / 2 : f + h * 0.35
      };
    });
  }

  /* ---------- text-layer page ---------- */
  function parseTextPage(items, pageH){
    const flat = items.filter(i => !i.rot);
    const partH = flat.find(i => /^PART\s*#?$/i.test(i.s));
    const qtyH = partH && flat.find(i => i.s === 'QTY' && Math.abs(i.yc - partH.yc) < 5);
    const descH = partH && flat.find(i => /^DESCRIPTION$/i.test(i.s) && Math.abs(i.yc - partH.yc) < 5);
    if(!partH || !qtyH || !descH) return null;
    const yHdr = partH.yc;

    // right-hand column headers (Box / ID may sit on two lines - merge by x)
    let rh = flat.filter(i => i.x > descH.x1 + 4 && Math.abs(i.yc - yHdr) < 12 && /^(qty|init\.?|skid.*|box.*|id|b\/o|date)$/i.test(i.s))
      .sort((a, b) => a.xc - b.xc);
    const merged = [];
    for(const it of rh){
      const last = merged[merged.length - 1];
      if(last && Math.abs(last.xc - it.xc) < 5){ if(!/^id$/i.test(it.s)) last.s = it.s + ' ' + last.s; continue; }
      merged.push({ ...it });
    }
    const cols = [];
    let ci = 0;
    for(const m of merged){
      while(ci < RIGHT_COLS.length && !RIGHT_COLS[ci][1].test(m.s.split(' ')[0])) ci++;
      if(ci >= RIGHT_COLS.length) break;
      cols.push({ key: RIGHT_COLS[ci][0], xc: m.xc });
      ci++;
    }
    for(let k = 0; k < cols.length; k++){
      const prev = cols[k - 1], next = cols[k + 1];
      cols[k].l = prev ? (prev.xc + cols[k].xc) / 2 : null;
      cols[k].r = next ? (cols[k].xc + next.xc) / 2 : null;
    }
    for(const c of cols){
      if(c.l == null) c.l = c.xc - (c.r - c.xc);
      if(c.r == null) c.r = c.xc + (c.xc - c.l);
    }
    const pkLeft = cols.length ? cols[0].l : Infinity;

    // item-number column: small numbers left of the part numbers
    // "I t e m" is printed one letter per line above the item-number column
    const itemLetters = flat.filter(i => /^[Iitem]$/.test(i.s) && Math.abs(i.yc - yHdr) < 30 && i.x < partH.x);
    const itemX0 = itemLetters.length ? Math.min(...itemLetters.map(i => i.x)) : partH.x - 90;
    const itemX1 = itemLetters.length ? Math.max(...itemLetters.map(i => i.x1)) : partH.x - 40;
    const partX0s = flat.filter(i => i.yc < yHdr - 4 && i.x > itemX1 - 0.5 && i.x < qtyH.x - 4 && !/^\d{1,3}$/.test(i.s)).map(i => i.x);
    const partLeft = partX0s.length ? Math.min(...partX0s) : itemX1 + 4;
    let nums = flat.filter(i => i.yc < yHdr - 4 && /^\d{1,3}$/.test(i.s) && i.x1 < partLeft + 1 && i.x > itemX0 - 12)
      .sort((a, b) => b.yc - a.yc);
    if(!nums.length) return null;
    const gaps = [];
    for(let k = 1; k < nums.length; k++) gaps.push(nums[k - 1].yc - nums[k].yc);
    gaps.sort((a, b) => a - b);
    const rowH = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 17;

    // group band labels (vertical text), joined per column of text
    const rot = items.filter(i => i.rot).sort((a, b) => a.x - b.x || a.y - b.y);
    const bands = [];
    for(const r of rot){
      let b = bands.find(bb => Math.abs(bb.x - r.x) < 3);
      if(!b){ b = { x: r.x, parts: [], y0: Infinity, y1: -Infinity }; bands.push(b); }
      b.parts.push(r); b.y0 = Math.min(b.y0, r.y); b.y1 = Math.max(b.y1, r.y + r.w);
    }
    for(const b of bands){
      b.text = b.parts.sort((p, q) => p.y - q.y).map(p => p.s).join(' ');
      const m = b.text.match(/GROUP\s*(\w+)/i);
      b.g = m ? 'GROUP ' + m[1].toUpperCase() : '';
      b.yc = (b.y0 + b.y1) / 2;
    }
    const groupBands = bands.filter(b => b.g);

    const lines = [];
    for(const n of nums){
      const top = n.yc + rowH / 2, bot = n.yc - rowH / 2;
      const inRow = flat.filter(i => i !== n && i.yc <= top && i.yc > bot && i.x >= n.x1 - 0.5);
      const part = inRow.filter(i => i.x < qtyH.xc - 10 && i.xc < qtyH.xc - 8).sort((a, b) => a.x - b.x).map(i => i.s).join(' ');
      const qtyIt = inRow.find(i => Math.abs(i.xc - qtyH.xc) <= 12 && /^\d+(\.\d+)?$/.test(i.s));
      const desc = inRow.filter(i => i !== qtyIt && i.xc > qtyH.xc + 10 && i.x1 <= pkLeft + 2)
        .sort((a, b) => b.yc - a.yc || a.x - b.x).map(i => i.s).join(' ');
      const filled = {};
      for(const c of cols){
        const v = inRow.filter(i => i.xc >= c.l && i.xc < c.r).map(i => i.s).join(' ');
        if(v) filled[c.key] = v;
      }
      let g = '';
      if(groupBands.length){
        const inside = groupBands.find(b => n.yc >= b.y0 - rowH && n.yc <= b.y1 + rowH);
        g = (inside || groupBands.slice().sort((a, b) => Math.abs(a.yc - n.yc) - Math.abs(b.yc - n.yc))[0]).g;
      }
      const fieldRects = {};
      for(const c of cols){
        fieldRects[c.key] = { x: c.l + 0.6, y: n.yc - rowH / 2 + 0.8, width: c.r - c.l - 1.2, height: rowH - 1.6 };
      }
      lines.push({ n: +n.s, p: part, q: qtyIt ? qtyIt.s : '', d: desc, g, conf: 1, fieldRects, filled, yc: n.yc });
    }

    // header block
    const above = flat.filter(i => i.yc > yHdr + 20);
    const LBL = {
      customer: /^CUSTOMER:?$/i, jobNo: /^JOB\s*#$/i, jobName: /^JOB\s*NAME:?$/i, carNo: /^CAR\s*#$/i,
      rev: /^REV\.?:?$/i, shipDate: /^SHIP\s*DATE:?$/i, attn: /^ATTN:?$/i
    };
    const labels = {};
    for(const [k, re] of Object.entries(LBL)) labels[k] = above.find(i => re.test(i.s));
    const allLabels = above.filter(i => Object.values(LBL).some(re => re.test(i.s)) || /^(SHIPPING|ADDRESS:?)$/i.test(i.s));
    const header = {};
    for(const [k, lab] of Object.entries(labels)){
      if(!lab) continue;
      const rightLabels = allLabels.filter(o => o !== lab && o.x > lab.x1 - 0.5).map(o => o.x);
      const limit = rightLabels.length ? Math.min(...rightLabels) : Infinity;
      header[k] = above.filter(i => Math.abs(i.yc - lab.yc) < 3 && i.x >= lab.x1 - 0.5 && i.x < limit && i !== lab)
        .sort((a, b) => a.x - b.x).map(i => i.s).join(' ');
    }
    const addrLab = above.find(i => /^ADDRESS:?$/i.test(i.s)) || above.find(i => /^SHIPPING$/i.test(i.s));
    if(addrLab && labels.customer){
      const rightX = Math.min(...allLabels.filter(o => o.x > addrLab.x + 60).map(o => o.x), Infinity);
      const lowY = labels.attn ? labels.attn.yc + 3 : addrLab.yc - 20;
      const addr = above.filter(i => i.x > addrLab.x1 + 2 && i.x < rightX && i.yc < labels.customer.yc - 3 && i.yc > lowY)
        .sort((a, b) => b.yc - a.yc || a.x - b.x);
      const byLine = [];
      for(const a of addr){
        const l = byLine.find(bl => Math.abs(bl.y - a.yc) < 3);
        if(l) l.t.push(a.s); else byLine.push({ y: a.yc, t: [a.s] });
      }
      header.shipAddr = byLine.map(l => l.t.join(' ').replace(/^[\s,.;]+/, '')).filter(Boolean).join('\n');
    }
    const titleIt = above.filter(i => /PRODUCT\s+LIST/i.test(i.s)).sort((a, b) => b.h - a.h)[0];
    if(titleIt) header.title = titleIt.s.toUpperCase();
    const foot = flat.map(i => i.s).join(' ').match(/\b([A-Z0-9]{1,5}P)\s*-\s*REV\s*(\d+)/i);
    if(foot) header.formRev = foot[1].toUpperCase() + '-REV ' + foot[2];
    const printed = flat.find(i => /^Printed:/i.test(i.s));
    if(printed) header.printed = printed.s;

    return { lines, header, cols: cols.map(c => c.key), rowH };
  }

  /* form-field values already on the PDF (e.g. a filled PDF exported from this app) */
  async function fieldValues(page){
    try{
      const ann = await page.getAnnotations();
      return ann.filter(a => a.subtype === 'Widget' && a.fieldValue != null && String(a.fieldValue).trim() !== '' && a.fieldValue !== 'Off')
        .map(a => ({ name: a.fieldName || '', v: String(a.fieldValue), xc: (a.rect[0] + a.rect[2]) / 2, yc: (a.rect[1] + a.rect[3]) / 2 }));
    }catch(e){ return []; }
  }

  async function renderPage(page){
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 2500 / vp1.width);
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    img.pageW = vp1.width; img.pageH = vp1.height; img.pxScale = scale;
    return img;
  }

  async function imageFile(file){
    const bmp = await createImageBitmap(file);
    const scale = bmp.width < 1800 ? Math.min(3, 2400 / bmp.width) : 1;
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    return ctx.getImageData(0, 0, cv.width, cv.height);
  }

  function emptyHeader(){
    return { title: '', customer: '', shipAddr: '', attn: '', jobNo: '', jobName: '', carNo: '', rev: '', shipDate: '', formRev: '' };
  }

  function groupSuffix(title){
    const src = (title || '').toUpperCase();
    const map = { G1: 'G1', G2: 'G2', G3: 'G3', ENT: 'ENT', CAB: 'CABS' };
    for(const k of ['G1', 'G2', 'G3', 'ENT', 'CAB']) if(new RegExp('\\b' + k + '\\b').test(src)) return map[k];
    return null;
  }
  function ensureHdwPack(res){
    if(res.lines.some(it => /^HDW[-\s]?PACK$/i.test((it.p || '').trim()))) return false;
    const suffix = groupSuffix(res.header.title);
    const g = res.lines.length ? res.lines[res.lines.length - 1].g : '';
    res.lines.push({ p: 'HDW-PACK', q: '1', d: 'REFFER TO THE CONSOLIDATED HARDWARE LIST FOR HARDWARE REQUIRED' + (suffix ? ' FOR ' + suffix : ''),
      g, conf: 1, fieldRects: null, pageIndex: null, filled: {}, added: true });
    return true;
  }

  // OCR sometimes picks up the printed footer as a line
  const junk = it => /\bBY:|\bPage\s*\w{1,3}\s*o?f|Printed:/i.test((it.p || '') + ' ' + (it.d || ''));

  /* Main entry: File(s) -> { header, lines, mode, pdfBytes, notes[] } */
  async function read(files, onStatus){
    const say = onStatus || (() => {});
    const res = { header: emptyHeader(), lines: [], mode: 'text', pdfBytes: null, notes: [] };
    const merge = h => { for(const k of Object.keys(h)) if(h[k] && !res.header[k]) res.header[k] = h[k]; };
    const single = files.length === 1 && /pdf$/i.test(files[0].type || files[0].name);
    let ocrUsed = false, prevSpans = null;
    for(const f of files){
      if(/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)){
        const lp = await lib();
        const buf = new Uint8Array(await f.arrayBuffer());
        if(single) res.pdfBytes = buf.slice();
        const doc = await lp.getDocument({ data: buf.slice() }).promise;
        for(let p = 1; p <= doc.numPages; p++){
          const page = await doc.getPage(p);
          say('Reading page ' + p + ' of ' + doc.numPages + '…');
          const tp = parseTextPage(textItems(await page.getTextContent()), page.view[3]);
          if(tp && tp.lines.length){
            const fv = await fieldValues(page);
            for(const v of fv){
              for(const ln of tp.lines){
                for(const [k, r] of Object.entries(ln.fieldRects)){
                  if(v.xc >= r.x && v.xc <= r.x + r.width && v.yc >= r.y - 1 && v.yc <= r.y + r.height + 1) ln.filled[k] = v.v;
                }
              }
            }
            for(const ln of tp.lines){ ln.pageIndex = p - 1; res.lines.push(ln); }
            merge(tp.header);
          } else {
            ocrUsed = true;
            say('Page ' + p + ' has no text layer — reading it with OCR (10–30 s)…');
            const img = await renderPage(page);
            const r = await OCR.readPage(img, prevSpans);
            prevSpans = r.spans;
            for(const it of r.items) if(!junk(it)) res.lines.push({ p: it.p, q: it.q, d: it.d, g: '', conf: it.conf, fieldRects: it.fieldRects, pageIndex: p - 1, filled: {} });
            merge(r.fields || {});
          }
        }
      } else {
        ocrUsed = true;
        say('Reading photo ' + f.name + ' with OCR (10–30 s)…');
        const img = await imageFile(f);
        const r = await OCR.readPage(img, prevSpans);
        prevSpans = r.spans;
        for(const it of r.items) if(!junk(it)) res.lines.push({ p: it.p, q: it.q, d: it.d, g: '', conf: it.conf, fieldRects: null, pageIndex: null, filled: {} });
        merge(r.fields || {});
      }
    }
    if(ocrUsed){
      res.mode = 'ocr';
      if(!res.lines.some(l => l.g)) res.lines.forEach(l => l.g = 'GROUP 1');
    }
    if(ensureHdwPack(res)) res.notes.push('Added the HDW-PACK sign-off line (not found on the document).');
    return res;
  }

  /* ---------- laser cut list reader ---------- */
  // A different ERP export entirely - flat rows of real part dimensions
  // (no department stamps), used to work out sheet material needed. Columns:
  // Group | Sub Group | Production | Product # | Description | QTY |
  // Width (in) | Length (in) | Thick (in) | Gauge | Stock No. | Weight (lb) |
  // Material | Material Finish | Notes
  const LASER_COLS = [
    ['group', /^group$/i], ['subGroup', /^sub\s*group$/i], ['production', /^production$/i],
    ['productNo', /^product\s*#$/i], ['description', /^description$/i], ['qty', /^qty$/i],
    ['width', /^width/i], ['length', /^length/i], ['thick', /^thick/i], ['gauge', /^gauge$/i],
    ['stockNo', /^stock\s*no\.?$/i], ['weight', /^weight/i], ['material', /^material$/i],
    ['finish', /^material\s*finish$/i], ['notes', /^notes$/i]
  ];
  function mergeRow(sorted, gap){
    const merged = [];
    for(const it of sorted){
      const last = merged[merged.length - 1];
      if(last && it.x - last.x1 < gap){ last.s = norm(last.s + ' ' + it.s); last.x1 = it.x1; last.xc = (last.x + last.x1) / 2; }
      else merged.push({ ...it });
    }
    return merged;
  }
  function parseLaserPage(items){
    const flat = items.filter(i => !i.rot);
    const qtyH = flat.find(i => /^qty$/i.test(i.s));
    if(!qtyH) return null;
    const hdrRow = flat.filter(i => Math.abs(i.yc - qtyH.yc) < 4).sort((a, b) => a.x - b.x);
    const hdrCells = mergeRow(hdrRow, 10);
    const cols = [];
    let ci = 0;
    for(const cell of hdrCells){
      while(ci < LASER_COLS.length && !LASER_COLS[ci][1].test(cell.s)) ci++;
      if(ci >= LASER_COLS.length) break;
      cols.push({ key: LASER_COLS[ci][0], xc: cell.xc });
      ci++;
    }
    if(cols.length < 10) return null; // not a laser-list page
    for(let k = 0; k < cols.length; k++){
      cols[k].l = k ? (cols[k - 1].xc + cols[k].xc) / 2 : -Infinity;
      cols[k].r = k < cols.length - 1 ? (cols[k].xc + cols[k + 1].xc) / 2 : Infinity;
    }
    const yHdr = qtyH.yc;
    const anchors = flat.filter(i => i.yc < yHdr - 2 && /^group\s*\d+$/i.test(i.s)).sort((a, b) => b.yc - a.yc);
    if(!anchors.length) return { header: {}, rows: [] };
    const gaps = [];
    for(let k = 1; k < anchors.length; k++) gaps.push(anchors[k - 1].yc - anchors[k].yc);
    gaps.sort((a, b) => a - b);
    const rowH = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 18;
    const rows = [];
    for(const a of anchors){
      const top = a.yc + rowH / 2, bot = a.yc - rowH / 2;
      const inRow = flat.filter(i => i.yc <= top && i.yc > bot);
      const row = {};
      for(const c of cols){
        const v = norm(inRow.filter(i => i.xc >= c.l && i.xc < c.r).sort((x, y) => x.x - y.x).map(i => i.s).join(' '));
        if(v) row[c.key] = v;
      }
      if(row.productNo || row.description) rows.push(row);
    }
    // header block (JOB NO / JOB NAME / BY / ELEVATOR NO / REV / TOTAL LINE ITEMS)
    const above = flat.filter(i => i.yc > yHdr + 10);
    const LBL = { jobNo: /^job\s*no:?$/i, jobName: /^job\s*name:?$/i, by: /^by:?$/i, elevatorNo: /^elevator\s*no:?$/i, rev: /^rev\.?:?$/i };
    const header = {};
    for(const [k, re] of Object.entries(LBL)){
      const lab = above.find(i => re.test(i.s));
      if(!lab) continue;
      const rightLabels = above.filter(o => o !== lab && Object.values(LBL).some(r2 => r2.test(o.s)) && o.x > lab.x1 - 0.5).map(o => o.x);
      const limit = rightLabels.length ? Math.min(...rightLabels) : Infinity;
      const v = norm(above.filter(i => Math.abs(i.yc - lab.yc) < 4 && i.x >= lab.x1 - 0.5 && i.x < limit && i !== lab)
        .sort((a, b) => a.x - b.x).map(i => i.s).join(' '));
      header[k] = k === 'rev' ? (v.split(' ')[0] || '') : v;
    }
    const titleIt = above.filter(i => /LASER.*PART|PART.*LASER/i.test(i.s)).sort((a, b) => b.h - a.h)[0];
    if(titleIt) header.title = titleIt.s.toUpperCase();
    return { header, rows };
  }

  /* Main entry for a laser cut list: File -> { header, rows[] }. One PDF only
     (no OCR fallback - this is always an ERP text-layer export). */
  async function readLaser(file, onStatus){
    const say = onStatus || (() => {});
    const lp = await lib();
    const buf = new Uint8Array(await file.arrayBuffer());
    const pdfBytes = buf.slice();
    const doc = await lp.getDocument({ data: buf.slice() }).promise;
    const res = { header: {}, rows: [], pdfBytes };
    for(let p = 1; p <= doc.numPages; p++){
      const page = await doc.getPage(p);
      say('Reading page ' + p + ' of ' + doc.numPages + '…');
      const tp = parseLaserPage(textItems(await page.getTextContent()));
      if(!tp) continue;
      for(const k of Object.keys(tp.header)) if(tp.header[k] && !res.header[k]) res.header[k] = tp.header[k];
      res.rows.push(...tp.rows);
    }
    return res;
  }

  return { read, readLaser, groupSuffix, lib };
})();
