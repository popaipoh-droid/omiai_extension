// ==UserScript==
// @name         Omiai Footprint Loader (GCF/Run trial)
// @namespace    https://footprinter.app/
// @version      0.1.2
// @description  Cloud Run から trial エンジンを取得して実行
// @match        https://www.omiai-jp.com/search*
// @match        https://omiai-jp.com/search*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      omiai-sample-435226602223.asia-northeast1.run.app
// @connect      *.run.app
// ==/UserScript==


(function(){
  'use strict';
  const ENDPOINT = 'https://omiai-sample-435226602223.asia-northeast1.run.app';

  const XHR = (typeof GM_xmlhttpRequest === 'function')
            ? GM_xmlhttpRequest
            : (GM && GM.xmlHttpRequest);

  if (!XHR) {
    alert('GM_xmlhttpRequest が利用できません。\n@grant の指定と Tampermonkey を確認してください。');
    return;
  }

  XHR({
    method: 'GET',
    url: ENDPOINT,             // まずはルートを叩く
    timeout: 15000,
    headers: { 'Accept': 'application/json' },
    onload: (res) => {
      console.log('[Loader] onload status:', res.status);
      try {
        const data = JSON.parse(res.responseText || '{}');
        if (data && data.ok && data.code) {
          (0, eval)(data.code);
        } else {
          alert('取得エラー: JSON 形式が不正 / 期待と違う応答です。\nHTTP ' + res.status);
          console.debug('Body:', res.responseText);
        }
      } catch (e) {
        alert('JSON 解析に失敗しました（HTMLが返っている可能性）\nHTTP ' + res.status);
        console.debug('Raw body:', res.responseText);
      }
    },
    onerror: (e) => {
      alert(
        'XHR error: 接続に失敗しました\n' +
        `ENDPOINT: ${ENDPOINT}\n` +
        '・@connect に明示ドメインを追加＆承認済みか\n' +
        '・Tampermonkey 設定で @connect * を禁止にしていないか\n' +
        '・他の拡張機能でブロックしていないか\n' +
        'を確認してください。'
      );
      console.error('XHR error', e);
    },
    ontimeout: () => alert('取得エラー: タイムアウトしました')
  });
})();
