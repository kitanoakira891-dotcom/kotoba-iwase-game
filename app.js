import {firebaseConfig} from './firebase-config.js';
import {initializeApp} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import {getAuth, signInAnonymously} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import {getFirestore, doc, getDoc, getDocs, collection, deleteDoc, onSnapshot, serverTimestamp, runTransaction, writeBatch, query, orderBy, where} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const DEFAULT_WORDS = [
  {text:'いや',points:1},{text:'でも',points:1},{text:'いや～でも～',points:1},
  {text:'ん～（甘え声）',points:2},
  {text:'ラニーニャ',points:3},{text:'エルニーニョ',points:3},{text:'スノボ',points:3},
  {text:'あれので',points:4},{text:'これので',points:4},{text:'それので',points:4},{text:'あれじゃない？（言うことを考える時間稼ぎ）',points:4},
  {text:'マウント',points:5},{text:'腹減った',points:5},{text:'ニセコでスマホを無くした話',points:5},{text:'紅ショウガの許可申請',points:5},{text:'モンストコラボの話',points:5},
  {text:'近ちゃんはそんなこと言わない',points:10}
];
const MAIN_ROOM = 'MAIN00';

const $ = selector => document.querySelector(selector);
let db;
let user;
let room = '';
let words = [];
let members = [];
let memberWords = [];
let unsubscribers = [];
let toastTimer;

function isConfigured(config) {
  const required = ['apiKey','authDomain','projectId','appId'];
  return required.every(key => typeof config[key] === 'string' && config[key].trim() && !config[key].includes('YOUR_'));
}

function setStatus(text, type) {
  $('#status').textContent = text;
  $('#status').className = `status ${type}`;
}

function toast(text) {
  const element = $('#toast');
  element.textContent = text;
  element.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.add('hidden'), 2300);
}

function playerName() {
  return $('#playerName').value.trim() || localStorage.getItem('kp-name') || '';
}

function accent(points) {
  return points >= 10 ? '#c72f45' : points >= 5 ? '#e0782d' : points >= 4 ? '#bd8b12' : points >= 3 ? '#2f8b68' : points >= 2 ? '#2b78ba' : '#6656e8';
}

function finiteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function init() {
  $('#playerName').value = localStorage.getItem('kp-name') || '';
  if (!isConfigured(firebaseConfig)) {
    setStatus('Firebase要設定', 'bad');
    toast('firebase-config.jsを設定してください');
    return;
  }

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  db = getFirestore(app);
  const credential = await signInAnonymously(auth);
  user = credential.user;
  setStatus('オンライン', 'ok');
  $('#joinBtn').disabled = false;
  if (playerName()) await joinRoom();
}

async function joinRoom() {
  if (!user) return toast('接続中です');
  const name = playerName();
  if (!name) return toast('表示名を入力してください');
  localStorage.setItem('kp-name', name);
  const roomRef = doc(db, 'rooms', MAIN_ROOM);
  await runTransaction(db, async transaction => {
    const existing = await transaction.get(roomRef);
    if (existing.exists()) return;
    transaction.set(roomRef, {createdAt:serverTimestamp()});
    DEFAULT_WORDS.forEach((word, index) => {
      const wordRef = doc(collection(db, 'rooms', MAIN_ROOM, 'words'));
      transaction.set(wordRef, {...word, count:0, totalScore:0, order:index, createdAt:serverTimestamp(), updatedAt:serverTimestamp()});
    });
  });
  await enter(MAIN_ROOM);
}

async function enter(code, snapshot) {
  snapshot = snapshot || await getDoc(doc(db, 'rooms', code));
  if (!snapshot.exists()) throw new Error('部屋が見つかりません');
  room = code;
  $('#setup').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#roomCode').textContent = 'みんなの部屋';
  $('#role').textContent = '全員が言葉と得点を編集できます';

  const memberRef = doc(db, 'rooms', code, 'members', user.uid);
  await runTransaction(db, async transaction => {
    const current = await transaction.get(memberRef);
    if (current.exists()) {
      transaction.update(memberRef, {name:playerName(), updatedAt:serverTimestamp()});
    } else {
      transaction.set(memberRef, {uid:user.uid, name:playerName(), joinedAt:serverTimestamp(), updatedAt:serverTimestamp()});
    }
  });

  unsubscribers.forEach(stop => stop());
  unsubscribers = [];
  unsubscribers.push(onSnapshot(
    query(collection(db, 'rooms', code, 'words'), orderBy('order')),
    snapshot => {
      words = snapshot.docs.map(item => ({id:item.id, ...item.data()}));
      render();
      renderMembers();
    },
    error => toast(`同期エラー: ${error.message}`)
  ));
  unsubscribers.push(onSnapshot(
    collection(db, 'rooms', code, 'members'),
    snapshot => {
      members = snapshot.docs.map(item => ({id:item.id, ...item.data()}));
      renderMembers();
    },
    error => toast(`参加者の同期エラー: ${error.message}`)
  ));
  unsubscribers.push(onSnapshot(
    collection(db, 'rooms', code, 'memberWords'),
    snapshot => {
      memberWords = snapshot.docs.map(item => ({id:item.id, ...item.data()}));
      render();
      renderMembers();
    },
    error => toast(`スコアの同期エラー: ${error.message}`)
  ));
}

function render() {
  let scores = 0;
  let counts = 0;
  const list = $('#wordList');
  list.replaceChildren();

  for (const word of words) {
    const points = finiteNumber(word.points);
    const count = finiteNumber(word.count);
    const totalScore = finiteNumber(word.totalScore);
    scores += totalScore;
    counts += count;

    const item = document.createElement('article');
    item.className = `word${points >= 10 ? ' ten' : ''}`;
    item.style.setProperty('--accent', accent(points));

    const details = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = typeof word.text === 'string' ? word.text : '（不正なデータ）';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.append('1回 ');
    const pointText = document.createElement('b');
    pointText.textContent = `${points >= 0 ? '+' : ''}${points}点`;
    meta.append(pointText, ` ・ 合計 ${totalScore}点`);
    details.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.className = 'icon edit';
    edit.textContent = '編集';
    edit.onclick = () => openEditor(word);
    const remove = document.createElement('button');
    remove.className = 'icon del';
    remove.textContent = '削除';
    remove.onclick = () => removeWord(word).catch(error => toast(error.message));
    actions.append(edit, remove);
    details.append(actions);

    const counter = document.createElement('div');
    counter.className = 'counter';
    const countText = document.createElement('span');
    countText.className = 'count';
    countText.textContent = String(count);
    const mine = memberWords.find(item => item.uid === user.uid && item.wordId === word.id)?.count || 0;
    const minus = document.createElement('button');
    minus.className = 'minus';
    minus.textContent = '−';
    minus.disabled = mine <= 0;
    minus.setAttribute('aria-label', `${title.textContent}を減らす`);
    minus.onclick = () => adjustCount(word, -1);
    const plus = document.createElement('button');
    plus.className = 'plus';
    plus.textContent = '＋';
    plus.setAttribute('aria-label', `${title.textContent}を加算`);
    plus.onclick = () => adjustCount(word, 1);
    counter.append(countText, minus, plus);
    item.append(details, counter);
    list.append(item);
  }

  $('#scoreTotal').textContent = String(scores);
  $('#countTotal').textContent = String(counts);
  $('#empty').classList.toggle('hidden', words.length !== 0);
}

function renderMembers() {
  const list = $('#memberList');
  list.replaceChildren();
  const pointsByWord = new Map(words.map(word => [word.id, finiteNumber(word.points)]));
  const totals = new Map(members.map(member => [member.uid, {member, count:0, score:0}]));
  for (const item of memberWords) {
    const total = totals.get(item.uid);
    if (!total) continue;
    const count = finiteNumber(item.count);
    total.count += count;
    total.score += count * (pointsByWord.get(item.wordId) || 0);
  }
  const ranking = [...totals.values()].sort((a, b) => b.score - a.score || b.count - a.count || String(a.member.name).localeCompare(String(b.member.name), 'ja'));
  for (const entry of ranking) {
    const row = document.createElement('div');
    row.className = 'member';
    const name = document.createElement('div');
    name.className = 'memberName';
    name.textContent = typeof entry.member.name === 'string' ? entry.member.name : 'ゲスト';
    if (entry.member.uid === user.uid) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '自分';
      name.append(badge);
    }
    const count = document.createElement('div');
    count.className = 'memberStat';
    count.innerHTML = `<span>カウント</span><strong>${entry.count}</strong>`;
    const score = document.createElement('div');
    score.className = 'memberStat';
    score.innerHTML = `<span>得点</span><strong>${entry.score}</strong>`;
    row.append(name, count, score);
    list.append(row);
  }
  $('#memberCount').textContent = `${members.length}人`;
}

async function adjustCount(word, delta) {
  const ref = doc(db, 'rooms', room, 'words', word.id);
  const memberWordRef = doc(db, 'rooms', room, 'memberWords', `${user.uid}_${word.id}`);
  try {
    await runTransaction(db, async transaction => {
      const [snapshot, memberSnapshot] = await Promise.all([transaction.get(ref), transaction.get(memberWordRef)]);
      if (!snapshot.exists()) throw new Error('項目が削除されています');
      const data = snapshot.data();
      const personalCount = memberSnapshot.exists() ? memberSnapshot.data().count : 0;
      if (delta < 0 && personalCount <= 0) throw new Error('自分が加算した回数は0です');
      transaction.update(ref, {
        count:data.count + delta,
        totalScore:data.totalScore + data.points * delta,
        updatedAt:serverTimestamp()
      });
      const personalData = {uid:user.uid, wordId:word.id, count:personalCount + delta, updatedAt:serverTimestamp()};
      if (memberSnapshot.exists()) transaction.update(memberWordRef, {count:personalData.count, updatedAt:personalData.updatedAt});
      else transaction.set(memberWordRef, personalData);
    });
  } catch (error) {
    toast(`変更できませんでした: ${error.message}`);
  }
}

function openEditor(word) {
  $('#editorTitle').textContent = word ? '言葉を編集' : '言葉を追加';
  $('#editId').value = word?.id || '';
  $('#wordText').value = word?.text || '';
  $('#wordPoints').value = word?.points ?? 1;
  $('#editor').showModal();
  $('#wordText').focus();
}

async function saveWord(event) {
  event.preventDefault();
  const text = $('#wordText').value.trim();
  const points = Number($('#wordPoints').value);
  const id = $('#editId').value;
  if (!text || text.length > 40 || !Number.isInteger(points) || points < -999 || points > 999) {
    return toast('入力内容を確認してください');
  }

  if (id) {
    const ref = doc(db, 'rooms', room, 'words', id);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('項目が削除されています');
      transaction.update(ref, {text, points, totalScore:snapshot.data().count * points, updatedAt:serverTimestamp()});
    });
  } else {
    const ref = doc(collection(db, 'rooms', room, 'words'));
    const batch = writeBatch(db);
    batch.set(ref, {text, points, count:0, totalScore:0, order:Date.now(), createdAt:serverTimestamp(), updatedAt:serverTimestamp()});
    await batch.commit();
  }
  $('#editor').close();
}

async function removeWord(word) {
  if (confirm(`「${word.text}」を削除しますか？`)) await deleteDoc(doc(db, 'rooms', room, 'words', word.id));
}

async function copyShareUrl() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('共有URLをコピーしました');
  } catch {
    window.prompt('このURLをコピーしてください', location.href);
  }
}

async function leaveRoom() {
  const personalSnapshots = await getDocs(query(
    collection(db, 'rooms', room, 'memberWords'),
    where('uid', '==', user.uid)
  ));
  const batch = writeBatch(db);
  personalSnapshots.forEach(item => batch.delete(item.ref));
  batch.delete(doc(db, 'rooms', room, 'members', user.uid));
  await batch.commit();

  unsubscribers.forEach(stop => stop());
  unsubscribers = [];
  room = '';
  words = [];
  members = [];
  memberWords = [];
  $('#game').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#playerName').value = localStorage.getItem('kp-name') || '';
  render();
  renderMembers();
  toast('退出しました');
}

$('#joinBtn').onclick = () => joinRoom().catch(error => toast(`参加エラー: ${error.message}`));
$('#addBtn').onclick = () => openEditor();
$('#editorForm').onsubmit = event => saveWord(event).catch(error => toast(error.message));
$('#cancelBtn').onclick = () => $('#editor').close();
$('#copyBtn').onclick = copyShareUrl;
$('#leaveBtn').onclick = () => leaveRoom().catch(error => toast(`退出できませんでした: ${error.message}`));
window.addEventListener('offline', () => setStatus('オフライン', 'warn'));
window.addEventListener('online', () => user && setStatus('オンライン', 'ok'));

init().catch(error => {
  setStatus('接続エラー', 'bad');
  toast(error.message);
});
