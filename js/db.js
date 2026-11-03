// Thin promise wrapper around IndexedDB. One database, several object stores.

const DB_NAME = 'macrolens';
const DB_VERSION = 1;
let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const make = (name, opts, indexes = []) => {
        if (db.objectStoreNames.contains(name)) return;
        const store = db.createObjectStore(name, opts);
        for (const [idx, key] of indexes) store.createIndex(idx, key);
      };
      make('entries', { keyPath: 'id' }, [['date', 'date']]);
      make('foods', { keyPath: 'id' }, [['barcode', 'barcode'], ['lastUsed', 'lastUsed'], ['source', 'source']]);
      make('settings', { keyPath: 'key' });
      make('days', { keyPath: 'date' });
      make('weights', { keyPath: 'date' });
      make('aiMemory', { keyPath: 'id' });
      make('embeddings', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('[db] upgrade blocked by another tab');
  });
  return dbPromise;
}

const asPromise = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });

export async function get(store, key) {
  const db = await openDB();
  return asPromise(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
  return value;
}

export async function bulkPut(store, values) {
  if (!values.length) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  await done(tx);
}

export async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function bulkDel(store, keys) {
  if (!keys.length) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const k of keys) os.delete(k);
  await done(tx);
}

export async function all(store) {
  const db = await openDB();
  return asPromise(db.transaction(store).objectStore(store).getAll());
}

export async function byIndex(store, index, query) {
  const db = await openDB();
  return asPromise(db.transaction(store).objectStore(store).index(index).getAll(query));
}

export async function count(store) {
  const db = await openDB();
  return asPromise(db.transaction(store).objectStore(store).count());
}

export async function clear(store) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await done(tx);
}

// Ask the browser to never evict our data (granted automatically for installed PWAs on Chrome).
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function storageInfo() {
  const persisted = (await navigator.storage?.persisted?.()) ?? false;
  const est = (await navigator.storage?.estimate?.()) ?? {};
  return { persisted, usage: est.usage || 0, quota: est.quota || 0 };
}
