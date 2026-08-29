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
    // byNext     : 逆引き用 (規則の「次の入力」-> その規則の配列)
    var prefixIndex = new Map();
    var extendable = new Set();
    var byNext = new Map();
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
      var nx = byNext.get(entry.next);
      if (!nx) { nx = []; byNext.set(entry.next, nx); }
      nx.push(entry);
    });

    return {
      map: map,
      prefixIndex: prefixIndex,
      extendable: extendable,
      byNext: byNext,
      size: map.size,
      stats: stats
    };
  }

  /* ---------------- 1 問分の判定 ---------------- */

  function createTarget(table, kana) {
    var memo = new Map();          // "i\0buf" -> 最短の残りローマ字 (不可能なら null)

    // 入力は IME と同じように、打鍵をテーブルで変換して積んでいく。
    // 目標と合っているかどうかは、積まれた text を kana と突き合わせて判定する。
    // ミスタイプしても変換は止めない (何が入力されてしまうのかを見せるため)。
    var text = '';                 // 変換された入力
    var buf = '';                  // 未確定のローマ字
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

    // shortest の逆向き。先頭から (i, buf) に到達する最短ローマ字を返す。
    // バックスペースで戻った位置の「打ち終わったローマ字」表示に使う。
    var pathMemo = new Map();

    function pathState(i, buf, visiting) {
      if (i < 0) return null;
      if (i === 0 && buf === '') return '';
      var k = skey(i, buf);
      if (pathMemo.has(k)) return pathMemo.get(k);
      if (visiting.has(k)) return null;           // 循環定義よけ

      visiting.add(k);
      var best = null;
      var bestOrd = Infinity;
      // (i, buf) に着く規則は「次の入力」が buf のものだけ
      var list = table.byNext.get(buf) || [];
      for (var n = 0; n < list.length; n++) {
        var e = list[n];
        var pi = i - e.out.length;
        if (pi < 0 || !kana.startsWith(e.out, pi)) continue;
        // e.key は、直前のバッファ (e.key の真の接頭辞) の続きとして打たれる
        for (var p = 0; p < e.key.length; p++) {
          var head = pathState(pi, e.key.slice(0, p), visiting);
          if (head === null) continue;
          var cand = head + e.key.slice(p);
          if (best === null || cand.length < best.length
              || (cand.length === best.length && e.ord < bestOrd)) {
            best = cand;
            bestOrd = e.ord;
          }
        }
      }
      // 規則がない文字 (英数字・空白など) はそのまま打たれている
      if (best === null && buf === '' && i > 0 && isDirect(kana.charAt(i - 1))) {
        var head2 = pathState(i - 1, '', visiting);
        if (head2 !== null) best = head2 + kana.charAt(i - 1);
      }
      visiting.delete(k);
      pathMemo.set(k, best);
      return best;
    }

    function pathTo(n) { return pathState(n, '', new Set()); }

    // 打鍵 1 文字を IME と同じ要領で取り込む。目標とは無関係に、
    // テーブルどおりに変換する。変換しきれない文字はそのまま入力される。
    function convert(ch) {
      var b = buf + ch;
      var guard = 0;
      while (b !== '' && guard++ < 64) {
        if (table.extendable.has(b)) break;              // まだ続きを待つ

        var e = table.map.get(b);
        if (e) { text += e.out; b = e.next; continue; }  // 規則どおりに確定

        // b は規則にならない。前から確定できるだけ確定させて詰める
        var applied = false;
        for (var L = b.length - 1; L >= 1; L--) {
          var pre = table.map.get(b.slice(0, L));
          if (pre) { text += pre.out; b = pre.next + b.slice(L); applied = true; break; }
        }
        if (applied) continue;

        text += b.charAt(0);                             // 変換できない文字はそのまま
        b = b.slice(1);
      }
      buf = b;
    }

    // text と kana が一致している長さ
    function matchLen() {
      var n = Math.min(text.length, kana.length);
      var i = 0;
      while (i < n && text.charAt(i) === kana.charAt(i)) i++;
      return i;
    }

    // 目標に向かって進めている状態か。
    // 余計な文字が入っている / バッファがどう転んでも目標にならない、なら false。
    function onTrack() {
      var m = matchLen();
      return m === text.length && remainingFrom(m, buf) !== null;
    }

    function isComplete() { return text === kana && buf === ''; }

    // 1 打鍵。戻り値は 'ok' / 'miss' / 'done'
    function input(ch) {
      convert(ch);
      if (!onTrack()) { miss++; return 'miss'; }
      correct++;
      return isComplete() ? 'done' : 'ok';
    }

    // バックスペース。戻り値は、実際に取り消したかどうか。
    // 未確定のローマ字が残っていればそれを捨て、無ければ入力を 1 文字戻す。
    // 戻すのはローマ字ではなく、変換後の 1 文字 (かな単位)。
    function backspace() {
      if (buf !== '') { buf = ''; return true; }
      if (text !== '') { text = text.slice(0, -1); return true; }
      return false;
    }

    // 表示用。
    //   入力欄  : confirmed (目標と一致) + wrong (ずれた分) + pending (未確定)
    //   ガイド  : guideDone + guidePending + remaining
    // ガイドは実際に打った綴りではなく、その位置に至る最短の綴りで表示する。
    function view() {
      var m = matchLen();
      var ok = onTrack();
      var rem = ok ? remainingFrom(m, buf) : remainingFrom(m, '');
      var head = pathTo(m);
      return {
        confirmed: text.slice(0, m),
        wrong: text.slice(m),
        pending: buf,
        onTrack: ok,
        kanaIndex: m,
        guideDone: head === null ? '' : head,
        guidePending: ok ? buf : '',
        remaining: rem === null ? '' : rem,
        correct: correct,
        miss: miss
      };
    }

    return {
      kana: kana,
      input: input,
      backspace: backspace,
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
