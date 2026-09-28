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
  return { build, loadLib };
})();
