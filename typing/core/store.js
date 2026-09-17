/*
 * 設定の保存 (localStorage)。
 *
 * キーは必ず "typing." の下に置く。同じオリジンに別のアプリが置かれる前提
 * なので、名前空間を分けておかないと混ざる。
 *
 * localStorage は使えないことがある (プライベートウィンドウ、サイトデータを
 * 止めている、容量超過)。読み書きは全て try/catch で包み、失敗しても既定の
 * まま動くようにする。保存できたかどうかは戻り値で分かる。
 *
 * ローマ字テーブルとお題は、パース結果ではなく**読み込んだテキストのまま**
 * 保存する。
 *   - パース結果は Map や Set を含むので素直に JSON にならない
 *   - 保存した後でパーサを直すと、古い形のまま残ってしまう
 *   - テキストなら、そのときのパーサで読み直せる
 * パースは数百規則でも一瞬なので、起動のたびにやり直して困らない。
 */
const PREFIX = 'typing.';

// これより大きいものは保存しない。localStorage はオリジン全体で数 MB しか
// 無いので、巨大なお題ファイルで埋めてしまわないようにする
const LIMIT = 1024 * 1024;

function storage() {
  try {
    return window.localStorage || null;
  } catch (e) {
    return null;                 // サイトデータを止めていると参照だけで例外
  }
}

/* 保存した値を読む。無い / 壊れている / 使えないときは null */
export function read(key) {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + key);
    return raw === null ? null : JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/* 保存する。できたら true */
export function write(key, value) {
  const s = storage();
  if (!s) return false;
  try {
    const raw = JSON.stringify(value);
    if (raw.length > LIMIT) return false;
    s.setItem(PREFIX + key, raw);
    return true;
  } catch (e) {
    return false;                // 容量超過など
  }
}

/* 消す */
export function remove(key) {
  const s = storage();
  if (!s) return;
  try { s.removeItem(PREFIX + key); } catch (e) { /* 無視 */ }
}
