/*
 * タイピング判定エンジン。
 *
 * ローマ字テーブルは「入力 / 出力 / 次の入力」の 3 列。
 * 例:  tt <TAB> っ <TAB> t   →  "tt" を打つと「っ」が確定し、"t" が入力欄に残る。
 *
 * 1 つのかなに複数のローマ字表記がある (し = si / shi / ci) ため、
 * 判定は「現在ありうる状態の集合」を持って進める。
 * 状態は { i: 確定したかな数, buf: 未確定のローマ字バッファ }。
 */
var Engine = (function () {
  'use strict';

  /* ---------------- テーブル ---------------- */

  function decodeBytes(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(buffer);
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(buffer);
    }
    var text = new TextDecoder('utf-8').decode(buffer);
    if (text.indexOf('\uFFFD') >= 0) {
      // UTF-8 として壊れているなら Shift_JIS を試す
      try {
        var sjis = new TextDecoder('shift_jis').decode(buffer);
        if (sjis.indexOf('\uFFFD') < 0) { return sjis; }
      } catch (e) { /* ブラウザが shift_jis 未対応なら諦める */ }
    }
    return text;
  }

  function parseTable(text) {
    var map = new Map();
    var stats = { lines: 0, entries: 0, comments: 0, overwritten: 0 };
    var lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');

    for (var n = 0; n < lines.length; n++) {
      var raw = lines[n];
      if (raw === '') continue;
      stats.lines++;

      var cols = raw.split('\t');
      var input = cols[0];
      var out = cols.length > 1 ? cols[1] : '';
      var next = cols.length > 2 ? cols[2] : '';

      // 出力・次の入力がどちらも空ならコメント行
      if (out === '' && next === '') { stats.comments++; continue; }
      if (input === '') { stats.comments++; continue; }

      if (map.has(input)) stats.overwritten++;   // 重複は後勝ち
      map.set(input, { out: out, next: next });
    }
    stats.entries = map.size;
    return buildTable(map, stats);
  }

  function buildTable(map, stats) {
    // prefixIndex: 前方一致検索用 (バッファ文字列 -> それで始まる規則の配列)
    // extendable : 「まだ続きがある」プレフィックスの集合
    var prefixIndex = new Map();
    var extendable = new Set();
    var ord = 0;

    map.forEach(function (v, key) {
      // ord は定義順。同じ打鍵数の表記が複数ある場合、先に定義された方を案内に使う
      var entry = { key: key, out: v.out, next: v.next, ord: ord++ };
      for (var i = 0; i <= key.length; i++) {
        var p = key.slice(0, i);
        var arr = prefixIndex.get(p);
        if (!arr) { arr = []; prefixIndex.set(p, arr); }
        arr.push(entry);
        if (i < key.length) extendable.add(p);
      }
    });

    return {
      map: map,
      prefixIndex: prefixIndex,
      extendable: extendable,
      size: map.size,
      stats: stats
    };
  }

  /* ---------------- 1 問分の判定 ---------------- */

  function createTarget(table, kana) {
    var memo = new Map();          // "i\0buf" -> 最短の残りローマ字 (不可能なら null)
    var states = [{ i: 0, buf: '' }];
    var typed = '';
    var correct = 0;
    var miss = 0;

    function skey(i, buf) { return i + '\u0000' + buf; }

    // テーブルに規則がなくても、キーボードから直接打てる文字 (英数字・記号・空白)
    function isDirect(c) { return c !== '' && c.charCodeAt(0) < 0x80; }

    // (i, buf) から目標かなを打ち切るのに必要な、最短の残りローマ字。
    // 戻り値は { s: 残りの打鍵, ord: 最初に使った規則の定義順 }。打ち切れなければ null。
    function shortest(i, buf, visiting) {
      var k = skey(i, buf);
      if (memo.has(k)) return memo.get(k);
      if (i >= kana.length && buf === '') return { s: '', ord: Infinity };
      if (visiting.has(k)) return null;           // 循環定義よけ

      visiting.add(k);
      var best = null;
      var cands = table.prefixIndex.get(buf);
      if (cands) {
        for (var n = 0; n < cands.length; n++) {
          var e = cands[n];
          if (!kana.startsWith(e.out, i)) continue;
          var rest = shortest(i + e.out.length, e.next, visiting);
          if (rest === null) continue;
          var cand = { s: e.key.slice(buf.length) + rest.s, ord: e.ord };
          if (best === null
              || cand.s.length < best.s.length
              || (cand.s.length === best.s.length && cand.ord < best.ord)) {
            best = cand;
          }
        }
      }
      // テーブルに規則がない文字 (英数字・空白など) はそのまま打つ
      if (best === null && buf === '' && i < kana.length && isDirect(kana.charAt(i))) {
        var tail = shortest(i + 1, '', visiting);
        if (tail !== null) best = { s: kana.charAt(i) + tail.s, ord: Infinity };
      }
      visiting.delete(k);
      memo.set(k, best);
      return best;
    }

    function remainingFrom(i, buf) {
      var r = shortest(i, buf, new Set());
      return r === null ? null : r.s;
    }

    // バッファがそのまま規則に一致する状態を、確定済みの状態にも展開する
    function expand(list) {
      var out = [];
      var seen = new Set();
      var stack = list.slice();
      while (stack.length) {
        var s = stack.pop();
        var k = skey(s.i, s.buf);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
        if (s.buf !== '') {
          var e = table.map.get(s.buf);
          if (e && kana.startsWith(e.out, s.i)) {
            stack.push({ i: s.i + e.out.length, buf: e.next });
          }
        }
      }
      return out;
    }

    function isComplete() {
      for (var n = 0; n < states.length; n++) {
        if (states[n].i >= kana.length && states[n].buf === '') return true;
      }
      return false;
    }

    // 1 打鍵。戻り値は 'ok' / 'miss' / 'done'
    function input(ch) {
      var next = [];
      var seen = new Set();

      function push(s) {
        if (remainingFrom(s.i, s.buf) === null) return;   // 目標に到達不能な枝は捨てる
        var k = skey(s.i, s.buf);
        if (seen.has(k)) return;
        seen.add(k);
        next.push(s);
      }

      for (var n = 0; n < states.length; n++) {
        var s = states[n];
        var nb = s.buf + ch;
        if (table.extendable.has(nb)) push({ i: s.i, buf: nb });   // まだ続きを待つ
        var e = table.map.get(nb);
        if (e && kana.startsWith(e.out, s.i)) push({ i: s.i + e.out.length, buf: e.next });
      }

      if (next.length === 0) {
        // テーブルにない文字はそのまま一致で進める
        for (var m = 0; m < states.length; m++) {
          if (states[m].buf === '' && kana.charAt(states[m].i) === ch && isDirect(ch)) {
            push({ i: states[m].i + 1, buf: '' });
          }
        }
      }

      if (next.length === 0) { miss++; return 'miss'; }

      states = expand(next);
      typed += ch;
      correct++;
      return isComplete() ? 'done' : 'ok';
    }

    // 表示用。typed は実際に打った文字列、remaining は最短の残り
    function view() {
      var best = null;
      var maxI = 0;
      for (var n = 0; n < states.length; n++) {
        var s = states[n];
        var r = remainingFrom(s.i, s.buf);
        if (r === null) continue;
        if (s.i > maxI) maxI = s.i;
        if (best === null || r.length < best.length) best = r;
      }
      return {
        typed: typed,
        remaining: best === null ? '' : best,
        kanaIndex: Math.min(maxI, kana.length),
        correct: correct,
        miss: miss
      };
    }

    return {
      kana: kana,
      input: input,
      view: view,
      isComplete: isComplete,
      // このテーブルで打ち切れる問題かどうか
      typeable: function () { return remainingFrom(0, '') !== null; },
      fullRomaji: function () { return remainingFrom(0, ''); }
    };
  }

  return {
    decodeBytes: decodeBytes,
    parseTable: parseTable,
    createTarget: createTarget
  };
})();
