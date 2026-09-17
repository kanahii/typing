/*
 * キーボード配列。
 *
 * 内部識別子は event.code (物理位置)。ローマ字テーブルは文字で書かれるので、
 * 「配列別の変換表」を通して code に解決する。この 1 ファイルが
 *   code + shift  ->  文字     (打鍵の解釈)
 *   文字          ->  code + shift  (キーボード表示)
 * の両方を持つ唯一の場所。実機で code が想定と違っていたら、ここだけ直せばよい。
 *
 * 物理位置は「平坦なキーのリスト + 原点からの x/y/w/h」で持つ (設計 §3)。
 * 行として書いた方が読みやすいので、行から x/y を計算して平坦化する。
 */

// 文字キー: code と、そのまま押したとき / Shift と押したときの文字
function k(code, lo, hi, w) {
  return { code: code, lo: lo, hi: hi || null, label: null, w: w || 1 };
}
// 文字を持たないキー
function sp(code, label, w) {
  return { code: code, lo: null, hi: null, label: label, w: w || 1 };
}
// 隙間 (L 字の Enter の下など)
function gap(w) {
  return { code: null, lo: null, hi: null, label: null, w: w };
}
// 英字キー
function a(c) { return k('Key' + c.toUpperCase(), c, c.toUpperCase()); }

const LETTERS1 = 'qwertyuiop'.split('').map(a);
const LETTERS2 = 'asdfghjkl'.split('').map(a);
const LETTERS3 = 'zxcvbnm'.split('').map(a);

const DEFS = {
  jis: {
    name: 'JIS (日本語)',
    rows: [
      [sp('Backquote', '半/全'),
       k('Digit1', '1', '!'), k('Digit2', '2', '"'), k('Digit3', '3', '#'),
       k('Digit4', '4', '$'), k('Digit5', '5', '%'), k('Digit6', '6', '&'),
       k('Digit7', '7', "'"), k('Digit8', '8', '('), k('Digit9', '9', ')'),
       k('Digit0', '0', null),
       k('Minus', '-', '='), k('Equal', '^', '~'), k('IntlYen', '¥', '|'),
       sp('Backspace', 'BS', 1.5)],

      [sp('Tab', 'Tab', 1.5), ...LETTERS1,
       k('BracketLeft', '@', '`'), k('BracketRight', '[', '{'),
       sp('Enter', 'Enter', 2)],

      [sp('CapsLock', 'Caps', 1.75), ...LETTERS2,
       k('Semicolon', ';', '+'), k('Quote', ':', '*'), k('Backslash', ']', '}'),
       gap(1.75)],

      [sp('ShiftLeft', 'Shift', 2.25), ...LETTERS3,
       k('Comma', ',', '<'), k('Period', '.', '>'), k('Slash', '/', '?'),
       k('IntlRo', '\\', '_'),
       sp('ShiftRight', 'Shift', 2.25)],

      [sp('ControlLeft', 'Ctrl', 1.25), sp('MetaLeft', 'Win', 1.25),
       sp('AltLeft', 'Alt', 1.25), sp('NonConvert', '無変換', 1.25),
       k('Space', ' ', null, 5.5),
       sp('Convert', '変換', 1.25), sp('KanaMode', 'かな', 1.25),
       sp('AltRight', 'Alt', 1.25), sp('ControlRight', 'Ctrl', 1.25)]
    ]
  },

  us: {
    name: 'US (英語)',
    rows: [
      [k('Backquote', '`', '~'),
       k('Digit1', '1', '!'), k('Digit2', '2', '@'), k('Digit3', '3', '#'),
       k('Digit4', '4', '$'), k('Digit5', '5', '%'), k('Digit6', '6', '^'),
       k('Digit7', '7', '&'), k('Digit8', '8', '*'), k('Digit9', '9', '('),
       k('Digit0', '0', ')'),
       k('Minus', '-', '_'), k('Equal', '=', '+'),
       sp('Backspace', 'BS', 2)],

      [sp('Tab', 'Tab', 1.5), ...LETTERS1,
       k('BracketLeft', '[', '{'), k('BracketRight', ']', '}'),
       k('Backslash', '\\', '|', 1.5)],

      [sp('CapsLock', 'Caps', 1.75), ...LETTERS2,
       k('Semicolon', ';', ':'), k('Quote', "'", '"'),
       sp('Enter', 'Enter', 2.25)],

      [sp('ShiftLeft', 'Shift', 2.25), ...LETTERS3,
       k('Comma', ',', '<'), k('Period', '.', '>'), k('Slash', '/', '?'),
       sp('ShiftRight', 'Shift', 2.75)],

      [sp('ControlLeft', 'Ctrl', 1.25), sp('MetaLeft', 'Win', 1.25),
       sp('AltLeft', 'Alt', 1.25),
       k('Space', ' ', null, 6.25),
       sp('AltRight', 'Alt', 1.25), sp('MetaRight', 'Win', 1.25),
       sp('ContextMenu', 'Menu', 1.25), sp('ControlRight', 'Ctrl', 1.25)]
    ]
  }
};

// ホームポジションの目印 (実機の突起と同じく F と J だけ)
const HOME_ANCHOR = ['KeyF', 'KeyJ'];

function build(id, def) {
  const keys = [];
  let width = 0;
  def.rows.forEach((row, y) => {
    let x = 0;
    for (const key of row) {
      keys.push({
        code: key.code, lo: key.lo, hi: key.hi, label: key.label,
        x: x, y: y, w: key.w, h: 1,
        anchor: HOME_ANCHOR.indexOf(key.code) >= 0
      });
      x += key.w;
    }
    if (x > width) width = x;
  });

  const byCode = new Map();
  const byChar = new Map();
  for (const key of keys) {
    if (key.code && !byCode.has(key.code)) byCode.set(key.code, key);
    if (key.lo !== null && !byChar.has(key.lo)) byChar.set(key.lo, { key: key, shift: false });
    if (key.hi !== null && !byChar.has(key.hi)) byChar.set(key.hi, { key: key, shift: true });
  }

  return {
    id: id, name: def.name,
    keys: keys, byCode: byCode, byChar: byChar,
    width: width, height: def.rows.length
  };
}

const CACHE = new Map();

export function get(id) {
  if (!DEFS[id]) id = 'jis';
  if (!CACHE.has(id)) CACHE.set(id, build(id, DEFS[id]));
  return CACHE.get(id);
}

export function list() {
  return Object.keys(DEFS).map(id => ({ id: id, name: DEFS[id].name }));
}

/* code + shift から、その配列で入力される文字。文字を持たないキーは null */
export function charOf(layout, code, shift) {
  const key = layout.byCode.get(code);
  if (!key) return null;
  const ch = shift ? key.hi : key.lo;
  return ch === null ? null : ch;
}

/* 文字から、それを打つための物理キーと Shift の有無 */
export function keyOf(layout, ch) {
  return layout.byChar.get(ch) || null;
}

/* キーボード原点からの相対位置 (単位はキー 1 個ぶん) */
export function rectOf(layout, code) {
  const key = layout.byCode.get(code);
  return key ? { x: key.x, y: key.y, w: key.w, h: key.h } : null;
}

/* keydown から文字を取り出す。修飾キー付きや文字を持たないキーは null */
export function charFromEvent(layout, ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  return charOf(layout, ev.code, ev.shiftKey);
}

/*
 * 経路計算に渡す配列情報。
 *
 * shiftOf  打鍵数が同じ経路が複数あるとき、Shift の少ない方を選ばせる。
 *          これで「ー」は JIS なら「:」、US なら「'」と、テーブルを分けずに
 *          配列に応じた案内になる。
 * canType  その文字をこの配列で直接打てるか。ローマ字テーブルに規則が無い
 *          文字は打鍵がそのまま入力されるので、配列にあるなら打てる。
 *          数字・大文字・記号がこれに当たる (a は「あ」に変換されるので
 *          打てないが、A と K は打てる、という区別になる)。
 */
export function routeOpts(layout) {
  return {
    id: layout.id,
    shiftOf(ch) {
      const hit = layout.byChar.get(ch);
      return hit ? hit.shift : false;
    },
    canType(ch) {
      return layout.byChar.has(ch);
    }
  };
}
