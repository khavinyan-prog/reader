// Library storage in IndexedDB: book metadata and the PDF files themselves. Nothing leaves the device.
const DB_NAME = 'reader';
const DB_VERSION = 1;
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let out;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const listBooks = () => tx('books', 'readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => (y.lastOpened || 0) - (x.lastOpened || 0)));
export const getBook = (id) => tx('books', 'readonly', (s) => s.get(id));
export const putBook = (meta) => tx('books', 'readwrite', (s) => s.put(meta));
export const getFile = (id) => tx('files', 'readonly', (s) => s.get(id));

export async function putFile(id, blob) {
  try {
    await tx('files', 'readwrite', (s) => s.put(blob, id));
  } catch {
    // Older Safari versions cannot store Blobs; fall back to the raw bytes.
    const buf = await blob.arrayBuffer();
    await tx('files', 'readwrite', (s) => s.put(buf, id));
  }
}

export async function deleteBook(id) {
  await tx('books', 'readwrite', (s) => s.delete(id));
  await tx('files', 'readwrite', (s) => s.delete(id));
}

export async function updatePosition(id, pos) {
  const meta = await getBook(id);
  if (!meta) return;
  meta.pos = pos;
  meta.lastOpened = Date.now();
  await putBook(meta);
}

export function askPersist() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ignore */ }
}
