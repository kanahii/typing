/*
 * お題ファイル。フォーマットは 3 列 (設計 §7)。
 *
 *   1 漢字かな   表示用
 *   2 かな       経路計算用 (省略時は 1 列目をそのまま使う)
 *   3 打鍵列     省略可。オーバーライド用
 *
 * ブロック構造や教示行はお題ファイルに混入させない (§7, §13 不変条件 2)。
 * お題ファイルは自由設定モードでも使う汎用フォーマットなので単純に保つ。
 * 段階固有の構造はコース定義側に書く。
 *
 * 打鍵列オーバーライドの用途は、最短経路が人間の直感と食い違う少数の例の
 * 手当て。空なら都度計算する (§6「エンジン側の要件」)。
 */
import { plan } from './route.js';

export function parse(text) {
  const list = [];
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  for (const line of lines) {
    if (line === '' || line.charAt(0) === '#') continue;
    const cols = line.split('\t');
    const display = cols[0];
    if (display === '') continue;
    list.push({
      type: 'word',
      display: display,
      kana: (cols.length > 1 && cols[1] !== '') ? cols[1] : display,
      keys: (cols.length > 2 && cols[2] !== '') ? cols[2] : null
    });
  }
  return list;
}

export function fromPairs(pairs) {
  return pairs.map(p => ({ type: 'word', display: p[0], kana: p[1], keys: null }));
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  return list;
}

/*
 * プールから n 件選ぶ。打てるかどうかの判定はお題ごとに状態空間を探索する
 * ので、全件は見ない。必要数が埋まるまで前から確かめて、打てないものだけ
 * 飛ばす。お題を増やしても起動時間が増えないようにするため。
 */
export function selectItems(table, pool, count, doShuffle, opts) {
  const list = doShuffle ? shuffle(pool.slice()) : pool.slice();
  const want = Math.max(1, Math.min(count, list.length));
  const items = [];
  const skipped = [];
  for (let i = 0; i < list.length && items.length < want; i++) {
    if (plan(table, list[i].kana, opts).ok) items.push(list[i]);
    else skipped.push(list[i].display);
  }
  return { items: items, skipped: skipped };
}
