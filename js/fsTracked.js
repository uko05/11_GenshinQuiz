// fsTracked.js
// 読み取り件数の集計(2026-10-07〜10-11の調査用)は終了した。各ファイルは firebase-firestore.js を直接使うように戻してある。
// このファイルは、ブラウザに古いプログラムが残っている間に読み込まれても動くよう、集計せずに元の関数をそのまま渡すだけ。
// 数日たったら削除してよい(2026-10-11)。
export { onSnapshot, getDocs, getDoc, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
