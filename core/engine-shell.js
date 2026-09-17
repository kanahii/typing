/*
 * 自由設定モードのシェル。
 *
 * 設定 UI とファイル読み込みを担い、パース済みのテーブル・アイテム列を
 * エンジンに渡す (§1)。エンジンはファイルパスを知らない。
 * 別のシェルを載せる場合も、渡すデータの作り方が違うだけで
 * エンジンの使い方は同じになる。
 */
import * as Layout from './layout.js';
import * as Table from './table.js';
import * as Problems from './problems.js';
import * as Store from './store.js';
import { createSession } from './session.js';
import { DEFAULT_ROMAJI_TSV, DEFAULT_ROMAJI_TABLE_NAME } from '../data/romaji-default.js';
import { DEFAULT_PROBLEMS, DEFAULT_PROBLEMS_NAME } from '../data/problems-default.js';

const $ = id => document.getElementById(id);

const el = {
  settings: $('settings'), btnSettings: $('btn-settings'),
  fileTable: $('file-table'), btnTableReset: $('btn-table-reset'),
  btnTableCheck: $('btn-table-check'), tableStatus: $('table-status'),
  fileProblems: $('file-problems'), btnProblemsReset: $('btn-problems-reset'),
  problemsStatus: $('problems-status'),
  optLayout: $('opt-layout'), optKeyboard: $('opt-keyboard'), optLabels: $('opt-labels'),
  optRomaji: $('opt-romaji'), optShuffle: $('opt-shuffle'), optCount: $('opt-count'),
  btnApply: $('btn-apply'), imeWarning: $('ime-warning'), play: $('play')
};

/*
 * 覚えておくもの。ローマ字テーブルを差し替えて使う人は、開くたびに読み込み
 * 直すのが手間なので、読み込んだテキストごと保存しておく。
 * キーはすべて Store が "typing." の下に置く。
 */
const KEY_LAYOUT = 'keyboardLayout';    // 配列は段階練習モードとも共有する
const KEY_TABLE = 'engine.table';
const KEY_PROBLEMS = 'engine.problems';
const KEY_OPTIONS = 'engine.options';

// 「かなの点検」で読み込む、かなを一通り並べたお題ファイル
const CHECK_FILE = 'sample-problems/kana-check.tsv';

let table = null;
let pool = [];
let session = null;
let poolLabel = '';        // お題欄の通常表示。除外の知らせを出した後で戻すのに使う

/* ---------- テーブル / お題 ---------- */

function applyTable(text, name, remember) {
  const t = Table.parse(text);
  if (t.size === 0) {
    el.tableStatus.textContent = '読み込めませんでした（有効な行が 0 件）。タブ区切りか確認してください。';
    el.tableStatus.className = 'status error';
    return false;
  }
  table = t;
  const s = t.stats;
  el.tableStatus.textContent = name + ' — ' + s.entries + ' 規則'
    + '（コメント ' + s.comments + ' 行'
    + (s.tagged ? ' / タグ付き ' + s.tagged + ' 件' : '')
    + (s.overwritten ? ' / 上書き ' + s.overwritten + ' 件' : '') + '）'
    + (t.alwaysEnabled.length ? ' 常時有効タグ: ' + t.alwaysEnabled.join(', ') : '');
  el.tableStatus.className = 'status';
  if (remember && !Store.write(KEY_TABLE, { name: name, text: text })) {
    el.tableStatus.textContent += '（大きすぎるので記憶しません）';
  }
  return true;
}

function applyProblems(list, name, text) {
  if (!list.length) {
    el.problemsStatus.textContent = 'お題が 0 件でした。';
    el.problemsStatus.className = 'status error';
    return false;
  }
  pool = list;
  poolLabel = name + ' — ' + list.length + ' 件';
  el.problemsStatus.textContent = poolLabel;
  el.problemsStatus.className = 'status';
  if (text !== undefined && !Store.write(KEY_PROBLEMS, { name: name, text: text })) {
    el.problemsStatus.textContent += '（大きすぎるので記憶しません）';
  }
  return true;
}

/*
 * 打てなかったものの並べ方。
 * 1〜2 件しか出さないと何が足りないのか見当が付かないので 5 件まで出す。
 */
function listSkipped(names) {
  const shown = names.slice(0, 5);
  const rest = names.length - shown.length;
  return shown.join(' / ') + (rest > 0 ? ' ほか ' + rest + ' 件' : '');
}

function readFile(file, onText) {
  const reader = new FileReader();
  reader.onload = () => onText(Table.decodeBytes(reader.result));
  reader.readAsArrayBuffer(file);
}

/* ---------- セッション ---------- */

function saveOptions() {
  Store.write(KEY_OPTIONS, {
    keyboard: el.optKeyboard.checked,
    labels: el.optLabels.checked,
    romaji: el.optRomaji.checked,
    shuffle: el.optShuffle.checked,
    count: parseInt(el.optCount.value, 10) || 10
  });
}

function restoreOptions() {
  const o = Store.read(KEY_OPTIONS);
  if (!o) return;
  if (typeof o.keyboard === 'boolean') el.optKeyboard.checked = o.keyboard;
  if (typeof o.labels === 'boolean') el.optLabels.checked = o.labels;
  if (typeof o.romaji === 'boolean') el.optRomaji.checked = o.romaji;
  if (typeof o.shuffle === 'boolean') el.optShuffle.checked = o.shuffle;
  const n = Number(o.count);
  if (n >= 1 && n <= 500) el.optCount.value = n;
}

function currentOptions() {
  return {
    showKeyboard: el.optKeyboard.checked,
    hintKeyboard: el.optLabels.checked,
    showRomaji: el.optRomaji.checked
  };
}

function buildItems() {
  const count = parseInt(el.optCount.value, 10) || 10;
  const r = Problems.selectItems(table, pool, count, el.optShuffle.checked,
                                 Layout.routeOpts(Layout.get(el.optLayout.value)));
  // 除外の知らせは出し直すたびに更新する。テーブルを直して出なくなったのに
  // 前の知らせが残っていると、直っていないように見える
  if (r.skipped.length) {
    el.problemsStatus.textContent = '現在のローマ字テーブルでは打てないお題 '
      + r.skipped.length + ' 件を出題から外しました: ' + listSkipped(r.skipped);
    el.problemsStatus.className = 'status error';
  } else {
    el.problemsStatus.textContent = poolLabel;
    el.problemsStatus.className = 'status';
  }
  return r.items;
}

function start() {
  const items = buildItems();
  if (session) session.destroy();
  session = createSession(el.play, {
    table: table,
    items: items,
    keyboardLayout: el.optLayout.value,
    options: currentOptions()
  });
  session.on('retry', () => start());
  session.on('ime', () => { el.imeWarning.hidden = false; });
  session.focus();
}

/* ---------- イベント ---------- */

el.btnSettings.addEventListener('click', () => {
  el.settings.hidden = !el.settings.hidden;
  if (el.settings.hidden && session) session.focus();
});

el.btnApply.addEventListener('click', () => {
  el.settings.hidden = true;
  saveOptions();
  start();
});

for (const id of ['optKeyboard', 'optLabels', 'optRomaji']) {
  el[id].addEventListener('change', () => {
    saveOptions();
    if (session) { session.setOptions(currentOptions()); session.focus(); }
  });
}

el.optLayout.addEventListener('change', () => {
  Store.write(KEY_LAYOUT, el.optLayout.value);
  if (session) { session.setLayout(el.optLayout.value); session.focus(); }
});

el.fileTable.addEventListener('change', () => {
  const f = el.fileTable.files[0];
  if (!f) return;
  readFile(f, text => { if (applyTable(text, f.name, true)) start(); });
});

/*
 * いま読み込んでいるテーブルで、かなが一通り打てるかを確かめる。
 * お題は入れ替えず、結果だけを出す。独自のテーブルを書いたときに
 * 「どの行が抜けているか」を探すのが目的。
 */
el.btnTableCheck.addEventListener('click', () => {
  el.tableStatus.textContent = '点検しています…';
  el.tableStatus.className = 'status';
  fetch(CHECK_FILE, { cache: 'no-cache' })
    .then(res => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
    .then(text => {
      const list = Problems.parse(text);
      const r = Problems.selectItems(table, list, list.length, false,
                                     Layout.routeOpts(Layout.get(el.optLayout.value)));
      if (!r.skipped.length) {
        el.tableStatus.textContent = 'かなの点検: ' + list.length + ' 件すべて打てます';
        el.tableStatus.className = 'status';
      } else {
        el.tableStatus.textContent = 'かなの点検: ' + list.length + ' 件中 '
          + r.skipped.length + ' 件が打てません — ' + listSkipped(r.skipped);
        el.tableStatus.className = 'status error';
      }
    })
    .catch(() => {
      el.tableStatus.textContent = '点検用のファイルを読めませんでした（' + CHECK_FILE + '）。';
      el.tableStatus.className = 'status error';
    });
});

el.btnTableReset.addEventListener('click', () => {
  el.fileTable.value = '';
  Store.remove(KEY_TABLE);
  applyTable(DEFAULT_ROMAJI_TSV, DEFAULT_ROMAJI_TABLE_NAME);
  start();
});

el.fileProblems.addEventListener('change', () => {
  const f = el.fileProblems.files[0];
  if (!f) return;
  readFile(f, text => { if (applyProblems(Problems.parse(text), f.name, text)) start(); });
});

el.btnProblemsReset.addEventListener('click', () => {
  el.fileProblems.value = '';
  Store.remove(KEY_PROBLEMS);
  applyProblems(Problems.fromPairs(DEFAULT_PROBLEMS), DEFAULT_PROBLEMS_NAME);
  start();
});

document.addEventListener('mousedown', e => {
  const tag = e.target.tagName;
  if (['INPUT', 'BUTTON', 'LABEL', 'SUMMARY', 'SELECT', 'OPTION', 'A'].indexOf(tag) >= 0) return;
  setTimeout(() => { if (session) session.focus(); }, 0);
});

/* ---------- 起動 ---------- */

for (const l of Layout.list()) {
  const op = document.createElement('option');
  op.value = l.id;
  op.textContent = l.name;
  el.optLayout.appendChild(op);
}
// 配列の誤設定は「壊れている」と読まれるので、選んだものは覚えておく (§2)
const savedLayout = Store.read(KEY_LAYOUT);
if (savedLayout) el.optLayout.value = savedLayout;
restoreOptions();

/*
 * 前回のテーブル / お題を戻す。読めなければ保存を捨てて既定に落とす。
 * (パーサを直した後で古い保存が残っていても、起動しなくならないように)
 */
function restore(key, apply, fallback) {
  const saved = Store.read(key);
  if (saved && typeof saved.text === 'string' && apply(saved.text, saved.name)) return;
  if (saved) Store.remove(key);
  fallback();
}

restore(KEY_TABLE,
  (text, name) => applyTable(text, name || '記憶したテーブル'),
  () => applyTable(DEFAULT_ROMAJI_TSV, DEFAULT_ROMAJI_TABLE_NAME));
restore(KEY_PROBLEMS,
  (text, name) => applyProblems(Problems.parse(text), name || '記憶したお題'),
  () => applyProblems(Problems.fromPairs(DEFAULT_PROBLEMS), DEFAULT_PROBLEMS_NAME));
start();

// デバッグ・自動確認用
window.__typing = {
  Layout, Table, Problems,
  get table() { return table; },
  get pool() { return pool; },
  get session() { return session; }
};
