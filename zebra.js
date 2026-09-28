/* Receiving labels: printed through the browser's own print dialog, so the person can
   pick whatever printer is set up on the tablet (or save as PDF) — no direct printer
   connection needed. Each label carries a QR code with the item's own record as text,
   so a label read anywhere (even offline, even with no app) says what it is and where
   it belongs. */
const Zebra = (() => {
  function payload(r){
    // short keys keep the QR small enough to scan off a 2x1 label
    return JSON.stringify({ c: r.code, t: r.type, j: r.jobNo || '', d: r.description, q: r.qty, u: r.uom || 'EA',
      b: r.bin || '', po: r.po || '', s: r.supplier || '', r: day(r.receivedAt) });
  }
  const day = iso => { if(!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 10) : d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  function qrSvg(text, px){
    const q = qrcode(0, 'M');
    q.addData(unescape(encodeURIComponent(text)));
    q.make();
    const n = q.getModuleCount(), cell = px / n;
    let d = '';
    for(let y = 0; y < n; y++) for(let x = 0; x < n; x++) if(q.isDark(y, x)) d += 'M' + (x * cell).toFixed(2) + ' ' + (y * cell).toFixed(2) + 'h' + cell.toFixed(2) + 'v' + cell.toFixed(2) + 'h-' + cell.toFixed(2) + 'z';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + px + ' ' + px + '"><path d="' + d + '" fill="#000"/></svg>';
  }

  function labelHtml(r, cfg){
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const w = +cfg.w || 2, h = +cfg.h || 1;
    return '<div class="lbl" style="width:' + w + 'in;height:' + h + 'in">' +
      '<div class="lbl-qr">' + qrSvg(payload(r), 200) + '</div><div class="lbl-t">' +
      '<b>' + (r.type === 'stock' ? 'STOCK' : 'JOB ' + esc(r.jobNo)) + '</b>' +
      '<span>' + esc(r.description) + '</span>' +
      '<span>QTY ' + esc(r.qty) + ' ' + esc(r.uom || 'EA') + (r.bin ? ' &middot; BIN ' + esc(r.bin) : '') + '</span>' +
      '<small>' + esc(r.code) + ' &middot; ' + esc(day(r.receivedAt)) + '</small></div></div>';
  }

  return { payload, qrSvg, labelHtml };
})();
