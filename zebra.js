/* Receiving labels: QR code carrying the item's own record as text, so a label
   read anywhere (even offline, even with no app) says what it is and where it
   belongs. Printed to the Zebra ZD621 over Bluetooth LE (ZPL), or through the
   browser's print dialog as a fallback. */
const Zebra = (() => {
  // Zebra Link-OS BLE "parser" service - same UUIDs the move app used.
  const SVC = '38eb4a80-c570-11e3-9507-0002a5d5c51b';
  const WRITE = '38eb4a82-c570-11e3-9507-0002a5d5c51b';
  let dev = null, ch = null;

  function payload(r){
    // short keys keep the QR small enough to scan off a 2x1 label
    return JSON.stringify({ c: r.code, t: r.type, j: r.jobNo || '', d: r.description, q: r.qty, u: r.uom || 'EA',
      b: r.bin || '', po: r.po || '', s: r.supplier || '', r: day(r.receivedAt) });
  }
  const day = iso => { if(!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 10) : d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const clean = s => String(s == null ? '' : s).replace(/[\^~\\]/g, ' ');

  function zpl(r, cfg){
    const dpi = +cfg.dpi || 203;
    const W = Math.round((+cfg.w || 2) * dpi), H = Math.round((+cfg.h || 1) * dpi);
    const mag = dpi >= 300 ? 4 : 3;
    const qrPx = Math.min(H - 20, 150 * (dpi / 203));
    const tx = Math.round(qrPx + 24);
    const fs = Math.round(dpi / 203 * 22), fsS = Math.round(dpi / 203 * 18);
    const maxCh = Math.max(10, Math.floor((W - tx - 8) / (fsS * 0.55)));
    const cut = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1) + '.' : s; };
    const lines = [
      [fs, (r.type === 'stock' ? 'STOCK' : 'JOB ' + cut(r.jobNo, maxCh - 4))],
      [fsS, cut(r.description, maxCh)],
      [fsS, cut(r.description.length > maxCh ? r.description.slice(maxCh - 1) : '', maxCh)],
      [fsS, 'QTY ' + clean(r.qty) + ' ' + clean(r.uom || 'EA') + (r.bin ? '  BIN ' + cut(r.bin, 12) : '')],
      [fsS, clean(r.code) + '  ' + day(r.receivedAt)]
    ].filter(l => l[1]);
    let y = 14, out = '^XA^CI28^PW' + W + '^LL' + H + '^LH0,0';
    out += '^FO10,10^BQN,2,' + mag + '^FDLA,' + clean(payload(r)) + '^FS';
    for(const [size, t] of lines){ out += '^FO' + tx + ',' + y + '^A0N,' + size + ',' + size + '^FD' + t + '^FS'; y += size + 8; }
    return out + '^XZ';
  }

  async function connect(){
    if(!navigator.bluetooth) throw new Error('This browser has no Bluetooth. Use Chrome on the Android tablet, or "Print (browser)".');
    if(!dev){
      dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SVC] });
      dev.addEventListener('gattserverdisconnected', () => { ch = null; });
    }
    if(!dev.gatt.connected || !ch){
      const server = await dev.gatt.connect();
      let svc;
      try{ svc = await server.getPrimaryService(SVC); }
      catch(e){
        const all = await server.getPrimaryServices().catch(() => []);
        throw new Error('Printer found but the Zebra print service was not. Services it reports: ' + (all.map(s => s.uuid).join(', ') || 'none'));
      }
      ch = await svc.getCharacteristic(WRITE);
    }
    return dev.name || 'Zebra';
  }

  async function send(text){
    await connect();
    const bytes = new TextEncoder().encode(text);
    for(let i = 0; i < bytes.length; i += 180){
      const part = bytes.slice(i, i + 180);
      if(ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(part);
      else await ch.writeValue(part);
      await new Promise(r => setTimeout(r, 25));
    }
  }

  async function print(r, cfg){ await send(zpl(r, cfg)); }

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

  return { print, zpl, payload, qrSvg, labelHtml, connect, supported: () => !!navigator.bluetooth };
})();
