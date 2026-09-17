/*
 * お題 1 件ぶんの打鍵状態。
 *
 * 打鍵は IME と同じ要領でテーブルにかけ
 *   text  確定した出力
 *   buf   未確定のバッファ (「次の入力」で残った分を含む)
 * に積んでいく。画面に見えている入力は text + buf。
 * 目標と合っているかは、積まれた text を kana と突き合わせて判定する。
 * ミスタイプしても変換は止めない (何が入力されてしまうのかを見せるため)。
 *
 * テーブルは 2 つ受け取る。
 *   table      全規則。変換と正誤判定はこれで行う。
 *              段階で未解禁の打ち方でも、打てば普通に変換される
 *   hintTable  解禁済みの規則だけ。案内 (次に押すキー、キーの表示、
 *              ローマ字ガイド、短縮余地の基準) はこちらを優先する。
 *              未解禁は「ヒントに出さない」だけで、入力を妨げない
 *
 * 経路計算は route.js に任せる (実装を 1 本に保つ)。
 */
import { convert } from './convert.js';
import { equivalents, align } from './width.js';
import {
  canFinish, stepsLeft, remainingFrom, keysTo, groupLength, maxGuideLength, plan
} from './route.js';

export function createTarget(table, kana, hintTable, opts) {
  const hint = hintTable || table;
  const ro = opts || undefined;   // 配列情報 (Shift 要否のタイブレーク)
  // 全角・半角の片方しか出せない記号は、出せる方で打てたことにする
  const pairs = equivalents(table, ro);

  let text = '';
  let buf = '';
  // text の 1 文字ごとに、それを出すのに使った打鍵数。バックスペースで文字を
  // 消すとその分の打鍵も一緒に消えるので、「いま画面に残っている入力を打つのに
  // 何打鍵かかったか」が分かる。
  let costs = [];
  let pendingKeys = 0;
  let correct = 0;
  let miss = 0;
  let lastExtra = 0;             // 直前の打鍵で増えた打鍵数
  let usedTags = new Set();      // 実際に使った規則のタグ

  function matchLen() {
    const n = Math.min(text.length, kana.length);
    let i = 0;
    while (i < n && text.charAt(i) === kana.charAt(i)) i++;
    return i;
  }

  // 目標に向かって進めている状態か。判定は全規則で行う。
  // 余計な文字が確定した / バッファがどう転んでも目標にならない、なら false。
  function onTrack() {
    const m = matchLen();
    return m === text.length && canFinish(table, kana, m, buf, ro);
  }

  function isComplete() { return text + buf === kana; }

  /*
   * 案内に使うテーブル。解禁済みで打ち切れるならそちらを使い、
   * 解禁済みでは行き着けない状態 (未解禁の打ち方で進んでしまったなど) の
   * ときだけ全規則に落とす。案内が消えてしまうのを避けるため。
   */
  function routeFor(i, b) {
    return canFinish(hint, kana, i, b, ro) ? hint : table;
  }

  /* 短縮余地の基準は、その段階で習った打ち方での最短 */
  function left() {
    const m = matchLen();
    if (m !== text.length) return null;
    return stepsLeft(routeFor(m, buf), kana, m, buf, ro);
  }

  /* 1 打鍵。戻り値は 'ok' / 'miss' / 'done' */
  function input(ch) {
    const before = left();
    const r = convert(table, buf, ch);
    const out = align(pairs, r.out, kana, text.length);

    pendingKeys++;
    if (out !== '') {            // ここまでの打鍵で out が出た
      costs.push(pendingKeys);
      for (let n = 1; n < out.length; n++) costs.push(0);
      pendingKeys = 0;
    }
    text += out;
    buf = r.buf;
    lastExtra = 0;

    if (!onTrack()) { miss++; return 'miss'; }

    for (const t of r.tags) usedTags.add(t);

    // 最短で打てば残りは 1 つ減るはず。減っていない分が、この打鍵で
    // 増えてしまった打鍵数 (じゃ を zya と打ったときの z など)
    const after = left();
    if (before !== null && after !== null && after - before + 1 > 0) {
      lastExtra = after - before + 1;
    }
    correct++;
    return isComplete() ? 'done' : 'ok';
  }

  /*
   * バックスペース。IME と同じく、画面に出ている入力の末尾 1 文字を消す。
   * 未確定のバッファが残っていればそちらを 1 文字、無ければ確定した入力を
   * 1 文字 (ローマ字単位ではなく、変換後の 1 文字)。
   * 消した結果バッファが規則の接頭辞でなくなっても、未確定のまま残す。
   */
  function backspace() {
    if (buf !== '') {
      buf = buf.slice(0, -1);
      if (pendingKeys > 0) pendingKeys--;
      return true;
    }
    if (text !== '') { text = text.slice(0, -1); costs.pop(); return true; }
    return false;
  }

  /* いま画面に残っている入力を打つのに使った打鍵数 */
  function usedKeys() {
    let sum = pendingKeys;
    for (const c of costs) sum += c;
    return sum;
  }

  /* このお題を、その段階で習った打ち方で打ち切るのに最低限必要な打鍵数 */
  function optimalKeys() {
    const r = remainingFrom(hint, kana, 0, '', ro) || remainingFrom(table, kana, 0, '', ro);
    return r === null ? 0 : r.length;
  }

  /*
   * 打ち切った時点で、あと何打鍵減らせたか。
   * バックスペースで打ち直した分は残っていないので数に入らない。
   * 未解禁の短い打ち方を使った場合は基準を下回るので 0 になる。
   */
  function reducible() {
    const diff = usedKeys() - optimalKeys();
    return diff > 0 ? diff : 0;
  }

  /*
   * いまその文字を打ったら何が入力されるか。状態は変えない。
   * キーの表示 (L1) に使うので、解禁済みのテーブルで引く。
   * 未解禁の打ち方は「ヒントに出さない」ため。
   */
  function preview(ch) {
    const r = convert(hint, buf, ch);
    return { out: align(pairs, r.out, kana, text.length), buf: r.buf, dropped: r.dropped };
  }

  /*
   * 表示用。
   *   入力欄  : confirmed (お題と一致) + wrong (ずれた分) + pending (未確定)
   *   案内    : guideDone + remaining (どちらも打鍵列)
   */
  function view() {
    const m = matchLen();
    const ok = onTrack();
    const b = ok ? buf : '';
    const rt = routeFor(m, b);
    const rem = remainingFrom(rt, kana, m, b, ro);
    return {
      confirmed: text.slice(0, m),
      wrong: text.slice(m),
      pending: buf,
      onTrack: ok,
      kanaIndex: m,
      groupLength: groupLength(rt, kana, m, b, ro),
      guideDone: keysTo(rt, kana, m, b, ro),
      remaining: rem === null ? '' : rem,
      correct: correct,
      miss: miss
    };
  }

  return {
    kana: kana,
    input: input,
    backspace: backspace,
    preview: preview,
    view: view,
    isComplete: isComplete,
    lastExtra: () => lastExtra,
    usedKeys: usedKeys,
    optimalKeys: optimalKeys,
    reducible: reducible,
    usedTags: () => usedTags,
    typeable: () => plan(table, kana, ro).ok,
    maxGuideLength: () => Math.max(maxGuideLength(hint, kana, ro), maxGuideLength(table, kana, ro)),
    fullRomaji: () => remainingFrom(hint, kana, 0, '', ro)
  };
}
