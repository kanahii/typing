/*
 * 打鍵 1 文字ぶんの変換。IME と同じ要領で、目標とは無関係に常にテーブル
 * どおりに変換する。変換しきれない文字はそのまま入力される。
 *
 * 戻り値
 *   out      確定した出力
 *   buf      残ったバッファ (「次の入力」で置かれた文字を含む。これも入力の一部)
 *   ord      最初に使った規則の定義順。同じ打鍵数の綴りの優先に使う
 *   dropped  溜めていたバッファが変換されずに素通しされたか
 *   tags     この打鍵で使った規則のタグ (カテゴリ横断で平坦化済み)
 */
import { NO_RULE } from './table.js';

export function convert(table, startBuf, ch) {
  // 変換結果はテーブルだけで決まるので、お題をまたいで使い回す
  const ckey = startBuf + ' ' + ch;
  const cached = table.convCache.get(ckey);
  if (cached) return cached;

  let out = '';
  let ord = NO_RULE;
  let dropped = false;
  let tags = null;
  let b = startBuf + ch;
  let guard = 0;

  const use = e => {
    if (ord === NO_RULE) ord = e.ord;
    if (e.tags.length) {
      if (!tags) tags = [];
      for (const t of e.tags) if (tags.indexOf(t) < 0) tags.push(t);
    }
  };

  while (b !== '' && guard++ < 64) {
    if (table.extendable.has(b)) break;              // まだ続きを待つ

    const e = table.rules.get(b);
    if (e) { use(e); out += e.out; b = e.next; continue; }

    // b は規則にならない。前から確定できるだけ確定させて詰める
    let applied = false;
    for (let L = b.length - 1; L >= 1; L--) {
      const pre = table.rules.get(b.slice(0, L));
      if (pre) { use(pre); out += pre.out; b = pre.next + b.slice(L); applied = true; break; }
    }
    if (applied) continue;

    if (startBuf !== '') dropped = true;             // 打ちかけが消える
    out += b.charAt(0);                              // 変換できない文字はそのまま
    b = b.slice(1);
  }

  const result = { out: out, buf: b, ord: ord, dropped: dropped, tags: tags || [] };
  table.convCache.set(ckey, result);
  return result;
}
