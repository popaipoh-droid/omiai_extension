// ==UserScript==
// @name         Omiai_AI_Assistant
// @namespace    https://footprinter.app/
// @version      1.2.1
// @description  /profile と /messages/detail で Cloud Functions から AIアシスタントUI（PRO/Trial）を取得して実行。二重実行ガード・IIFEラップ・in-flightガード。足跡ツールのBusyフラグ/ハートビートを検知して起動を抑止し、解除時に自動起動。
// @match        https://www.omiai-jp.com/*
// @match        https://omiai-jp.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      omiai-ai-loader-ui-435226602223.asia-northeast1.run.app
// @connect      *.run.app
// @downloadURL  https://github.com/popaipoh-droid/omiai_extension/raw/refs/heads/main/Omiai-AI-Assistant.user.js
// @updateURL    https://github.com/popaipoh-droid/omiai_extension/raw/refs/heads/main/Omiai-AI-Assistant.user.js
// ==/UserScript==

(function () {
  'use strict';

  // =========================
  // 設定：AIアシスタント Cloud Functions
  // =========================
  const AI_ENDPOINT = 'https://omiai-ai-loader-ui-435226602223.asia-northeast1.run.app';

  // ライセンスキー（共通キー名を踏襲）
  const LS_KEY = 'fw_license_key';
  const loadKey = () => { try { return localStorage.getItem(LS_KEY) || '' } catch { return '' } };
  const saveKey = (v) => { try { localStorage.setItem(LS_KEY, v || '') } catch { } };

  // =========================
  // 足跡ツール Busy 連携
  // =========================
  const BUSY_KEY = 'omiai:fw:busy:v1';   // 足跡側が書き込む {busy, updatedAt, expiresAt}
  const readBusyObj = () => { try { return JSON.parse(localStorage.getItem(BUSY_KEY) || 'null'); } catch { return null; } };
  const isFootprintBusy = () => {
    const o = readBusyObj();
    return !!(o && o.busy && typeof o.expiresAt === 'number' && o.expiresAt > Date.now());
  };
  let cachedBusy = isFootprintBusy();

  // Busy変化を受け取る（BroadcastChannel）
  const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('omiai-tools') : null;
  if (bc) {
    bc.onmessage = (ev) => {
      const t = ev?.data?.type;
      if (t === 'footprint:started') {
        cachedBusy = true;
      } else if (t === 'footprint:stopped') {
        cachedBusy = false;
        // 忙しくなくなったタイミングで、AIルートなら起動を試みる
        ensureAIForCurrentRoute(false);
      }
    };
  }
  // TTL切れなどローカルストレージ側の状態更新もポーリングで追従
  setInterval(() => {
    const now = isFootprintBusy();
    if (now !== cachedBusy) {
      cachedBusy = now;
      if (!cachedBusy) ensureAIForCurrentRoute(false);
    }
  }, 3000);

  // =========================
  // ルーティング判定（SPA対応）
  // =========================
  const isAIPage = () =>
    /\/profile(?:[/?#]|$)/.test(location.pathname) ||
    /\/messages\/detail(?:[/?#]|$)/.test(location.pathname);

  (function attachLocationChangeEvent() {
    const fire = () => window.dispatchEvent(new Event('locationchange'));
    const _push = history.pushState;
    history.pushState = function () { const r = _push.apply(this, arguments); fire(); return r; };
    const _replace = history.replaceState;
    history.replaceState = function () { const r = _replace.apply(this, arguments); fire(); return r; };
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  })();

  // =========================
  // 表示切替：AI 側のパネルID
  //  - trial: omiai-ai-trial-panel（関数側で生成）
  //  - pro:   omiai-unified-panel（IIFE内で生成）
  //  - 自前:  fw-license-panel（ライセンス入力UI）
  // =========================
  const PANEL_IDS = {
    license: 'fw-license-panel',
    ai: ['omiai-ai-trial-panel', 'omiai-unified-panel'],
  };

  function setPanelsVisibilityForRoute() {
    const onAI = isAIPage();

    // まず全パネルを隠す
    const all = [PANEL_IDS.license, ...PANEL_IDS.ai];
    for (const id of all) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }

    // AIルートなら AI のパネルを表示（存在していれば）
    if (onAI) {
      for (const id of PANEL_IDS.ai) {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
      }
    }

    // ライセンスパネルが開いていれば常に表示
    const lic = document.getElementById(PANEL_IDS.license);
    if (lic && lic.style.display === 'block') lic.style.display = 'block';
  }

  window.addEventListener('locationchange', setPanelsVisibilityForRoute);
  document.addEventListener('DOMContentLoaded', setPanelsVisibilityForRoute);
  setInterval(setPanelsVisibilityForRoute, 1000); // 軽い保険

  // =========================
  // Trial UI の撤去（Trial→Proへ切替時）
  // =========================
  function cleanupTrialUIAggressive() {
    try {
      // Trial 停止フラグ（Trial実装側が見ていれば有効）
      window.__FW_TRIAL_ABORT = true;

      const killIds = ['omiai-ai-trial-panel'];
      const kill = () => {
        killIds.forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
      };
      kill();

      // 念のため再生成抑止
      GM_addStyle(`#omiai-ai-trial-panel{display:none!important;visibility:hidden!important;}`);

      // 10秒だけ監視して、再生成されたら即消す
      const mo = new MutationObserver(kill);
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 10000);
    } catch (e) { console.warn('cleanupTrialUI failed', e); }
  }

  // =========================
  // ライセンスUI（AI 専用）
  // =========================
  GM_addStyle(`
    #fw-license-panel{
      position:fixed;right:16px;bottom:16px;z-index:2147483647;width:360px;
      background:rgba(0,0,0,.85);color:#fff;padding:12px;border-radius:12px;
      box-shadow:0 10px 28px rgba(0,0,0,.45);font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
      display:none
    }
    #fw-license-panel .row{display:flex;gap:8px;align-items:center;margin:6px 0}
    #fw-license-panel input[type=text]{flex:1;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#0b1220;color:#fff;outline:none}
    #fw-license-panel button{padding:6px 10px;border:0;border-radius:8px;cursor:pointer;color:#000}
    #fw-btn-save{background:#38bdf8}
    #fw-btn-fetch{background:#86efac}
    #fw-btn-close{background:#fca5a5}
    #fw-license-panel .muted{opacity:.75}
    #fw-license-panel small code{background:#111827;padding:1px 4px;border-radius:4px}
  `);

  function mountLicensePanel() {
    if (document.getElementById(PANEL_IDS.license)) return;
    const box = document.createElement('div'); box.id = PANEL_IDS.license;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <b>Omiai AI Loader｜ライセンス設定</b><span id="fw-plan-badge" class="muted">–</span>
      </div>
      <div class="row"><label style="min-width:72px">ライセンス</label><input id="fw-key" type="text" placeholder="例: OMIAI-PRO-...." autocomplete="off"/></div>
      <div class="row muted" style="display:block">
        <small>AI UI: <code>${AI_ENDPOINT}</code></small>
      </div>
      <div class="row" style="justify-content:flex-end">
        <button id="fw-btn-save">キー保存</button>
        <button id="fw-btn-fetch">認証＆実行（この画面用）</button>
        <button id="fw-btn-close">閉じる</button>
      </div>
      <div id="fw-lic-status" class="muted"><small>待機中</small></div>
    `;
    document.documentElement.appendChild(box);

    const $ = (s) => box.querySelector(s);
    $('#fw-key').value = loadKey();
    const setStatus = (t) => $('#fw-lic-status').innerHTML = `<small>${t}</small>`;
    const setPlan = (p) => $('#fw-plan-badge').textContent = p;

    $('#fw-btn-save').addEventListener('click', () => { saveKey($('#fw-key').value.trim()); setStatus('キーを保存しました'); setPanelsVisibilityForRoute(); });
    $('#fw-btn-fetch').addEventListener('click', () => ensureAIForCurrentRoute(true, setStatus, setPlan));
    $('#fw-btn-close').addEventListener('click', () => { box.style.display = 'none'; setPanelsVisibilityForRoute(); });

    window.__FW_openLicensePanel = () => { $('#fw-key').value = loadKey(); box.style.display = 'block'; setPanelsVisibilityForRoute(); };
    window.__FW_setPlanBadge = (p) => setPlan(p);

    setPanelsVisibilityForRoute();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountLicensePanel);
  } else {
    mountLicensePanel();
  }

  // =========================
  // 汎用：コード実行ラッパ（重複実行ガード＋二重IIFEラップ）
  // =========================
  function execCode(codeText, label) {
    // 既にUIが存在する／フラグが立っている場合は実行をスキップ
    if (document.getElementById('omiai-unified-panel')) {
      console.info('[AI] UI already mounted. Skip re-run.');
      return true;
    }
    if (window.__OMIAI_AI_LOADED__) {
      console.info('[AI] Already loaded flag present. Skip.');
      return true;
    }

    // GM_* 簡易ポリフィル（関数側コードで GM_* 未定義でも落ちないように）
    const shim = `
      (function(){
        if (typeof GM_addStyle === 'undefined') {
          window.GM_addStyle = function(css){ const s=document.createElement('style'); s.textContent=css; document.documentElement.appendChild(s); return s; };
        }
        if (typeof GM_registerMenuCommand === 'undefined') { window.GM_registerMenuCommand = function(){}; }
        if (typeof GM_xmlhttpRequest === 'undefined') { window.GM_xmlhttpRequest = null; }
      })();`;

    // 二重IIFEでスコープを閉じる（トップレベルconstの再宣言衝突を避ける）
    const wrapped =
      `${shim}\n(function(){\n` +
      `${codeText}\n` +
      `})();\n//# sourceURL=${label || 'omiai_ai_loader.js'}`;

    try {
      (new Function(wrapped))();
      window.__OMIAI_AI_LOADED__ = true; // 二度目以降の実行を抑止
      setPanelsVisibilityForRoute();
      return true;
    } catch (e) {
      console.error('[AI run error]', e);
      alert('AIコード実行エラー:\n' + (e && e.message ? e.message : e));
      return false;
    }
  }

  // =========================
  // Cloud Functions 取得（AIのみ）
  // =========================
  function fetchAI(showAlerts, setStatus = () => {}, setPlan = () => {}) {
    const token = (loadKey() || '').trim();
    const url = `${AI_ENDPOINT}?token=${encodeURIComponent(token)}&ts=${Date.now()}`;
    setStatus(`取得中…（AI, ${token ? 'キーあり' : 'キーなし'}）`);

    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers: { 'Accept': 'application/json' }, timeout: 20000,
        onload: (res) => {
          if (res.status !== 200) {
            console.warn('HTTP status:', res.status, res.responseText);
            setStatus(`HTTP ${res.status}`);
            if (showAlerts) alert(`HTTP ${res.status}：関数の公開/URL/リージョンを確認`);
            return resolve(null);
          }
          let data = null;
          try { data = JSON.parse(res.responseText || '{}'); }
          catch (e) { console.error('JSON parse error:', e, res.responseText); setStatus('エラー: JSON解析失敗'); if (showAlerts) alert('取得エラー（JSON解析失敗）'); return resolve(null); }

          if (!data || !data.ok || (!data.code && !data.code_url)) {
            console.error('Invalid JSON payload', data);
            setStatus('エラー: JSON不正');
            if (showAlerts) alert('取得エラー（JSON不正）');
            return resolve(null);
          }

          const plan = (data.plan || data?.meta?.plan || 'unknown');
          setPlan(plan); window.__FW_setPlanBadge?.(plan);

          if (plan === 'pro') {
            cleanupTrialUIAggressive(); // Trial UI を撤去
          }

          const run = (codeStr) => {
            // 実行直前の二重チェック
            if (document.getElementById('omiai-unified-panel') || window.__OMIAI_AI_LOADED__) {
              setStatus('既にAI UIが存在するため実行をスキップしました');
              return resolve({ plan, ok: true });
            }
            const ok = execCode(codeStr, 'omiai_ai.js');
            setStatus(ok ? '実行完了' : '実行エラー');
            resolve({ plan, ok });
          };

          if (data.code_url) {
            GM_xmlhttpRequest({
              method: 'GET', url: data.code_url, timeout: 15000,
              onload: (r2) => { run(r2.responseText); },
              onerror: (e) => { setStatus('コードURL取得失敗'); if (showAlerts) alert('コードURL取得失敗'); console.error(e); resolve(null); },
              ontimeout: () => { setStatus('コードURL取得タイムアウト'); if (showAlerts) alert('コードURL取得タイムアウト'); resolve(null); }
            });
          } else {
            run(data.code);
          }
        },
        onerror: (e) => {
          console.error('GM_xmlhttpRequest onerror', e);
          setStatus('接続失敗');
          if (showAlerts) alert('接続失敗：@connect と公開設定を確認\n' + (e && e.error ? e.error : ''));
          resolve(null);
        },
        ontimeout: () => { setStatus('タイムアウト'); if (showAlerts) alert('取得タイムアウト'); resolve(null); }
      });
    });
  }

  // =========================
  // ルート別ロード制御（AIのみ）
  // =========================
  let loadedAI = false;
  let aiInflight = false;

  async function ensureAIForCurrentRoute(showAlerts = false, setStatus = () => {}, setPlan = () => {}) {
    setPanelsVisibilityForRoute();

    if (!isAIPage()) return;

    // 既にロード済みなら何もしない
    if (loadedAI || window.__OMIAI_AI_LOADED__ || document.getElementById('omiai-unified-panel')) return;

    // 足跡ツールが Busy の間は起動しない
    if (isFootprintBusy()) {
      setStatus?.('足跡ツール実行中のためAI起動を待機中…（自動で再開します）');
      return; // BroadcastChannel/TTLで解除後に ensure が走る
    }

    // 同時多発防止
    if (aiInflight) return;

    aiInflight = true;
    try {
      const r = await fetchAI(showAlerts, setStatus, setPlan);
      if (r && r.ok) loadedAI = true;
    } finally {
      aiInflight = false;
    }
    setPanelsVisibilityForRoute();
  }

  // 初回サイレント取得（AIページならロード。ただしBusyなら待機）
  ensureAIForCurrentRoute(false);

  // 画面遷移の都度、必要ならロード（Busyなら待機）
  window.addEventListener('locationchange', () => ensureAIForCurrentRoute(false));

  // =========================
  // メニュー
  // =========================
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('製品版キー入力（パネルを開く）', () => { window.__FW_openLicensePanel?.(); setPanelsVisibilityForRoute(); });
    GM_registerMenuCommand('AIアシスタントを再取得（この画面用）', () => ensureAIForCurrentRoute(true));
    GM_registerMenuCommand('Busy状態を表示', () => { alert(JSON.stringify(readBusyObj(), null, 2)); });
    GM_registerMenuCommand('（デバッグ）Busyを無視して即起動', () => {
      // 強行起動（Busyチェックをスキップ）
      const prev = isFootprintBusy;
      try {
        // 一時的に常に false を返すように差し替え
        window._isFootprintBusyBackup = prev;
        // @ts-ignore
        isFootprintBusy = () => false;
      } catch {}
      ensureAIForCurrentRoute(true, (t)=>console.log(t), (p)=>console.log('plan:', p));
      // 5秒後に元へ
      setTimeout(() => {
        try { /* @ts-ignore */ isFootprintBusy = window._isFootprintBusyBackup || prev; } catch {}
      }, 5000);
    });
  }
})();
