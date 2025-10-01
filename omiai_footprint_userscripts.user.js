// ==UserScript==
// @name         Omiai Engine Loader (iOS) - Minimal Errors
// @namespace    nothing
// @version      1.1.0
// @description  成功時は無音。失敗時だけ原因を1回だけalertで表示。
// @match        https://www.omiai-jp.com/search*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
    'use strict';
    const CLOUD_FN_URL = 'https://omiai-footprint-435226602223.asia-northeast1.run.app';
    const LS_LICENSE_KEY = 'fw_license_key';
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
        const msg = `[Loader ${code}] ${detail || ''}\n\n対処: ①Userscripts拡張ON ②参照フォルダにこの.user.jsがある ③URL/電波 を確認`;
        alert(msg);
        try { console.error(msg); } catch { }
    }
    function sanitizeReturnedCode(src) {
        let code = String(src || '');
        code = code.replace(/^\+\s?.*$/gm, '');
        code = code.replace(
            /cand\s*=\s*\[\s*\$\{?o\}?\/profile\/\$\{?id\}?[\s,]*\$\{?o\}?\/profile\?id=\$\{?id\}?[\s,]*\$\{?o\}?\/profile\s*\]\s*;/g,
            'const o = location.origin; const cand = [`${o}/profile/${id}`, `${o}/profile?id=${id}`, `${o}/profile`];'
        );
        return code;
    }
    async function runCode(raw, label) {
        const code = sanitizeReturnedCode(raw);
        // blob → eval の順
        try {
            const blob = new Blob([code + `\n//# sourceURL=${label}`], { type: 'text/javascript' });
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
            // GM_addStyleだけ軽ポリフィル（PRO内で使うため）
            if (typeof window.GM_addStyle !== 'function') {
                window.GM_addStyle = (css) => {
                    try {
                        const st = document.createElement('style'); st.textContent = String(css || '');
                        (document.head || document.documentElement).appendChild(st); return st;
                    } catch { }
                };
            }

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
            catch (e) { showError(ERR.JSON_PARSE, 'textの取得失敗'); return; }

            let json;
            try { json = JSON.parse(dataText); }
            catch (e) { showError(ERR.JSON_PARSE, (dataText || '').slice(0, 200)); return; }

            if (!json || json.ok !== true || typeof json.code !== 'string' || json.code.length < 50) {
                showError(ERR.BAD_PAYLOAD, JSON.stringify({ ok: json && json.ok, len: json && (json.code || '').length }));
                return;
            }

            const plan = json.plan || 'trial';
            const ok = await runCode(json.code, `omiai-${plan}.js`);
            if (!ok) return; // runCode内でエラー表示済み
        } catch (e) {
            showError('E99:想定外', e.message || String(e));
        }
    })();
})();
