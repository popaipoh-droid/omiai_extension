// ==UserScript==
// @name         Omiai_Footprint-test
// @namespace    https://footprinter.app/
// @version      1.3.1
// @description  Cloud Functions から Trial/Pro エンジンを取得。Trialに「製品版にする」ボタンを注入。PRO化時は体験版UIを強制撤去＆停止。/search 以外ではUIを自動非表示。★ビジーフラグ/ハートビート送信でAI側の自動起動を抑止。PC版ではユーザーの「非表示」状態を尊重して再表示しない。
// @match        https://www.omiai-jp.com/search*
// @match        https://omiai-jp.com/search*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      omiai-footprint-435226602223.asia-northeast1.run.app
// @connect      omiai-footprint-test-435226602223.asia-northeast1.run.app
// @connect      *.run.app
// @downloadURL  https://github.com/popaipoh-droid/omiai_extension/raw/refs/heads/main/Omiai-Footprint.user.js
// @updateURL    https://github.com/popaipoh-droid/omiai_extension/raw/refs/heads/main/Omiai-Footprint.user.js
// ==/UserScript==


(function () {
  'use strict';

  // === 設定 ===
  const ENDPOINT = 'https://omiai-footprint-435226602223.asia-northeast1.run.app'; // prod
  // const ENDPOINT = 'https://omiai-footprint-test-435226602223.asia-northeast1.run.app'; // test

  const LS_KEY = 'fw_license_key';
  const UI_HIDE_KEY = 'fw_ui_hidden'; // ★ PRO側の「非表示」状態を尊重するためのフラグ
  const loadKey = () => { try { return localStorage.getItem(LS_KEY) || '' } catch { return '' } };
  const saveKey = (v) => { try { localStorage.setItem(LS_KEY, v || '') } catch { } };

  // === Busy/Heartbeat（AI起動抑止用） ===
  const BUSY_KEY = 'omiai:fw:busy:v1';
  const HEARTBEAT_MS = 5000;   // 5s
  const BUSY_TTL_MS = 20000;   // 20s (AI側は expiresAt > Date.now() を「実行中」と判断)

  let hbTimer = null;
  const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('omiai-tools') : null;

  const getBusy = () => {
    try { return JSON.parse(localStorage.getItem(BUSY_KEY) || 'null'); } catch { return null; }
  };
  const writeBusy = (busy) => {
    const now = Date.now();
    const payload = busy
      ? { busy: true, updatedAt: now, expiresAt: now + BUSY_TTL_MS }
      : null;
    try {
      if (payload) localStorage.setItem(BUSY_KEY, JSON.stringify(payload));
      else localStorage.removeItem(BUSY_KEY);
    } catch {}
  };
  const heartbeatOnce = () => {
    const cur = getBusy();
    if (!cur || !cur.busy) return;
    writeBusy(true); // updatedAt/TTL を延長
  };
  const startHeartbeat = () => {
    writeBusy(true);
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(heartbeatOnce, HEARTBEAT_MS);
    if (bc) bc.postMessage({ type: 'footprint:started', ts: Date.now() });
  };
  const stopHeartbeat = () => {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
    writeBusy(false);
    if (bc) bc.postMessage({ type: 'footprint:stopped', ts: Date.now() });
  };

  // URL変化監視（SPA対応）
  (function attachLocationChangeEvent() {
    const fire = () => window.dispatchEvent(new Event('locationchange'));
    const _push = history.pushState;
    history.pushState = function () { _push.apply(this, arguments); fire(); };
    const _replace = history.replaceState;
    history.replaceState = function () { _replace.apply(this, arguments); fire(); };
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  })();

  // 表示/非表示の切替対象ID（本スクリプト＋Trial/PRO エンジンのパネル）
  const PANEL_IDS = [
    'fw-license-panel',     // ライセンスUI（このスクリプト）
    'fw-trial-panel',       // 体験版パネル（Trialエンジン）
    'omiai-footprint-panel' // 製品版パネル（PROエンジン）
  ];

  function onSearchPage() {
    // https://www.omiai-jp.com/search 直下のみ表示。
    // パラメータや末尾スラッシュ、クエリ/ハッシュも許容。
    return /^\/search(?:[/?#]|$)/.test(location.pathname);
  }

  // ★ 修正：ユーザーが PRO 側で押した「非表示」状態（fw_ui_hidden）を尊重
  function togglePanelsForCurrentURL() {
    const onSearch = onSearchPage();

    // FAB の表示からも推測してよいが、確実性のため localStorage を主に参照
    const userHidden = (function(){
      try { return localStorage.getItem(UI_HIDE_KEY) === '1'; } catch { return false; }
    })();

    for (const id of PANEL_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;

      // /search 以外 → 常に非表示
      if (!onSearch) { el.style.display = 'none'; continue; }

      // /search 上でも、ユーザーが「非表示」中は再表示しない
      el.style.display = userHidden ? 'none' : '';
    }
  }

  // 初回 & URL変更時に反映（取りこぼし防止に軽めのポーリング）
  window.addEventListener('locationchange', togglePanelsForCurrentURL);
  document.addEventListener('DOMContentLoaded', togglePanelsForCurrentURL);
  setInterval(togglePanelsForCurrentURL, 1000);

  // ===== Utility: TRIAL UI 強制撤去 & 停止フラグ =====
  function cleanupTrialUIAggressive() {
    try {
      // Trialエンジンに停止を知らせる（実装側が参照していれば有効）
      window.__FW_TRIAL_ABORT = true;

      const kill = () => {
        const p = document.getElementById('fw-trial-panel');
        if (p) p.remove();
      };
      kill();
      // 念のため再生成抑止
      GM_addStyle(`#fw-trial-panel{display:none!important;visibility:hidden!important;}`);
      // 10秒だけ監視して、再生成されたら即消す
      const mo = new MutationObserver(kill);
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 10000);
    } catch (e) { console.warn('cleanupTrialUI failed', e); }
  }

  // ===== Utility: TRIALパネルに「製品版にする」ボタンを注入 =====
  function ensureUpgradeButtonInTrialPanel() {
    const panel = document.getElementById('fw-trial-panel');
    if (!panel) return;
    if (panel.querySelector('#fw-trial-upgrade')) return;

    GM_addStyle(`
      #fw-trial-upgrade{
        margin-left:8px; padding:6px 10px; border:0; border-radius:8px; cursor:pointer;
        background:#fbbf24; color:#000; font:inherit;
      }
    `);

    const row = Array.from(panel.querySelectorAll('div'))
      .find(d => (d.getAttribute('style') || '').includes('justify-content:flex-end')) || panel;

    const btn = document.createElement('button');
    btn.id = 'fw-trial-upgrade';
    btn.textContent = '製品版にする';
    btn.addEventListener('click', () => {
      if (typeof window.__FW_openLicensePanel === 'function') {
        window.__FW_openLicensePanel();
      } else {
        alert('ライセンス設定画面を開けませんでした。メニュー「製品版キー入力（パネルを開く）」から開いてください。');
      }
    });
    row.appendChild(btn);
  }

  function watchTrialPanelForUpgradeButton() {
    ensureUpgradeButtonInTrialPanel(); // もう出ていたら即注入
    const obs = new MutationObserver(() => ensureUpgradeButtonInTrialPanel());
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 60000); // 1分で監視解除
  }

  // ===== ライセンスUI（共通） =====
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
  `);

  function mountPanel() {
    if (document.getElementById('fw-license-panel')) return;
    const box = document.createElement('div'); box.id = 'fw-license-panel';
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <b>Footprint ライセンス設定</b><span id="fw-plan-badge" class="muted">–</span>
      </div>
      <div class="row"><label style="min-width:72px">ライセンス</label><input id="fw-key" type="text" placeholder="例: OMIAI-PRO-...." autocomplete="off"/></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        ※認証後はページの再読み込みしてください
      </div>
      <div class="row" style="justify-content:flex-end">
        <button id="fw-btn-save">キー入力後に押す(保存)</button>
        <button id="fw-btn-fetch">認証する</button>
        <button id="fw-btn-close">閉じる</button>
      </div>
      <div id="fw-lic-status" class="muted"><small>待機中</small></div>
      <div class="muted" style="margin-top:4px"><small>Endpoint: ${ENDPOINT}</small></div>
    `;
    document.documentElement.appendChild(box);

    const $ = (s) => box.querySelector(s);
    $('#fw-key').value = loadKey();
    const setStatus = (t) => $('#fw-lic-status').innerHTML = `<small>${t}</small>`;
    const setPlan = (p) => $('#fw-plan-badge').textContent = p;

    $('#fw-btn-save').addEventListener('click', () => { saveKey($('#fw-key').value.trim()); setStatus('キーを保存しました'); togglePanelsForCurrentURL(); });
    $('#fw-btn-fetch').addEventListener('click', () => fetchAndRun(true, setStatus, setPlan));
    $('#fw-btn-close').addEventListener('click', () => box.style.display = 'none');

    window.__FW_openLicensePanel = () => { $('#fw-key').value = loadKey(); box.style.display = 'block'; togglePanelsForCurrentURL(); };
    window.__FW_setPlanBadge = (p) => setPlan(p);

    // 生成後に現在URLに応じて表示/非表示を即時反映
    togglePanelsForCurrentURL();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPanel);
  } else {
    mountPanel();
  }

  // ===== エンジン実行ラッパ =====
  function execCode(codeText, label) {
    // GM_* 簡易ポリフィル
    const shim = `
      (function(){
        if (typeof GM_addStyle === 'undefined') {
          window.GM_addStyle = function(css){ const s=document.createElement('style'); s.textContent=css; document.documentElement.appendChild(s); return s; };
        }
        if (typeof GM_registerMenuCommand === 'undefined') { window.GM_registerMenuCommand = function(){}; }
        if (typeof GM_xmlhttpRequest === 'undefined') { window.GM_xmlhttpRequest = null; }
      })();`;
    const wrapped = `${shim}\n${codeText}\n//# sourceURL=${label || 'omiai_engine.js'}`;
    try {
      (new Function(wrapped))();
      // 実行直後にボタンへフック（PRO/Trial両対応）
      attachEngineHooksWithRetry();
      togglePanelsForCurrentURL();
      return true;
    }
    catch (e) { console.error('[Engine run error]', e); alert('エンジン実行エラー:\n' + (e && e.message ? e.message : e)); return false; }
  }

  // ====== PRO/Trial の開始/停止ボタンへフック（Busy管理） ======
  function bindIfButtonExists(btn, handler, markAttr) {
    if (!btn) return false;
    if (btn.dataset[markAttr]) return true;
    btn.dataset[markAttr] = '1';
    // キャプチャ段階で先に拾って Busy を立てる
    btn.addEventListener('click', handler, { capture: true });
    return true;
  }

  function observeStatusForStop() {
    // PRO パネルのステータスを監視して、停止/完了表示で Busy を降ろす
    const st = document.querySelector('#omiai-footprint-panel #fw-status');
    if (!st) return;
    const stopKeywords = ['停止しました', '完了', '終了します']; // エンジンの表示文言に追従
    const mo = new MutationObserver(() => {
      const t = (st.textContent || '').trim();
      if (stopKeywords.some(k => t.includes(k))) {
        stopHeartbeat();
      }
    });
    mo.observe(st, { childList: true, subtree: true, characterData: true });
    // しばらく監視（長時間でも軽いので放置でOK）
  }

  function attachEngineHooks() {
    const proPanel = document.getElementById('omiai-footprint-panel');
    const trialPanel = document.getElementById('fw-trial-panel');

    // PRO
    if (proPanel) {
      const startBtn = proPanel.querySelector('#fw-start');
      const stopBtn  = proPanel.querySelector('#fw-stop');

      bindIfButtonExists(startBtn, () => { startHeartbeat(); }, 'fwHooked');
      bindIfButtonExists(stopBtn,  () => { stopHeartbeat();  }, 'fwHooked');

      observeStatusForStop();
    }

    // Trial
    if (trialPanel) {
      const trialStart = trialPanel.querySelector('#fw-trial-start');
      bindIfButtonExists(trialStart, () => { startHeartbeat(); }, 'fwHooked');

      // Trial は stop ボタンなし。パネルが消えたら止める／または TTL に任せる。
      const mo = new MutationObserver(() => {
        if (!document.getElementById('fw-trial-panel')) {
          stopHeartbeat();
          mo.disconnect();
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 120000); // 2分で監視解除（TTLでも落ちるため）
    }
  }

  function attachEngineHooksWithRetry() {
    attachEngineHooks();
    // しばらく DOM 生成を待ちながら再試行
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      attachEngineHooks();
      const got = document.querySelector('#omiai-footprint-panel #fw-start') ||
                  document.querySelector('#fw-trial-panel #fw-trial-start');
      if (got || tries >= 40) clearInterval(iv); // 最大 ~20秒
    }, 500);
  }

  // ===== 取得＆起動 =====
  function fetchAndRun(showAlerts, setStatus = () => { }, setPlan = () => { }) {
    const token = (loadKey() || '').trim();
    const url = `${ENDPOINT}?token=${encodeURIComponent(token)}&ts=${Date.now()}`;
    setStatus(`取得中… (${token ? 'キーあり' : 'キーなし'})`);
    GM_xmlhttpRequest({
      method: 'GET', url, headers: { 'Accept': 'application/json' }, timeout: 15000,
      onload: (res) => {
        // HTTP ステータスの可視化（403/404/500切り分け用）
        if (res.status !== 200) {
          console.warn('HTTP status:', res.status, res.responseText);
          setStatus(`HTTP ${res.status}`);
          if (showAlerts) alert(`HTTP ${res.status}：関数の公開/URL/リージョンを確認`);
        }
        let data = null;
        try { data = JSON.parse(res.responseText || '{}'); }
        catch (e) { console.error('JSON parse error:', e, res.responseText); setStatus('エラー: JSON解析失敗'); if (showAlerts) alert('エンジン取得エラー（JSON解析失敗）'); return; }

        if (!data || !data.ok || (!data.code && !data.code_url)) {
          console.error('Invalid JSON payload', data);
          setStatus(`エラー: JSON不正 (HTTP ${res.status})`);
          if (showAlerts) alert('エンジン取得エラー（JSON不正）');
          return;
        }

        const plan = (data.plan || data?.meta?.plan || 'unknown');
        setPlan(plan); window.__FW_setPlanBadge?.(plan);

        // PROは体験版UIを徹底撤去（実行前）
        if (plan === 'pro') {
          cleanupTrialUIAggressive();
        } else {
          // TRIAL なら「製品版にする」ボタンを注入
          watchTrialPanelForUpgradeButton();
        }

        const run = (codeStr) => {
          const ok = execCode(codeStr, plan === 'pro' ? 'omiai_pro.js' : 'omiai_trial.js');
          setStatus(ok ? '実行完了' : '実行エラー');
        };

        if (data.code_url) {
          GM_xmlhttpRequest({
            method: 'GET', url: data.code_url, timeout: 15000,
            onload: (r2) => { run(r2.responseText); togglePanelsForCurrentURL(); },
            onerror: (e) => { setStatus('コードURL取得失敗'); if (showAlerts) alert('コードURL取得失敗'); console.error(e); },
            ontimeout: () => { setStatus('コードURL取得タイムアウト'); if (showAlerts) alert('コードURL取得タイムアウト'); }
          });
        } else {
          run(data.code);
        }
      },
      onerror: (e) => {
        console.error('GM_xmlhttpRequest onerror', e);
        setStatus('接続失敗');
        if (showAlerts) alert('接続失敗：@connect と公開設定を確認\n' + (e && e.error ? e.error : ''));
      },
      ontimeout: () => { setStatus('タイムアウト'); if (showAlerts) alert('取得タイムアウト'); }
    });
  }

  // 初回サイレント取得（実行後にURLに応じてUI切替も適用）
  fetchAndRun(false);

  // メニュー
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('製品版キー入力（パネルを開く）', () => { window.__FW_openLicensePanel?.(); togglePanelsForCurrentURL(); });
    GM_registerMenuCommand('エンジン再取得（キー送信）', () => fetchAndRun(true));
    GM_registerMenuCommand('Busyフラグを強制リセット', () => { stopHeartbeat(); alert('Busyフラグをリセットしました'); });
    GM_registerMenuCommand('Busy状態を表示', () => { alert(JSON.stringify(getBusy(), null, 2)); });
  }

  // ページ離脱時（タブを閉じる/リロード）には Busy を自動で降ろさない
  // ※ Walker はプロフ→一覧を往復するため、leave で消すと誤判定になりやすい。
})();
