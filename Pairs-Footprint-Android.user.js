// ==UserScript==
// @name         Pairs Footprinter (Android ver)
// @namespace    https://note.com/footprinter
// @version      1.0
// @description  ペアーズ足あとツール用の拡張機能
// @match        https://pairs.lv/search*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ✅ あなたの本番Cloud Functionsエンドポイント
    const CLOUD_FN_URL = 'https://pairs-footprint-android-435226602223.asia-northeast1.run.app';
    const LS_LICENSE_KEY = 'pf_license_key';
    const FETCH_TIMEOUT_MS = 15000;

    const ERR = {
        NET_TIMEOUT: 'E01:ネットワーク/タイムアウト',
        HTTP_STATUS: 'E02:HTTPエラー',
        JSON_PARSE: 'E03:JSONパース失敗',
        BAD_PAYLOAD: 'E04:ペイロード不正',
        BLOB_EXEC: 'E05:blob実行失敗',
        EVAL_EXEC: 'E06:eval実行失敗'
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    function withTimeout(promise, ms) {
        return new Promise((resolve, reject) => {
            const id = setTimeout(() => reject(new Error('timeout')), ms);
            promise.then(v => { clearTimeout(id); resolve(v); },
                e => { clearTimeout(id); reject(e); });
        });
    }

    function license() {
        let lic = (localStorage.getItem(LS_LICENSE_KEY) || '').trim();
        if (!lic) {
            lic = prompt('ライセンスキーを入力してください（空OK=体験版）', '') || '';
            lic = lic.trim();
            try { localStorage.setItem(LS_LICENSE_KEY, lic); } catch { }
        }
        return lic;
    }

    function showError(code, detail) {
        const msg = `[Loader ${code}] ${detail || ''}\n\n対処: ネット接続/ライセンス確認`;
        alert(msg);
        try { console.error(msg); } catch { }
    }

    async function runCode(raw, label) {
        try {
            const blob = new Blob([raw + `\n//# sourceURL=${label}`], { type: 'text/javascript' });
            const url = URL.createObjectURL(blob);
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = url;
                s.onload = () => { try { URL.revokeObjectURL(url); } catch { }; resolve(); };
                s.onerror = () => { try { URL.revokeObjectURL(url); } catch { }; reject(new Error('blob load error')); };
                (document.head || document.documentElement).appendChild(s);
            });
            return true;
        } catch (e) {
            console.warn('[Loader]', ERR.BLOB_EXEC, e);
            try { eval(raw + `\n//# sourceURL=${label}`); return true; }
            catch (ee) { console.error('[Loader]', ERR.EVAL_EXEC, ee); showError(ERR.EVAL_EXEC, ee.message); return false; }
        }
    }

    (async () => {
        try {
            const lic = license();
            const url = `${CLOUD_FN_URL}?token=${encodeURIComponent(lic)}`;

            let res;
            try {
                res = await withTimeout(fetch(url, { mode: 'cors', cache: 'no-cache', credentials: 'omit' }), FETCH_TIMEOUT_MS);
            } catch (e) {
                showError(ERR.NET_TIMEOUT, e.message || String(e));
                return;
            }

            if (!res.ok) {
                showError(ERR.HTTP_STATUS, `status=${res.status}`);
                return;
            }

            let dataText = '';
            try { dataText = await res.text(); }
            catch (e) { showError(ERR.JSON_PARSE, 'text取得失敗'); return; }

            let json;
            try { json = JSON.parse(dataText); }
            catch (e) { showError(ERR.JSON_PARSE, (dataText || '').slice(0, 200)); return; }

            // ✅ True → true に修正済み
            if (!json || json.ok !== true || typeof json.code !== 'string' || json.code.length < 50) {
                showError(ERR.BAD_PAYLOAD, JSON.stringify({ ok: json && json.ok, len: json && (json.code || '').length }));
                return;
            }

            const plan = json.plan || 'trial';
            console.log(`[Pairs Loader] plan=${plan}`);
            const ok = await runCode(json.code, `pairs-${plan}.js`);
            if (!ok) return;
        } catch (e) {
            showError('E99:想定外', e.message || String(e));
        }
    })();
})();
