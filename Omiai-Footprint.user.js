// ==UserScript==
// @name         Omiai_Footprint
// @namespace    https://footprinter.app/
// @version      1.1.0
// @description  Cloud Functions から Trial/Pro エンジンを取得。Trialに「製品版にする」ボタンを注入。PRO化時は体験版UIを強制撤去＆停止。
// @match        https://www.omiai-jp.com/search*
// @match        https://omiai-jp.com/search*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      omiai-footprint-435226602223.asia-northeast1.run.app
// @connect      *.run.app
// ==/UserScript==

(function () {
  'use strict';
  const ENDPOINT = 'https://omiai-footprint-435226602223.asia-northeast1.run.app';

  const LS_KEY='fw_license_key';
  const loadKey=()=>{try{return localStorage.getItem(LS_KEY)||''}catch{return''}};
  const saveKey=(v)=>{try{localStorage.setItem(LS_KEY,v||'')}catch{}};

  // ===== Utility: TRIAL UI 強制撤去 & 停止フラグ =====
  function cleanupTrialUIAggressive(){
    try{
      // Trialエンジンに「止まって！」と伝えるフラグ
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
      mo.observe(document.documentElement,{childList:true,subtree:true});
      setTimeout(()=>mo.disconnect(), 10000);
    }catch(e){ console.warn('cleanupTrialUI failed', e); }
  }

  // ===== Utility: TRIALパネルに「製品版にする」ボタンを注入 =====
  function ensureUpgradeButtonInTrialPanel(){
    // 既に付いてるなら何もしない
    const panel = document.getElementById('fw-trial-panel');
    if (!panel) return;

    if (panel.querySelector('#fw-trial-upgrade')) return;

    // スタイル（Trialのボタン横に綺麗に並ぶ）
    GM_addStyle(`
      #fw-trial-upgrade{
        margin-left:8px; padding:6px 10px; border:0; border-radius:8px; cursor:pointer;
        background:#fbbf24; color:#000; font:inherit;
      }
    `);

    // 既存のボタン行を探す（Trial実装では flex-end の行がある）
    const row = Array.from(panel.querySelectorAll('div'))
      .find(d => (d.getAttribute('style')||'').includes('justify-content:flex-end')) || panel;

    const btn = document.createElement('button');
    btn.id = 'fw-trial-upgrade';
    btn.textContent = '製品版にする';
    btn.addEventListener('click', () => {
      // ライセンスパネルを開く
      if (typeof window.__FW_openLicensePanel === 'function') {
        window.__FW_openLicensePanel();
      } else {
        alert('ライセンス設定画面を開けませんでした。メニュー「製品版キー入力（パネルを開く）」から開いてください。');
      }
    });
    row.appendChild(btn);
  }

  // Trialパネルの生成を監視して、出てきた瞬間に注入
  function watchTrialPanelForUpgradeButton(){
    ensureUpgradeButtonInTrialPanel(); // もう出ていたら即注入
    const obs = new MutationObserver(() => ensureUpgradeButtonInTrialPanel());
    obs.observe(document.documentElement, { childList:true, subtree:true });
    // 負荷軽減のため1分で監視解除（十分注入済みのはず）
    setTimeout(()=>obs.disconnect(), 60000);
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
  function mountPanel(){
    if(document.getElementById('fw-license-panel')) return;
    const box=document.createElement('div'); box.id='fw-license-panel';
    box.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><b>Footprint ライセンス設定</b><span id="fw-plan-badge" class="muted">–</span></div>
      <div class="row"><label style="min-width:72px">ライセンス</label><input id="fw-key" type="text" placeholder="例: OMIAI-PRO-...." autocomplete="off"/></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">※認証後はページの再読み込みしてください</div>
      <div class="row" style="justify-content:flex-end"><button id="fw-btn-save">キー入力後に押す(保存)</button><button id="fw-btn-fetch">認証する</button><button id="fw-btn-close">閉じる</button></div>
      <div id="fw-lic-status" class="muted"><small>待機中</small></div>
      <div class="muted" style="margin-top:4px"><small>Endpoint: ${ENDPOINT}</small></div>`;
    document.documentElement.appendChild(box);
    const $=(s)=>box.querySelector(s);
    $('#fw-key').value=loadKey();
    const setStatus=(t)=>$('#fw-lic-status').innerHTML=`<small>${t}</small>`;
    const setPlan=(p)=>$('#fw-plan-badge').textContent=p;
    $('#fw-btn-save').addEventListener('click',()=>{ saveKey($('#fw-key').value.trim()); setStatus('キーを保存しました'); });
    $('#fw-btn-fetch').addEventListener('click',()=>fetchAndRun(true,setStatus,setPlan));
    $('#fw-btn-close').addEventListener('click',()=>box.style.display='none');
    window.__FW_openLicensePanel=()=>{ $('#fw-key').value=loadKey(); box.style.display='block'; };
    window.__FW_setPlanBadge=(p)=>setPlan(p);
  }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',mountPanel); } else { mountPanel(); }

  // ===== エンジン実行ラッパ =====
  function execCode(codeText, label){
    // GM_* 簡易ポリフィル
    const shim = `
      (function(){
        if (typeof GM_addStyle === 'undefined') {
          window.GM_addStyle = function(css){ const s=document.createElement('style'); s.textContent=css; document.documentElement.appendChild(s); return s; };
        }
        if (typeof GM_registerMenuCommand === 'undefined') { window.GM_registerMenuCommand = function(){}; }
        if (typeof GM_xmlhttpRequest === 'undefined') { window.GM_xmlhttpRequest = null; }
      })();`;
    const wrapped = `${shim}\n${codeText}\n//# sourceURL=${label||'omiai_engine.js'}`;
    try { (new Function(wrapped))(); return true; }
    catch(e){ console.error('[Engine run error]', e); alert('エンジン実行エラー:\n'+(e && e.message ? e.message : e)); return false; }
  }

  // ===== 取得＆起動 =====
  function fetchAndRun(showAlerts,setStatus=()=>{},setPlan=()=>{}){
    const token=(loadKey()||'').trim();
    const url=`${ENDPOINT}?token=${encodeURIComponent(token)}&ts=${Date.now()}`;
    setStatus(`取得中… (${token?'キーあり':'キーなし'})`);
    GM_xmlhttpRequest({
      method:'GET', url, headers:{'Accept':'application/json'}, timeout:15000,
      onload:(res)=>{
        let data=null;
        try{ data = JSON.parse(res.responseText||'{}'); }
        catch(e){ console.error('JSON parse error:', e, res.responseText); setStatus('エラー: JSON解析失敗'); if(showAlerts) alert('エンジン取得エラー（JSON解析失敗）'); return; }

        if(!data || !data.ok || (!data.code && !data.code_url)){
          console.error('Invalid JSON payload', data);
          setStatus(`エラー: JSON不正 (HTTP ${res.status})`);
          if(showAlerts) alert('エンジン取得エラー（JSON不正）');
          return;
        }
        const plan = (data.plan||data?.meta?.plan||'unknown');
        setPlan(plan); window.__FW_setPlanBadge?.(plan);

        // PROは体験版UIを徹底撤去（実行前）
        if (plan === 'pro') {
          cleanupTrialUIAggressive();
        } else {
          // TRIAL なら「製品版にする」ボタンを注入
          watchTrialPanelForUpgradeButton();
        }

        const run = (codeStr)=> {
          const ok = execCode(codeStr, plan==='pro'?'omiai_pro.js':'omiai_trial.js');
          setStatus(ok?'実行完了':'実行エラー');
        };

        if (data.code_url){
          GM_xmlhttpRequest({
            method:'GET', url:data.code_url, timeout:15000,
            onload:(r2)=> run(r2.responseText),
            onerror:()=>{ setStatus('コードURL取得失敗'); if(showAlerts) alert('コードURL取得失敗'); },
            ontimeout:()=>{ setStatus('コードURL取得タイムアウト'); if(showAlerts) alert('コードURL取得タイムアウト'); },
          });
        } else {
          run(data.code);
        }
      },
      onerror:()=>{ setStatus('接続失敗'); if(showAlerts) alert('接続失敗：@connect と公開設定を確認'); },
      ontimeout:()=>{ setStatus('タイムアウト'); if(showAlerts) alert('取得タイムアウト'); }
    });
  }

  // 初回サイレント取得
  fetchAndRun(false);

  // メニュー
  if(typeof GM_registerMenuCommand==='function'){
    GM_registerMenuCommand('製品版キー入力（パネルを開く）', ()=> window.__FW_openLicensePanel?.());
    GM_registerMenuCommand('エンジン再取得（キー送信）', ()=> fetchAndRun(true));
  }
})();
