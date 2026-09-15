/*
 * 画面内キーボード。
 *
 * L0 (配列そのもの) と L1 (予測ラベル = そのキーを押すと何が入力されるか) を
 * 描く。L2 (キーの上に重ねる教示) は呼び出し側の仕事なので、ここでは
 *   getKeyRect(code)   キーの矩形
 *   on('layout')       リサイズ・配列変更で座標が動いたとき
 * を公開するだけにする (設計 §3, §9)。
 *
 * キーは配列ファイルの x/y/w/h をもとに絶対配置する。行ごとの flex ではなく
 * 座標にしたのは、L2 が矩形を必要とするため。
 */
import * as Layout from './layout.js';

const UNIT_MIN = 40;             // 1 キーぶんの最小 px。これ以下なら横スクロール
const GAP = 5;

export function create(container, layoutId) {
  let layout = Layout.get(layoutId);
  let cells = new Map();         // code -> { el, key, outEl, hiEl, pendEl }
  let marked = [];
  let unit = UNIT_MIN;
  const handlers = { layout: [] };

  container.classList.add('kb');
  container.style.position = 'relative';

  function emit(name) { for (const fn of handlers[name] || []) fn(); }

  function render() {
    container.textContent = '';
    cells = new Map();
    marked = [];

    for (const key of layout.keys) {
      if (!key.code) continue;                       // 隙間
      const el = document.createElement('div');
      el.className = 'kb-key';
      if (key.anchor) el.classList.add('kb-anchor');

      let outEl = null, hiEl = null, pendEl = null;
      if (key.label !== null) {
        el.classList.add('kb-sp');
        el.textContent = key.label;
      } else {
        hiEl = document.createElement('span');
        hiEl.className = 'kb-hi';
        const lo = document.createElement('span');
        lo.className = 'kb-lo';
        outEl = document.createElement('span');
        outEl.className = 'kb-out';
        pendEl = document.createElement('span');
        pendEl.className = 'kb-pend';
        lo.appendChild(outEl);
        lo.appendChild(pendEl);
        el.appendChild(hiEl);
        el.appendChild(lo);
      }

      container.appendChild(el);
      cells.set(key.code, { el: el, key: key, outEl: outEl, hiEl: hiEl, pendEl: pendEl });
    }
    place();
  }

  function place() {
    const avail = container.parentElement
      ? container.parentElement.clientWidth : container.clientWidth;
    unit = Math.max(UNIT_MIN, Math.floor((avail || 0) / layout.width));
    container.style.width = (unit * layout.width) + 'px';
    container.style.height = (unit * layout.height) + 'px';
    // キーの大きさに合わせて文字も拡縮する (キー内の指定は em)
    container.style.fontSize = Math.max(10, Math.round(unit * 0.28)) + 'px';

    cells.forEach(c => {
      const k = c.key;
      c.el.style.left = (k.x * unit) + 'px';
      c.el.style.top = (k.y * unit) + 'px';
      c.el.style.width = (k.w * unit - GAP) + 'px';
      c.el.style.height = (k.h * unit - GAP) + 'px';
    });
    emit('layout');
  }

  /*
   * 各キーに「いま押したら何が入力されるか」を出す。
   *   preview(ch) -> { out, buf, dropped } または null
   *   known       テーブルの規則に出てくる文字の集合。Shift 側は、ここに
   *               入っている文字だけ表示する (大文字などは読みづらいだけ)
   */
  function setLabels(preview, known) {
    cells.forEach(c => {
      if (!c.outEl) return;
      const lo = c.key.lo;
      const p = (preview && lo !== null) ? preview(lo) : null;

      if (p && p.dropped) {
        // 打ちかけが消えるキー。何が出るかを出しても読みづらいので、
        // その打鍵で始まる分だけを薄く出す
        c.outEl.textContent = '';
        c.pendEl.textContent = p.buf || lo;
        c.el.classList.add('kb-dead');
      } else {
        c.outEl.textContent = p ? p.out : (lo === null ? '' : lo);
        c.pendEl.textContent = p ? p.buf : '';
        c.el.classList.remove('kb-dead');
      }

      if (c.key.hi !== null && known && known.has(c.key.hi)) {
        const q = preview ? preview(c.key.hi) : null;
        c.hiEl.textContent = q ? (q.dropped ? c.key.hi : q.out + q.buf) : c.key.hi;
      } else {
        c.hiEl.textContent = '';
      }
    });
  }

  function clearNext() {
    for (const el of marked) el.classList.remove('next', 'next-mod');
    marked = [];
  }

  function mark(el, cls) { el.classList.add(cls); marked.push(el); }

  /* 次に押すキーを示す。Shift が要るキーなら Shift も一緒に示す */
  function setNext(ch) {
    clearNext();
    if (!ch) return;
    const hit = Layout.keyOf(layout, ch);
    if (!hit) return;
    const cell = cells.get(hit.key.code);
    if (!cell) return;
    mark(cell.el, 'next');
    if (hit.shift) {
      for (const code of ['ShiftLeft', 'ShiftRight']) {
        const s = cells.get(code);
        if (s) mark(s.el, 'next-mod');
      }
    }
  }

  /* 物理キーを直に示す (BackSpace など) */
  function setNextCode(code) {
    clearNext();
    const cell = cells.get(code);
    if (cell) mark(cell.el, 'next');
  }

  // 打鍵が増える打ち方 (waste) は見逃しやすいので、少し長めに点ける
  const FLASH_MS = { hit: 150, bad: 150, waste: 320 };

  function flashEl(el, kind) {
    el.classList.remove('hit', 'bad', 'waste');
    void el.offsetWidth;                             // 連打でも点き直すように
    el.classList.add(kind);
    clearTimeout(el.flashTimer);
    el.flashTimer = setTimeout(() => el.classList.remove(kind), FLASH_MS[kind] || 150);
  }

  function flashCode(code, kind) {
    const cell = cells.get(code);
    if (cell) flashEl(cell.el, kind);
  }

  function flash(ch, kind) {
    const hit = Layout.keyOf(layout, ch);
    if (hit) flashCode(hit.key.code, kind);
  }

  /* キーボード原点からの相対位置 (px)。L2 オーバーレイの配置に使う */
  function getKeyRect(code) {
    const cell = cells.get(code);
    if (!cell) return null;
    const k = cell.key;
    return {
      left: k.x * unit, top: k.y * unit,
      width: k.w * unit - GAP, height: k.h * unit - GAP,
      x: k.x, y: k.y, w: k.w, h: k.h        // 単位はキー 1 個ぶん
    };
  }

  function setLayout(id) {
    layout = Layout.get(id);
    render();
  }

  const onResize = () => place();
  window.addEventListener('resize', onResize);

  render();

  return {
    setLayout: setLayout,
    get layout() { return layout; },
    setLabels: setLabels,
    setNext: setNext,
    setNextCode: setNextCode,
    clearNext: clearNext,
    flash: flash,
    flashCode: flashCode,
    getKeyRect: getKeyRect,
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    relayout: place,
    destroy() { window.removeEventListener('resize', onResize); container.textContent = ''; }
  };
}
