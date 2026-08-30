(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    settings: $('settings'), btnSettings: $('btn-settings'),
    fileTable: $('file-table'), btnTableReset: $('btn-table-reset'), tableStatus: $('table-status'),
    fileProblems: $('file-problems'), btnProblemsReset: $('btn-problems-reset'), problemsStatus: $('problems-status'),
    optShuffle: $('opt-shuffle'), optCount: $('opt-count'), btnApply: $('btn-apply'),
    optLayout: $('opt-layout'), optKeyboard: $('opt-keyboard'), optRomaji: $('opt-romaji'),
    keyboard: $('keyboard'), keyboardWrap: document.querySelector('.keyboard-wrap'),
    stage: $('stage'), qProgress: $('q-progress'), timer: $('timer'),
    display: $('display'), kana: $('kana'), input: $('input'),
    romaji: $('romaji'), hint: $('hint'),
    statKpm: $('stat-kpm'), statKeys: $('stat-keys'), statMiss: $('stat-miss'), statAcc: $('stat-acc'),
    result: $('result'), rKpm: $('r-kpm'), rTime: $('r-time'), rKeys: $('r-keys'),
    rMiss: $('r-miss'), rAcc: $('r-acc'), rWaste: $('r-waste'),
    rWasteNote: $('r-waste-note'), btnRetry: $('btn-retry'),
    imeWarning: $('ime-warning'), keycatch: $('keycatch')
  };

  var S = {
    table: null,
    tableChars: null,
    problems: [],        // [{ display, kana }]
    queue: [],
    qi: 0,
    target: null,
    running: false,
    finished: false,
    startedAt: 0,
    elapsed: 0,
    keys: 0,
    miss: 0,
    waste: 0,
    tickId: 0,
    kb: null
  };

  /* ---------------- テーブル / お題の読み込み ---------------- */

  function applyTable(text, name) {
    var table = Engine.parseTable(text);
    if (table.size === 0) {
      el.tableStatus.textContent = '読み込めませんでした（有効な行が 0 件）。タブ区切りか確認してください。';
      el.tableStatus.className = 'status error';
      return false;
    }
    S.table = table;
    S.tableChars = new Set(table.alphabet);      // Shift 側に出す文字の判定用
    var st = table.stats;
    el.tableStatus.textContent = name + ' — ' + st.entries + ' 規則'
      + '（コメント ' + st.comments + ' 行'
      + (st.overwritten ? ' / 上書き ' + st.overwritten + ' 件' : '') + '）';
    el.tableStatus.className = 'status';
    return true;
  }

  function parseProblems(text) {
    var lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    var list = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === '' || line.charAt(0) === '#') continue;
      var cols = line.split('\t');
      var display = cols[0];
      var kana = cols.length > 1 && cols[1] !== '' ? cols[1] : cols[0];
      if (display === '') continue;
      list.push({ display: display, kana: kana });
    }
    return list;
  }

  function applyProblems(list, name) {
    if (!list.length) {
      el.problemsStatus.textContent = 'お題が 0 件でした。';
      el.problemsStatus.className = 'status error';
      return false;
    }
    S.problems = list;
    el.problemsStatus.textContent = name + ' — ' + list.length + ' 件';
    el.problemsStatus.className = 'status';
    return true;
  }

  function readFile(file, onText) {
    var reader = new FileReader();
    reader.onload = function () { onText(Engine.decodeBytes(reader.result)); };
    reader.readAsArrayBuffer(file);
  }

  /* ---------------- 出題 ---------------- */

  function buildQueue() {
    // 現在のテーブルで打てないお題は除外する
    var usable = [];
    var skipped = [];
    for (var i = 0; i < S.problems.length; i++) {
      var p = S.problems[i];
      if (Engine.createTarget(S.table, p.kana).typeable()) usable.push(p);
      else skipped.push(p.display);
    }

    if (skipped.length) {
      el.problemsStatus.textContent = S.problems.length + ' 件中 ' + skipped.length
        + ' 件は現在のローマ字テーブルでは打てないため除外しました: ' + skipped.slice(0, 3).join(' / ')
        + (skipped.length > 3 ? ' ほか' : '');
      el.problemsStatus.className = 'status error';
    }

    var list = usable.slice();
    if (el.optShuffle.checked) {
      for (var j = list.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1));
        var t = list[j]; list[j] = list[k]; list[k] = t;
      }
    }
    var count = Math.max(1, Math.min(parseInt(el.optCount.value, 10) || 10, list.length));
    S.queue = list.slice(0, count);
  }

  function startSet() {
    buildQueue();
    S.qi = 0;
    S.running = false;
    S.finished = false;
    S.elapsed = 0;
    S.keys = 0;
    S.miss = 0;
    S.waste = 0;
    stopTick();

    el.result.hidden = true;
    el.stage.hidden = false;

    if (!S.queue.length) {
      el.display.textContent = '出題できるお題がありません';
      el.kana.textContent = '';
      el.romaji.textContent = '';
      el.hint.textContent = '設定からお題かローマ字テーブルを見直してください';
      S.target = null;
      if (S.kb) { S.kb.setLabels(null, null); S.kb.clearNext(); }
      return;
    }
    loadProblem(0);
    el.hint.textContent = 'キーを押すと開始します';
    updateStats();
    el.timer.textContent = '0.0 秒';
  }

  function loadProblem(index) {
    S.qi = index;
    var p = S.queue[index];
    S.target = Engine.createTarget(S.table, p.kana);
    S.guideGhost = new Array(S.target.maxGuideLength() + 1).join('m');
    el.display.textContent = p.display;
    el.qProgress.textContent = (index + 1) + ' / ' + S.queue.length;
    render();
  }

  /* ---------------- 描画 ---------------- */

  function spanRun(text, cls) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    return s;
  }

  function render() {
    if (!S.target) return;
    var v = S.target.view();
    var kana = S.target.kana;

    // よみは見本。減らさず全文を出し、次に入力するかなだけ印をつける
    el.kana.textContent = '';
    el.kana.appendChild(spanRun(kana.slice(0, v.kanaIndex), 'todo'));
    if (v.kanaIndex < kana.length) {
      el.kana.appendChild(spanRun(kana.charAt(v.kanaIndex), 'cur'));
      el.kana.appendChild(spanRun(kana.slice(v.kanaIndex + 1), 'todo'));
    }

    // 入力欄は空から増えていく。打ち間違えても変換は続くので、
    // 間違えた結果そのものが wrong として見える。
    // 打ち進めても折り返し行数が変わらないよう、お題の長さぶんの高さを
    // 透明な控えで確保しておく (下のキーボードが上下に動かないように)
    el.input.textContent = '';
    el.input.appendChild(spanRun(kana + '　', 'in-ghost'));

    var live = spanRun('', 'in-live');
    if (v.confirmed) live.appendChild(spanRun(v.confirmed, 'in-ok'));
    if (v.wrong) live.appendChild(spanRun(v.wrong, 'in-err'));
    if (v.pending) {
      live.appendChild(spanRun(v.pending, v.onTrack ? 'in-pending' : 'in-pending bad'));
    }
    live.appendChild(spanRun('', 'caret'));
    el.input.appendChild(live);

    // ガイドも綴りの取り方で長さが変わるので、最大長ぶんの高さを確保しておく
    el.romaji.textContent = '';
    el.romaji.appendChild(spanRun(S.guideGhost, 'in-ghost'));

    var guide = spanRun('', 'in-live');
    if (v.guideDone) guide.appendChild(spanRun(v.guideDone, 'done'));
    if (v.guidePending) guide.appendChild(spanRun(v.guidePending, 'done'));
    if (v.remaining) {
      guide.appendChild(spanRun(v.remaining.charAt(0), 'cur'));
      guide.appendChild(spanRun(v.remaining.slice(1), 'todo'));
    }
    el.romaji.appendChild(guide);

    if (S.kb) {
      // キーの表示は「いま押したら何が入力されるか」
      S.kb.setLabels(function (ch) { return S.target.preview(ch); }, S.tableChars);
      // ずれているときに押すべきキーは BackSpace
      if (v.onTrack) S.kb.setNext(v.remaining.charAt(0));
      else S.kb.setNextId('backspace');
    }

    el.stage.classList.toggle('has-error', !v.onTrack);
    if (S.running) {
      el.hint.textContent = v.onTrack ? '' : 'BackSpace で消してください';
    }
  }

  function buildKeyboard() {
    S.kb = Keyboard.create(el.keyboard, el.optLayout.value);
    render();
  }

  function applyDisplayOptions() {
    el.keyboardWrap.hidden = !el.optKeyboard.checked;
    el.romaji.hidden = !el.optRomaji.checked;
  }

  function updateStats() {
    var total = S.keys + S.miss;
    var acc = total ? Math.round((S.keys / total) * 100) : 100;
    var min = S.elapsed / 60000;
    var kpm = min > 0 ? Math.round(S.keys / min) : 0;
    el.statKpm.textContent = kpm;
    el.statKeys.textContent = S.keys;
    el.statMiss.textContent = S.miss;
    el.statAcc.textContent = acc + '%';
  }

  function startTick() {
    stopTick();
    S.tickId = setInterval(function () {
      S.elapsed = performance.now() - S.startedAt;
      el.timer.textContent = (S.elapsed / 1000).toFixed(1) + ' 秒';
      updateStats();
    }, 50);
  }
  function stopTick() { if (S.tickId) { clearInterval(S.tickId); S.tickId = 0; } }

  /* ---------------- 入力 ---------------- */

  function handleChar(ch) {
    if (!S.target || S.finished) return;

    if (!S.running) {
      S.running = true;
      S.startedAt = performance.now();
      el.hint.textContent = '';
      startTick();
    }

    var r = S.target.input(ch);
    var waste = S.target.lastWaste();      // この打鍵で増えてしまった打鍵数
    if (r === 'miss') {
      S.miss++;
      flashMiss();
    } else {
      S.keys++;
      S.waste += waste;
    }
    if (S.kb) S.kb.flash(ch, r === 'miss' ? 'bad' : (waste > 0 ? 'waste' : 'hit'));
    render();
    updateStats();

    if (r === 'done') {
      if (S.qi + 1 < S.queue.length) loadProblem(S.qi + 1);
      else finish();
    }
  }

  // かな 1 文字ぶんの取り消し。打鍵数・ミス数には影響させない
  function handleBackspace() {
    if (!S.target || S.finished || !S.running) return;
    var done = S.target.backspace();
    if (S.kb) S.kb.flashId('backspace', done ? 'hit' : 'bad');
    if (done) render();
  }

  var missTimer = 0;
  function flashMiss() {
    el.stage.classList.add('miss');
    clearTimeout(missTimer);
    missTimer = setTimeout(function () { el.stage.classList.remove('miss'); }, 120);
  }

  function finish() {
    S.finished = true;
    S.running = false;
    S.elapsed = performance.now() - S.startedAt;
    stopTick();

    var total = S.keys + S.miss;
    var acc = total ? Math.round((S.keys / total) * 100) : 100;
    var min = S.elapsed / 60000;
    el.rKpm.textContent = min > 0 ? Math.round(S.keys / min) : 0;
    el.rTime.textContent = (S.elapsed / 1000).toFixed(1);
    el.rKeys.textContent = S.keys;
    el.rMiss.textContent = S.miss;
    el.rAcc.textContent = acc + '%';
    el.rWaste.textContent = S.waste;
    el.rWasteNote.hidden = S.waste === 0;
    el.rWasteNote.textContent = 'より少ない打鍵で打てる場面が ' + S.waste
      + ' 回ありました。その打鍵はキーが橙色で光っています。';

    el.stage.hidden = true;
    el.result.hidden = false;
  }

  /* ---------------- イベント ---------------- */

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') { e.preventDefault(); startSet(); focusInput(); return; }
    if (e.key === 'Enter') {
      if (S.finished) { e.preventDefault(); startSet(); focusInput(); }
      return;
    }
    if (!el.settings.hidden && document.activeElement !== el.keycatch) return;

    if (e.key === 'Backspace') { e.preventDefault(); handleBackspace(); return; }
    if (e.key.length !== 1) return;

    e.preventDefault();
    handleChar(e.key);
  });

  el.keycatch.addEventListener('compositionstart', function () {
    el.imeWarning.hidden = false;
    el.keycatch.value = '';
  });
  el.keycatch.addEventListener('compositionend', function () { el.keycatch.value = ''; });
  el.keycatch.addEventListener('input', function () { el.keycatch.value = ''; });
  el.keycatch.addEventListener('focus', function () { el.imeWarning.hidden = true; });

  function focusInput() { el.keycatch.focus(); }

  document.addEventListener('mousedown', function (e) {
    var tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'LABEL' || tag === 'SUMMARY') return;
    setTimeout(focusInput, 0);
  });

  el.btnSettings.addEventListener('click', function () {
    el.settings.hidden = !el.settings.hidden;
    if (el.settings.hidden) focusInput();
  });

  el.optLayout.addEventListener('change', buildKeyboard);
  el.optKeyboard.addEventListener('change', applyDisplayOptions);
  el.optRomaji.addEventListener('change', applyDisplayOptions);

  el.btnApply.addEventListener('click', function () {
    el.settings.hidden = true;
    startSet();
    focusInput();
  });

  el.btnRetry.addEventListener('click', function () { startSet(); focusInput(); });

  el.fileTable.addEventListener('change', function () {
    var f = el.fileTable.files[0];
    if (!f) return;
    readFile(f, function (text) {
      if (applyTable(text, f.name)) startSet();
    });
  });

  el.btnTableReset.addEventListener('click', function () {
    el.fileTable.value = '';
    applyTable(DEFAULT_ROMAJI_TSV, DEFAULT_ROMAJI_TABLE_NAME);
    startSet();
    focusInput();
  });

  el.fileProblems.addEventListener('change', function () {
    var f = el.fileProblems.files[0];
    if (!f) return;
    readFile(f, function (text) {
      if (applyProblems(parseProblems(text), f.name)) startSet();
    });
  });

  el.btnProblemsReset.addEventListener('click', function () {
    el.fileProblems.value = '';
    applyProblems(DEFAULT_PROBLEMS.map(function (p) {
      return { display: p[0], kana: p[1] };
    }), DEFAULT_PROBLEMS_NAME);
    startSet();
    focusInput();
  });

  /* ---------------- 起動 ---------------- */

  Keyboard.layouts().forEach(function (l) {
    var op = document.createElement('option');
    op.value = l.id;
    op.textContent = l.name;
    el.optLayout.appendChild(op);
  });
  S.kb = Keyboard.create(el.keyboard, el.optLayout.value);
  applyDisplayOptions();

  applyTable(DEFAULT_ROMAJI_TSV, DEFAULT_ROMAJI_TABLE_NAME);
  applyProblems(DEFAULT_PROBLEMS.map(function (p) {
    return { display: p[0], kana: p[1] };
  }), DEFAULT_PROBLEMS_NAME);
  startSet();
  focusInput();
})();
