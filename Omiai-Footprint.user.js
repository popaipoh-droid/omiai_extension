// ==UserScript==
// @name         Omiai_Footprint(PC)
// @namespace    https://note.com/footprinter
// @version      2.0.0
// @description  Cloud Functions から Omiai Footprinter エンジン(JS)を取得して実行するローダー。ライセンス判定・UI・ログ・Busy フラグなどはすべてサーバー側エンジンに委譲。
// @match        https://www.omiai-jp.com/search*
// @match        https://omiai-jp.com/search*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      omiai-footprint-435226602223.asia-northeast1.run.app
// @connect      omiai-footprint-test-435226602223.asia-northeast1.run.app
// @connect      *.run.app
// @downloadURL  https://github.com/popaipoh-droid/omiai_extension/raw/refs/heads/main/Omiai-Footprint.user.js
// @updateURL    https://github.com/popaipoh-droid/omiai_extension/raw/refs/heads/main/Omiai-Footprint.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ===== 設定 =====
  const ENDPOINT = 'https://omiai-footprint-435226602223.asia-northeast1.run.app'; // prod
  // const ENDPOINT = 'https://omiai-footprint-test-435226602223.asia-northeast1.run.app'; // test
  const LS_KEY   = 'fw_license_key'; // ライセンスキーはエンジン側モーダルで管理

  const loadKey = () => {
    try { return localStorage.getItem(LS_KEY) || ''; }
    catch { return ''; }
  };

  // ===== エンジン実行ラッパ（ローダーの唯一の役割） =====
  function execCode(codeText, label) {
    // GM_* ポリフィル（エンジン側で必要になったときのため）
    const shim = `
      (function(){
        if (typeof GM_addStyle === 'undefined') {
          window.GM_addStyle = function(css){
            const s = document.createElement('style');
            s.textContent = css;
            document.documentElement.appendChild(s);
            return s;
          };
        }
        if (typeof GM_registerMenuCommand === 'undefined') {
          window.GM_registerMenuCommand = function(){};
        }
        if (typeof GM_xmlhttpRequest === 'undefined') {
          window.GM_xmlhttpRequest = null;
        }
      })();
    `;
    const wrapped = `${shim}\n${codeText}\n//# sourceURL=${label || 'omiai_engine.js'}`;
    try {
      // 返ってきたエンジン JS をそのまま実行
      (new Function(wrapped))();
      return true;
    } catch (e) {
      console.error('[Engine run error]', e);
      alert('Footprinter エンジン実行エラー:\n' + (e && e.message ? e.message : e));
      return false;
    }
  }

  // ===== Cloud Functions からエンジン取得＆実行 =====
  function fetchAndRun(showAlerts) {
    const token = (loadKey() || '').trim();
    const url   = `${ENDPOINT}?token=${encodeURIComponent(token)}&ts=${Date.now()}`;

    GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
      onload: (res) => {
        if (res.status !== 200) {
          console.warn('HTTP status:', res.status, res.responseText);
          if (showAlerts) {
            alert(`Footprinter エンジン取得エラー: HTTP ${res.status}\nCloud Functions の公開設定や URL を確認してください。`);
          }
          return;
        }

        let data = null;
        try {
          data = JSON.parse(res.responseText || '{}');
        } catch (e) {
          console.error('JSON parse error:', e, res.responseText);
          if (showAlerts) alert('エンジン取得エラー（JSON解析失敗）');
          return;
        }

        if (!data || !data.ok || (!data.code && !data.code_url)) {
          console.error('Invalid payload:', data);
          if (showAlerts) alert('エンジン取得エラー（code が含まれていません）');
          return;
        }

        const run = (codeStr) => {
          const ok = execCode(codeStr, 'omiai_engine_unified.js');
          if (!ok && showAlerts) {
            alert('Footprinter エンジンの実行に失敗しました。コンソールログをご確認ください。');
          }
        };

        if (data.code_url) {
          // 将来 code_url 方式にする場合も想定
          GM_xmlhttpRequest({
            method: 'GET',
            url: data.code_url,
            timeout: 15000,
            onload: (r2) => run(r2.responseText),
            onerror: (e2) => {
              console.error('code_url fetch error', e2);
              if (showAlerts) alert('エンジンコード取得エラー（code_url）');
            },
            ontimeout: () => {
              if (showAlerts) alert('エンジンコード取得タイムアウト（code_url）');
            }
          });
        } else {
          run(data.code);
        }
      },
      onerror: (e) => {
        console.error('GM_xmlhttpRequest onerror', e);
        if (showAlerts) {
          alert('Footprinter エンジンへの接続に失敗しました。\n@connect 設定や Cloud Functions のステータスを確認してください。');
        }
      },
      ontimeout: () => {
        if (showAlerts) {
          alert('Footprinter エンジン取得がタイムアウトしました。');
        }
      }
    });
  }

  // ===== 自動起動 =====
  // /search ページに来たら自動的にエンジンを取得して実行。
  fetchAndRun(false);

  // ===== メニュー（デバッグ・再取得用だけ） =====
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Footprinter エンジン再取得', () => fetchAndRun(true));
  }
})();
