/* Filled PDF export.
   - Original form available (the PDF that was imported) -> values are placed as
     fillable fields on the original page, in the Packaging / QC / Back Order
     cells. Looks exactly like the original. Department columns have no place on
     the original form, so they are not included there.
   - No original (photo import) -> a generated landscape sheet with every column,
     departments included. */
const PdfExport = (() => {
  let loading = null;
  function loadLib(){
    if(window.PDFLib) return Promise.resolve();
    if(!loading) loading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = './vendor/pdf-lib.min.js'; s.onload = res; s.onerror = () => rej(new Error('pdf-lib failed to load'));
      document.head.appendChild(s);
    });
    return loading;
  }
  const RIGHT = ['pkQty', 'pkInit', 'qcInit', 'skid', 'boxId', 'boQty', 'boInit', 'boDate'];

  async function onOriginal(list, pdfBytes){
    await loadLib();
    const { PDFDocument, StandardFonts, TextAlignment, rgb } = PDFLib;
    const pdf = await PDFDocument.load(pdfBytes);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const form = pdf.getForm();
    // a re-imported filled copy already carries fields - clear them so they don't stack
    for(const f of form.getFields()){ try{ form.removeField(f); }catch(e){} }
    let fid = 0;
    for(const ln of list.items){
      if(!ln.fieldRects || ln.pageIndex == null || ln.pageIndex >= pdf.getPageCount()) continue;
      const page = pdf.getPage(ln.pageIndex);
      for(const key of RIGHT){
        const r = ln.fieldRects[key];
        if(!r) continue;
        const tf = form.createTextField(key + '_' + (ln.n || fid) + '_' + (fid++));
        tf.addToPage(page, { x: r.x, y: r.y, width: r.width, height: r.height, font,
          textColor: key === 'boQty' || key === 'boInit' || key === 'boDate' ? rgb(0.7, 0.1, 0.1) : rgb(0.05, 0.2, 0.55),
          backgroundColor: undefined, borderColor: undefined, borderWidth: 0 });
        tf.setFontSize(r.width < 26 ? 6.5 : 8);
        tf.setAlignment(TextAlignment.Center);
        tf.setText(String(ln[key] == null ? '' : ln[key]));
      }
    }
    // small stamp so a printed copy says where it came from
    const p0 = pdf.getPage(0);
    const done = list.items.filter(isDone).length;
    p0.drawText('Exported ' + new Date().toLocaleString() + ' — ' + done + '/' + list.items.length + ' lines complete (MEII Shop Floor)',
      { x: 36, y: 14, size: 6.5, font: bold, color: rgb(0.35, 0.35, 0.35) });
    form.updateFieldAppearances(font);
    return pdf.save();
  }

  async function generated(job, list){
    await loadLib();
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const form = pdf.getForm();
    const PW = 1224, PH = 792, M = 30;
    const cols = [
      { key: 'n', label: '#', w: 22 },
      { key: 'p', label: 'PART #', w: 132 },
      { key: 'q', label: 'QTY', w: 30 },
      { key: 'd', label: 'DESCRIPTION', w: 238 },
      { key: 'laser', label: 'LASER', w: 44, cb: true }, { key: 'weld', label: 'WELD', w: 44, cb: true },
      { key: 'brake', label: 'BRAKE\nPRESS', w: 44, cb: true }, { key: 'paint', label: 'PAINT', w: 44, cb: true },
      { key: 'assy', label: 'ASSEMBLY', w: 50, cb: true },
      { key: 'pkQty', label: 'PKG\nQTY', w: 40, tf: true }, { key: 'pkInit', label: 'PKG\nINIT', w: 46, tf: true },
      { key: 'qcInit', label: 'QC\nINIT', w: 46, tf: true }, { key: 'skid', label: 'SKID #', w: 46, tf: true },
      { key: 'boxId', label: 'BOX ID', w: 44, tf: true }, { key: 'boQty', label: 'B/O\nQTY', w: 36, tf: true },
      { key: 'boInit', label: 'B/O\nINIT', w: 46, tf: true }, { key: 'boDate', label: 'B/O\nDATE', w: 56, tf: true }
    ];
    const tableW = cols.reduce((s, c) => s + c.w, 0);
    const rowH = 22, hdrH = 30;
    let page, y, fid = 0;
    const head = first => {
      page = pdf.addPage([PW, PH]); y = PH - M;
      if(first){
        page.drawText((list.title || 'PRODUCT LIST') + (list.carNo ? '  —  CAR ' + list.carNo : ''), { x: M, y: y - 16, size: 16, font: bold });
        const info = ['Job #: ' + (job.jobNo || ''), 'Job name: ' + (job.jobName || ''), 'Customer: ' + (job.customer || ''),
          'Rev: ' + (list.rev || ''), 'Ship date: ' + (list.shipDate || ''), 'Exported: ' + new Date().toLocaleString()];
        info.forEach((s, i) => page.drawText(s, { x: M + (i % 3) * 260, y: y - 36 - Math.floor(i / 3) * 13, size: 9, font }));
        y -= 70;
      }
      let cx = M;
      page.drawRectangle({ x: M, y: y - hdrH, width: tableW, height: hdrH, color: rgb(0.92, 0.89, 0.8), borderColor: rgb(0, 0, 0), borderWidth: 1 });
      for(const c of cols){
        page.drawRectangle({ x: cx, y: y - hdrH, width: c.w, height: hdrH, borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
        c.label.split('\n').forEach((t, li) => {
          const tw = bold.widthOfTextAtSize(t, 7);
          page.drawText(t, { x: cx + Math.max(2, (c.w - tw) / 2), y: y - 12 - li * 9, size: 7, font: bold });
        });
        cx += c.w;
      }
      y -= hdrH;
    };
    head(true);
    for(const ln of list.items){
      if(y - rowH < M) head(false);
      let cx = M;
      for(const c of cols){
        page.drawRectangle({ x: cx, y: y - rowH, width: c.w, height: rowH, borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
        if(c.cb){
          const cb = form.createCheckBox('cb_' + (fid++) + '_' + c.key);
          cb.addToPage(page, { x: cx + c.w / 2 - 6, y: y - rowH / 2 - 6, width: 12, height: 12, borderColor: rgb(0, 0, 0), borderWidth: 1 });
          if(ln.st && ln.st[c.key] && ln.st[c.key].on) cb.check();
        } else if(c.tf){
          const tf = form.createTextField('tf_' + (fid++) + '_' + c.key);
          tf.addToPage(page, { x: cx + 2, y: y - rowH + 3, width: c.w - 4, height: rowH - 6, font, borderWidth: 0, backgroundColor: undefined, borderColor: undefined });
          tf.setFontSize(8);
          tf.setText(String(ln[c.key] == null ? '' : ln[c.key]));
        } else {
          let t = String(ln[c.key] == null ? '' : ln[c.key]);
          const maxW = c.w - 6;
          if(font.widthOfTextAtSize(t, 8) > maxW){
            while(t.length > 1 && font.widthOfTextAtSize(t + '…', 8) > maxW) t = t.slice(0, -1);
            t += '…';
          }
          page.drawText(t, { x: cx + 3, y: y - rowH + 8, size: 8, font });
        }
        cx += c.w;
      }
      y -= rowH;
    }
    form.updateFieldAppearances(font);
    return pdf.save();
  }

  function isDone(ln){ return window.Model ? Model.lineStatus(ln) === 'done' : false; }

  async function build(job, list, pdfBytes){
    const withRects = list.items.filter(l => l.fieldRects && l.pageIndex != null).length;
    if(pdfBytes && withRects >= list.items.length * 0.5) return { bytes: await onOriginal(list, pdfBytes), original: true };
    return { bytes: await generated(job, list), original: false };
  }

  function wrapText(txt, font, size, maxWidth){
    const words = String(txt || '').split(/\s+/).filter(Boolean);
    const lines = []; let cur = '';
    for(const w of words){
      const test = cur ? cur + ' ' + w : w;
      if(cur && font.widthOfTextAtSize(test, size) > maxWidth){ lines.push(cur); cur = w; } else cur = test;
    }
    if(cur) lines.push(cur);
    return lines;
  }
  function fmtDL(d){
    if(!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }
  // A real PDF (letter portrait) of the packing slip, for e-mailing - a
  // from-scratch rebuild of the same layout printPackingSlip() renders to
  // the browser's print dialog, since that flow only ever makes a PDF when
  // a person manually chooses "Save as PDF". Single page; a shipment with
  // an unusually long line list will run items off the bottom of the page
  // (no pagination yet) - the printed version remains the complete record.
  async function buildPackingSlip(job, list, sp, items){
    await loadLib();
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const PW = 612, PH = 792, M = 36;
    const page = pdf.addPage([PW, PH]);
    let y = PH - M;
    const hr = yy => page.drawLine({ start: { x: M, y: yy }, end: { x: PW - M, y: yy }, thickness: 1, color: rgb(0, 0, 0) });
    const box = (x, yTop, w, h) => page.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    const txt = (t, x, yy, size, f, color) => page.drawText(String(t == null ? '' : t), { x, y: yy, size: size || 9, font: f || font, color: color || rgb(0, 0, 0) });
    const fit = (t, f, size, maxW) => {
      t = String(t == null ? '' : t);
      if(f.widthOfTextAtSize(t, size) <= maxW) return t;
      while(t.length > 1 && f.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1);
      return t + '…';
    };

    txt('MODERN ELEVATOR', M, y - 14, 14, bold);
    txt('1149 Pioneer Road, Burlington, ON L7M 1K5', M, y - 28, 8);
    txt('tf: 1-866-448-6667   t: 905-523-0040   f: 905-523-0096', M, y - 38, 8);
    const noLbl = 'Packing Slip #:', noLblW = bold.widthOfTextAtSize(noLbl, 9);
    txt(noLbl, PW - M - noLblW, y - 12, 9, bold);
    const noVal = String(sp.packingSlipNo || ''), noValW = bold.widthOfTextAtSize(noVal, 16);
    txt(noVal, PW - M - noValW, y - 32, 16, bold);
    y -= 46; hr(y); y -= 14;

    const tableW = PW - 2 * M;
    const boxW = (tableW - 10) / 2;
    const shipLines = String(job.shipAddr || '').split('\n').filter(Boolean);
    const boxH = Math.max(56, 26 + shipLines.length * 11 + 8 + 14);
    box(M, y, boxW, boxH); box(M + boxW + 10, y, boxW, boxH);
    txt('Invoice To:', M + 6, y - 12, 9, bold);
    txt(fit(job.customer || '', font, 9, boxW - 12), M + 6, y - 26, 9);
    txt('Ship To:', M + boxW + 16, y - 12, 9, bold);
    shipLines.forEach((ln, i) => txt(fit(ln, font, 9, boxW - 20), M + boxW + 16, y - 26 - i * 11, 9));
    txt('Tel#: ' + (sp.contactPhone || ''), M + boxW + 16, y - 26 - shipLines.length * 11 - 8, 9);
    y -= (boxH + 14);

    const colW = tableW / 4, rowHdr = 14, rowVal = 16;
    const infoRow = (labels, values, yTop) => {
      let cx = M;
      for(const l of labels){ box(cx, yTop, colW, rowHdr); txt(l, cx + 3, yTop - 10, 7, bold); cx += colW; }
      cx = M;
      for(const v of values){ box(cx, yTop - rowHdr, colW, rowVal); txt(fit(v, font, 9, colW - 6), cx + 3, yTop - rowHdr - 11, 9); cx += colW; }
    };
    infoRow(['CUSTOMER', 'PROJECT NAME', 'P.O#', 'M.E.I.#'], [job.customer || '', job.jobName || '', sp.poNum || '', job.jobNo || ''], y);
    y -= (rowHdr + rowVal);
    infoRow(['CONTACT', 'F.O.B.', 'DATE SHIPPED', 'SHIP VIA'], [sp.contactName || job.attn || '', sp.fob || '', fmtDL(sp.shipDate), sp.bookedCarrier || ''], y);
    y -= (rowHdr + rowVal + 10);

    box(M, y, tableW, 18);
    txt('FREIGHT TERMS: ' + (sp.freightTerms || ''), M + 6, y - 13, 9, bold);
    y -= (18 + 10);

    const cols = [
      { key: 'p', label: 'Product #', w: tableW * 0.14 }, { key: 'q', label: 'Qty', w: tableW * 0.08 },
      { key: 'd', label: 'Description', w: tableW * 0.38 }, { key: 'qs', label: 'Qty Shipped', w: tableW * 0.14 },
      { key: 'vb', label: 'Verified By', w: tableW * 0.14 }, { key: 'bo', label: 'Qty B.O.', w: tableW * 0.12 }
    ];
    const hdrH = 16, rowH = 15;
    let cx = M;
    for(const c of cols){ box(cx, y, c.w, hdrH); txt(c.label, cx + 3, y - 11, 7, bold); cx += c.w; }
    y -= hdrH;
    if(!items.length){
      box(M, y, tableW, rowH); txt('No lines shipping on this slip', M + 6, y - 11, 8); y -= rowH;
    } else {
      for(const ln of items){
        cx = M;
        const vals = { p: ln.p || '', q: ln.q || '', d: ln.d || '', qs: (ln._qtyShipped != null ? ln._qtyShipped : ln.q) || '', vb: '', bo: ln._bo || '' };
        for(const c of cols){ box(cx, y, c.w, rowH); txt(fit(vals[c.key], font, 8, c.w - 6), cx + 3, y - 11, 8); cx += c.w; }
        y -= rowH;
      }
    }
    y -= 10;

    txt((sp.customerPickup ? '[X]' : '[ ]') + ' Customer Pickup', M, y - 10, 9, bold);
    txt('Print Name: ______________________', M + 170, y - 10, 9);
    txt('Signature: ______________________', M + 380, y - 10, 9);
    y -= 24;

    const specH = 42;
    box(M, y, tableW, specH);
    txt('Special Instruction', M + 6, y - 12, 8, bold);
    wrapText(sp.specialInstruction || '', font, 8, tableW - 12).slice(0, 3).forEach((ln, i) => txt(ln, M + 6, y - 26 - i * 10, 8));
    y -= (specH + 10);

    infoRow(['WEIGHT', '# of SKIDS', 'Shipped by: (Print Name)', 'Signature'],
      [sp.weightKg ? sp.weightKg + ' kg' : '', sp.skidCount || '', '', ''], y);
    y -= (rowHdr + rowVal + 10);

    const qaRowH = 14;
    for(const [lbl, desc] of [['QA: Product List', 'Verified and Signed, included in attached envelope.'], ['QA: Pictures', 'Digital Images have been taken for this Shipment.']]){
      box(M, y, tableW, qaRowH);
      txt(lbl, M + 4, y - 10, 7, bold); txt(desc, M + 120, y - 10, 7); txt('Yes [ ]   No [ ]', PW - M - 80, y - 10, 7);
      y -= qaRowH;
    }
    y -= 10;

    const claims = 'CLAIMS: No claims allowed in regards to quality and quantity unless made within 30 days of receipt of goods. Any claim is limited to the replacement of goods. Title of goods remains with seller until payment received. No goods will be accepted for return without authorization.';
    const claimLines = wrapText(claims, font, 7, tableW);
    claimLines.forEach((ln, i) => txt(ln, M, y - 8 - i * 9, 7));
    y -= (claimLines.length * 9 + 14);

    const footer = 'Accounting (White)    Project File (Yellow)    Customer (Pink)';
    const fw = bold.widthOfTextAtSize(footer, 9);
    txt(footer, M + (tableW - fw) / 2, y, 9, bold);

    return pdf.save();
  }

  return { build, buildPackingSlip, loadLib };
})();
