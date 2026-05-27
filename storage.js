/**
 * storage.js
 * IndexedDB: 画像Blob + ピース状態
 * localStorage: 軽量メタ情報（フラグ・難易度・経過時間）
 */

const DB_NAME = 'oshiPuzzleDB';
const DB_VERSION = 1;
const STORE_NAME = 'puzzleState';
const LS_KEY = 'oshiPuzzleMeta';

let db = null;

export async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_NAME)) {
        d.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveState({ imageBlob, pieces, cols, rows, elapsed, vW, vH }) {
  await dbPut({ id: 'current', imageBlob, pieces });
  localStorage.setItem(LS_KEY, JSON.stringify({ exists: true, cols, rows, elapsed, savedAt: Date.now(), vW, vH }));
}

export async function loadState() {
  const meta = localStorage.getItem(LS_KEY);
  if (!meta) return null;
  const { exists, cols, rows, elapsed, vW, vH } = JSON.parse(meta);
  if (!exists) return null;
  const record = await dbGet('current');
  if (!record) return null;
  return { imageBlob: record.imageBlob, pieces: record.pieces, cols, rows, elapsed, vW, vH };
}

export async function clearState() {
  await dbDelete('current');
  localStorage.removeItem(LS_KEY);
}

export function hasSavedState() {
  const meta = localStorage.getItem(LS_KEY);
  if (!meta) return false;
  try { return JSON.parse(meta).exists === true; } catch { return false; }
}
