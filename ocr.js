/* OCR fallback for scanned PDFs and photos of product lists.
   Ported unchanged from Product_List_Converter.html (analyze / extractPage /
   digit-template matcher). Only used when a PDF has no text layer. */
const OCR = (() => {
let engine = null;
function simdOk(){
  try{ return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])); }
  catch(e){ return false; }
}
async function ensureEngine(){
  if(engine) return engine;
  const tess = await import('./vendor/tesseract-lib.js');
  const wasm = new Uint8Array(await (await fetch(simdOk() ? './vendor/tesseract-core.wasm' : './vendor/tesseract-core-fallback.wasm')).arrayBuffer());
  const OrigURL = window.URL;
  function SafeURL(u, base){ try { return new OrigURL(u, base); } catch(e){ return { href: String(u) }; } }
  SafeURL.createObjectURL = OrigURL.createObjectURL.bind(OrigURL);
  SafeURL.revokeObjectURL = OrigURL.revokeObjectURL.bind(OrigURL);
  window.URL = SafeURL;
  let p;
  try{ p = tess.createOCREngine({ wasmBinary: wasm }); } finally { window.URL = OrigURL; }
  engine = await p;
  engine.loadModel(new Uint8Array(await (await fetch('./vendor/eng.traineddata')).arrayBuffer()));
  return engine;
}
/* ================= image analysis ================= */
function analyze(img){
  const W = img.width, H = img.height, px = img.data;
  const N = W * H;
  const red = new Uint8Array(N);
  for(let i = 0; i < N; i++) red[i] = px[i * 4];

  // illumination: per-64px-tile 90th percentile of red, bilinear across tiles
  const T = 64, gw = Math.ceil(W / T), gh = Math.ceil(H / T);
  const bg = new Float32Array(gw * gh);
  const hist = new Int32Array(256);
  for(let gy = 0; gy < gh; gy++){
    for(let gx = 0; gx < gw; gx++){
      hist.fill(0);
      let cnt = 0;
      const y1 = Math.min((gy + 1) * T, H), x1 = Math.min((gx + 1) * T, W);
      for(let y = gy * T; y < y1; y++){
        const row = y * W;
        for(let x = gx * T; x < x1; x++){ hist[red[row + x]]++; cnt++; }
      }
      let acc = 0, v = 255;
      const target = cnt * 0.9;
      for(let k = 0; k < 256; k++){ acc += hist[k]; if(acc >= target){ v = k; break; } }
      bg[gy * gw + gx] = Math.max(v, 60);
    }
  }
  function bgAt(x, y){
    let fx = x / T - 0.5, fy = y / T - 0.5;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const dx = fx - x0, dy = fy - y0;
    x0 = Math.max(0, Math.min(gw - 1, x0)); y0 = Math.max(0, Math.min(gh - 1, y0));
    const x2 = Math.min(gw - 1, x0 + 1), y2 = Math.min(gh - 1, y0 + 1);
    return bg[y0 * gw + x0] * (1 - dx) * (1 - dy) + bg[y0 * gw + x2] * dx * (1 - dy) +
           bg[y2 * gw + x0] * (1 - dx) * dy + bg[y2 * gw + x2] * dx * dy;
  }

  const text = new Uint8Array(N), lineSrc = new Uint8Array(N);
  for(let y = 0; y < H; y++){
    const row = y * W;
    for(let x = 0; x < W; x++){
      const b = bgAt(x, y), v = red[row + x];
      if(v < b * 0.62) text[row + x] = 1;
      if(v < b * 0.84) lineSrc[row + x] = 1;
    }
  }

  // long runs
  const L = Math.max(30, Math.round(0.0235 * W));
  const Hm = new Uint8Array(N), Vm = new Uint8Array(N);
  const hx = [], hy = [], vx = [], vy = [];
  for(let y = 0; y < H; y++){
    const row = y * W;
    let run = 0;
    for(let x = 0; x <= W; x++){
      if(x < W && lineSrc[row + x]) run++;
      else{
        if(run >= L){
          for(let k = x - run; k < x; k++){ Hm[row + k] = 1; hx.push(k); hy.push(y); }
        }
        run = 0;
      }
    }
  }
  for(let x = 0; x < W; x++){
    let run = 0;
    for(let y = 0; y <= H; y++){
      if(y < H && lineSrc[y * W + x]) run++;
      else{
        if(run >= L){
          for(let k = y - run; k < y; k++){ Vm[k * W + x] = 1; vx.push(x); vy.push(k); }
        }
        run = 0;
      }
    }
  }

  function fitShear(xs, ys, vertical){
    const step = Math.max(1, Math.floor(xs.length / 60000));
    let best = 0, bestScore = -1;
    for(let a = -2.5; a <= 2.51; a += 0.1){
      const t = Math.tan(a * Math.PI / 180);
      let mn = Infinity, mx = -Infinity;
      const cs = [];
      for(let i = 0; i < xs.length; i += step){
        const c = vertical ? xs[i] + ys[i] * t : ys[i] - xs[i] * t;
        cs.push(c);
        if(c < mn) mn = c; if(c > mx) mx = c;
      }
      const nb = Math.max(1, Math.ceil((mx - mn) / 3) + 1);
      const h = new Float64Array(nb);
      for(const c of cs) h[Math.floor((c - mn) / 3)]++;
      let s = 0;
      for(let i = 0; i < nb; i++) s += h[i] * h[i];
      if(s > bestScore){ bestScore = s; best = t; }
    }
    return best;
  }
  const th = hx.length ? fitShear(hx, hy, false) : 0;
  const tv = vx.length ? fitShear(vx, vy, true) : 0;

  function borders(xs, ys, vertical, t, minCount){
    if(!xs.length) return [];
    let mn = Infinity, mx = -Infinity;
    const cs = new Float64Array(xs.length);
    for(let i = 0; i < xs.length; i++){
      const c = vertical ? xs[i] + ys[i] * t : ys[i] - xs[i] * t;
      cs[i] = c;
      if(c < mn) mn = c; if(c > mx) mx = c;
    }
    const nb = Math.ceil((mx - mn) / 3) + 1;
    const h = new Float64Array(nb);
    for(let i = 0; i < cs.length; i++) h[Math.floor((cs[i] - mn) / 3)]++;
    const out = [];
    let i = 0;
    while(i < nb){
      if(h[i] >= minCount){
        let j = i, wsum = 0, csum = 0;
        while(j < nb && h[j] >= minCount){ wsum += h[j]; csum += h[j] * (mn + j * 3 + 1.5); j++; }
        out.push(csum / wsum);
        i = j;
      } else i++;
    }
    const mrg = [];
    const gap = 0.007 * (vertical ? W : H) + 12;
    for(const c of out){
      if(mrg.length && c - mrg[mrg.length - 1] < gap) mrg[mrg.length - 1] = (mrg[mrg.length - 1] + c) / 2;
      else mrg.push(c);
    }
    return mrg;
  }
  const rowB = borders(hx, hy, false, th, W * 0.15);
  const colB = borders(vx, vy, true, tv, H * 0.10);

  // cleaned OCR image: text minus dilated lines
  const lines = new Uint8Array(N);
  for(let i = 0; i < N; i++) lines[i] = Hm[i] | Vm[i];
  const tmp = new Uint8Array(N);
  for(let y = 0; y < H; y++){
    const row = y * W;
    for(let x = 0; x < W; x++)
      tmp[row + x] = lines[row + x] | (x > 0 ? lines[row + x - 1] : 0) | (x < W - 1 ? lines[row + x + 1] : 0);
  }
  const dil = new Uint8Array(N);
  for(let y = 0; y < H; y++){
    const row = y * W, up = (y > 0 ? y - 1 : y) * W, dn = (y < H - 1 ? y + 1 : y) * W;
    for(let x = 0; x < W; x++) dil[row + x] = tmp[row + x] | tmp[up + x] | tmp[dn + x];
  }
  const clean = new ImageData(W, H);
  const cd = clean.data;
  for(let i = 0; i < N; i++){
    const v = (text[i] && !dil[i]) ? 0 : 255;
    cd[i * 4] = cd[i * 4 + 1] = cd[i * 4 + 2] = v;
    cd[i * 4 + 3] = 255;
  }
  return { clean, rowB, colB, th, tv, W, H };
}

/* ================= word -> table extraction ================= */
const cxw = w => (w.x0 + w.x1) / 2, cyw = w => (w.y0 + w.y1) / 2;
const cleanTok = s => s.replace(/\s+/g, ' ').trim().replace(/^[^0-9A-Za-z(.]+|[^0-9A-Za-z").]+$/g, '');
function fixConfusables(s){
  const ch = s.split('');
  const map = {O:'0', B:'8', l:'1', I:'1'};
  for(let i = 1; i < ch.length - 1; i++){
    if(map[ch[i]] && /\d/.test(ch[i-1]) && /\d/.test(ch[i+1])) ch[i] = map[ch[i]];
  }
  return ch.join('');
}
function mergeOverlap(a, b){
  for(let k = Math.min(a.length, b.length); k > 1; k--){
    if(a.endsWith(b.slice(0, k))) return a + b.slice(k);
  }
  return null;
}
function fixPart(p, conf){
  p = fixConfusables(cleanTok(p)).toUpperCase();
  let toks = p.split(' ').filter(Boolean);
  if(toks.length >= 2){
    if(toks[0].includes('-') && toks[1].includes('-')){
      const m = mergeOverlap(toks[0], toks[1]);
      if(m) toks = [m].concat(toks.slice(2));
    }
    if(toks.length > 1 && toks[0].includes('-') && !toks[toks.length - 1].includes('-') && toks[toks.length - 1].length <= 4)
      toks = toks.slice(0, -1);
    if(toks.length > 1 && /^\d+$/.test(toks[0]) && toks[1].includes('-'))
      toks = [toks[0] + '-' + toks[1]].concat(toks.slice(2));
  }
  p = toks.join(' ');
  if(conf < 0.5){
    const m2 = p.match(/^[JLI|\/]([A-Z]{2,}\d\S*)$/);
    if(m2) p = m2[1];
  }
  return p;
}

function extractPage(words, geo, prevSpans){
  const { rowB, colB, th, tv, W } = geo;
  const shx = w => cxw(w) + cyw(w) * tv;
  const shy = w => cyw(w) - cxw(w) * th;
  const interval = (bl, v) => { for(let i = 0; i < bl.length - 1; i++) if(bl[i] <= v && v < bl[i + 1]) return i; return -1; };
  const rowOf = w => interval(rowB, shy(w));
  words = words.filter(w => w.t.trim());

  let descH = words.filter(w => w.t.toUpperCase().includes('DESCRIPTION')).sort((a, b) => a.y0 - b.y0)[0];
  let spans, HR, fields = {};
  if(descH){
    const hy0 = shy(descH);
    const lineH = words.filter(w => Math.abs(shy(w) - hy0) < 0.018 * W);
    const partH = lineH.filter(w => w.t.toUpperCase().includes('PART')).sort((a, b) => a.x0 - b.x0)[0];
    if(!partH) throw new Error('Found the DESCRIPTION header but not PART # - is this a product list?');
    const qtyH = lineH.filter(w => /^[O0Q][TVY1I][TVY1I]\.?$/.test(w.t.toUpperCase()) &&
                  w.x0 > partH.x1 && w.x0 < descH.x0).sort((a, b) => a.x0 - b.x0)[0];
    const nxt = lineH.filter(w => w.x0 > descH.x1 + 30).sort((a, b) => a.x0 - b.x0)[0];
    const snap = (target, lo, hi, tol) => {
      const cand = colB.filter(b => (lo == null || b > lo) && (hi == null || b < hi));
      if(cand.length){
        let best = cand[0];
        for(const b of cand) if(Math.abs(b - target) < Math.abs(best - target)) best = b;
        if(Math.abs(best - target) <= tol) return best;
      }
      return target;
    };
    const tol = 0.016 * W;
    const b_ip = snap(partH.x0 - 0.024 * W, null, partH.x0, 0.1 * W);
    const b_il = snap(b_ip - 0.04 * W, null, b_ip - 0.008 * W, 0.05 * W);
    let b_pq, b_qd;
    if(qtyH){
      b_pq = snap((partH.x1 + qtyH.x0) / 2, null, null, tol);
      b_qd = snap((qtyH.x1 + descH.x0) / 2, null, null, tol);
    } else {
      // No reliable "QTY" header text found - common on noisy phone photos where small
      // header letters get missed. Most robust fallback: the actual quantity values are
      // short standalone numbers that repeat down the page in one tight column - find
      // that cluster directly rather than depend on header text or border lines (which
      // can be thrown off by photo shadows/perspective).
      const numTokens = words.filter(w => /^\d{1,3}$/.test(w.t.trim()) &&
        w.x0 > partH.x1 + 0.02 * W && w.x1 < descH.x0);
      let clustered = false;
      if(numTokens.length >= 3){
        const xs = numTokens.map(w => w.x0).sort((a, b) => a - b);
        const med = xs[Math.floor(xs.length / 2)];
        const near = numTokens.filter(w => Math.abs(w.x0 - med) < 0.05 * W);
        if(near.length >= 3){
          b_pq = Math.min(...near.map(w => w.x0)) - 0.012 * W;
          b_qd = Math.max(...near.map(w => w.x1)) + 0.012 * W;
          clustered = true;
        }
      }
      if(!clustered){
        const nearDesc = colB.filter(b => b > partH.x1 + 0.05 * W && descH.x0 - b < 0.06 * W && descH.x0 - b > 0)
          .sort((a, b) => b - a);
        if(nearDesc.length){
          b_qd = nearDesc[0];
          const further = colB.filter(b => b < b_qd - 0.01 * W && b > partH.x1).sort((a, b) => b - a);
          b_pq = further.length ? further[0] : snap(b_qd - 0.04 * W, partH.x1, b_qd, tol);
        } else {
          b_pq = snap(partH.x1 + 0.024 * W, partH.x1, descH.x0, tol);
          b_qd = b_pq + 0.035 * W;
        }
      }
    }
    // Some documents wrap longer descriptions onto a second line, and the wrapped line
    // is center-justified - meaning it can start further left than a typical single-line
    // description, encroaching on the header-anchored Qty/Description boundary and
    // getting misclassified as part of Qty (corrupting both columns for that row). Detect
    // this directly: find where real qty digits actually sit, then check whether any
    // plain-letter word sits between them and the current boundary - if so, that's a
    // stray description word, and we widen the boundary to give it room.
    {
      const qtyDigits = words.filter(w => /^\d{1,3}$/.test(w.t.trim()) && w.x0 > b_pq && w.x0 < b_qd);
      if(qtyDigits.length){
        const qtyRight = Math.max(...qtyDigits.map(w => w.x1));
        const encroachers = words.filter(w => /^[A-Za-z]{3,}$/.test(w.t.trim()) &&
          w.x0 > qtyRight + 0.01 * W && w.x0 < b_qd);
        if(encroachers.length){
          const minX = Math.min(...encroachers.map(w => w.x0));
          b_qd = Math.min(b_qd, minX - 0.006 * W);
        }
      }
    }
    const b_dp = snap((descH.x1 + (nxt ? nxt.x0 : descH.x1 + 0.12 * W)) / 2, null, null, tol) + 0.012 * W;

    // For the "export matching the original form" feature: locate the handwritten
    // Packaging/QC/Back-Order columns from the printed cell borders, purely so we know
    // where to place interactive form fields on the original PDF - not to read their
    // content (that approach was tried and abandoned; OCR can't reliably read
    // handwriting). Placement only needs to be close enough to tap, so this is a much
    // safer use of border detection than trying to extract values from it.
    let hwBounds = null;
    {
      const rightBorders = colB.filter(b => b > b_dp + 0.006 * W).sort((a, b) => a - b);
      if(rightBorders.length >= 7){
        // 8 sub-columns: Pkg Qty | Pkg Init | QC Init | Skid# | Box ID | B/O Qty | B/O Init | B/O Date
        const edges = [b_dp, ...rightBorders.slice(0, 7)];
        const last = edges[7] + (edges[7] - edges[6]);
        hwBounds = { edges: [...edges, last], names: ['pkQty', 'pkInit', 'qcInit', 'skid', 'boxId', 'boQty', 'boInit', 'boDate'] };
      } else if(rightBorders.length >= 6){
        // 7 sub-columns: Pkg Qty | Pkg Init | QC Init | Skid# | B/O Qty | B/O Init | B/O Date
        const edges = [b_dp, ...rightBorders.slice(0, 6)];
        const last = edges[6] + (edges[6] - edges[5]);
        hwBounds = { edges: [...edges, last], names: ['pkQty', 'pkInit', 'qcInit', 'skid', 'boQty', 'boInit', 'boDate'] };
      }
    }
    spans = { b_il, b_ip, b_pq, b_qd, b_dp, hwBounds, W };
    HR = rowOf(descH);
    fields = headerFields(words, shx, shy, hy0, W, descH);
  } else if(prevSpans){
    const k = W / prevSpans.W;
    spans = { b_il: prevSpans.b_il * k, b_ip: prevSpans.b_ip * k, b_pq: prevSpans.b_pq * k,
              b_qd: prevSpans.b_qd * k, b_dp: prevSpans.b_dp * k,
              hwBounds: prevSpans.hwBounds ? { edges: prevSpans.hwBounds.edges.map(v => v * k), names: prevSpans.hwBounds.names } : null,
              W };
    HR = -1;
  } else {
    throw new Error('Could not find the PART # / QTY / DESCRIPTION header row on this page.');
  }

  const runExtraction = (b_il_v, b_ip_v) => {
    const colOf = w => {
      const v = shx(w);
      if(v >= b_il_v && v < b_ip_v) return 'item';
      if(v >= b_ip_v && v < spans.b_pq) return 'part';
      if(v >= spans.b_pq && v < spans.b_qd) return 'qty';
      if(v >= spans.b_qd && v < spans.b_dp) return 'desc';
      return null;
    };
    const cells = {};
    for(const w of words){
      const ri = rowOf(w), ci = colOf(w);
      if(ri <= HR || ri < 0 || !ci || ci === 'item') continue;
      (cells[ri + ':' + ci] = cells[ri + ':' + ci] || []).push(w);
    }
    const cellTxt = (ri, ci) => {
      const ws = (cells[ri + ':' + ci] || []).slice().sort((a, b) => shy(a) - shy(b));
      if(!ws.length) return ['', 1];
      const hs = ws.map(v => v.y1 - v.y0).sort((a, b) => a - b);
      const hmed = hs[hs.length >> 1];
      const linesArr = [[ws[0]]];
      for(let i = 1; i < ws.length; i++){
        const last = linesArr[linesArr.length - 1];
        if(shy(ws[i]) - shy(last[last.length - 1]) > hmed * 0.7) linesArr.push([ws[i]]);
        else last.push(ws[i]);
      }
      const txt = linesArr.map(l => l.sort((a, b) => a.x0 - b.x0).map(v => v.t).join(' ')).join(' ');
      let conf = 1;
      for(const v of ws) if(v.c < conf) conf = v.c;
      return [txt, conf];
    };
    const pxRectToPoints = (x0, y0, x1, y1) => {
      if(!geo.pxScale) return null;
      const s = geo.pxScale;
      return { x: x0 / s, y: geo.pageH - (y1 / s), width: (x1 - x0) / s, height: (y1 - y0) / s };
    };
    const out = [];
    const ris = Object.keys(cells).map(k => +k.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    for(const ri of ris){
      const [pr, cp] = cellTxt(ri, 'part');
      const [qr, cq] = cellTxt(ri, 'qty');
      const [dr, cd] = cellTxt(ri, 'desc');
      const p = fixPart(pr, cp);
      const qm = qr.match(/\d+/);
      const q = qm ? qm[0] : '';
      const d = cleanTok(dr);
      if(!p && !d) continue;
      if(/Printed:|Page \d+ of|REV \d/i.test(p + ' ' + d)) continue;
      let fieldRects = null;
      if(spans.hwBounds && rowB[ri] != null && rowB[ri + 1] != null){
        const { edges, names } = spans.hwBounds;
        const xc = (edges[0] + edges[edges.length - 1]) / 2;
        const yTopRaw = rowB[ri] + xc * th, yBotRaw = rowB[ri + 1] + xc * th;
        fieldRects = {};
        for(let i = 0; i < names.length; i++){
          if(names[i] === 'boxId') continue; // not tracked in the digital sheet - nothing to place there
          const rect = pxRectToPoints(edges[i], yTopRaw, edges[i + 1], yBotRaw);
          if(rect) fieldRects[names[i]] = rect;
        }
      }
      out.push({ p, q, d, conf: Math.min(cp, cq, cd), _ri: ri, fieldRects });
    }
    return out;
  };

  let items = runExtraction(spans.b_il, spans.b_ip);

  // If most rows came back with a blank Part# under the header-anchored boundary,
  // that's a clear, objective sign it's wrong for this document (rather than trying
  // to predict that in advance, which twice caused regressions on documents where
  // the header-anchored boundary was actually fine) - only then, try alternate
  // boundaries and keep whichever produces fewer blanks.
  if(descH && items.length >= 3){
    const blanks = items.filter(it => !it.p && it.d).length;
    if(blanks / items.length > 0.4){
      const tryAlt = (altBip) => {
        if(altBip == null || Math.abs(altBip - spans.b_ip) < 0.01 * W) return;
        const altBil = altBip - 0.04 * W;
        const altItems = runExtraction(altBil, altBip);
        const altBlanks = altItems.filter(it => !it.p && it.d).length;
        if(altItems.length && altBlanks < blanks){
          items = altItems; blanks_final = altBlanks;
          spans.b_ip = altBip; spans.b_il = altBil;
          return true;
        }
      };
      let blanks_final = blanks;
      // Signal 1: item numbers (1, 2, 3...) - short pure-digit tokens right before Part#.
      let altBip = null;
      const itemNums = words.filter(w => /^\d{1,3}$/.test(w.t.trim()) && rowOf(w) > HR && shx(w) < spans.b_ip);
      if(itemNums.length >= 3){
        const xs1 = itemNums.map(w => w.x1).sort((a, b) => a - b);
        const med = xs1[Math.floor(xs1.length / 2)];
        const near = itemNums.filter(w => Math.abs(w.x1 - med) < 0.04 * W);
        if(near.length >= 3) altBip = Math.max(...near.map(w => w.x1)) + 0.008 * W;
      }
      const fixed1 = altBip != null && tryAlt(altBip);
      // Signal 2 (only if signal 1 didn't already fix it): real part numbers usually
      // share a common numeric job-prefix (e.g. "3181" from "3181-24-A01"). Requiring
      // exactly 3-5 digits AT THE START excludes glued item+part-number artifacts like
      // "28-2080-TCA-A02" (only 2 digits before its first hyphen, so it can't match).
      if(!fixed1){
        const prefixCounts = {}, candidates = [];
        for(const w of words){
          if(rowOf(w) <= HR || shx(w) >= spans.b_dp) continue;
          const core = w.t.replace(/[^A-Za-z0-9-]/g, '');
          const m = core.match(/^(\d{3,5})-/);
          if(m){ prefixCounts[m[1]] = (prefixCounts[m[1]] || 0) + 1; candidates.push({ w, prefix: m[1] }); }
        }
        let dominant = null, dominantCount = 0;
        for(const pfx in prefixCounts) if(prefixCounts[pfx] > dominantCount){ dominant = pfx; dominantCount = prefixCounts[pfx]; }
        if(dominant && dominantCount >= 3){
          const matched = candidates.filter(c => c.prefix === dominant).map(c => c.w);
          const xs = matched.map(w => w.x0).sort((a, b) => a - b);
          const med = xs[Math.floor(xs.length / 2)];
          const near = matched.filter(w => Math.abs(w.x0 - med) < 0.03 * W);
          if(near.length >= 3) tryAlt(Math.min(...near.map(w => w.x0)) - 0.01 * W);
        }
      }
    }
  }
  // dominant-prefix repair
  const counts = {};
  for(const it of items){
    const m = it.p.match(/^(\d{3,4})-/);
    if(m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const dom = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  if(dom){
    for(const it of items){
      if(!it.p.startsWith(dom)){
        const m = it.p.match(new RegExp('^[0-9A-Z]' + dom + '(-.*)$'));
        if(m) it.p = dom + m[1];
      }
    }
  }
  return { fields, items, spans };
}

// ---- digit template matcher (fallback for isolated digits OCR drops as noise) ----
// Tesseract's own noise-filtering runs before recognition, so no configuration of the
// engine can rescue a lone digit it decides is too small/sparse to be text (tested
// extensively: multiple page-seg modes, digit whitelisting, upsampling - none helped).
// The item-number column gives us a source of 100%-certain digit shapes without any
// OCR at all: row 3's item number is always "3", by construction, no recognition
// needed. We crop those cells directly as templates, then match blank Qty cells
// against them with straightforward image comparison.
const TPL_W = 20, TPL_H = 28;

function inkMask(imgData, threshold){
  threshold = threshold == null ? 128 : threshold;
  const { data, width, height } = imgData;
  const mask = new Uint8Array(width * height);
  for(let i = 0; i < width * height; i++) mask[i] = data[i * 4] < threshold ? 1 : 0;
  return { mask, width, height };
}

function ccaBlobs(mask, width, height, minPixels){
  minPixels = minPixels || 4;
  const seen = new Uint8Array(width * height);
  const blobs = [];
  const stack = [];
  for(let y = 0; y < height; y++){
    for(let x = 0; x < width; x++){
      const idx = y * width + x;
      if(!mask[idx] || seen[idx]) continue;
      let x0 = x, x1 = x, y0 = y, y1 = y, count = 0;
      stack.length = 0;
      stack.push(idx); seen[idx] = 1;
      while(stack.length){
        const cur = stack.pop();
        const cy = (cur / width) | 0, cx = cur - cy * width;
        count++;
        if(cx < x0) x0 = cx; if(cx > x1) x1 = cx;
        if(cy < y0) y0 = cy; if(cy > y1) y1 = cy;
        for(let dy = -1; dy <= 1; dy++){
          for(let dx = -1; dx <= 1; dx++){
            if(dx === 0 && dy === 0) continue;
            const nx = cx + dx, ny = cy + dy;
            if(nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nidx = ny * width + nx;
            if(mask[nidx] && !seen[nidx]){ seen[nidx] = 1; stack.push(nidx); }
          }
        }
      }
      if(count >= minPixels) blobs.push({ x0, y0, x1, y1, count });
    }
  }
  return blobs.sort((a, b) => a.x0 - b.x0);
}

function cropMask(m, x0, y0, x1, y1){
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8Array(w * h);
  for(let yy = 0; yy < h; yy++)
    for(let xx = 0; xx < w; xx++)
      out[yy * w + xx] = m.mask[(y0 + yy) * m.width + (x0 + xx)];
  return { mask: out, width: w, height: h };
}

function resizeMask(m, W, H){
  const out = new Uint8Array(W * H);
  for(let y = 0; y < H; y++){
    const sy = Math.min(m.height - 1, Math.floor(y * m.height / H));
    for(let x = 0; x < W; x++){
      const sx = Math.min(m.width - 1, Math.floor(x * m.width / W));
      out[y * W + x] = m.mask[sy * m.width + sx];
    }
  }
  return { mask: out, width: W, height: H };
}

function maskSimilarity(a, b){
  let same = 0;
  for(let i = 0; i < a.mask.length; i++) if(a.mask[i] === b.mask[i]) same++;
  return same / a.mask.length;
}

function buildDigitTemplates(geo, spans, items){
  const { b_il, b_ip } = spans;
  if(b_il == null || b_ip == null || !(b_ip > b_il)) return {};
  const { rowB, th } = geo;
  const full = inkMask(geo.clean);
  const templates = {};
  const xc = (b_il + b_ip) / 2;
  const x0 = Math.max(0, Math.round(b_il)), x1 = Math.min(full.width, Math.round(b_ip));
  if(x1 <= x0) return templates;
  for(let d = 1; d <= 9 && d <= items.length; d++){
    const ri = items[d - 1]._ri; // item d is the d-th extracted row, in document order
    if(ri == null || rowB[ri] == null || rowB[ri + 1] == null) continue;
    const yTop = Math.max(0, Math.round(rowB[ri] + xc * th));
    const yBot = Math.min(full.height, Math.round(rowB[ri + 1] + xc * th));
    if(yBot <= yTop) continue;
    const cell = cropMask(full, x0, yTop, x1 - 1, yBot - 1);
    const blobs = ccaBlobs(cell.mask, cell.width, cell.height, 4);
    if(blobs.length !== 1) continue; // only trust a cell with exactly one clean glyph
    const bb = blobs[0];
    templates[d] = resizeMask(cropMask(cell, bb.x0, bb.y0, bb.x1, bb.y1), TPL_W, TPL_H);
  }
  return templates;
}

function matchQtyBlank(geo, spans, ri, templates){
  const { b_pq, b_qd } = spans;
  if(b_pq == null || b_qd == null || !(b_qd > b_pq)) return null;
  const { rowB, th } = geo;
  if(rowB[ri] == null || rowB[ri + 1] == null) return null;
  const full = inkMask(geo.clean);
  const xc = (b_pq + b_qd) / 2;
  const yTop = Math.max(0, Math.round(rowB[ri] + xc * th));
  const yBot = Math.min(full.height, Math.round(rowB[ri + 1] + xc * th));
  const x0 = Math.max(0, Math.round(b_pq)), x1 = Math.min(full.width, Math.round(b_qd));
  if(x1 <= x0 || yBot <= yTop) return null;
  const cell = cropMask(full, x0, yTop, x1 - 1, yBot - 1);
  const blobs = ccaBlobs(cell.mask, cell.width, cell.height, 4);
  if(!blobs.length || blobs.length > 3) return null; // quantities are 1-3 digits
  const availDigits = Object.keys(templates);
  if(!availDigits.length) return null;
  let result = '';
  for(const bb of blobs){
    const glyph = resizeMask(cropMask(cell, bb.x0, bb.y0, bb.x1, bb.y1), TPL_W, TPL_H);
    let best = null, bestScore = -1;
    for(const d of availDigits){
      const s = maskSimilarity(glyph, templates[d]);
      if(s > bestScore){ bestScore = s; best = d; }
    }
    if(bestScore < 0.82) return null; // not confident - leave the whole cell blank rather than guess
    result += best;
  }
  return result;
}

function headerFields(words, shx, shy, headerY, W, descH){
  const above = words.filter(w => shy(w) < headerY - 0.012 * W && w.t.trim().length > 0);
  const lineOf = anchor => above.filter(w => Math.abs(shy(w) - shy(anchor)) < 0.011 * W);
  const rightOf = (anchor, maxGap) => {
    const same = lineOf(anchor).filter(w => w.x0 > anchor.x1 - 5).sort((a, b) => a.x0 - b.x0);
    const out = [];
    let edge = anchor.x1;
    for(const w of same){
      if(w.x0 - edge > maxGap) break;
      if(/^(JOB|CAR|REV|SHIP|ATTN|CUSTOMER|NAME:|ADDRESS:|DATE:)/i.test(w.t) && out.length) break;
      out.push(w.t); edge = w.x1;
    }
    return cleanTok(out.join(' '));
  };
  const find = re => above.filter(w => re.test(w.t.toUpperCase())).sort((a, b) => a.y0 - b.y0)[0];
  const f = {};
  // The title bar sits in its own band well above the customer/job block;
  // only look there so table-header words like "Product Details" (which
  // sit just above the PART#/QTY row) can't be mistaken for the title.
  const cust0 = find(/^CUSTOMER/);
  const titleBand = cust0 ? above.filter(w => shy(w) < shy(cust0) - 0.008 * W) : above;
  const titleWords = titleBand.filter(w => w.t.trim())
    .sort((a, b) => shy(a) - shy(b) || a.x0 - b.x0).map(w => w.t).join(' ');
  const m = titleWords.match(/([A-Z0-9]{1,4}\s+)?PRODUCT\s+LIST/i);
  if(m) f.title = cleanTok(m[0]).toUpperCase();
  if(!f.title){
    // The title banner is typically white text on a solid color fill, which this
    // pipeline's dark-on-light OCR preprocessing can't read at all. Fall back to the
    // form-code footer text ("G3P-REV 0", "CABP-REV 0", etc.), which is normal
    // black-on-white text and reads fine, to recover which form type this is.
    const footerMatch = words.map(w => w.t).join(' ').match(/\b([A-Z0-9]{1,4})P\s*-\s*REV\b/i);
    if(footerMatch) f.title = footerMatch[1].toUpperCase() + ' PRODUCT LIST';
  }
  const cust = cust0;
  if(cust) f.customer = rightOf(cust, 0.25 * W);
  const attn = find(/^ATTN/);
  if(attn) f.attn = rightOf(attn, 0.25 * W);
  const jobLbl = find(/^JOB#?$|^JOB#/);
  if(jobLbl) f.jobNo = rightOf(jobLbl, 0.2 * W).replace(/^#\s*/, '');
  const nameLbl = find(/^NAME[.:]?$/);
  if(nameLbl) f.jobName = rightOf(nameLbl, 0.2 * W);
  const carLbl = find(/^CAR#?$|^CAR#/);
  if(carLbl) f.carNo = rightOf(carLbl, 0.2 * W).replace(/^#\s*/, '');
  const revLbl = find(/^REV[.:]?$/);
  if(revLbl) f.rev = rightOf(revLbl, 0.15 * W);
  const shipLbl = find(/^SHIP$/);
  if(shipLbl){
    const dateLbl = lineOf(shipLbl).filter(w => /^DATE/i.test(w.t) && w.x0 >= shipLbl.x1 - 5).sort((a,b)=>a.x0-b.x0)[0];
    f.shipDate = rightOf(dateLbl || shipLbl, 0.2 * W);
  }
  if(cust && attn && jobLbl){
    const addrLines = {};
    for(const w of above){
      const y = shy(w);
      if(y > shy(cust) + 0.008 * W && y < shy(attn) - 0.008 * W &&
         w.x0 > cust.x1 - 0.02 * W && w.x1 < jobLbl.x0 - 0.005 * W &&
         !/^(JOB|CAR|REV|SHIP|NAME|DATE)[.:#]?$/i.test(w.t)){
        const key = Math.round(y / (0.011 * W));
        (addrLines[key] = addrLines[key] || []).push(w);
      }
    }
    f.shipAddr = Object.keys(addrLines).sort((a, b) => a - b)
      .map(k => addrLines[k].sort((a, b) => a.x0 - b.x0).map(w => cleanTok(w.t)).filter(Boolean).join(' '))
      .filter(Boolean).join('\n');
  }
  return f;
}

/* ================= file handling & flow ================= */
async function readPage(img, prevSpans){
  const eng = await ensureEngine();
  const geo = analyze(img);
  geo.pageW = img.pageW; geo.pageH = img.pageH; geo.pxScale = img.pxScale;
  eng.loadImage(geo.clean);
  const boxes = eng.getTextBoxes('word');
  const words = boxes.map(b => ({ t: b.text, c: b.confidence, x0: b.rect.left, y0: b.rect.top, x1: b.rect.right, y1: b.rect.bottom }));
  const res = extractPage(words, geo, prevSpans);
  if(res.spans){
    try{
      const templates = buildDigitTemplates(geo, res.spans, res.items);
      if(Object.keys(templates).length >= 3){
        for(const it of res.items){
          if(it._ri == null) continue;
          const guess = matchQtyBlank(geo, res.spans, it._ri, templates);
          if(guess && guess !== it.q){ it.q = guess; it.conf = Math.min(it.conf, 0.5); }
        }
      }
    }catch(e){}
  }
  return res;
}
return { readPage, ensureEngine };
})();
