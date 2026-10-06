// fsTracked.js
// Firestore の読み取り件数を、コレクションごとに数えて日別に集計する(2026-10-07、一時的な調査用)。
// onSnapshot / getDocs / getDoc / getCountFromServer を、数えながら元の関数を呼ぶ版に差し替えている。
// 画面には何も出さず、集計の書き込みに失敗しても何もしない。
// 集計先: readStats/{日本時間の日付} の c.{サイト|コレクション|種類} に件数を足す(管理者だけが読める)。
// 調査が終わったら、各ファイルの import を "firebase-firestore.js" に戻してこのファイルを消す。
import * as F from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";

const SITE = (location.pathname.split('/').filter(Boolean)[0] || 'root').slice(0, 30);
const FLUSH_MS = 5 * 60 * 1000;
let counts = {};

function collOf(x) {
  try {
    if (x && x.type === 'document') return x.parent ? x.parent.id : 'doc';
    if (x && x.type === 'collection') return x.id;
    const q = x && x._query;
    if (q) return q.collectionGroup || (q.path && q.path.lastSegment && q.path.lastSegment()) || 'query';
  } catch (e) { /* 数えられなくても動作には影響させない */ }
  return 'unknown';
}
function add(x, kind, n) {
  if (!n) return;
  const key = `${SITE}|${collOf(x)}|${kind}`.replace(/[.\/\[\]*`~]/g, '_');
  counts[key] = (counts[key] || 0) + n;
}

async function flush() {
  const entries = Object.entries(counts);
  if (!entries.length) return;
  counts = {};
  try {
    const db = F.getFirestore(getApp());
    const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const c = {};
    entries.forEach(([k, v]) => { c[k] = F.increment(v); });
    await F.setDoc(F.doc(db, 'readStats', day), { c, updatedAt: F.serverTimestamp() }, { merge: true });
  } catch (e) { /* 集計できなくても何もしない */ }
}
setInterval(flush, FLUSH_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
window.addEventListener('pagehide', flush);

export function onSnapshot(ref, ...args) {
  let firstServer = true;
  const i = args.findIndex((a) => typeof a === 'function');
  if (i >= 0) {
    const cb = args[i];
    args[i] = (snap) => {
      try {
        if (!snap.metadata.fromCache) {
          if (typeof snap.docChanges === 'function') {
            add(ref, 'listen', firstServer ? snap.size : snap.docChanges().length);
          } else {
            add(ref, 'listenDoc', 1);
          }
          firstServer = false;
        }
      } catch (e) { /* 無視 */ }
      return cb(snap);
    };
  }
  return F.onSnapshot(ref, ...args);
}
export async function getDocs(q) {
  const snap = await F.getDocs(q);
  try { if (!snap.metadata.fromCache) add(q, 'getDocs', snap.size || 1); } catch (e) { /* 無視 */ }
  return snap;
}
export async function getDoc(ref) {
  const snap = await F.getDoc(ref);
  try { if (!snap.metadata.fromCache) add(ref, 'getDoc', 1); } catch (e) { /* 無視 */ }
  return snap;
}
export async function getCountFromServer(q) {
  const r = await F.getCountFromServer(q);
  add(q, 'count', 1);
  return r;
}
