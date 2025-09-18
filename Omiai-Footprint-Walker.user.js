// ==UserScript==
// @name         Omiai Footprint Walker
// @namespace    https://footprinter.note
// @version      1.5.1
// @description  Omiaiの一覧を順番に開いて足跡付け（人間ぽいランダム滞在＆スクロール、年齢スイープ、自動読み込み対応）
// @match        https://www.omiai-jp.com/search*
// @match        https://omiai-jp.com/search*
// @run-at       document-idle
// @grant        GM_addStyle
// @downloadURL  https://github.com/popaipoh-droid/omiai_extension/raw/refs/heads/main/Omiai-Footprint-Walker.user.js
// @updateURL    https://github.com/popaipoh-droid/omiai_extension/raw/refs/heads/main/Omiai-Footprint-Walker.user.js

// ==/UserScript==

(function () {
  'use strict';

  /*** 設定（UIから変更可） ***/
  let BASE_WAIT_SEC = 8;       // プロフ滞在の「最大」秒（実際は 2〜この値 でランダム）
  let BETWEEN_WAIT_MS = 900;   // 次カードまで(ミリ秒)
  let MAX_COUNT = 0;           // 1サイクル上限(0=無制限)
  let MAX_AUTO_SCROLL = 14;    // 未処理カード探しスクロール回数

  // 年齢スイープ（UIで上書き）
  let AGE_SWEEP_ENABLED = true;
  let AGE_START = 33;
  let AGE_END = 36;
  let AGE_STEP = 1;
  let AGE_SET_BEFORE_FIRST = false;

  // プロフィール内「人っぽい」スクロール
  let PROF_SCROLL_ENABLED = true;   // ランダムスクロールON/OFF（UI）
  let PROF_SCROLL_MAX_MOVES = 6;    // 滞在中に最大何回スクロールするか（1〜6の範囲を推奨）
  const PROF_STEP_MIN = 300;        // 1回のスクロール量(最小px)
  const PROF_STEP_MAX = 1200;       // 1回のスクロール量(最大px)
  const PROF_PAUSE_MIN = 300;       // スクロール間の待機(最小ms)
  const PROF_PAUSE_MAX = 1000;      // スクロール間の待機(最大ms)
  const PROF_BACK_JIGGLE_P = 0.4;   // スクロール後にちょい戻しする確率

  // 末尾での読み込み促進（スワイプ相当）
  const PRIME_BURSTS = 10;        // 連続スクロール試行回数
  const PRIME_STEP_PX = 1200;     // 1回の下スクロール量
  const PRIME_SETTLE_MS = 900;    // 下スクロール後の待機
  const NUDGE_SCROLL_PX = 260;    // 戻り直後の軽い下スクロール
  const NUDGE_SETTLE_MS = 180;

  // 上パルス（上に少し戻す → 再度下スクロール）
  const PRIME_UP_PULSE_PX = 200;
  const PRIME_UP_SETTLE_MS = 150;

  /*** セレクタ & 正規表現 ***/
  const CARD_SELECTOR = '.Profile__ProfileBox-sc-14hjqgs-0';
  const LIST_ROOT_SELECTOR = '.ResultList__StyledDiv-sc-15q2fqo-0';
  const IMG_ID_RE = /profile_photo\/(\d+)\//i;

  /*** ユーティリティ ***/
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  async function waitFor(cond, timeout = 15000, interval = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (await cond()) return true; } catch { }
      await sleep(interval);
    }
    return false;
  }
  function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function byText(root, textExact) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_ELEMENT, null);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if ((el.textContent || '').trim() === textExact) return el;
    }
    return null;
  }

  function getCardElements() { return Array.from(document.querySelectorAll(CARD_SELECTOR)); }

  function extractIdFromCard(card) {
    const img = card.querySelector('img[src*="profile_photo/"]');
    if (!img) return null;
    const src = img.getAttribute('src') || '';
    const m = src.match(IMG_ID_RE);
    return m && m[1] ? m[1] : null;
  }
  function getLastCardSignature() {
    const cards = getCardElements();
    if (!cards.length) return null;
    const card = cards[cards.length - 1];
    const id = extractIdFromCard(card);
    if (id) return `id:${id}`;
    const t = (card.textContent || '').trim().slice(0, 80);
    return `t:${t}`;
  }
  function makeCandidates(id) {
    const origin = location.origin;
    return [
      `${origin}/profile/${id}`,
      `${origin}/profile?id=${id}`,
      `${origin}/profile`
    ];
  }

  function dispatchSafe(el, type, init) {
    try {
      const EventCtor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new EventCtor(type, init));
    } catch { }
  }

  function clickInside(el) {
    const clickable = el.closest('button, a, [role="button"]') || el.querySelector('img, button, a, [role="button"]') || el;
    const rect = clickable.getBoundingClientRect();
    const cx = Math.floor(rect.left + rect.width / 2);
    const cy = Math.floor(rect.top + Math.min(24, rect.height / 2));
    const base = { bubbles: true, cancelable: true, composed: true, clientX: Math.max(0, cx), clientY: Math.max(0, cy) };
    dispatchSafe(clickable, 'pointerdown', base);
    dispatchSafe(clickable, 'mousedown', base);
    dispatchSafe(clickable, 'mouseup', base);
    dispatchSafe(clickable, 'click', base);
    try { typeof clickable.click === 'function' && clickable.click(); } catch { }
  }

  function onListPage() {
    return document.querySelector(CARD_SELECTOR) != null;
  }
  function onProfilePage() {
    const pathHasProfile = /\/profile(?:\/|\?|$)/.test(location.pathname);
    const listGone = !document.querySelector(LIST_ROOT_SELECTOR) && !document.querySelector(CARD_SELECTOR);
    return pathHasProfile || listGone;
  }

  /*** スクロールターゲット自動検出 & フォールバック ***/
  function isScrollable(el) {
    if (!el) return false;
    const styles = getComputedStyle(el);
    const oy = styles.overflowY;
    const okOverflow = oy === 'auto' || oy === 'scroll';
    const hasRoom = (el.scrollHeight - el.clientHeight) > 8;
    return okOverflow && hasRoom;
  }
  function collectScrollables() {
    const candidates = [];
    const hinted = [
      document.querySelector('#wrapBox'),
      document.querySelector('.WrapBox__StyledWrapBox'),
      document.querySelector('.ResultList__StyledDiv-sc-15q2fqo-0'),
      document.querySelector('main'),
      document.getElementById('__next'),
    ].filter(Boolean);
    hinted.forEach(el => { if (isScrollable(el)) candidates.push(el); });

    document.querySelectorAll('div,main,section,article').forEach(el => {
      if (isScrollable(el)) candidates.push(el);
    });

    const uniq = Array.from(new Set(candidates));
    uniq.sort((a, b) =>
      (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
    );
    return uniq;
  }
  function getWindowTarget() {
    return {
      type: 'window',
      el: window,
      get top() { return document.scrollingElement ? document.scrollingElement.scrollTop : window.pageYOffset; },
      scrollBy(dy) { window.scrollBy(0, dy); }
    };
  }
  function makeElTarget(el) {
    return {
      type: 'element',
      el,
      get top() { return el.scrollTop; },
      scrollBy(dy) { el.scrollBy(0, dy); }
    };
  }

  let SCROLL_TARGET = null;
  let FALLBACKS = [];
  function pickBestTarget() {
    const list = collectScrollables();
    FALLBACKS = [getWindowTarget(), ...list.map(makeElTarget)];
    SCROLL_TARGET = FALLBACKS[0];
    updateTargetBadge();
  }
  async function scrollBySmart(delta) {
    const tryTargets = [SCROLL_TARGET, ...FALLBACKS.filter(t => t !== SCROLL_TARGET)];
    for (const t of tryTargets) {
      const before = t.top;
      t.scrollBy(delta);
      await sleep(80);
      const after = t.top;
      if (Math.abs(after - before) >= Math.min(8, Math.abs(delta) * 0.2)) {
        SCROLL_TARGET = t;
        updateTargetBadge();
        return true;
      }
    }
    pickBestTarget();
    const t = SCROLL_TARGET;
    const before = t.top;
    t.scrollBy(delta);
    await sleep(80);
    const after = t.top;
    const ok = Math.abs(after - before) >= Math.min(8, Math.abs(delta) * 0.2);
    return !!ok;
  }

  async function autoScrollMore(stepPx = 900) {
    await scrollBySmart(stepPx);
    await sleep(400 + Math.random() * 300);
  }

  /*** 条件UI検出 ***/
  function findConditionButton() {
    const img = document.querySelector('img[alt="condition-icon"]');
    if (img) return img.closest('div');
    const byClass = qsa('div[class*="ConditionButton__ConditionImgWrapper"]').at(0);
    return byClass || null;
  }
  function findAgeLabel() {
    const exact = byText(document.body, '年齢');
    if (exact) return exact;
    return qsa('div[class*="ElementBox__Text"]').find(el => (el.textContent || '').trim() === '年齢') || null;
  }
  function findApplyButton() {
    const all = qsa('button, div, a');
    return all.find(el => (el.textContent || '').trim() === 'この条件で検索') || null;
  }

  /*** 年齢戻る（Chevron）検出 ***/
  function findChevronBack() {
    let svg = qsa('svg').find(s => (s.getAttribute('class') || '').includes('StyledChevron'));
    if (svg) return svg.closest('button, a, [role="button"], [class*="Header"], svg');
    const poly = document.querySelector('svg polyline[points*="15 18"][points*="9 12"][points*="15 6"]');
    if (poly) return poly.closest('button, a, [role="button"], [class*="Header"], svg');
    const headerSvg = qsa('header svg').find(s => /chevron|arrow|StyledChevron/i.test(s.getAttribute('class') || ''));
    return headerSvg ? (headerSvg.closest('button, a, [role="button"], [class*="Header"], svg')) : null;
  }

  /*** Select 操作（堅牢版） ***/
  function hasOptionForAge(sel, ageNumber) {
    if (!sel) return false;
    const val = String(ageNumber);
    if (sel.querySelector(`option[value="${val}"]`)) return true;
    return Array.from(sel.options).some(o => (o.textContent || '').trim() === `${val}歳`);
  }
  function setSelectByValueOrText(sel, ageNumber) {
    if (!sel) return false;
    const val = String(ageNumber);
    let opt = sel.querySelector(`option[value="${val}"]`);
    if (!opt) opt = Array.from(sel.options).find(o => (o.textContent || '').trim() === `${val}歳`);
    if (!opt) return false;

    sel.value = opt.value;
    opt.selected = true;

    try { sel.focus(); } catch { }
    try { clickInside(sel); } catch { }

    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }
  async function setSelectByValueOrTextRetry(getter, ageNumber, { tries = 5, afterSetWait = 120 } = {}) {
    for (let i = 0; i < tries; i++) {
      const sel = getter();
      if (!sel) { await sleep(150); continue; }
      const okOpt = await waitFor(() => hasOptionForAge(getter(), ageNumber), 2000 + i * 300, 120);
      if (!okOpt) { await sleep(120); continue; }
      const ok = setSelectByValueOrText(sel, ageNumber);
      if (ok) { await sleep(afterSetWait); return true; }
      await sleep(150 + i * 100);
    }
    return false;
  }

  /*** 検索条件（フィルタ）操作 ***/
  async function openConditionPanel() {
    const btn = findConditionButton();
    if (!btn) throw new Error('条件ボタンが見つかりません');
    btn.scrollIntoView({ block: 'center', behavior: 'auto' });
    await sleep(120);
    clickInside(btn);
    await sleep(3000);
  }
  async function openAgeSection() {
    const ok = await waitFor(() => !!findAgeLabel(), 6000, 100);
    if (!ok) throw new Error('「年齢」ラベルが見つかりません');
    const node = findAgeLabel();
    node.scrollIntoView({ block: 'center', behavior: 'auto' });
    await sleep(100);
    clickInside(node);
    await sleep(2000);
  }
  async function waitForAgeSelects(timeout = 8000) {
    const ok = await waitFor(() => {
      const a = document.getElementById('begin_age');
      const b = document.getElementById('end_age');
      return a && b;
    }, timeout, 120);
    return ok ? {
      begin: () => document.getElementById('begin_age'),
      end: () => document.getElementById('end_age')
    } : null;
  }
  async function closeAgeSubpanelViaChevron() {
    const ok = await waitFor(() => !!findChevronBack(), 4000, 120);
    const chevron = ok ? findChevronBack() : null;
    if (!chevron) {
      console.warn('[FW] Chevron(戻る)が見つからないため history.back() をフォールバックします');
      try { history.back(); } catch { }
      await waitFor(() => (!document.getElementById('begin_age') && !document.getElementById('end_age')) || !!findApplyButton(), 6000, 120);
      return;
    }
    chevron.scrollIntoView({ block: 'center', behavior: 'auto' });
    await sleep(80);
    clickInside(chevron);
    await waitFor(() => (!document.getElementById('begin_age') && !document.getElementById('end_age')) && !!findApplyButton(), 6000, 120);
  }
  async function applyAgeFilter(age) {
    await openConditionPanel();
    await openAgeSection();

    const sels = await waitForAgeSelects(9000);
    if (!sels) throw new Error('年齢セレクトが見つかりません');
    const { begin, end } = sels;

    const okBegin = await setSelectByValueOrTextRetry(begin, age, { tries: 6, afterSetWait: 200 });
    if (!okBegin) console.warn('[FW] begin_age の設定に失敗した可能性', { age });

    const okEnd = await setSelectByValueOrTextRetry(end, age, { tries: 8, afterSetWait: 200 });
    if (!okEnd) console.warn('[FW] end_age の設定に失敗した可能性', { age });

    await sleep(200);
    await closeAgeSubpanelViaChevron();

    const apply = findApplyButton();
    if (apply) {
      apply.scrollIntoView({ block: 'center', behavior: 'auto' });
      await sleep(80);
      clickInside(apply);
    } else {
      console.warn('[FW] 「この条件で検索」ボタンが見つからず、条件パネルが閉じたとみなして続行します');
    }
    await sleep(5000);
  }

  /*** 読み込み促進（末尾での上→下パルス） ***/
  async function forceLoadMoreAndWait(maxBursts = PRIME_BURSTS) {
    let baseCount = getCardElements().length;
    let baseSig = getLastCardSignature();

    for (let i = 0; i < maxBursts; i++) {
      await scrollBySmart(-PRIME_UP_PULSE_PX);
      await sleep(PRIME_UP_SETTLE_MS + Math.floor(Math.random() * 120));

      await scrollBySmart(PRIME_STEP_PX);
      await sleep(PRIME_SETTLE_MS + Math.floor(Math.random() * 300));

      const newCount = getCardElements().length;
      const newSig = getLastCardSignature();
      if (newCount > baseCount || newSig !== baseSig) {
        return true;
      }
    }
    return false;
  }

  /*** プロフィール閲覧中の人間っぽいスクロール ***/
  function snapshotScrollTarget() {
    return { target: SCROLL_TARGET, fallbacks: [...FALLBACKS] };
  }
  function restoreScrollTarget(snap) {
    if (!snap) return;
    SCROLL_TARGET = snap.target;
    FALLBACKS = snap.fallbacks;
    updateTargetBadge();
  }
  async function humanScrollDuring(msTotal) {
    if (!PROF_SCROLL_ENABLED || msTotal < 500) {
      await sleep(msTotal);
      return;
    }
    const snap = snapshotScrollTarget();
    // プロフページのスクロールターゲットに合わせ直し
    pickBestTarget();
    await sleep(50);

    const moves = Math.max(1, Math.min(PROF_SCROLL_MAX_MOVES, randInt(1, PROF_SCROLL_MAX_MOVES)));
    const deadline = Date.now() + msTotal;

    for (let i = 0; i < moves; i++) {
      const now = Date.now();
      if (now >= deadline - 250) break;

      const waitMs = randInt(PROF_PAUSE_MIN, PROF_PAUSE_MAX);
      if (now + waitMs >= deadline) {
        await sleep(Math.max(0, deadline - Date.now()));
        break;
      }
      await sleep(waitMs);

      const dir = Math.random() < 0.72 ? 1 : -1; // 下7：上3 くらい
      const step = randInt(PROF_STEP_MIN, PROF_STEP_MAX) * dir;
      await scrollBySmart(step);

      // ちょい戻し（読む動き）
      if (Math.random() < PROF_BACK_JIGGLE_P) {
        await sleep(randInt(150, 400));
        await scrollBySmart(-Math.sign(step) * randInt(80, 180));
      }
    }

    const remain = deadline - Date.now();
    if (remain > 0) await sleep(remain);

    restoreScrollTarget(snap);
  }

  /*** UI パネル ***/
  GM_addStyle(`
    #omiai-footprint-panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      background: rgba(0,0,0,.75); color: #fff; padding: 10px 12px;
      border-radius: 12px; font: 12px/1.4 system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
      width: 360px;
    }
    #omiai-footprint-panel .row { display:flex; gap:8px; align-items:center; margin:4px 0; flex-wrap:wrap; }
    #omiai-footprint-panel .row label { display:flex; align-items:center; gap:6px; }
    #omiai-footprint-panel input[type=number] { width: 76px; }
    #omiai-footprint-panel input[type=checkbox] { transform: translateY(1px); }
    #omiai-footprint-panel button {
      margin: 4px 4px 0 0; padding: 6px 10px; border: 0; border-radius: 8px; cursor: pointer;
    }
    #omiai-footprint-panel small { opacity: .8; }
    #omiai-footprint-panel .muted { opacity:.7 }
    #omiai-footprint-panel hr { border:0; border-top:1px solid rgba(255,255,255,.2); margin:8px 0; }
    #omiai-footprint-panel .pill { background:#111827; padding:2px 6px; border-radius:6px; }
  `);
  const panel = document.createElement('div');
  panel.id = 'omiai-footprint-panel';
  panel.innerHTML = `
    <div style="margin-bottom:6px"><b>Footprint Walker</b>
      <span class="pill" id="fw-target">–</span>
    </div>

    <div class="row">
      <label>巡回秒数(最大) <input id="fw-wait" type="number" min="2" value="${BASE_WAIT_SEC}"></label>
      <label>最大巡回人数 <input id="fw-max" type="number" min="0" value="${MAX_COUNT}"></label>
    </div>
    <div class="row"><small class="muted">※0は指定なし。滞在は 2〜指定秒 でランダム（1秒は使用しません）</small></div>

    <hr>

    <div class="row">
      <span class="pill">プロフ内スクロール</span>
      <label><input id="fw-profscroll" type="checkbox" ${PROF_SCROLL_ENABLED ? 'checked' : ''}> 有効にする</label>
      <label>最大回数 <input id="fw-profscroll-max" type="number" min="1" max="6" value="${PROF_SCROLL_MAX_MOVES}"></label>
    </div>

    <hr>

    <div class="row">
      <span class="pill">対象がなくなった場合に年齢条件を変更して再実行します</span>
      <label><input id="fw-agecb" type="checkbox" ${AGE_SWEEP_ENABLED ? 'checked' : ''}> 年齢スイープを使う</label>
    </div>
    <div class="row">
      <label>開始 <input id="fw-age-start" type="number" min="18" max="99" value="${AGE_START}"></label>
      <label>終了 <input id="fw-age-end"   type="number" min="18" max="99" value="${AGE_END}"></label>
      <label>刻み <input id="fw-age-step"  type="number" min="1"  max="5"  value="${AGE_STEP}"></label>
    </div>
    <div class="row">
      <label><input id="fw-age-first" type="checkbox" ${AGE_SET_BEFORE_FIRST ? 'checked' : ''}> 初回開始前にも適用</label>
    </div>

    <hr>

    <div class="row" style="justify-content:flex-end; flex-wrap:nowrap">
      <button id="fw-start" style="background:#38bdf8;color:#000">開始</button>
      <button id="fw-stop"  style="background:#fca5a5;color:#000">停止</button>
    </div>

    <hr>

    <div id="fw-status" style="margin-top:6px"><small class="muted">待機中</small></div>
  `;
  document.documentElement.appendChild(panel);
  const $ = (sel) => panel.querySelector(sel);
  const setStatus = (t) => $('#fw-status').innerHTML = `<small>${t}</small>`;
  const updateTargetBadge = () => {
    const el = $('#fw-target');
    if (!el) return;
    el.textContent = SCROLL_TARGET ? `${SCROLL_TARGET.type}` : '–';
  };

  /*** メイン処理 ***/
  let running = false;
  let sweeping = false;
  let ageCursor = AGE_START;
  const doneIds = new Set();

  async function findNextCard() {
    for (let tries = 0; tries <= MAX_AUTO_SCROLL; tries++) {
      const cards = getCardElements();
      for (const card of cards) {
        const id = extractIdFromCard(card);
        if (!id) continue;
        if (doneIds.has(id)) continue;
        return { card, id };
      }
      await autoScrollMore();
    }
    return null;
  }

  async function clickWalkCycle() {
    let processed = 0;
    const limit = (MAX_COUNT > 0) ? MAX_COUNT : Infinity;

    while (running && processed < limit) {
      if (!onListPage()) {
        setStatus('一覧へ戻っています…');
        history.back();
        await waitFor(onListPage, 12000, 150);
      }

      const next = await findNextCard();
      if (!next) {
        setStatus('候補が尽きました。上→下パルスで読み込みを促進中…');
        const loaded = await forceLoadMoreAndWait();
        if (loaded) {
          setStatus('追加の候補を検出。続行します。');
          continue;
        }
        setStatus('新しい候補が一定時間出ませんでした（年齢サイクル終了）。');
        break;
      }

      const { card, id } = next;
      try { card.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch { }
      await sleep(80);

      setStatus(`(${processed + 1}/${isFinite(limit) ? limit : '∞'}) 開く… ${id ? 'id=' + id : ''}`);
      clickInside(card);

      let moved = await waitFor(onProfilePage, 8000, 150);
      if (!moved && id) {
        for (const url of makeCandidates(id)) {
          try {
            location.assign(url);
            moved = await waitFor(onProfilePage, 6000, 150);
            if (moved) break;
          } catch { }
        }
      }

      // ★ ランダム滞在（2〜BASE_WAIT_SEC 秒）＋ プロフ内スクロール
      const dwellSec = Math.max(2, randInt(2, Math.max(2, BASE_WAIT_SEC)));
      setStatus(`プロフィール閲覧中… 約 ${dwellSec} 秒`);
      await humanScrollDuring(dwellSec * 1000);

      if (id) doneIds.add(id);
      processed++;

      history.back();
      await waitFor(onListPage, 12000, 150);

      await scrollBySmart(NUDGE_SCROLL_PX);
      await sleep(NUDGE_SETTLE_MS);

      await sleep(BETWEEN_WAIT_MS + Math.floor(Math.random() * 500));
    }
  }

  async function runAll() {
    running = true;
    sweeping = AGE_SWEEP_ENABLED;

    // UIから読み込み（最小2秒を保証）
    BASE_WAIT_SEC = Math.max(2, parseInt($('#fw-wait').value || '6', 10));
    MAX_COUNT = Math.max(0, parseInt($('#fw-max').value || '0', 10));

    PROF_SCROLL_ENABLED = $('#fw-profscroll').checked;
    PROF_SCROLL_MAX_MOVES = Math.max(1, Math.min(6, parseInt($('#fw-profscroll-max').value || PROF_SCROLL_MAX_MOVES, 10)));

    AGE_SWEEP_ENABLED = $('#fw-agecb').checked;
    AGE_START = Math.max(18, Math.min(99, parseInt($('#fw-age-start').value || AGE_START, 10)));
    AGE_END = Math.max(AGE_START, Math.min(99, parseInt($('#fw-age-end').value || AGE_END, 10)));
    AGE_STEP = Math.max(1, parseInt($('#fw-age-step').value || AGE_STEP, 10));
    AGE_SET_BEFORE_FIRST = $('#fw-age-first').checked;

    // 入力の見た目も補正（2未満を防ぐ）
    $('#fw-wait').value = BASE_WAIT_SEC;

    // スクロールターゲット初期化（2段構え）
    pickBestTarget();
    await sleep(300);
    pickBestTarget();

    ageCursor = AGE_START;

    if (running && AGE_SWEEP_ENABLED && AGE_SET_BEFORE_FIRST) {
      setStatus(`初回条件適用: 年齢 ${ageCursor}歳…`);
      try { await applyAgeFilter(ageCursor); } catch (e) { console.warn('[FW] 初回フィルタ適用エラー', e); }
      doneIds.clear();
      try { window.scrollTo(0, 0); } catch { }
      await waitFor(() => document.querySelector(CARD_SELECTOR), 8000, 150);
    }

    while (running) {
      doneIds.clear();
      try { window.scrollTo(0, 0); } catch { }
      setStatus('一覧の検出中…');
      const ok = await waitFor(() => document.querySelector(CARD_SELECTOR), 15000, 200);
      if (!ok) {
        setStatus('カードが見つかりません。ページを少しスクロールしてください。');
        break;
      }
      setStatus('クロール開始…');
      await clickWalkCycle();

      if (!running) break;

      if (AGE_SWEEP_ENABLED) {
        ageCursor += AGE_STEP;
        if (ageCursor > AGE_END) {
          setStatus('年齢スイープ完了。終了します。');
          break;
        }
        setStatus(`次の年齢に切替: ${ageCursor}歳…`);
        try {
          await applyAgeFilter(ageCursor);
        } catch (e) {
          console.warn('[FW] 年齢適用エラー', e);
          await sleep(1500);
        }
        continue;
      } else {
        setStatus('サイクル完了。終了します。');
        break;
      }
    }

    setStatus('完了 or 停止しました');
    running = false;
    sweeping = false;
  }

  // UIイベント
  $('#fw-start').addEventListener('click', () => { if (!running) runAll(); });
  $('#fw-stop').addEventListener('click', () => { running = false; sweeping = false; setStatus('停止しました'); });

  // 初期ターゲット試行（初回取りこぼし対策）
  (async () => {
    pickBestTarget();
    await sleep(300);
    pickBestTarget();
    setStatus('待機中（ターゲット初期化完了）');
  })();

  console.log('[FW] Tampermonkey walker loaded on', location.href);
})();
