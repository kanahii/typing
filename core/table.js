/*
 * ローマ字テーブル。
 *
 * 列 (タブ区切り):
 *   1 入力       打鍵列
 *   2 出力       かな
 *   3 次の入力   変換後に入力欄へ残す文字列
 *   4 第1カテゴリのタグ   1 打目の意識
 *   5 第2カテゴリのタグ   2 打目の意識
 *   6 第3カテゴリのタグ   最終打の意識
 *
 * 設計資料 §4 は「既存の 2 列 (input / output)」を前提にタグを 3 列目からと
 * していたが、この実装は 3 列目に「次の入力」を持つ (Google 日本語入力の
 * 形式)。「次の入力」は入力の一部として画面に出る仕様上の要なので動かせない。
 * よってタグは 4〜6 列目に置く。既存テーブルと Google IME の書き出しは
 * そのまま読める。
 *
 * タグは同じものが別のカテゴリに現れる (row.sha は xa では第1、sya では第2)。
 * これは実態の反映なので正しく、集合演算はカテゴリ横断で平坦化する (§4)。
 *
 * 指示行: 1 列目が @名前 の行。いまは @alwaysEnabled だけ。
 *   @alwaysEnabled <TAB> std,legacy
 *
 * コメント行: 出力と次の入力がどちらも空の行 (タグ列だけあっても無視)。
 */

const NO_RULE = 0xffff;          // 規則を伴わない打鍵 (バッファに溜めるだけ)
const DIRECTIVES = { '@alwaysenabled': 'alwaysEnabled', '@group': 'group' };

export { NO_RULE };

export function decodeBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer);
  }
  const text = new TextDecoder('utf-8').decode(buffer);
  if (text.indexOf('�') >= 0) {
    // UTF-8 として壊れているなら Shift_JIS を試す
    try {
      const sjis = new TextDecoder('shift_jis').decode(buffer);
      if (sjis.indexOf('�') < 0) return sjis;
    } catch (e) { /* ブラウザが shift_jis 未対応なら諦める */ }
  }
  return text;
}

function splitTags(cell) {
  if (!cell) return [];
  return cell.split(',').map(s => s.trim()).filter(s => s !== '');
}

export function parse(text) {
  const rules = new Map();
  const alwaysEnabled = [];
  const groups = new Map();      // グループ名 -> タグ (ワイルドカード可)
  const stats = { lines: 0, entries: 0, comments: 0, overwritten: 0, tagged: 0, directives: 0 };
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

  for (const raw of lines) {
    if (raw === '') continue;
    stats.lines++;

    const cols = raw.split('\t');
    const input = cols[0];

    // 指示行
    const name = /^@[A-Za-z][A-Za-z0-9]*$/.test(input)
      ? DIRECTIVES[input.toLowerCase()] : undefined;
    if (name) {
      stats.directives++;
      if (name === 'alwaysEnabled') {
        for (const t of splitTags(cols[1])) {
          if (alwaysEnabled.indexOf(t) < 0) alwaysEnabled.push(t);
        }
      } else if (name === 'group') {
        // @group <TAB> 名前 <TAB> タグ,タグ,...
        // 普段まとめて使うタグに名前を付ける。解禁指定で @名前 と書ける
        const gname = (cols[1] || '').trim();
        if (gname) groups.set(gname, splitTags(cols[2]));
      }
      continue;
    }

    const out = cols.length > 1 ? cols[1] : '';
    const next = cols.length > 2 ? cols[2] : '';
    const cats = [splitTags(cols[3]), splitTags(cols[4]), splitTags(cols[5])];

    // 出力・次の入力がどちらも空ならコメント行
    if (out === '' && next === '') { stats.comments++; continue; }
    if (input === '') { stats.comments++; continue; }

    // タグ集合はカテゴリ横断で平坦化する (§4「カテゴリ横断の平坦化」)
    const tags = [];
    for (const cat of cats) {
      for (const t of cat) if (tags.indexOf(t) < 0) tags.push(t);
    }
    if (tags.length) stats.tagged++;

    if (rules.has(input)) stats.overwritten++;   // 重複は後勝ち
    rules.set(input, { out: out, next: next, cats: cats, tags: tags });
  }
  stats.entries = rules.size;
  return index(rules, alwaysEnabled, stats, groups);
}

/*
 * 探索に使う索引を作る。
 *   extendable  「まだ続きがある」プレフィックス。IME と同じく、ここに載って
 *               いる間は変換せず次の打鍵を待つ
 *   alphabet    打鍵候補。規則のキーに出てくる ASCII 文字
 *   ord         定義順。同じ打鍵数の綴りが複数あるとき、先に定義した方を案内に使う
 */
function index(rules, alwaysEnabled, stats, groups) {
  const extendable = new Set();
  const alphabet = [];
  const seen = new Set();
  let ord = 0;

  rules.forEach((v, key) => {
    v.ord = Math.min(ord++, NO_RULE - 1);
    for (let i = 0; i < key.length; i++) {
      extendable.add(key.slice(0, i));
      const c = key.charAt(i);
      if (c.charCodeAt(0) < 0x80 && !seen.has(c)) { seen.add(c); alphabet.push(c); }
    }
  });
  alphabet.sort();

  return {
    rules: rules,
    alwaysEnabled: alwaysEnabled,
    groups: groups || new Map(),
    extendable: extendable,
    alphabet: alphabet,
    convCache: new Map(),        // (バッファ, 打鍵) -> 変換結果。お題に依らない
    routeCache: new Map(),       // かな -> 解析結果
    size: rules.size,
    stats: stats
  };
}

/* テーブルに出てくるタグを全部集める (ワイルドカード解決とコース作成用) */
export function allTags(table) {
  const set = new Set();
  table.rules.forEach(v => { for (const t of v.tags) set.add(t); });
  return set;
}

/*
 * タグの条件式を解決する。unlocks は完全指定とワイルドカードを混ぜられる (§8)。
 *   "ext.hatsu"  完全指定
 *   "*.direct"   打鍵性質で一括
 *   "you.*"      音韻現象で一括
 * x- で始まるタグはワイルドカードの対象外 (§5「予約」)。
 */
export function resolveTags(table, patterns, depth) {
  const out = new Set();
  const all = allTags(table);
  for (const p of patterns || []) {
    // @名前 は @group で宣言したタグの束
    if (p.charAt(0) === '@') {
      const g = table.groups.get(p.slice(1));
      if (g && (depth || 0) < 8) {
        for (const t of resolveTags(table, g, (depth || 0) + 1)) out.add(t);
      }
      continue;
    }
    if (p.indexOf('*') < 0) { out.add(p); continue; }
    const rx = patternToRegExp(p);
    all.forEach(t => { if (t.indexOf('x-') !== 0 && rx.test(t)) out.add(t); });
  }
  return out;
}

/*
 * "*" は「. で区切られた 1 区画」に対応する。ただし語彙には大分類の無い
 * タグ (direct, std, legacy) もあるので、
 *   先頭の "*." は大分類が無い場合にも当たる  ("*.direct" は direct にも当たる)
 *   末尾の ".*" は小分類が無い場合にも当たる  ("you.*" は you にも当たる)
 * とする。設計資料 §8 の例が両方ともこの形。
 */
function patternToRegExp(p) {
  if (p === '*') return /^.*$/;            // 全部 (x- は呼び出し側で除く)
  let body = p;
  let head = '';
  let tail = '';
  if (body.indexOf('*.') === 0) { head = '([^.]+\\.)?'; body = body.slice(2); }
  if (body.length > 2 && body.slice(-2) === '.*') { tail = '(\\.[^.]+)?'; body = body.slice(0, -2); }
  const mid = body.split('*').map(escapeRx).join('[^.]*');
  return new RegExp('^' + head + mid + tail + '$');
}

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/*
 * 有効タグ集合 = alwaysEnabled + そこまでの unlocks の累積和 (§4)
 */
export function enabledTags(table, unlockPatterns) {
  const set = resolveTags(table, unlockPatterns);
  // alwaysEnabled もワイルドカードを書ける。音種や行タグまで含めて常時有効に
  // するには数が多く、列挙させるのは現実的でないため
  for (const t of resolveTags(table, table.alwaysEnabled)) set.add(t);
  return set;
}

/*
 * 有効タグ集合で絞ったテーブルを返す。
 * エントリが載る条件は「そのエントリの持つタグが全て有効タグ集合に含まれる」
 * こと (AND)。タグを持たないエントリは常に載る。
 * enabled が null なら絞らない (全タグ)。
 */
export function filterByTags(table, enabled) {
  if (!enabled) return table;

  const rules = new Map();
  table.rules.forEach((v, key) => {
    for (const t of v.tags) if (!enabled.has(t)) return;
    rules.set(key, { out: v.out, next: v.next, cats: v.cats, tags: v.tags });
  });

  const sub = index(rules, table.alwaysEnabled, {
    lines: table.stats.lines, entries: rules.size, comments: table.stats.comments,
    overwritten: 0, tagged: table.stats.tagged, directives: table.stats.directives
  }, table.groups);
  sub.parent = table;
  return sub;
}
