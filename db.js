/* On-device storage (IndexedDB). Every read/write in the app goes through DB,
   so moving to a shared backend later means rewriting this file only. */
const DB = (() => {
  const NAME = 'meii-shopfloor', VERSION = 2;
  const STORES = { jobs: 'id', lists: 'id', pdfs: 'id', receipts: 'id', spools: 'id', settings: 'k' };
  let dbp = null;

  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        for(const [s, key] of Object.entries(STORES)){
          if(!d.objectStoreNames.contains(s)){
            const os = d.createObjectStore(s, { keyPath: key });
            if(s === 'lists') os.createIndex('jobId', 'jobId');
            if(s === 'receipts') os.createIndex('jobNo', 'jobNo');
          }
        }
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn){
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const os = t.objectStore(store);
      let out;
      Promise.resolve(fn(os)).then(v => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  return {
    get: (s, k) => tx(s, 'readonly', os => req(os.get(k))),
    all: s => tx(s, 'readonly', os => req(os.getAll())),
    put: (s, v) => tx(s, 'readwrite', os => req(os.put(v))),
    putMany: (s, arr) => tx(s, 'readwrite', os => { arr.forEach(v => os.put(v)); }),
    del: (s, k) => tx(s, 'readwrite', os => req(os.delete(k))),
    clear: s => tx(s, 'readwrite', os => req(os.clear())),
    async setting(k, dflt){ const r = await this.get('settings', k); return r ? r.v : dflt; },
    setSetting(k, v){ return this.put('settings', { k, v }); },
    STORES: Object.keys(STORES)
  };
})();
