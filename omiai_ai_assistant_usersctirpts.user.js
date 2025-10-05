// ==UserScript==
// @name         Omiai AI Assistant Loader (iOS) - Minimal Errors
// @namespace    your.brand
// @version      1.0.0
// @description  成功時は無音。失敗時だけ原因を1回だけalertで表示。AIパネルに非表示↔＋ボタン復帰、タイトルとボタンゾーンの分離パッチを静かに適用。
// @match        https://www.omiai-jp.com/*
// @match        https://omiai-jp.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
    'use strict';

    // ===== 設定 =====
    const AI_CLOUD_URL = 'https://omiai-ai-loader-ui-435226602223.asia-northeast1.run.app'; // Cloud Run / Functions 側（AIアシスタントUIを返すエンドポイント）
    const LS_LICENSE_KEY = 'fw_license_key';        // ライセンスキーを共通のキー名に保存
    const FETCH_TIMEOUT_MS = 15000;

    // UIパッチ用（Tampermonkey版と同じ挙動）
    const ROOT_ID = 'omiai-unified-panel';
    const FAB_ID = 'omiai-ai-fab';
    const LS_HIDE_KEY = 'omiai_ai_ui_hidden';

    const ERR = {
        NET_TIMEOUT: 'E01:ネットワーク/タイムアウト',
        HTTP_STATUS: 'E02:HTTPエラー',
        JSON_PARSE: 'E03:JSONパース失敗',
        BAD_PAYLOAD: 'E04:ペイロード不正',
        BLOB_EXEC: 'E05:blob実行失敗',
        EVAL_EXEC: 'E06:eval実行失敗'
    };

    // ===== Utils =====
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
            lic = prompt('ライセンスキーを入力してください（空OK=TRIAL）', '') || '';
            lic = lic.trim();
            try { localStorage.setItem(LS_LICENSE_KEY, lic); } catch { }
        }
        return lic;
    }
    function showError(code, detail) {
        const msg = `[AI Loader ${code}] ${detail || ''}\n\n対処: ①Userscripts拡張ON ②この.user.jsが参照フォルダにある ③URL/電波 を確認`;
        alert(msg);
        try { console.error(msg); } catch { }
    }

    // ===== ここから：UIパッチ（非表示↔＋復帰、タイトル/ボタン分離） =====
    function injectPatchStyleOnce() {
        if (document.getElementById('ai-ios-style')) return;
        const st = document.createElement('style');
        st.id = 'ai-ios-style';
        st.textContent = `
      /* tool bar をbody先頭に */
      #${ROOT_ID} .toolbar{
        position: sticky; top: 0; z-index: 1;
        display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;
        padding:10px 0; margin:0 0 6px;
        background: linear-gradient(#fff,#fff);
        border-bottom:1px dashed #eceef6;
      }
      #${FAB_ID}{
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        width: 44px; height: 44px; border-radius: 9999px;
        background: rgba(0,0,0,.78); color: #fff;
        display: none; align-items: center; justify-content: center;
        font: 24px/1 system-ui,-apple-system,sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,.35);
        border: 0; cursor: pointer; -webkit-tap-highlight-color: transparent;
      }
      #${FAB_ID}:active { transform: scale(0.96); }
      #${ROOT_ID}.ai-hidden{ display: none !important; }
    `;
        (document.head || document.documentElement).appendChild(st);
    }
    function ensureFab() {
        let fab = document.getElementById(FAB_ID);
        if (!fab) {
            fab = document.createElement('button');
            fab.id = FAB_ID;
            fab.type = 'button';
            fab.setAttribute('aria-label', 'AIパネルを表示');
            fab.textContent = '+';
            (document.documentElement || document.body).appendChild(fab);
            fab.addEventListener('click', showPanel);
        }
        return fab;
    }
    function hidePanel() {
        try {
            const root = document.getElementById(ROOT_ID);
            const fab = ensureFab();
            if (root) root.classList.add('ai-hidden');
            if (fab) fab.style.display = 'flex';
            localStorage.setItem(LS_HIDE_KEY, '1');
        } catch { }
    }
    function showPanel() {
        try {
            const root = document.getElementById(ROOT_ID);
            const fab = ensureFab();
            if (root) root.classList.remove('ai-hidden');
            if (fab) fab.style.display = 'none';
            localStorage.removeItem(LS_HIDE_KEY);
        } catch { }
    }
    function applyHiddenState() {
        const hidden = localStorage.getItem(LS_HIDE_KEY) === '1';
        const root = document.getElementById(ROOT_ID);
        const fab = ensureFab();
        if (!root) {
            fab.style.display = hidden ? 'flex' : 'none';
            return;
        }
        if (hidden) {
            root.classList.add('ai-hidden');
            fab.style.display = 'flex';
        } else {
            root.classList.remove('ai-hidden');
            fab.style.display = 'none';
        }
    }
    function patchUIPanelOnce(root) {
        try {
            if (!root) { applyHiddenState(); return; }
            injectPatchStyleOnce();

            // タイトル行に「非表示」ボタンを生やす（未設置なら）
            const hdr = root.querySelector('.hdr') || root.querySelector(':scope > div');
            if (hdr && !hdr.querySelector('#omiai-hide')) {
                const btn = document.createElement('button');
                btn.id = 'omiai-hide';
                btn.type = 'button';
                btn.textContent = '非表示';
                btn.style.padding = '6px 10px';
                btn.style.fontSize = '12px';
                btn.style.borderRadius = '10px';
                btn.style.cursor = 'pointer';
                btn.style.border = '1px solid #e5e7eb';
                btn.style.background = '#f8fafc';
                btn.style.color = '#1f2937';
                btn.addEventListener('click', hidePanel);
                hdr.appendChild(btn);
            }

            // ヘッダーの .btns を本文 .body 先頭に .toolbar として移設（未設置なら）
            const btns = root.querySelector('.hdr .btns');
            const body = root.querySelector('.body') || root;
            if (btns && body && !root.querySelector('.body .toolbar')) {
                const toolbar = document.createElement('div');
                toolbar.className = 'toolbar';
                Array.from(btns.children).forEach(ch => toolbar.appendChild(ch));
                body.insertBefore(toolbar, body.firstChild);
                btns.style.display = 'none';
            }

            applyHiddenState();
        } catch (e) {
            console.warn('[iOS AI UI patch] failed:', e);
        }
    }
    function startUIMonitor() {
        const mo = new MutationObserver(() => {
            const root = document.getElementById(ROOT_ID);
            if (root) patchUIPanelOnce(root);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        // 最初の適用
        patchUIPanelOnce(document.getElementById(ROOT_ID));
    }

    // ===== ここまでUIパッチ =====

    // iOS用：GM_addStyle 相当の簡易ポリフィル（AI本体が呼ぶことがあるため）
    if (typeof window.GM_addStyle !== 'function') {
        window.GM_addStyle = (css) => {
            try {
                const st = document.createElement('style');
                st.textContent = String(css || '');
                (document.head || document.documentElement).appendChild(st);
                return st;
            } catch { }
        };
    }

    // 取得したコードの実行
    async function runCode(raw, label) {
        const src = String(raw || '');
        // 1st: blob<script> 2nd: eval
        try {
            const blob = new Blob([src + `\n//# sourceURL=${label}`], { type: 'text/javascript' });
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
            console.warn('[AI Loader]', ERR.BLOB_EXEC, e);
            try { eval(src + `\n//# sourceURL=${label}`); return true; }
            catch (ee) { console.error('[AI Loader]', ERR.EVAL_EXEC, ee); showError(ERR.EVAL_EXEC, ee.message); return false; }
        }
    }

    // 実行本体
    (async () => {
        try {
            const lic = license();
            const url = `${AI_CLOUD_URL}?token=${encodeURIComponent(lic)}&ts=${Date.now()}`;

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
            const ok = await runCode(json.code, `omiai-ai-${plan}.js`);
            if (!ok) return;

            // 実行後にUIパッチを静かに適用（初回＆再レンダ両対応）
            startUIMonitor();
            // ほんの少しディレイして初回適用を安定させる
            setTimeout(() => patchUIPanelOnce(document.getElementById(ROOT_ID)), 0);

        } catch (e) {
            showError('E99:想定外', e.message || String(e));
        }
    })();
})();
