/*
 * 経路計算。設計資料 §6 の「中核となる 1 つの計算」。
 *
 *   かな列と (絞り込まれた) テーブルを与えると、最短の打鍵列と、
 *   そこで使われたタグを返す
 *
 * これが以下を全て賄う。実装はこの 1 本に保つ (§13 不変条件 5)。
 *   - お題の自動選抜・フィルタ (オフライン)
 *   - 打鍵中の受理判定と案内 (オンライン)
 *   - プレイ後のフィードバック
 *   - 将来のコース作成支援における検証
 *
 * 「次の入力」に置かれた文字も入力の一部として画面に見えるため、規則の
 * 「出力」を一度も経由しないかなも入力できる。よって到達判定は、規則を
 * たどるのではなくテーブルを実際にシミュレートして行う。
 */
import { convert } from './convert.js';

const NO_RULE_ORD = 0xffff;
const MAX_BUF = 32;

function skey(i, b) { return i + ' ' + b; }

function preferred(prefer, tags) {
  if (!prefer || !tags) return false;
  for (const t of tags) if (prefer.has(t)) return true;
  return false;
}

/*
 * 経路計算のオプションに「優先するタグ」を足す。
 * キャッシュ鍵に入る文字列も一緒に作る (同じテーブルを違う優先度で引くため)。
 */
export function withPrefer(opts, tags) {
  const list = [...(tags || [])].sort();
  return Object.assign({}, opts || {}, {
    // 空なら null にする。優先なしのときの結果とキャッシュ鍵を、
    // withPrefer を通さない呼び出し (自由設定モード) と一致させるため
    prefer: list.length ? new Set(list) : null,
    preferKey: list.join(',')
  });
}

/*
 * お題 1 件ぶんの状態グラフ。
 * 状態は { i: 確定した出力の長さ, buf: 未確定のバッファ }。
 * 起点は先頭と各かな位置 (バックスペースで戻った位置の案内に使う)、
 * および各状態からバッファの末尾を削った状態 (バックスペースで届く)。
 */
/*
 * opts.prefer -> その段階で練習する打ち方のタグ集合 (Set)。
 * opts.preferKey -> prefer をキャッシュ鍵に入れるための文字列 (withPrefer が作る)。
 * 打鍵数が同じ経路が複数あるとき、このタグを使う経路を先に選ぶ。
 * 互換キーは標準の打ち方と打鍵数が同じなので、これが無いと定義順しだいで
 * 案内に出たり出なかったりする (きゃ は kga、ぎゃ は gya のように)。
 * その段階で教えている打ち方を案内に出すために見る。打鍵数は犠牲にしない。
 *
 * opts.shiftOf(ch) -> その文字を出すのに Shift が要るか。
 * 打鍵数が同じ経路が複数あるとき、Shift の少ない方を先に選ぶために使う。
 * 「ー」は JIS では「:」(Shift 不要)、US では「'」(Shift 不要) が押しやすく、
 * どちらが楽かは配列で変わる。テーブルを配列別に分けずに済ませるため、
 * 打鍵数を犠牲にしない範囲でここを見る。
 * 省略すると Shift を考えない (レイアウト非依存の結果になる)。
 */
export function analyze(table, kana, opts) {
  const shiftOf = (opts && opts.shiftOf) || null;
  const prefer = (opts && opts.prefer) || null;
  const cacheKey = (opts && opts.id ? opts.id : '-')
    + '\u0000' + (opts && opts.preferKey ? opts.preferKey : '')
    + '\u0000' + kana;
  const cached = table.routeCache.get(cacheKey);
  if (cached) return cached;

  // 打鍵候補: 規則に出てくる文字 + お題に含まれる ASCII (英数字・空白など)
  const alphabet = table.alphabet.slice();
  const known = new Set(alphabet);
  for (const ch of kana) {
    if (ch.charCodeAt(0) < 0x80 && !known.has(ch)) { known.add(ch); alphabet.push(ch); }
  }

  const nodes = new Map();
  const order = [];

  function node(i, b) {
    const key = skey(i, b);
    let n = nodes.get(key);
    if (!n) {
      n = { key: key, i: i, buf: b, out: [], from: [] };
      nodes.set(key, n);
      order.push(n);
      if (b !== '') node(i, b.slice(0, -1));   // バックスペースで届く状態
    }
    return n;
  }

  for (let s = 0; s <= kana.length; s++) node(s, '');

  for (let qi = 0; qi < order.length; qi++) {
    const cur = order[qi];
    for (const ch of alphabet) {
      const r = convert(table, cur.buf, ch);
      if (!kana.startsWith(r.out, cur.i)) continue;    // 目標からずれる
      if (r.buf.length > MAX_BUF) continue;            // 暴走よけ
      const edge = {
        c: ch, ord: r.ord, outLen: r.out.length, tags: r.tags,
        pref: preferred(prefer, r.tags) ? 0 : 1,
        shift: shiftOf ? (shiftOf(ch) ? 1 : 0) : 0,
        from: cur, to: node(cur.i + r.out.length, r.buf)
      };
      cur.out.push(edge);
      edge.to.from.push(edge);
    }
  }

  // 入力 (確定 + バッファ) がお題そのものになっている状態が終端
  const isEnd = n => n.buf === kana.slice(n.i);

  // 終端からの逆 BFS。dist = そこから打ち切るのに必要な打鍵数
  const dist = new Map();
  const rq = [];
  for (const n of order) if (isEnd(n)) { dist.set(n.key, 0); rq.push(n); }
  for (let ri = 0; ri < rq.length; ri++) {
    const n = rq[ri];
    const d = dist.get(n.key) + 1;
    for (const e of n.from) {
      if (dist.has(e.from.key)) continue;
      dist.set(e.from.key, d);
      rq.push(e.from);
    }
  }

  // 同じ打鍵数の経路が複数あるときの優先順位。前から順に強い。
  //   1. その段階で練習する打ち方を使う (pref)
  //   2. Shift が要らない (shift)
  //   3. テーブルの定義順が早い (ord)
  // 打鍵ごとの順位を並べた文字列にして辞書順で比べる。
  const pick = new Map();
  const seq = new Map();
  for (const n of rq) {
    const d = dist.get(n.key);
    if (d === 0) { seq.set(n.key, ''); continue; }
    let bestEdge = null, bestSeq = null;
    for (const e of n.out) {
      if (dist.get(e.to.key) !== d - 1) continue;
      const cand = String.fromCharCode(e.pref, e.shift, e.ord) + seq.get(e.to.key);
      if (bestSeq === null || cand < bestSeq) { bestSeq = cand; bestEdge = e; }
    }
    seq.set(n.key, bestSeq === null ? '' : bestSeq);
    if (bestEdge) pick.set(n.key, bestEdge);
  }

  // 先頭からの前向き BFS。各状態に至る最短の打鍵列
  const start = nodes.get(skey(0, ''));
  const fdist = new Map([[start.key, 0]]);
  const fq = [start];
  for (let fi = 0; fi < fq.length; fi++) {
    const n = fq[fi];
    const nd = fdist.get(n.key) + 1;
    for (const e of n.out) {
      if (fdist.has(e.to.key)) continue;
      fdist.set(e.to.key, nd);
      fq.push(e.to);
    }
  }
  const fwd = new Map([[start.key, '']]);
  const fseq = new Map([[start.key, '']]);
  for (let gi = 1; gi < fq.length; gi++) {
    const n = fq[gi];
    const gd = fdist.get(n.key);
    let bstr = null, bseq = null;
    for (const e of n.from) {
      if (fdist.get(e.from.key) !== gd - 1) continue;
      const cs = fseq.get(e.from.key) + String.fromCharCode(e.pref, e.shift, e.ord);
      if (bseq === null || cs < bseq) { bseq = cs; bstr = fwd.get(e.from.key) + e.c; }
    }
    fseq.set(n.key, bseq === null ? '' : bseq);
    fwd.set(n.key, bstr === null ? '' : bstr);
  }

  const result = { kana: kana, nodes: nodes, dist: dist, pick: pick, fwd: fwd };
  table.routeCache.set(cacheKey, result);
  return result;
}

/* (i, b) から打ち切れるか */
export function canFinish(table, kana, i, b, opts) {
  const a = analyze(table, kana, opts);
  const n = a.nodes.get(skey(i, b));
  return !!(n && a.dist.has(n.key));
}

/* (i, b) から打ち切るのに必要な残り打鍵数。打ち切れなければ null */
export function stepsLeft(table, kana, i, b, opts) {
  const a = analyze(table, kana, opts);
  const n = a.nodes.get(skey(i, b));
  return (n && a.dist.has(n.key)) ? a.dist.get(n.key) : null;
}

/* (i, b) から打ち切るための最短の打鍵列。打ち切れなければ null */
export function remainingFrom(table, kana, i, b, opts) {
  const a = analyze(table, kana, opts);
  let n = a.nodes.get(skey(i, b));
  if (!n || !a.dist.has(n.key)) return null;

  let s = '';
  let guard = 0;
  while (a.dist.get(n.key) > 0 && guard++ < 1024) {
    const e = a.pick.get(n.key);
    if (!e) return null;
    s += e.c;
    n = e.to;
  }
  return s;
}

/*
 * その状態に至るまでの最短の打鍵列。バッファの中身ではなく実際に押すキー。
 * バックスペースでしか行けない状態には前向きの経路がないので、その場合は
 * 直前の区切りまでの打鍵列で代用する。
 */
export function keysTo(table, kana, i, b, opts) {
  const a = analyze(table, kana, opts);
  const key = skey(i, b);
  if (a.fwd.has(key)) return a.fwd.get(key);
  const base = a.fwd.get(skey(i, ''));
  return base === undefined ? '' : base;
}

/*
 * 次にまとめて確定するかなの文字数。
 * 案内どおり打ったときに、次に出力を伴う打鍵が何文字を出すかを見る。
 * 「次の入力」で続けて入力される分は別の打鍵になるので含まない。
 */
export function groupLength(table, kana, i, b, opts) {
  const a = analyze(table, kana, opts);
  let n = a.nodes.get(skey(i, b));
  if (!n || !a.dist.has(n.key)) return 1;

  let guard = 0;
  while (a.dist.get(n.key) > 0 && guard++ < 64) {
    const e = a.pick.get(n.key);
    if (!e) break;
    if (e.outLen > 0) return e.outLen;
    n = e.to;
  }
  return 1;
}

/* 案内が取りうる最大の長さ。表示欄の高さを先に確保するのに使う */
export function maxGuideLength(table, kana, opts) {
  const a = analyze(table, kana, opts);
  let max = 0;
  a.nodes.forEach(n => {
    if (!a.dist.has(n.key)) return;
    const len = keysTo(table, kana, n.i, n.buf, opts).length + a.dist.get(n.key);
    if (len > max) max = len;
  });
  return max;
}

/*
 * §6「中核となる 1 つの計算」の公開形。
 * 真偽値ではなく判定理由を含む結果オブジェクトを返す (§6「返り値の形」)。
 * 設計時フィルタは「なぜこの文が落ちたか」を人に見せる必要があるため。
 *
 *   ok        打ち切れるか
 *   cost      最短の打鍵数
 *   keys      最短の打鍵列
 *   tags      その経路で使ったタグ
 *   consumesMultiple  かな 2 文字以上を 1 エントリで消費する箇所があるか
 *   reason    落ちた理由 (ok が false のとき)
 */
export function plan(table, kana, opts) {
  const keys = remainingFrom(table, kana, 0, '', opts);
  if (keys === null) {
    return {
      ok: false, cost: Infinity, keys: null, tags: new Set(), tagCounts: new Map(),
      consumesMultiple: false,
      reason: 'このテーブルでは打ち切れる打鍵列が存在しない'
    };
  }

  // 選んだ経路を辿り直して、使ったタグと複数かな消費の有無を集める。
  // タグは有無だけでなく回数も数える。「その段階で練習するものが 1 文の中に
  // 何回出るか」は、お題を選ぶうえで有無より重要なため。
  const a = analyze(table, kana, opts);
  let n = a.nodes.get(skey(0, ''));
  const tags = new Set();
  const tagCounts = new Map();
  let consumesMultiple = false;
  let guard = 0;
  while (a.dist.get(n.key) > 0 && guard++ < 1024) {
    const e = a.pick.get(n.key);
    if (!e) break;
    for (const t of e.tags) {
      tags.add(t);
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
    if (e.outLen >= 2) consumesMultiple = true;
    n = e.to;
  }

  return {
    ok: true, cost: keys.length, keys: keys, tags: tags, tagCounts: tagCounts,
    consumesMultiple: consumesMultiple, reason: null
  };
}

/*
 * 段階での経路と全タグでの経路を比べる (§6「2 つの経路長」)。
 * 無駄 = cost_stage - cost_full。「まだ習っていない拡張が使える箇所」の量。
 * 0 に近いほどその段階で練習する価値がある。
 */
export function compare(fullTable, stageTable, kana, opts) {
  const full = plan(fullTable, kana, opts);
  const stage = plan(stageTable, kana, opts);
  return {
    kana: kana,
    ok: stage.ok && full.ok,
    stage: stage,
    full: full,
    waste: (stage.ok && full.ok) ? stage.cost - full.cost : Infinity,
    reason: !stage.ok ? 'この段階の打鍵では打ち切れない: ' + stage.reason
          : !full.ok ? 'このテーブルでは打ち切れない: ' + full.reason
          : null
  };
}
