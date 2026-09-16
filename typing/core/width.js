/*
 * 全角・半角の同一視。
 *
 * ローマ字テーブルは普通、対になる記号の片方しか出せない。既定テーブルなら
 * 「?」は打てるが「？」は打てない。実際の IME は「記号を半角で入力するか
 * 全角で入力するか」の設定を持ち、もう一方は漢字変換で出すので、テーブルは
 * 片方だけで足りている。
 *
 * ここではその漢字変換の代わりとして、**テーブルが片方しか出せない対に限り**
 * 打鍵で出た方をお題の側の文字として扱う。「？」を含むお題で「?」を打つと
 * 「？」が入力されたことになる。入力欄にもお題と同じ文字が出るので、
 * 見た目がお題と食い違わない。
 *
 * 両方出せるテーブルでは何もしない。その場合は打ち分けられるので、
 * 同一視してしまうと練習にならない。
 */
import { convert } from './convert.js';

/* 対になる文字 (複数ありうる。「~」には「～」と「〜」が対応する) */
function counterparts(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 0x21 && c <= 0x7e) {
    const wide = [String.fromCharCode(c + 0xfee0)];
    if (ch === '~') wide.push('〜');            // 波ダッシュ
    return wide;
  }
  if (ch === ' ') return ['　'];
  if (ch === '¥') return ['￥'];
  return [];
}

/* 候補になる半角側の文字 */
function narrowChars() {
  const list = [' ', '¥'];
  for (let c = 0x21; c <= 0x7e; c++) list.push(String.fromCharCode(c));
  return list;
}

/*
 * その文字をテーブルで出せるか。
 *   - どれかの規則の出力に含まれる
 *   - その文字を打つとその文字がそのまま確定する (規則の無い打鍵の素通し)
 * 打ちかけとしてバッファに残るだけの文字 (k など) は見ない。対になる記号で
 * そうなるものが無いため。
 */
function producible(table, opts) {
  const set = new Set();
  table.rules.forEach(v => { for (const c of v.out) set.add(c); });

  const canType = (opts && opts.canType) || (ch => ch.charCodeAt(0) < 0x80);
  for (const ch of narrowChars()) {
    if (!canType(ch)) continue;
    const r = convert(table, '', ch);
    if (r.out === ch && r.buf === '') set.add(ch);
  }
  return set;
}

const cache = new WeakMap();    // table -> (配列 id -> 同一視の対応)

/*
 * 同一視してよい対応。「出せない方 -> 出せる方」の Map。
 * 片方しか出せない対だけが入る。両方出せる対は打ち分けられるので入れない。
 */
export function equivalents(table, opts) {
  const id = (opts && opts.id) || '-';
  let byLayout = cache.get(table);
  if (!byLayout) { byLayout = new Map(); cache.set(table, byLayout); }
  const hit = byLayout.get(id);
  if (hit) return hit;

  const can = producible(table, opts);
  const map = new Map();
  for (const narrow of narrowChars()) {
    for (const wide of counterparts(narrow)) {
      const a = can.has(narrow), b = can.has(wide);
      if (a === b) continue;                 // 両方出せる / 両方出せないときは何もしない
      if (a) map.set(wide, narrow); else map.set(narrow, wide);
    }
  }
  byLayout.set(id, map);
  return map;
}

/*
 * お題の文字を出すのに、代わりに打てる文字。
 * 打鍵候補に足すために使う (「？」が目標なら「?」を打ってみる)。
 * 規則の出力として出る文字はテーブルの打鍵候補に元から入っているので、
 * ここで返るのは配列で直接打てる文字だけを足せばよい。
 */
export function standIn(map, ch) {
  return map.get(ch) || null;
}

/*
 * 打鍵で出た文字列を、お題の同じ位置の文字に合わせる。
 * 合わせるのは同一視してよい対応だけで、位置が違えば何もしない。
 * お題に半角の「?」が出てくる箇所では、打った「?」はそのまま「?」になる。
 */
export function align(map, out, kana, at) {
  if (!map.size || out === '') return out;
  let s = '';
  for (let i = 0; i < out.length; i++) {
    const c = out.charAt(i);
    const want = kana.charAt(at + i);
    s += (want !== '' && c !== want && map.get(want) === c) ? want : c;
  }
  return s;
}
