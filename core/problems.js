/*
 * お題ファイル。1 行 1 題で、列は 3 つ (設計 §7)。
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
 *
 *
 * 連続出題グループ
 * ----------------
 * ランダム出題でも並べ替えず、必ずその順で続けて出したい数行を囲める。
 *
 *   #{ 桃太郎
 *   昔々あるところに	むかしむかしあるところに
 *   お爺さんとお婆さんが住んでいました	おじいさんとおばあさんがすんでいました
 *   #}
 *
 * 「この数行は文脈上不可分」という性質は、どのコースのどの段階から読まれても
 * 同じ値になる。お題自身の属性なので、お題ファイルに置いてよい (§7 の判定基準)。
 *
 * 選抜の単位は、この「グループ」か「単独のお題 1 件」。どちらも units の 1 要素
 * として同じ形で扱い、グループの有無で処理を分けない。
 */
import { plan } from './route.js';

/* 空白とみなす文字。日本語の利用者は全角空白を打つことがある */
const SPACE = /[ \t　]/;
const OPEN = '#{';
const CLOSE = '#}';

function trimEnd(s) {
  let i = s.length;
  while (i > 0 && SPACE.test(s.charAt(i - 1))) i--;
  return s.slice(0, i);
}

function item(cols) {
  const display = cols[0];
  return {
    type: 'word',
    display: display,
    kana: (cols.length > 1 && cols[1] !== '') ? cols[1] : display,
    keys: (cols.length > 2 && cols[2] !== '') ? cols[2] : null
  };
}

/* 単位の呼び名。エラーや除外の報告に使う */
export function unitName(unit) {
  return unit.label || (unit.items.length ? unit.items[0].display : '(空)');
}

/*
 * お題ファイルを選抜の単位に分けて読む。
 *
 *   units    [{ items, label, line }]  単独のお題も 1 件だけの単位
 *   errors   [{ line, message }]       記法の誤り。あれば読み込みを断る
 *   warnings [{ line, message }]       読めはするが、たぶん書き間違い
 *
 * 記法の誤りを黙って補正も無視もしない。誤った範囲でグループが成立したり
 * しなかったりしても気付けないため。
 */
export function parse(text) {
  const units = [];
  const errors = [];
  const warnings = [];
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

  let open = null;          // 開いているグループ { items, label, line }

  const push = (u) => { if (u.items.length) units.push(u); };

  lines.forEach((raw, i) => {
    const no = i + 1;
    const line = trimEnd(raw);
    if (line === '') return;

    // 行頭に空白があると、現状のパーサでは表示文として読まれてしまう。
    // 新しい記法と組み合わさると気付きにくいので知らせる
    const lead = line.replace(/^[ \t　]+/, '');
    if (lead !== line && (lead.indexOf(OPEN) === 0 || lead.indexOf(CLOSE) === 0)) {
      warnings.push({ line: no, message: '行頭に空白があります。グループの印として扱いません: ' + line.trim() });
    }

    if (line.indexOf(OPEN) === 0) {
      const rest = line.slice(OPEN.length);
      if (rest !== '' && !SPACE.test(rest.charAt(0))) {
        errors.push({ line: no, message: OPEN + ' の後ろは行末か空白にしてください: ' + line });
        return;
      }
      if (open) {
        errors.push({ line: no, message: 'グループの中でグループを開いています（' + open.line + ' 行目から開いたまま）' });
        return;
      }
      open = { items: [], label: rest.trim(), line: no };
      return;
    }

    if (line.indexOf(CLOSE) === 0) {
      const rest = line.slice(CLOSE.length);
      if (rest !== '') {
        errors.push({ line: no, message: CLOSE + ' の行には何も書けません: ' + line });
        return;
      }
      if (!open) {
        errors.push({ line: no, message: '対応する ' + OPEN + ' がありません' });
        return;
      }
      if (!open.items.length) {
        warnings.push({ line: open.line, message: '中身の無いグループです' });
      }
      push(open);
      open = null;
      return;
    }

    if (line.charAt(0) === '#') return;        // ふつうのコメント

    const it = item(line.split('\t'));
    if (it.display === '') return;
    if (open) open.items.push(it);
    else units.push({ items: [it], label: '', line: no });
  });

  if (open) {
    errors.push({ line: open.line, message: 'グループが ' + CLOSE + ' で閉じていません' });
  }

  return { units: units, errors: errors, warnings: warnings };
}

/* 既定のお題。各組を 1 件だけの単位として返す */
export function fromPairs(pairs) {
  return {
    units: pairs.map((p, i) => ({
      items: [{ type: 'word', display: p[0], kana: p[1], keys: null }],
      label: '', line: i + 1
    })),
    errors: [],
    warnings: []
  };
}

/* 単位に含まれる全行が打てるか (集約は AND)。1 行でも打てなければ丸ごと外す */
export function unitTypeable(table, unit, opts) {
  return unit.items.every(it => plan(table, it.kana, opts).ok);
}

export function countItems(units) {
  let n = 0;
  for (const u of units) n += u.items.length;
  return n;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  return list;
}

/*
 * 単位から出題分を選ぶ。
 *
 * 出題数は行数で数える。足りるまで単位を丸ごと足し、最後の 1 単位ぶんだけ
 * 超えることを許す。行数が出題数を超える単位は、入りようがないので外す。
 *
 * 打てるかどうかの判定は状態空間の探索なので、必要数が埋まるまでしか見ない。
 * お題を増やしても起動時間が増えないようにするため。
 * ただし「長すぎる単位」は行数だけで決まる静的な条件なので、先に全件から
 * 求めておく。打ち切った後ろに残ったぶんも漏れなく報告できる。
 */
export function selectItems(table, units, count, doShuffle, opts) {
  const want = Math.max(1, count);
  const long = new Set(units.filter(u => u.items.length > want));
  const tooLong = [...long].map(u => ({ name: unitName(u), length: u.items.length }));

  const list = doShuffle ? shuffle(units.slice()) : units.slice();
  const items = [];
  const skipped = [];
  for (const u of list) {
    if (items.length >= want) break;
    if (long.has(u)) continue;
    if (unitTypeable(table, u, opts)) for (const it of u.items) items.push(it);
    else skipped.push(unitName(u));
  }
  return { items: items, skipped: skipped, tooLong: tooLong };
}
