/*
 * 画面内キーボード。
 * 次に押すキーと、実際に押されたキーをハイライトする。
 *
 * ローマ字テーブルによっては、ローマ字表記とかけ離れたマッピングになる。
 * その場合ローマ字ガイドは読みづらいので、キー位置で示せるようにする。
 */
var Keyboard = (function () {
  'use strict';

  // lo = そのまま押したときの文字 / hi = Shift を押したときの文字
  function k(lo, hi, w, label) {
    return { lo: lo, hi: hi || null, w: w || 1, label: label || null };
  }
  // 文字を持たないキー
  function sp(label, w, id) {
    return { lo: null, hi: null, w: w, label: label, id: id || null };
  }
  // 英字キー
  function a(c) { return k(c, c.toUpperCase()); }

  var LETTERS1 = 'qwertyuiop'.split('').map(a);
  var LETTERS2 = 'asdfghjkl'.split('').map(a);
  var LETTERS3 = 'zxcvbnm'.split('').map(a);

  var LAYOUTS = {
    jis: {
      name: 'JIS (日本語)',
      rows: [
        [sp('半/全', 1)].concat(
          [k('1', '!'), k('2', '"'), k('3', '#'), k('4', '$'), k('5', '%'),
           k('6', '&'), k('7', "'"), k('8', '('), k('9', ')'), k('0', null),
           k('-', '='), k('^', '~'), k('¥', '|')],
          [sp('BS', 1.5, 'backspace')]),
        [sp('Tab', 1.5)].concat(LETTERS1, [k('@', '`'), k('[', '{')], [sp('', 2)]),
        [sp('Caps', 1.75)].concat(LETTERS2, [k(';', '+'), k(':', '*'), k(']', '}')],
          [sp('Enter', 1.75, 'enter')]),
        [sp('Shift', 2.25, 'shift')].concat(LETTERS3,
          [k(',', '<'), k('.', '>'), k('/', '?'), k('\\', '_')],
          [sp('Shift', 2.25, 'shift')]),
        [sp('Ctrl', 1.25), sp('Win', 1.25), sp('Alt', 1.25), sp('無変換', 1.25),
         k(' ', null, 5.5, 'Space'),
         sp('変換', 1.25), sp('かな', 1.25), sp('Alt', 1.25), sp('Ctrl', 1.25)]
      ]
    },
    us: {
      name: 'US (英語)',
      rows: [
        [k('`', '~'), k('1', '!'), k('2', '@'), k('3', '#'), k('4', '$'), k('5', '%'),
         k('6', '^'), k('7', '&'), k('8', '*'), k('9', '('), k('0', ')'),
         k('-', '_'), k('=', '+'), sp('BS', 2, 'backspace')],
        [sp('Tab', 1.5)].concat(LETTERS1, [k('[', '{'), k(']', '}'), k('\\', '|', 1.5)]),
        [sp('Caps', 1.75)].concat(LETTERS2, [k(';', ':'), k("'", '"')],
          [sp('Enter', 2.25, 'enter')]),
        [sp('Shift', 2.25, 'shift')].concat(LETTERS3,
          [k(',', '<'), k('.', '>'), k('/', '?')],
          [sp('Shift', 2.75, 'shift')]),
        [sp('Ctrl', 1.25), sp('Win', 1.25), sp('Alt', 1.25),
         k(' ', null, 6.25, 'Space'),
         sp('Alt', 1.25), sp('Win', 1.25), sp('Menu', 1.25), sp('Ctrl', 1.25)]
      ]
    }
  };

  function names() {
    return Object.keys(LAYOUTS).map(function (id) {
      return { id: id, name: LAYOUTS[id].name };
    });
  }

  // ホームポジションの目印。キーの刻印 (lo) で見るので JIS / US 共通
  var HOME_ROW = 'asdfghjkl;';
  var HOME_ANCHOR = 'fj';

  function create(container, layoutName) {
    var layout = LAYOUTS[layoutName] || LAYOUTS.jis;
    var index = new Map();       // 文字 -> { el, shift }
    var byId = new Map();        // 'shift' などの特殊キー -> [el]
    var marked = [];             // いま next を付けているキー
    var charKeys = [];           // 表示を差し替えるキー

    container.textContent = '';

    layout.rows.forEach(function (row) {
      var r = document.createElement('div');
      r.className = 'kb-row';

      row.forEach(function (key) {
        var el = document.createElement('div');
        el.className = 'kb-key';
        el.style.flexGrow = String(key.w);

        if (key.lo && HOME_ANCHOR.indexOf(key.lo) >= 0) el.classList.add('kb-anchor');
        else if (key.lo && HOME_ROW.indexOf(key.lo) >= 0) el.classList.add('kb-home');

        if (key.label !== null) {
          el.classList.add('kb-sp');
          el.textContent = key.label;
        } else {
          // 刻印ではなく「いま押したら入力される文字」を出すので、
          // 中身は setLabels で差し替える
          var hi = document.createElement('span');
          hi.className = 'kb-hi';
          var lo = document.createElement('span');
          lo.className = 'kb-lo';
          var out = document.createElement('span');
          out.className = 'kb-out';
          var pend = document.createElement('span');
          pend.className = 'kb-pend';
          lo.appendChild(out);
          lo.appendChild(pend);
          el.appendChild(hi);
          el.appendChild(lo);
          charKeys.push({ el: el, lo: key.lo, hi: key.hi, hiEl: hi, outEl: out, pendEl: pend });
        }

        if (key.lo && !index.has(key.lo)) index.set(key.lo, { el: el, shift: false });
        if (key.hi && !index.has(key.hi)) index.set(key.hi, { el: el, shift: true });
        if (key.id) {
          if (!byId.has(key.id)) byId.set(key.id, []);
          byId.get(key.id).push(el);
        }

        r.appendChild(el);
      });

      container.appendChild(r);
    });

    // 各キーに「いま押したら何が入力されるか」を出す。
    //   preview(ch) -> { out: 確定する文字, buf: 未確定で残る文字 } または null
    //   known       : テーブルの規則に出てくる文字の集合。
    //                 Shift 側は、ここに入っている文字だけ表示する
    //                 (大文字などを出しても読みづらくなるだけなので)
    function setLabels(preview, known) {
      for (var i = 0; i < charKeys.length; i++) {
        var rec = charKeys[i];
        var p = preview ? preview(rec.lo) : null;

        if (p && p.dropped) {
          // 打ちかけを無駄にするキー。何が出るかを出しても読みづらいので、
          // その打鍵で始まる分だけを薄く出す
          rec.outEl.textContent = '';
          rec.pendEl.textContent = p.buf || rec.lo;
          rec.el.classList.add('kb-dead');
        } else {
          rec.outEl.textContent = p ? p.out : rec.lo;
          rec.pendEl.textContent = p ? p.buf : '';
          rec.el.classList.remove('kb-dead');
        }

        if (rec.hi && known && known.has(rec.hi)) {
          var q = preview ? preview(rec.hi) : null;
          rec.hiEl.textContent = q ? (q.dropped ? rec.hi : q.out + q.buf) : rec.hi;
        } else {
          rec.hiEl.textContent = '';
        }
      }
    }

    function clearNext() {
      for (var i = 0; i < marked.length; i++) marked[i].classList.remove('next', 'next-mod');
      marked = [];
    }

    function mark(el, cls) { el.classList.add(cls); marked.push(el); }

    // 次に押すキーを示す。Shift が要るキーなら Shift も一緒に示す
    function setNext(ch) {
      clearNext();
      if (!ch) return;
      var hit = index.get(ch);
      if (!hit) return;
      mark(hit.el, 'next');
      if (hit.shift) {
        var shifts = byId.get('shift') || [];
        for (var i = 0; i < shifts.length; i++) mark(shifts[i], 'next-mod');
      }
    }

    // 特殊キー (BackSpace など) を次に押すキーとして示す
    function setNextId(id) {
      clearNext();
      var els = byId.get(id) || [];
      for (var i = 0; i < els.length; i++) mark(els[i], 'next');
    }

    function flashEl(el, cls) {
      el.classList.remove('hit', 'bad');
      void el.offsetWidth;                             // 連打でも点き直すように
      el.classList.add(cls);
      clearTimeout(el.flashTimer);
      el.flashTimer = setTimeout(function () { el.classList.remove(cls); }, 150);
    }

    // 実際に押されたキーを光らせる
    function flash(ch, ok) {
      var hit = index.get(ch);
      if (!hit) return;
      flashEl(hit.el, ok ? 'hit' : 'bad');
    }

    function flashId(id, ok) {
      var els = byId.get(id) || [];
      for (var i = 0; i < els.length; i++) flashEl(els[i], ok ? 'hit' : 'bad');
    }

    return {
      setLabels: setLabels,
      setNext: setNext,
      setNextId: setNextId,
      flash: flash,
      flashId: flashId,
      clearNext: clearNext
    };
  }

  return { layouts: names, create: create };
})();
