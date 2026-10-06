// ============================================================
// UQ（うこクイズ）メインアプリ
// ============================================================

import { initializeApp, getApps, getApp } from
  "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, updateDoc, collection, query, where, serverTimestamp, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getDoc, getDocs, onSnapshot } from './fsTracked.js'; // 読み取り件数の集計(調査用、fsTracked.js参照)
import { APP_VERSION } from './version.js';

// ============================================================
// 定数  ← アプリ名・ゲーム設定はここだけ変える
// ============================================================
const APP_NAME           = '原神クイズ王';
const ROUND_SEC          = 20;    // 回答受付時間（秒）
const RESULT_SEC         = 6;     // 結果表示時間（秒）
const ANSWER_COOLDOWN_MS = 800;   // 誤答後の再送信禁止時間（ms）

// チャット色プリセット（12色）
const CHAT_COLORS = [
  '#ff8c00', // オレンジ（デフォルト）
  '#ffd700', // 黄色
  '#00bcd4', // 水色
  '#ff69b4', // ピンク
  '#4caf50', // 緑
  '#f44336', // 赤
  '#9c27b0', // 紫
  '#000000', // 黒
  '#ffc107', // 金
  '#8bc34a', // 黄緑
  '#26c6da', // シアン
  '#ff6b6b', // サーモンピンク
];

// ============================================================
// グローバル状態
// ============================================================
let db;
let clientId;
let questions       = [];
let currentQuestion = null;
let currentState    = null;

let timerInterval      = null;
let correctUnsub       = null;

let isAdminMode        = false; // sharedUserRolesから取得(loadAdminRole参照)
let isAnswerLocked     = false;
let isInCooldown       = false;
let roundEndAttempted   = false;  // このラウンドで遷移を試みたか
let roundStartAttempted = false;  // このrevealingで遷移を試みたか
let offlineMode         = false;  // Firestore接続不可時のオフラインモード
let isPageVisible       = true;   // Page Visibility API: タブ表示中かどうか

// チャット状態
let chatSentCount  = 0;
let chatRoundId    = null;
let chatUnsub      = null;
let selectedColor  = localStorage.getItem('uq_chatColor') || '#ff8c00';
const LANE_COUNT   = 6;
const laneActive   = new Array(LANE_COUNT).fill(false);

// ============================================================
// エントリーポイント
// ============================================================
async function init() {
  document.getElementById('appTitle').textContent = APP_NAME;
  document.getElementById('version').textContent = APP_VERSION;

  // クライアントIDを取得 or 生成
  clientId = localStorage.getItem('uq_clientId');
  if (!clientId) {
    clientId = 'c_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now();
    localStorage.setItem('uq_clientId', clientId);
  }

  // 名前を復元
  const savedName = localStorage.getItem('uq_name');
  if (savedName) document.getElementById('nameInput').value = savedName;
  updateAdminIndicator();

  // 問題データ読み込み
  try {
    const res = await fetch('data/questions.json');
    const raw = await res.json();
    questions = raw.filter(q => q.prompt?.trim() && q.answer?.trim());
    if (!questions.length) throw new Error('有効な問題が0件');
  } catch (e) {
    setLoading('問題の読み込みに失敗しました。再読み込みしてください。');
    console.error(e);
    return;
  }

  // Firebase 初期化
  try {
    // account-status.js が先に同じデフォルトAppを作っている場合があるので、あれば使い回す
    const app = getApps().length ? getApp() : initializeApp(window.FIREBASE_CONFIG);
    db = getFirestore(app);
  } catch (e) {
    setLoading('Firebase初期化に失敗しました。firebase-config.jsを確認してください。');
    console.error(e);
    return;
  }
  await loadAdminRole();

  // タブの表示・非表示を監視してタイマーを制御（Firestore書き込み節約）
  isPageVisible = !document.hidden;
  document.addEventListener('visibilitychange', () => {
    isPageVisible = !document.hidden;
    if (isPageVisible && currentState) {
      // タブ復帰 → 現在の状態に合わせてタイマー再開
      onStateChange(currentState);
    } else {
      // タブ非表示 → タイマー停止（遷移処理が走らなくなる）
      clearInterval(timerInterval);
    }
  });

  // state/current をリアルタイム監視
  // 3秒以内に応答がなければオフラインモードへ
  let firstSnapReceived = false;
  const connectionTimeout = setTimeout(() => {
    if (!firstSnapReceived) {
      console.warn('[UQ] Firestore接続タイムアウト → オフラインモード');
      startOfflineMode('timeout');
    }
  }, 3000);

  const stateRef = doc(db, 'quizState', 'current');
  onSnapshot(stateRef, (snap) => {
    clearTimeout(connectionTimeout);
    firstSnapReceived = true;
    if (!snap.exists()) {
      firstRound();
    } else {
      onStateChange(snap.data());
    }
  }, (err) => {
    clearTimeout(connectionTimeout);
    firstSnapReceived = true;
    const category = categorizeFirestoreError(err);
    console.error(`[UQ] Firestore接続エラー [${category}]:`, err.message);
    startOfflineMode(category);
  });
}

// ============================================================
// 状態変化ハンドラ
// ============================================================
function onStateChange(state) {
  const prevRoundId = currentState?.roundId;
  currentState      = state;
  currentQuestion   = questions.find(q => q.id === state.questionId) || null;

  if (state.status === 'running') {
    setActiveScreen('quizScreen');
    renderQuestion();
    startLocalTimer();

    if (prevRoundId !== state.roundId) {
      resetInput();
      resetChat(state.roundId);
    }

    subscribeCorrectCount(state.roundId);

  } else if (state.status === 'revealing') {
    setActiveScreen('resultScreen');
    renderResult();
  }
}

// ============================================================
// Quiz UI
// ============================================================
function renderQuestion() {
  if (!currentQuestion) return;

  document.getElementById('questionText').textContent = currentQuestion.prompt;

  const container = document.getElementById('imageContainer');
  const img       = document.getElementById('questionImage');

  if (currentQuestion.image) {
    img.src = 'img/' + currentQuestion.image;
    container.style.display = 'flex';
  } else {
    container.style.display = 'none';
  }
}

function startLocalTimer() {
  clearInterval(timerInterval);
  roundEndAttempted = false;
  const el = document.getElementById('timerDisplay');

  timerInterval = setInterval(() => {
    if (!currentState) return;
    const remaining = Math.max(0, currentState.endsAtMs - Date.now());
    const secs      = Math.ceil(remaining / 1000);
    el.textContent  = `残り ${secs}秒`;
    el.classList.toggle('urgent', secs <= 5);

    // 時間切れ → 遷移（タブ非表示時はスキップ）
    if (remaining === 0 && !roundEndAttempted && isPageVisible) {
      roundEndAttempted = true;
      if (offlineMode) startOfflineReveal();
      else             transitionToRevealing();
    }
  }, 500);
}

// ============================================================
// Result UI
// ============================================================
function renderResult() {
  const top3   = currentState?.top3    || [];
  const answer = currentState?.answerText || '';

  const listEl = document.getElementById('top3List');
  listEl.innerHTML = '';

  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < 3; i++) {
    const item = document.createElement('div');
    item.className = 'top3-item';
    const name = top3[i]?.name ?? '—';
    item.innerHTML =
      `<span class="top3-rank">${medals[i]}</span>` +
      `<span class="top3-name">${escapeHtml(name)}</span>`;
    listEl.appendChild(item);
  }

  document.getElementById('answerReveal').innerHTML =
    `<span class="label">こたえ</span>${escapeHtml(answer)}`;

  // 答え画像
  const answerImgContainer = document.getElementById('answerImageContainer');
  const answerImg          = document.getElementById('answerImage');
  const answerImage        = currentQuestion?.answerimage || null;
  if (answerImage) {
    answerImg.src = 'img/' + answerImage;
    answerImgContainer.style.display = 'flex';
  } else {
    answerImgContainer.style.display = 'none';
  }

  startResultCountdown();
}

function startResultCountdown() {
  clearInterval(timerInterval);
  roundStartAttempted = false;
  const el           = document.getElementById('nextCountdown');
  const revealEndsAt = (currentState?.endsAtMs || Date.now()) + RESULT_SEC * 1000;

  timerInterval = setInterval(() => {
    const remaining = Math.max(0, revealEndsAt - Date.now());
    const secs      = Math.ceil(remaining / 1000);
    el.textContent  = secs > 0 ? `次の問題まで：${secs}秒` : '次の問題へ…';

    // 結果表示終了 → 次ラウンドへ（タブ非表示時はスキップ）
    if (remaining === 0 && !roundStartAttempted && isPageVisible) {
      roundStartAttempted = true;
      if (!offlineMode) transitionToRunning();
      // オフライン時は startOfflineReveal() の setTimeout が次ラウンドを開始
    }
  }, 500);
}

// ============================================================
// ラウンド遷移（全クライアントが試みる・トランザクションで1回だけ実行）
// ============================================================

/** running → revealing */
async function transitionToRevealing() {
  if (!currentState || currentState.status !== 'running') return;

  const roundId = currentState.roundId;
  const answer  = currentQuestion?.answer || '';

  // TOP3 取得（orderByを使わずクライアント側でソート → 複合インデックス不要）
  let top3 = [];
  try {
    const q    = query(
      collection(db, 'quizAnswers'),
      where('roundId', '==', roundId)
    );
    const snap = await getDocs(q);
    top3 = snap.docs
      .map(d => d.data())
      .sort((a, b) => (a.answeredAtMs ?? 0) - (b.answeredAtMs ?? 0))
      .slice(0, 3)
      .map(d => ({ name: d.name }));
  } catch (e) {
    console.error('TOP3取得失敗:', e);
  }

  try {
    const stateRef = doc(db, 'quizState', 'current');
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      const data = snap.data();
      // 別クライアントが先に更新済み、またはラウンドが変わった場合はスキップ
      if (data?.status !== 'running' || data?.roundId !== roundId) return;
      tx.update(stateRef, {
        status:           'revealing',
        top3:             top3,
        answerText:       answer,
        leaderId:         clientId,
        leaderLastSeenMs: Date.now()
      });
    });
  } catch (e) {
    console.error('revealing遷移失敗:', e);
  }
}

/** revealing → running */
async function transitionToRunning() {
  if (!currentState || currentState.status !== 'revealing') return;

  const now = Date.now();

  try {
    const stateRef = doc(db, 'quizState', 'current');
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      const data = snap.data();
      // 別クライアントが先に更新済みの場合はスキップ
      if (data?.status !== 'revealing') return;
      const lastQuestionIds = data.lastQuestionIds || [];
      const question = pickQuestion(lastQuestionIds);
      tx.set(stateRef, {
        roundId:          generateId(),
        questionId:       question.id,
        status:           'running',
        startedAt:        serverTimestamp(),
        endsAtMs:         now + ROUND_SEC * 1000,
        answerText:       '',
        top3:             [],
        leaderId:         clientId,
        leaderLastSeenMs: now,
        lastQuestionIds:  [...lastQuestionIds.slice(-49), question.id]
      });
    });
  } catch (e) {
    console.error('running遷移失敗:', e);
  }
}

/** 初回ラウンド作成（ドキュメントなし時）*/
async function firstRound() {
  const stateRef = doc(db, 'quizState', 'current');
  const question = pickQuestion();
  const now      = Date.now();
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stateRef);
      if (snap.exists()) return; // 別クライアントが先に作成済み
      tx.set(stateRef, {
        roundId:          generateId(),
        questionId:       question.id,
        status:           'running',
        startedAt:        serverTimestamp(),
        endsAtMs:         now + ROUND_SEC * 1000,
        answerText:       '',
        top3:             [],
        leaderId:         clientId,
        leaderLastSeenMs: now,
        lastQuestionIds:  [question.id]
      });
    });
  } catch (e) {
    console.error('初回ラウンド作成失敗:', e);
  }
}

// ============================================================
// 回答処理
// ============================================================
function setupAnswerForm() {
  const submitBtn   = document.getElementById('submitBtn');
  const answerInput = document.getElementById('answerInput');
  const nameInput   = document.getElementById('nameInput');

  submitBtn.addEventListener('click', handleSubmit);
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSubmit();
  });

  nameInput.addEventListener('change', () => {
    const val = sanitizeName(nameInput.value.trim());
    nameInput.value = val;
    localStorage.setItem('uq_name', val);
  });
}

async function handleSubmit() {
  if (isAnswerLocked || isInCooldown)     return;
  if (currentState?.status !== 'running') return;
  if (!currentQuestion)                   return;

  const nameInput   = document.getElementById('nameInput');
  const answerInput = document.getElementById('answerInput');
  const name        = nameInput.value.trim();

  if (!name) {
    flashBorder(nameInput);
    nameInput.focus();
    return;
  }

  if (!answerInput.value.trim()) return;

  const input   = normalizeAnswer(answerInput.value);
  const correct = normalizeAnswer(currentQuestion.answer);

  if (input === correct) {
    if (!offlineMode) await saveCorrectAnswer(name);
    showCorrectMessage();
    lockInput();
  } else {
    answerInput.value = '';
    flashBorder(answerInput);
    setCooldown();
  }
}

function normalizeAnswer(str) {
  return katakanaToHiragana(str.trim()).replace(/\s/g, '');
}

function katakanaToHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

async function saveCorrectAnswer(name) {
  const ref = doc(db, 'quizAnswers', clientId + '_' + currentState.roundId);
  try {
    await setDoc(ref, {
      roundId:      currentState.roundId,
      clientId:     clientId,
      name:         name,
      answeredAt:   serverTimestamp(),
      answeredAtMs: Date.now(),
      questionId:   currentState.questionId,
      expiresAt:    new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
  } catch (e) {
    console.error('正解保存失敗:', e);
  }
}

function lockInput() {
  isAnswerLocked = true;
  document.getElementById('answerInput').disabled = true;
  document.getElementById('submitBtn').disabled   = true;
}

function resetInput() {
  isAnswerLocked = false;
  isInCooldown   = false;
  const answerInput = document.getElementById('answerInput');
  answerInput.disabled = false;
  answerInput.value    = '';
  document.getElementById('submitBtn').disabled = false;
  document.getElementById('correctMessage').classList.add('hidden');
  document.getElementById('correctCount').textContent = '正解者: 0人';
}

function showCorrectMessage() {
  document.getElementById('correctMessage').classList.remove('hidden');
}

function setCooldown() {
  isInCooldown = true;
  document.getElementById('submitBtn').disabled = true;
  setTimeout(() => {
    isInCooldown = false;
    if (!isAnswerLocked) {
      document.getElementById('submitBtn').disabled = false;
    }
  }, ANSWER_COOLDOWN_MS);
}

function flashBorder(el) {
  el.style.borderColor = 'var(--wrong)';
  setTimeout(() => { el.style.borderColor = ''; }, 700);
}

// ============================================================
// 正解者数 リアルタイム購読
// ============================================================
function subscribeCorrectCount(roundId) {
  if (offlineMode) return;
  if (correctUnsub) correctUnsub();
  const q = query(collection(db, 'quizAnswers'), where('roundId', '==', roundId));
  correctUnsub = onSnapshot(q, (snap) => {
    document.getElementById('correctCount').textContent = `正解者: ${snap.size}人`;
  }, (e) => {
    console.error('正解者数購読エラー:', e);
  });
}

// ============================================================
// オフラインモード
// ============================================================

/** エラー原因をカテゴリ分けしてコンソールに出す */
function categorizeFirestoreError(err) {
  const msg  = err?.message || '';
  const code = err?.code    || '';
  if (code === 'permission-denied' || msg.includes('403'))          return 'permission-denied';
  if (msg.includes('has not been used') || msg.includes('disabled')) return 'api-disabled';
  if (msg.includes('blocked') || msg.includes('ERR_BLOCKED'))        return 'blocked/client';
  return 'unknown';
}

/** Firestore 接続不可 → エラー表示してオフラインゲームを開始 */
function startOfflineMode(reason) {
  offlineMode = true;
  const labels = {
    'timeout':           'Firestoreに接続できません（タイムアウト）',
    'permission-denied': 'Firestoreのルール/権限エラー（403）',
    'api-disabled':      'Firestore APIが未有効です',
    'blocked/client':    '通信がブロックされています（拡張機能を確認）',
    'unknown':           'Firestore接続エラー'
  };
  const msg = labels[reason] || labels['unknown'];
  setLoading(`⚠ ${msg} — オフラインモードで起動します...`);
  setTimeout(() => startOfflineRound(), 2000);
}

/** オフライン: 次の問題を始める */
function startOfflineRound() {
  currentQuestion = pickQuestion();
  currentState = {
    roundId:    'offline',
    questionId: currentQuestion.id,
    status:     'running',
    endsAtMs:   Date.now() + ROUND_SEC * 1000,
    top3:       [],
    answerText: ''
  };
  setActiveScreen('quizScreen');
  renderQuestion();
  startLocalTimer();
  resetInput();
  resetChat(null);
  document.getElementById('correctCount').textContent = 'オフラインモード';
}

/** オフライン: 結果画面を表示して次のラウンドへ */
function startOfflineReveal() {
  currentState = { ...currentState, status: 'revealing' };
  renderResult();
  setTimeout(() => startOfflineRound(), RESULT_SEC * 1000);
}

// ============================================================
// チャット
// ============================================================
function setupChatForm() {
  const toggleBtn = document.getElementById('colorToggleBtn');
  const palette   = document.getElementById('colorPalette');
  const sendBtn   = document.getElementById('chatSendBtn');
  const chatInput = document.getElementById('chatInput');

  toggleBtn.style.background = selectedColor;

  CHAT_COLORS.forEach(color => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-btn' + (color === selectedColor ? ' selected' : '');
    btn.style.background = color;
    btn.addEventListener('click', () => {
      selectedColor = color;
      toggleBtn.style.background = color;
      localStorage.setItem('uq_chatColor', color);
      palette.classList.add('hidden');
      palette.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    palette.appendChild(btn);
  });

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    palette.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.chat-color-wrap')) palette.classList.add('hidden');
  });

  sendBtn.addEventListener('click', handleChatSend);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleChatSend(); });
}

function handleChatSend() {
  if (chatSentCount >= 3) return;
  const chatInput = document.getElementById('chatInput');
  const nameInput = document.getElementById('nameInput');
  const text = chatInput.value.trim();
  const name = nameInput.value.trim();
  if (!name) { flashBorder(nameInput); nameInput.focus(); return; }
  if (!text) return;

  chatInput.value = '';
  chatSentCount++;
  if (chatSentCount >= 3) document.getElementById('chatSendBtn').disabled = true;

  renderFlyingComment(name, text, selectedColor, isAdminMode);

  if (!offlineMode && chatRoundId) {
    const ref = doc(db, 'quizMessages', `${clientId}_${chatSentCount}_${chatRoundId}`);
    setDoc(ref, {
      roundId:   chatRoundId,
      clientId,
      text,
      name,
      color:     selectedColor,
      isAdmin:   isAdminMode,
      sentAt:    serverTimestamp(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000 * 3)
    }).catch(e => console.error('チャット送信失敗:', e));
  }
}

function subscribeChat(roundId) {
  if (chatUnsub) chatUnsub();
  let isFirst = true;
  // orderBy を使わない → 複合インデックス不要
  const q = query(
    collection(db, 'quizMessages'),
    where('roundId', '==', roundId)
  );
  chatUnsub = onSnapshot(q, snap => {
    if (isFirst) { isFirst = false; return; }
    snap.docChanges().forEach(ch => {
      if (ch.type === 'added' && ch.doc.data().clientId !== clientId) {
        const d = ch.doc.data();
        renderFlyingComment(d.name || '名無し', d.text, d.color, d.isAdmin === true);
      }
    });
  }, (e) => {
    console.error('チャット購読エラー:', e);
  });
}

function resetChat(roundId) {
  chatSentCount = 0;
  chatRoundId   = roundId;
  document.getElementById('chatSendBtn').disabled = false;
  if (!offlineMode && roundId) subscribeChat(roundId);
}

function renderFlyingComment(name, text, color, isAdmin = false) {
  const overlay = document.getElementById('commentOverlay');
  let lane = laneActive.findIndex(v => !v);
  if (lane === -1) lane = Math.floor(Math.random() * LANE_COUNT);
  laneActive[lane] = true;

  const displayName = isAdmin ? `🔧${name}` : name;
  const el = document.createElement('div');
  el.className   = 'fly-comment' + (isAdmin ? ' fly-comment--admin' : '');
  el.textContent = `${displayName}：${text}`;
  el.style.color = color;
  el.style.top   = `${lane * (80 / LANE_COUNT) + 5}%`;
  overlay.appendChild(el);

  el.addEventListener('animationend', () => {
    laneActive[lane] = false;
    el.remove();
  });
}

// ============================================================
// 画面管理
// ============================================================
function setActiveScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setLoading(msg) {
  setActiveScreen('loadingScreen');
  if (msg) document.querySelector('.loading-text').textContent = msg;
}

// ============================================================
// ユーティリティ
// ============================================================
function pickQuestion(excludeIds = []) {
  const pool = excludeIds.length ? questions.filter(q => !excludeIds.includes(q.id)) : questions;
  const src = pool.length ? pool : questions;
  return src[Math.floor(Math.random() * src.length)];
}

function generateId() {
  return 'r_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now();
}

// 🔧 を名前から除去（なりすまし防止）
function sanitizeName(name) {
  return name.replace(/🔧/g, '').trim();
}

// 管理者モードの視覚インジケーター更新（名前欄の枠色）
function updateAdminIndicator() {
  const el = document.getElementById('nameInput');
  if (!el) return;
  el.style.borderColor = isAdminMode ? '#FFD700' : '';
  el.title = isAdminMode ? '🔧 管理者モード中' : '';
}

// うこ氏サイト群共通ID（同一オリジンのlocalStorageを共有する前提。omikuji/userData.jsのgetUserId()と同じロジック）
function getSharedUserId() {
  let id = localStorage.getItem('genshinOmikuji_userId');
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = 'u_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('genshinOmikuji_userId', id);
  }
  return id;
}

// 管理者ロールをsharedUserRolesから取得(genshin-bakatare01に統合済みなのでdbをそのまま使う)
async function loadAdminRole() {
  try {
    const snap = await getDoc(doc(db, 'sharedUserRoles', getSharedUserId()));
    isAdminMode = !!(snap.exists() && snap.data().role === 'admin');
  } catch (e) {
    console.warn('[UQ] 管理者ロール取得に失敗:', e);
  }
  updateAdminIndicator();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// 起動
// ============================================================
setupAnswerForm();
setupChatForm();
init();
