/*
 * エンジン本体。
 *
 *   createSession(container, config) -> session
 *   config = { table, items, keyboardLayout, options }
 *   session.on('finish', result => ...)
 *
 * table と items は「パース済みのデータ構造」を受け取る。ファイルパスでは
 * ない。取得方法 (fetch / File API / インライン) は呼び出し側の責任 (§1)。
 *
 * エンジンは合格条件・コース構造・教示内容を知らない (§13 不変条件 3)。
 * 結果オブジェクトを返すだけで、その解釈と進捗保存はコース層の仕事。
 *
 * アイテムは 2 種類 (§8)。
 *   word         かな列を持ち、打鍵で進み、統計に算入する
 *   instruction  かな列が空、Space で進み、統計に算入しない
 */
import * as Layout from './layout.js';
import * as KeyboardView from './keyboard-view.js';
import { createTarget } from './typing.js';
import { withPrefer } from './route.js';

const DEFAULT_OPTIONS = {
  showKeyboard: true,
  showRomaji: false,          // 既定はオフ (§10、および打鍵列に BackSpace を表せない問題)
  // 予測ラベル。true / false / 'onHesitate' (一定時間停止 or ミス時に提示)
  hintKeyboard: true,
  hintDelayMs: 1200,
  // 段階内の最初の k 問だけ強制的に ON にする。null なら無効
  hintFadeAfter: null
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function span(text, cls) { return el('span', cls, text); }

export function createSession(container, config) {
  // table     全規則。変換と正誤判定に使う (未解禁でも打てば変換される)
  // hintTable 解禁済み。案内とキーの表示に使う
  const table = config.table;
  const hintTable = config.hintTable || config.table;
  const options = Object.assign({}, DEFAULT_OPTIONS, config.options || {});
  const handlers = {};
  const tableChars = new Set(hintTable.alphabet);

  let items = (config.items || []).slice();
  let index = 0;
  let target = null;            // 通常アイテムのときだけ
  let guideGhost = '';
  let running = false;
  let finished = false;
  let startedAt = 0;
  let elapsed = 0;
  let keys = 0, miss = 0, reducible = 0;
  const usedTags = new Set();
  let tickId = 0;
  let missTimer = 0;
  let layoutId = config.keyboardLayout || 'jis';
  let wordSeen = 0;             // 統計に算入したアイテム数 (fadeAfter 用)
  let hesitateTimer = 0;
  let hesitateShown = false;    // onHesitate で今のアイテムのラベルを出したか
  let l2Visible = true;         // 教示オーバーレイの表示 (永続化しない)

  /*
   * 経路計算のオプション。配列 (Shift の要否) と、その段階で優先する打ち方。
   * 配列を切り替えるたびに作り直すので、ここで組む。
   */
  function routeOpts() {
    return withPrefer(Layout.routeOpts(keyboard.layout), config.preferTags || []);
  }

  /* ---------- DOM ---------- */

  container.textContent = '';
  const ui = {};

  ui.stage = el('section', 'panel stage');
  ui.head = el('div', 'stage-head');
  ui.progress = span('- / -');
  ui.timer = span('0.0 秒');
  ui.head.append(ui.progress, ui.timer);

  ui.display = el('p', 'display');
  ui.kana = el('p', 'kana');

  ui.io = el('div', 'io');
  ui.ioLabel = el('span', 'io-label', '入力');
  ui.input = el('p', 'input');
  ui.romaji = el('p', 'romaji');
  ui.io.append(ui.ioLabel, ui.input, ui.romaji);

  ui.kbWrap = el('div', 'keyboard-wrap');
  ui.kb = el('div', 'keyboard');
  ui.kbWrap.appendChild(ui.kb);

  ui.doc = el('div', 'lesson-doc');       // 教示の文書 (キーボード外に置く)
  ui.doc.hidden = true;
  ui.hint = el('p', 'hint', 'キーを押すと開始します');

  ui.stats = el('div', 'stats');
  const stat = (id, unit) => {
    const d = el('div', 'stat');
    ui[id] = el('b', null, '0');
    d.append(ui[id], el('small', null, unit));
    ui.stats.appendChild(d);
    return d;
  };
  stat('statKpm', '打/分'); stat('statKeys', '打鍵');
  stat('statMiss', 'ミス'); stat('statAcc', '正確率');
  ui.statAcc.textContent = '100%';

  ui.stage.append(ui.head, ui.display, ui.kana, ui.io, ui.kbWrap, ui.doc, ui.hint, ui.stats);

  ui.result = el('section', 'panel result');
  ui.result.hidden = true;
  ui.result.appendChild(el('h2', null, 'おつかれさまでした'));
  ui.rStats = el('div', 'stats big');
  const rStat = (id, unit) => {
    const d = el('div', 'stat');
    ui[id] = el('b', null, '0');
    d.append(ui[id], el('small', null, unit));
    ui.rStats.appendChild(d);
  };
  rStat('rKpm', '打/分'); rStat('rTime', '秒'); rStat('rKeys', '打鍵');
  rStat('rMiss', 'ミス'); rStat('rAcc', '正確率'); rStat('rReducible', '短縮余地');
  ui.rNote = el('p', 'note');
  ui.rNote.hidden = true;
  ui.rAdvice = el('p', 'note advice');
  ui.rAdvice.hidden = true;
  ui.retry = el('button', 'primary', 'もう一度 (Enter)');
  ui.retry.type = 'button';
  ui.result.append(ui.rStats, ui.rNote, ui.rAdvice, ui.retry);

  ui.keycatch = el('input', 'keycatch');
  ui.keycatch.setAttribute('autocomplete', 'off');
  ui.keycatch.setAttribute('spellcheck', 'false');
  ui.keycatch.setAttribute('aria-label', 'タイピング入力欄');

  container.append(ui.stage, ui.result, ui.keycatch);

  const keyboard = KeyboardView.create(ui.kb, layoutId);

  /* ---------- 進行 ---------- */

  function emit(name, arg) { for (const fn of handlers[name] || []) fn(arg); }

  function isInstruction(item) { return item && item.type === 'instruction'; }

  function loadItem(i) {
    index = i;
    const item = items[i];
    ui.progress.textContent = (i + 1) + ' / ' + items.length;

    if (isInstruction(item)) {
      target = null;
      guideGhost = '';
      ui.display.textContent = item.display || '';
      ui.kana.textContent = '';
      ui.io.hidden = true;
      ui.doc.hidden = false;
      ui.doc.textContent = '';
      for (const line of (item.text || '').split('\n')) {
        ui.doc.appendChild(el('p', null, line));
      }
      ui.doc.appendChild(el('p', 'doc-next', 'Space キーで次へ'));
      keyboard.setLabels(null, null);
      keyboard.setNextCode('Space');
      ui.stage.classList.remove('has-error');
      emit('item', { index: i, item: item });
      return;
    }

    ui.io.hidden = false;
    ui.doc.hidden = true;
    target = createTarget(table, item.kana, hintTable, routeOpts());
    guideGhost = 'm'.repeat(target.maxGuideLength());
    ui.display.textContent = item.display;
    render();
    emit('item', { index: i, item: item });
  }

  function render() {
    if (!target) return;
    const v = target.view();
    const kana = target.kana;

    // よみは見本。減らさず全文を出し、1 打鍵でまとまって確定する分に印をつける
    ui.kana.textContent = '';
    ui.kana.appendChild(span(kana.slice(0, v.kanaIndex), 'todo'));
    if (v.kanaIndex < kana.length) {
      const end = Math.min(v.kanaIndex + Math.max(1, v.groupLength), kana.length);
      ui.kana.appendChild(span(kana.slice(v.kanaIndex, end), 'cur'));
      ui.kana.appendChild(span(kana.slice(end), 'todo'));
    }

    // 入力欄は空から増えていく。打ち間違えても変換は続くので、
    // 間違えた結果そのものが wrong として見える。
    // 打ち進めても折り返し行数が変わらないよう、お題の長さぶんの高さを
    // 透明な控えで確保しておく
    ui.input.textContent = '';
    ui.input.appendChild(span(kana + '　', 'in-ghost'));
    const live = span('', 'in-live');
    if (v.confirmed) live.appendChild(span(v.confirmed, 'in-ok'));
    if (v.wrong) live.appendChild(span(v.wrong, 'in-err'));
    if (v.pending) live.appendChild(span(v.pending, v.onTrack ? 'in-pending' : 'in-pending bad'));
    live.appendChild(span('', 'caret'));
    ui.input.appendChild(live);

    ui.romaji.textContent = '';
    ui.romaji.appendChild(span(guideGhost, 'in-ghost'));
    const guide = span('', 'in-live');
    if (v.guideDone) guide.appendChild(span(v.guideDone, 'done'));
    if (v.remaining) {
      guide.appendChild(span(v.remaining.charAt(0), 'cur'));
      guide.appendChild(span(v.remaining.slice(1), 'todo'));
    }
    ui.romaji.appendChild(guide);

    if (labelsVisible()) keyboard.setLabels(ch => target.preview(ch), tableChars);
    else keyboard.setLabels(null, null);
    // ずれているときに押すべきキーは BackSpace
    if (v.onTrack) keyboard.setNext(v.remaining.charAt(0));
    else keyboard.setNextCode('Backspace');

    ui.stage.classList.toggle('has-error', !v.onTrack);
    if (running) ui.hint.textContent = v.onTrack ? '' : 'BackSpace で消してください';
  }

  /*
   * 予測ラベルを出すか (§10)。
   * 最初の k 問は必ず出し、その後は hintKeyboard に従う。
   * 'onHesitate' は一定時間停止したときとミスしたときだけ出す。
   * 消すのは予測ラベルだけで、物理配列の枠は残す。指の位置の確認手段は保つ。
   */
  function labelsVisible() {
    if (options.hintFadeAfter !== null && options.hintFadeAfter !== undefined
        && wordSeen < options.hintFadeAfter) return true;
    if (options.hintKeyboard === 'onHesitate') return hesitateShown;
    return !!options.hintKeyboard;
  }

  function armHesitate() {
    clearTimeout(hesitateTimer);
    if (options.hintKeyboard !== 'onHesitate' || hesitateShown) return;
    const ms = options.hintDelayMs || 1200;
    hesitateTimer = setTimeout(() => { hesitateShown = true; render(); }, ms);
  }

  function updateStats() {
    const total = keys + miss;
    const acc = total ? Math.round((keys / total) * 100) : 100;
    const min = elapsed / 60000;
    ui.statKpm.textContent = min > 0 ? Math.round(keys / min) : 0;
    ui.statKeys.textContent = keys;
    ui.statMiss.textContent = miss;
    ui.statAcc.textContent = acc + '%';
  }

  function startTick() {
    stopTick();
    tickId = setInterval(() => {
      elapsed = performance.now() - startedAt;
      ui.timer.textContent = (elapsed / 1000).toFixed(1) + ' 秒';
      updateStats();
    }, 50);
  }
  function stopTick() { if (tickId) { clearInterval(tickId); tickId = 0; } }

  function flashMiss() {
    ui.stage.classList.add('miss');
    clearTimeout(missTimer);
    missTimer = setTimeout(() => ui.stage.classList.remove('miss'), 120);
  }

  function begin() {
    if (running) return;
    running = true;
    startedAt = performance.now();
    ui.hint.textContent = '';
    startTick();
  }

  function advance() {
    if (index + 1 < items.length) loadItem(index + 1);
    else finish();
  }

  function finish() {
    finished = true;
    running = false;
    elapsed = running ? elapsed : (startedAt ? performance.now() - startedAt : 0);
    stopTick();

    const total = keys + miss;
    const acc = total ? Math.round((keys / total) * 100) : 100;
    const min = elapsed / 60000;
    const result = {
      keys: keys, miss: miss, accuracy: acc, reducible: reducible,
      elapsedMs: elapsed, kpm: min > 0 ? Math.round(keys / min) : 0,
      usedTags: new Set(usedTags),
      items: items.filter(it => !isInstruction(it)).length
    };

    ui.rKpm.textContent = result.kpm;
    ui.rTime.textContent = (elapsed / 1000).toFixed(1);
    ui.rKeys.textContent = keys;
    ui.rMiss.textContent = miss;
    ui.rAcc.textContent = acc + '%';
    ui.rReducible.textContent = reducible;
    ui.rNote.hidden = reducible === 0;
    ui.rNote.textContent = '打ち方を変えると、あと ' + reducible
      + ' 打鍵 減らせます。橙色に光ったキーがその場面です。';

    ui.stage.hidden = true;
    ui.result.hidden = false;
    emit('finish', result);
  }

  /* ---------- 入力 ---------- */

  function handleChar(ch) {
    if (!target || finished) return;
    begin();

    const r = target.input(ch);
    const waste = target.lastWaste();
    if (r === 'miss') {
      miss++; flashMiss();
      // ミスしたら答えを見せる (想起の試行を先にさせてから提示する形)
      if (options.hintKeyboard === 'onHesitate') hesitateShown = true;
    } else { keys++; }
    armHesitate();
    keyboard.flash(ch, r === 'miss' ? 'bad' : (waste > 0 ? 'waste' : 'hit'));
    render();
    updateStats();
    emit('input', { char: ch, result: r, waste: waste });

    if (r === 'done') {
      // 短縮余地は打ち切った時点の入力で数える。バックスペースで
      // 打ち直した分は残っていないので加算されない
      reducible += target.reducible();
      for (const t of target.usedTags()) usedTags.add(t);
      wordSeen++;
      hesitateShown = false;
      advance();
    }
  }

  function handleBackspace() {
    if (!target || finished || !running) return;
    const done = target.backspace();
    keyboard.flashCode('Backspace', done ? 'hit' : 'bad');
    if (done) render();
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // IME がオンのとき、code は正しく届くが key は "Process" になり、
    // 打鍵は IME 側にも渡っている。ここで処理すると二重入力になるので、
    // 無視して警告に回す。
    if (e.isComposing) { emit('ime'); return; }

    if (e.code === 'Escape') { e.preventDefault(); reset(); return; }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (finished) { e.preventDefault(); emit('retry'); }
      return;
    }
    if (document.activeElement !== ui.keycatch
        && document.activeElement && document.activeElement.tagName === 'INPUT') return;

    if (e.code === 'Backspace') { e.preventDefault(); handleBackspace(); return; }

    // 教示アイテムは Space で次へ
    if (isInstruction(items[index])) {
      if (e.code === 'Space') { e.preventDefault(); begin(); advance(); }
      return;
    }

    const ch = Layout.charFromEvent(keyboard.layout, e);
    if (ch === null) return;
    e.preventDefault();
    handleChar(ch);
  }

  document.addEventListener('keydown', onKeyDown);

  ui.keycatch.addEventListener('compositionstart', () => {
    ui.keycatch.value = '';
    emit('ime');
  });
  ui.keycatch.addEventListener('input', () => { ui.keycatch.value = ''; });
  ui.retry.addEventListener('click', () => emit('retry'));

  /* ---------- 表示オプション ---------- */

  function applyOptions() {
    ui.kbWrap.hidden = !options.showKeyboard;
    ui.romaji.hidden = !options.showRomaji;
    keyboard.relayout();
  }

  function reset() {
    index = 0; target = null;
    running = false; finished = false;
    startedAt = 0; elapsed = 0;
    keys = 0; miss = 0; reducible = 0;
    usedTags.clear();
    stopTick();
    ui.result.hidden = true;
    ui.stage.hidden = false;
    ui.timer.textContent = '0.0 秒';
    updateStats();
    if (!items.length) {
      ui.display.textContent = '出題できるお題がありません';
      ui.kana.textContent = '';
      ui.io.hidden = true;
      ui.doc.hidden = true;
      ui.hint.textContent = '設定からお題かローマ字テーブルを見直してください';
      keyboard.setLabels(null, null);
      keyboard.clearNext();
      return;
    }
    loadItem(0);
    ui.hint.textContent = 'キーを押すと開始します';
  }

  applyOptions();
  reset();
  ui.keycatch.focus();

  return {
    keyboard: keyboard,
    get element() { return container; },
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    setItems(next) { items = (next || []).slice(); reset(); },
    setOptions(next) { Object.assign(options, next || {}); applyOptions(); render(); },
    getOptions() { return Object.assign({}, options); },
    setLayout(id) { layoutId = id; keyboard.setLayout(id); render(); },
    focus() { ui.keycatch.focus(); },
    reset: reset,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      stopTick();
      keyboard.destroy();
      container.textContent = '';
    }
  };
}
