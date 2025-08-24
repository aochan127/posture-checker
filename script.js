/* posture-checker FULL (2025-08-24b)
   ✅ DOMContentLoaded 待ち & グローバルエラーログ
   ✅ 安全ローダ: HEIC/PNG/巨大JPEG → ダウンサンプルしてJPEG正規化（4096px/20MPガード）
   ✅ EXIF依存を基本撤廃（正規化で向き安定）＋手動回転（左/右90°）
   ✅ レターボックスFit / 高DPR
   ✅ 手動5点: ①耳(赤) ②肩峰(橙) ③大転子(黄) ④膝(青) ⑤外果(緑)
   ✅ ドラッグ編集 / 拡大鏡(長押し) / Undo・Redo
   ✅ プラムライン: 中央/表示切替/外果±オフセット/数値入力
   ✅ MoveNet(TFJS, ローカルモデル)で自動抽出 + サイド自動判定 + 手動切替
   ✅ 5分類: Ideal / Kypho-lordotic / Lordotic / Flat-back / Sway-back（しきい値UIで微調整）
   ✅ mm換算: 身長法 & 物差し法
   依存: vendor/tf.min.js → vendor/pose-detection.min.js → script.js
   モデル: ./models/movenet/model.json
*/

/* ====== グローバルエラーを画面ログへ ====== */
window.addEventListener('error', e=>{
  const msg = `[ERROR] ${e.message} @ ${e.filename}:${e.lineno}`;
  console.error(msg, e.error);
  const box=document.getElementById('log'); if(box){ box.value+=(box.value?'\n':'')+msg; box.scrollTop=box.scrollHeight; }
});
window.addEventListener('unhandledrejection', e=>{
  const msg = `[PromiseRejection] ${e.reason?.message||e.reason}`;
  console.error(msg);
  const box=document.getElementById('log'); if(box){ box.value+=(box.value?'\n':'')+msg; box.scrollTop=box.scrollHeight; }
});

/* ====== DOM 準備後に init ====== */
(function bootstrap(){
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();

function init(){
  // --- DOM参照 ---
  const canvas = document.getElementById('canvas');
  const ctx    = canvas.getContext('2d');

  const fileInput = document.getElementById('fileInput');
  const aiBtn     = document.getElementById('aiBtn');
  const clearBtn  = document.getElementById('clearBtn');
  const sideSelect= document.getElementById('sideSelect');

  const plumbXInput     = document.getElementById('plumbX');
  const centerPlumbBtn  = document.getElementById('centerPlumbBtn');
  const togglePlumb     = document.getElementById('togglePlumb');
  const plumbOffset     = document.getElementById('plumbOffset');
  const plumbAtAnkleBtn = document.getElementById('plumbAtAnkleBtn');

  const metricsDiv = document.getElementById('metrics');
  const classDiv   = document.getElementById('classification');
  const classDefEl = document.getElementById('classDef');
  const logEl      = document.getElementById('log');

  // しきい値UI
  const thrFhaIdeal   = document.getElementById('thrFhaIdeal');
  const thrFhaFwd     = document.getElementById('thrFhaFwd');
  const thrHipNeutral = document.getElementById('thrHipNeutral');
  const thrHipFwd     = document.getElementById('thrHipFwd');
  const thrHipBwd     = document.getElementById('thrHipBwd');
  const thrKneeBack   = document.getElementById('thrKneeBack');
  const vFhaIdeal     = document.getElementById('vFhaIdeal');
  const vFhaFwd       = document.getElementById('vFhaFwd');
  const vHipNeutral   = document.getElementById('vHipNeutral');
  const vHipFwd       = document.getElementById('vHipFwd');
  const vHipBwd       = document.getElementById('vHipBwd');
  const vKneeBack     = document.getElementById('vKneeBack');
  const thrReset      = document.getElementById('thrReset');

  // Undo/Redo
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');

  // mm換算
  const scaleHeightCm = document.getElementById('scaleHeightCm');
  const scaleBodyPix  = document.getElementById('scaleBodyPix');
  const scaleRefPx    = document.getElementById('scaleRefPx');
  const scaleRefMm    = document.getElementById('scaleRefMm');

  // --- 状態 ---
  let img = new Image();
  let imgDataURL = null;
  let imgLoaded = false;

  // 5点: 0耳,1肩,2大転子,3膝,4外果
  let points = [null,null,null,null,null];
  let pointSources = [null,null,null,null,null]; // 'manual' or 'auto'
  let currentEdit = 0;

  // プラムライン
  let plumbX = 0;
  let showPlumb = true;

  // mm換算
  let PX_PER_MM = null;

  // 描画
  const COLORS=["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"];
  const RADIUS=7, FONT_SIZE=13;

  // レターボックスFit
  let imgFit = { dx:0,dy:0,dw:0,dh:0,iw:0,ih:0,sx:1,sy:1 };

  // Magnifier
  let magnifier={active:false,x:0,y:0,scale:2.0,r:60,timer:null};

  // Drag
  let drag={idx:-1,active:false};

  // Undo/Redo
  const history=[], future=[];

  // AI
  let detector=null, lastDet=null, lastSide='auto', lastAnteriorSign=1;

  // しきい値
  const THR = { FHA_IDEAL_MAX:12, FHA_FORWARD_HD:20, HIP_IDEAL_ABS:10, HIP_FWD:10, HIP_BWD:-10, KNEE_BACK:-5 };
  const EXTRA = { LORD_FHA_MAX:18, KNEE_NEAR_BACK:-6 };

  // --- ユーティリティ ---
  function log(m){ if(!logEl) return; logEl.value+=(logEl.value?'\n':'')+m; logEl.scrollTop=logEl.scrollHeight; }
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function snapshot(){ history.push(JSON.stringify({points,plumbX})); if(history.length>100) history.shift(); future.length=0; }
  function restore(s){ try{ const st=JSON.parse(s); points=st.points.map(p=>p?{x:p.x,y:p.y}:p); plumbX=st.plumbX||0; requestDraw(); compute(); }catch(e){ log('Undo失敗:'+e); } }

  function setupCanvasDPR(){
    const dpr=window.devicePixelRatio||1, r=canvas.getBoundingClientRect();
    canvas.width=Math.round(r.width*dpr); canvas.height=Math.round(r.height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  function updateImageFit(){
    const r=canvas.getBoundingClientRect(), iw=img.naturalWidth||r.width, ih=img.naturalHeight||r.height;
    const s=Math.min(r.width/iw,r.height/ih), dw=Math.round(iw*s), dh=Math.round(ih*s);
    const dx=Math.round((r.width-dw)/2), dy=Math.round((r.height-dh)/2);
    imgFit={dx,dy,dw,dh,iw,ih,sx:dw/iw,sy:dh/ih};
  }

  let drawQueued=false;
  function requestDraw(){ if(drawQueued) return; drawQueued=true; requestAnimationFrame(()=>{drawQueued=false; draw();}); }

  function draw(){
    const r=canvas.getBoundingClientRect();
    ctx.clearRect(0,0,r.width,r.height);
    if(imgLoaded) ctx.drawImage(img,imgFit.dx,imgFit.dy,imgFit.dw,imgFit.dh);

    if(showPlumb && plumbX>0){
      ctx.save(); ctx.strokeStyle="rgba(30,41,59,.95)"; ctx.setLineDash([8,6]); ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(plumbX,0); ctx.lineTo(plumbX,r.height); ctx.stroke(); ctx.restore();
    }

    // 接続線
    ctx.save(); ctx.strokeStyle="rgba(239,68,68,.85)"; ctx.lineWidth=3;
    ctx.beginPath();
    let started=false;
    for(let i=0;i<points.length;i++){
      const p=points[i]; if(!p) continue;
      if(!started){ ctx.moveTo(p.x,p.y); started=true; } else ctx.lineTo(p.x,p.y);
    }
    if(started) ctx.stroke(); ctx.restore();

    // ノード
    points.forEach((p,i)=>{
      if(!p) return;
      ctx.save();
      ctx.beginPath(); ctx.fillStyle=COLORS[i]; ctx.arc(p.x,p.y,RADIUS,0,2*Math.PI); ctx.fill();
      ctx.font=`bold ${FONT_SIZE}px system-ui,-apple-system,Segoe UI,Noto Sans JP,sans-serif`;
      ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.lineWidth=3; ctx.strokeStyle="rgba(0,0,0,.9)";
      const label=String(i+1); ctx.strokeText(label,p.x,p.y); ctx.fillStyle="#fff"; ctx.fillText(label,p.x,p.y);
      ctx.restore();
    });

    // magnifier
    if(magnifier.active){
      const r0=magnifier.r; ctx.save(); ctx.beginPath(); ctx.arc(magnifier.x,magnifier.y,r0,0,2*Math.PI); ctx.clip();
      ctx.save(); ctx.translate(magnifier.x,magnifier.y); ctx.scale(magnifier.scale,magnifier.scale); ctx.translate(-magnifier.x,-magnifier.y);
      ctx.drawImage(canvas,0,0); ctx.restore();
      ctx.lineWidth=2; ctx.strokeStyle="rgba(0,0,0,.6)";
      ctx.beginPath(); ctx.arc(magnifier.x,magnifier.y,r0,0,2*Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(magnifier.x-r0,magnifier.y); ctx.lineTo(magnifier.x+r0,magnifier.y);
      ctx.moveTo(magnifier.x,magnifier.y-r0); ctx.lineTo(magnifier.x,magnifier.y+r0); ctx.stroke(); ctx.restore();
    }
  }

  // ===== しきい値UI =====
  function bindThresholdControls(){
    if(!thrFhaIdeal) return;
    const sync=()=>{
      vFhaIdeal&&(vFhaIdeal.textContent=THR.FHA_IDEAL_MAX);
      vFhaFwd&&(vFhaFwd.textContent=THR.FHA_FORWARD_HD);
      vHipNeutral&&(vHipNeutral.textContent=THR.HIP_IDEAL_ABS);
      vHipFwd&&(vHipFwd.textContent=THR.HIP_FWD);
      vHipBwd&&(vHipBwd.textContent=THR.HIP_BWD);
      vKneeBack&&(vKneeBack.textContent=THR.KNEE_BACK);
    };
    thrFhaIdeal.value=THR.FHA_IDEAL_MAX;
    thrFhaFwd.value=THR.FHA_FORWARD_HD;
    thrHipNeutral.value=THR.HIP_IDEAL_ABS;
    thrHipFwd.value=THR.HIP_FWD;
    thrHipBwd.value=THR.HIP_BWD;
    thrKneeBack.value=THR.KNEE_BACK;
    sync();
    const hook=(el,key)=> el.addEventListener('input',()=>{ THR[key]=Number(el.value); if(key==='HIP_IDEAL_ABS') THR[key]=Math.abs(THR[key]); sync(); compute(); });
    hook(thrFhaIdeal,'FHA_IDEAL_MAX'); hook(thrFhaFwd,'FHA_FORWARD_HD'); hook(thrHipNeutral,'HIP_IDEAL_ABS');
    hook(thrHipFwd,'HIP_FWD'); hook(thrHipBwd,'HIP_BWD'); hook(thrKneeBack,'KNEE_BACK');
    thrReset?.addEventListener('click',()=>{ THR.FHA_IDEAL_MAX=12; THR.FHA_FORWARD_HD=20; THR.HIP_IDEAL_ABS=10; THR.HIP_FWD=10; THR.HIP_BWD=-10; THR.KNEE_BACK=-5;
      thrFhaIdeal.value=12; thrFhaFwd.value=20; thrHipNeutral.value=10; thrHipFwd.value=10; thrHipBwd.value=-10; thrKneeBack.value=-5; sync(); compute(); });
  }

  // ===== mm換算 =====
  function recomputeScale(){
    const refPx=Number(scaleRefPx?.value||NaN), refMm=Number(scaleRefMm?.value||NaN);
    if(!isNaN(refPx)&&refPx>0&&!isNaN(refMm)&&refMm>0){ PX_PER_MM=refPx/refMm; return; }
    const hCm=Number(scaleHeightCm?.value||NaN), bodyPix=Number(scaleBodyPix?.value||NaN);
    if(!isNaN(hCm)&&hCm>0&&!isNaN(bodyPix)&&bodyPix>0){ PX_PER_MM=bodyPix/(hCm*10); return; }
    PX_PER_MM=null;
  }
  [scaleRefPx,scaleRefMm,scaleHeightCm,scaleBodyPix].forEach(el=>el?.addEventListener('change',()=>{recomputeScale(); compute();}));
  const pxToMm = px => PX_PER_MM? (px/PX_PER_MM):null;

  // ===== 計測&分類 =====
  function compute(){
    if(points.filter(Boolean).length<5 || plumbX<=0){
      metricsDiv&&(metricsDiv.innerHTML="<p>5点と鉛直線を設定してください。</p>");
      classDiv&&(classDiv.innerHTML=""); classDefEl&&(classDefEl.innerHTML=""); return;
    }
    const [ear,shoulder,hip,knee]=points;
    const angleDeg=Math.atan2(ear.y-shoulder.y, ear.x-shoulder.x)*180/Math.PI;
    const FHA=Math.abs(90-Math.abs(angleDeg));
    const hipOffsetPx=hip.x-plumbX, kneeOffsetPx=knee.x-plumbX;

    let type="判定不可";
    if (Math.abs(hipOffsetPx)<=THR.HIP_IDEAL_ABS && FHA<=THR.FHA_IDEAL_MAX) type="Ideal";
    else if (FHA>THR.FHA_FORWARD_HD && hipOffsetPx>=THR.HIP_FWD) type="Kyphotic-lordotic";
    else if (FHA<=EXTRA.LORD_FHA_MAX && hipOffsetPx>=THR.HIP_FWD && kneeOffsetPx>=EXTRA.KNEE_NEAR_BACK) type="Lordotic";
    else if (hipOffsetPx<=THR.HIP_BWD && kneeOffsetPx<=THR.KNEE_BACK) type="Sway-back";
    else if (FHA<10 && hipOffsetPx<THR.HIP_FWD) type="Flat-back";
    else type = (kneeOffsetPx<=0)? "Sway-back" : "Flat-back";

    const showMm=v=>v!=null?` (${v.toFixed(1)} mm)`:``;
    metricsDiv&&(metricsDiv.innerHTML=`
      <p><b>FHA角度</b>: ${FHA.toFixed(1)}°</p>
      <p><b>大転子オフセット</b>: ${hipOffsetPx.toFixed(0)} px${showMm(pxToMm(hipOffsetPx))}</p>
      <p><b>膝オフセット</b>: ${kneeOffsetPx.toFixed(0)} px${showMm(pxToMm(kneeOffsetPx))}</p>
    `);
    classDiv&&(classDiv.innerHTML=`<p><b>${type}</b></p>`);
    const defs={
      "Ideal":`耳・肩峰・大転子・膝が鉛直線近傍。FHA≲${THR.FHA_IDEAL_MAX}°、大転子±${THR.HIP_IDEAL_ABS}px以内。`,
      "Kyphotic-lordotic":`胸椎後弯↑＋腰椎前弯↑、骨盤前傾。FHA>${THR.FHA_FORWARD_HD}° かつ大転子が前方（+${THR.HIP_FWD}px以上）。`,
      "Lordotic":`腰椎前弯↑優位。FHA≲${EXTRA.LORD_FHA_MAX}°、大転子は前方、膝は中立〜前方寄り。`,
      "Flat-back":"胸椎後弯↓・腰椎前弯↓、骨盤後傾。FHA<10°で平坦、中立〜やや後方。",
      "Sway-back":`骨盤後傾＋股伸展で体幹後方。大転子が線より後（${THR.HIP_BWD}px以下）、膝も後方（${THR.KNEE_BACK}px以下）。`
    };
    classDefEl&&(classDefEl.innerHTML=defs[type]||"");
  }

  // ===== 入力: 安全ローダ（HEIC/巨大対応） =====
  async function handleFile(file){
    const url=URL.createObjectURL(file);
    try{
      const im=await new Promise((res,rej)=>{ const t=new Image(); t.onload=()=>res(t); t.onerror=()=>rej(new Error("decode失敗")); t.src=url; });
      const iw=im.naturalWidth||im.width, ih=im.naturalHeight||im.height;
      const MAX_SIDE=4096, MAX_PIXELS=20_000_000;
      let outW=iw, outH=ih;
      if(Math.max(iw,ih)>MAX_SIDE || iw*ih>MAX_PIXELS){
        const ratio=Math.min(MAX_SIDE/Math.max(iw,ih), Math.sqrt(MAX_PIXELS/(iw*ih)));
        outW=Math.max(1,Math.round(iw*ratio)); outH=Math.max(1,Math.round(ih*ratio));
      }
      const off=document.createElement('canvas'); off.width=outW; off.height=outH;
      const c=off.getContext('2d'); c.imageSmoothingEnabled=true; c.imageSmoothingQuality='high';
      c.fillStyle='#fff'; c.fillRect(0,0,outW,outH);
      c.drawImage(im,0,0,outW,outH);
      const dataURL=off.toDataURL('image/jpeg',0.95);
      handleDataURL(dataURL);
      log(`画像読込OK (${iw}x${ih}→${outW}x${outH})`);
    }catch(e){
      log(`⚠️ handleFile失敗: ${e?.message||e}`);
    }finally{ URL.revokeObjectURL(url); }
  }
  function handleDataURL(dataURL){
    imgDataURL=dataURL; img=new Image(); img.decoding='async';
    img.onload=()=>{
      imgLoaded=true; imgFit.iw=img.naturalWidth||img.width; imgFit.ih=img.naturalHeight||img.height;
      setupCanvasDPR(); updateImageFit();
      points=[null,null,null,null,null]; pointSources=['','','','',''];
      aiBtn && (aiBtn.disabled=false); requestDraw(); log(`画像 onload 完了 (${imgFit.iw}x${imgFit.ih})`);
      recomputeScale();
    };
    img.onerror=()=>log('⚠️ 画像読み込み失敗');
    img.src=dataURL; img.decode?.().catch(()=>{});
  }

  // ===== 入力イベント =====
  fileInput?.addEventListener('change',e=>{ const f=e.target.files?.[0]; if(f) handleFile(f); });
  function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
  ['dragenter','dragover','dragleave','drop'].forEach(ev=>{
    document.addEventListener(ev,preventDefaults,false); canvas.addEventListener(ev,preventDefaults,false);
  });
  document.addEventListener('drop', e=>{
    const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith('image/')); if(f) handleFile(f);
  });
  document.addEventListener('paste', e=>{
    const items=e.clipboardData?.items||[]; for(const it of items){ if(it.type?.startsWith('image/')){ const f=it.getAsFile(); if(f){ handleFile(f); return; } } }
  });

  // ===== 手動回転 =====
  function rotate(dir){ if(!imgDataURL) return;
    const src=new Image(); src.onload=()=>{
      const w=src.naturalWidth||src.width, h=src.naturalHeight||src.height;
      const off=document.createElement('canvas'); off.width=h; off.height=w; const c=off.getContext('2d');
      c.fillStyle='#fff'; c.fillRect(0,0,off.width,off.height);
      if(dir>0){ c.translate(h,0); c.rotate(Math.PI/2); } else { c.translate(0,w); c.rotate(-Math.PI/2); }
      c.drawImage(src,0,0); handleDataURL(off.toDataURL('image/jpeg',0.95)); log(`回転${dir>0?'右':'左'}90°`);
    }; src.src=imgDataURL;
  }
  document.getElementById('rotateL')?.addEventListener('click',()=>rotate(-1));
  document.getElementById('rotateR')?.addEventListener('click',()=>rotate(+1));
  // 無ければ自動生成
  (function ensureRotateButtons(){
    const l=document.getElementById('rotateL'), r=document.getElementById('rotateR');
    if(l&&r) return; const wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.gap='6px'; wrap.style.margin='6px 0';
    const bl=document.createElement('button'); bl.id='rotateL'; bl.textContent='⟲ 左90°';
    const br=document.createElement('button'); br.id='rotateR'; br.textContent='⟳ 右90°';
    wrap.append(bl,br); (canvas.parentElement||document.body).insertBefore(wrap,canvas);
    bl.addEventListener('click',()=>rotate(-1)); br.addEventListener('click',()=>rotate(+1));
  })();

  // ===== 手動プロット/ドラッグ =====
  document.querySelectorAll('input[name="lm"]').forEach(r=>r.addEventListener('change',()=> currentEdit=Number(r.value||0)));
  function getCanvasPoint(evt){
    if(typeof evt.offsetX==='number' && evt.target===canvas){
      const r=canvas.getBoundingClientRect(); return {x:clamp(evt.offsetX,0,r.width), y:clamp(evt.offsetY,0,r.height)};
    }
    const r=canvas.getBoundingClientRect(); const t=evt.touches?.[0]||evt.changedTouches?.[0]||evt;
    return { x:clamp(t.clientX-r.left,0,r.width), y:clamp(t.clientY-r.top,0,r.height) };
  }
  function clampToImageRect(p){ return { x:clamp(p.x, imgFit.dx, imgFit.dx+imgFit.dw), y:clamp(p.y, imgFit.dy, imgFit.dy+imgFit.dh) }; }
  function hitTest(pt){ const H=Math.max(RADIUS*1.8,16); let best={idx:-1,d2:1e9}; points.forEach((p,i)=>{ if(!p) return; const dx=p.x-pt.x,dy=p.y-pt.y,d2=dx*dx+dy*dy; if(d2<best.d2 && d2<=H*H) best={idx:i,d2};}); return best.idx; }
  function startMagnifier(x,y){ magnifier.x=x; magnifier.y=y; magnifier.active=true; requestDraw(); }
  function stopMagnifier(){ magnifier.active=false; requestDraw(); }

  canvas.addEventListener('pointerdown', e=>{
    e.preventDefault(); if(!imgLoaded) return;
    let p=getCanvasPoint(e); p=clampToImageRect(p); const hit=hitTest(p);
    magnifier.timer && clearTimeout(magnifier.timer); magnifier.timer=setTimeout(()=>startMagnifier(p.x,p.y),350);
    snapshot();
    if(hit>=0){ drag.idx=hit; drag.active=true; currentEdit=hit; }
    else{ points[currentEdit]=p; pointSources[currentEdit]='manual'; if(currentEdit===4) setPlumbFromAnkle(); requestDraw(); compute(); }
  }, {passive:false});
  canvas.addEventListener('pointermove', e=>{
    if(!imgLoaded) return; let p=getCanvasPoint(e); p=clampToImageRect(p);
    if(magnifier.active){ magnifier.x=p.x; magnifier.y=p.y; requestDraw(); }
    if(!drag.active) return; points[drag.idx]=p; pointSources[drag.idx]='manual'; if(drag.idx===4) setPlumbFromAnkle(); requestDraw(); compute();
  });
  function endPointer(){ magnifier.timer&&clearTimeout(magnifier.timer); if(magnifier.active) stopMagnifier(); if(drag.active){ drag.active=false; drag.idx=-1; } }
  canvas.addEventListener('pointerup',endPointer); canvas.addEventListener('pointercancel',endPointer); canvas.addEventListener('pointerleave',endPointer);

  // Undo/Redo
  undoBtn?.addEventListener('click',()=>{ if(!history.length){ log('⚠️ Undoなし'); return; } future.push(JSON.stringify({points,plumbX})); restore(history.pop()); });
  redoBtn?.addEventListener('click',()=>{ if(!future.length){ log('⚠️ Redoなし'); return; } history.push(JSON.stringify({points,plumbX})); restore(future.pop()); });

  // ===== プラムライン =====
  plumbXInput?.addEventListener('change',()=>{ const r=canvas.getBoundingClientRect(); plumbX=clamp(Number(plumbXInput.value||0),0,r.width); snapshot(); requestDraw(); compute(); });
  centerPlumbBtn?.addEventListener('click',()=>{ const r=canvas.getBoundingClientRect(); snapshot(); plumbX=Math.round(r.width/2); plumbXInput&&(plumbXInput.value=plumbX); requestDraw(); compute(); });
  togglePlumb?.addEventListener('change',()=>{ showPlumb=togglePlumb.checked; requestDraw(); });
  plumbAtAnkleBtn?.addEventListener('click',()=>{ snapshot(); setPlumbFromAnkle(); });
  plumbOffset?.addEventListener('change',()=>{ if(points[4]){ snapshot(); setPlumbFromAnkle(); } });

  function setPlumbFromAnkle(){
    const ankle=points[4], knee=points[3]; if(!ankle||!knee){ log('⚠️ 外果(5)と膝(4)を先に'); return; }
    const r=canvas.getBoundingClientRect(); const offsetAbs=Math.abs(Number(plumbOffset?.value ?? 10));
    const anteriorSign=Math.sign(knee.x-ankle.x)||1; plumbX=clamp(ankle.x+anteriorSign*offsetAbs,0,r.width);
    plumbXInput&&(plumbXInput.value=Math.round(plumbX)); requestDraw(); compute(); lastAnteriorSign=anteriorSign;
    log(`鉛直線=外果±${offsetAbs}px（前方 sign=${anteriorSign}）`);
  }

  // ===== リセット =====
  clearBtn?.addEventListener('click',()=>{
    points=[null,null,null,null,null]; pointSources=['','','','','']; imgLoaded=false; imgDataURL=null; lastDet=null; detector=null;
    plumbX=0; plumbXInput&&(plumbXInput.value=0); aiBtn&&(aiBtn.disabled=true);
    metricsDiv&&(metricsDiv.innerHTML=""); classDiv&&(classDiv.innerHTML=""); classDefEl&&(classDefEl.innerHTML="");
    requestDraw(); log('リセットしました。');
  });

  // ===== リサイズ =====
  let resizeTimer=null;
  window.addEventListener('resize', ()=>{
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{
      if(!imgLoaded){ setupCanvasDPR(); updateImageFit(); requestDraw(); return; }
      const dpr=window.devicePixelRatio||1, oldW=canvas.width/dpr, oldH=canvas.height/dpr, r=canvas.getBoundingClientRect();
      const rx=oldW? r.width/oldW : 1, ry=oldH? r.height/oldH : 1;
      points=points.map(p=>p?{x:p.x*rx,y:p.y*ry}:p); plumbX*=rx; setupCanvasDPR(); updateImageFit();
      if(points[4]&&points[3]) setPlumbFromAnkle(); requestDraw(); compute();
    }, 120);
  });

  // ===== AI MoveNet =====
  function vendorsOK(){ const ok=!!(window.tf&&window.poseDetection); if(!window.tf) log("⚠️ tf.min.js 未読込"); if(!window.poseDetection) log("⚠️ pose-detection.min.js 未読込"); return ok; }
  async function ensureDetector(){
    if(detector) return detector; if(!vendorsOK()) return null;
    try{
      try{ await tf.setBackend('webgl'); }catch{} await tf.ready();
      if(tf.getBackend()!=='webgl'){ await tf.setBackend('cpu'); await tf.ready(); }
      log('TFJS backend: '+tf.getBackend());
      const mt=(poseDetection.movenet?.modelType?.SINGLEPOSE_LIGHTNING)||'SINGLEPOSE_LIGHTNING';
      detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet,
        { runtime:'tfjs', modelType:mt, modelUrl:'./models/movenet/model.json', enableSmoothing:true });
      log('MoveNet 初期化OK'); return detector;
    }catch(e){ log('Detector初期化エラー: '+(e?.message||e)); return null; }
  }
  function avgScore(kps,names){ let s=0,c=0; for(const n of names){ const kp=kps.find(x=>x.name===n); if(kp?.score!=null){ s+=kp.score; c++; } } return c? s/c:0; }
  function plausibilityScore(kps,names){
    const pick=n=>kps.find(k=>k.name===n), pts=names.map(n=>pick(n)); if(pts.some(p=>!p)) return -1e9;
    let penalty=0; for(let i=0;i<pts.length-1;i++){ if(pts[i].y>=pts[i+1].y) penalty+=1; }
    const ankleY=pts[4].y, maxY=Math.max(...pts.map(p=>p.y)); const ankleBonus=(ankleY===maxY)?1.0:0;
    const kneeAhead=(Math.abs(pts[3].x-pts[4].x)>2)?0.3:0;
    const conf=pts.reduce((s,p)=>s+(p.score||0),0)/pts.length;
    return 0.7*conf + ankleBonus - 0.5*penalty + kneeAhead;
  }
  async function runAutoDetect(){
    if(!imgLoaded||!imgDataURL){ log('⚠️ 先に画像を読み込んでください。'); return; }
    const det=await ensureDetector(); if(!det){ log('⚠️ Detector用意失敗'); return; }
    const tmp=new Image(); tmp.onload=async ()=>{
      try{
        const res=await det.estimatePoses(tmp,{flipHorizontal:false});
        const kps=res?.[0]?.keypoints; if(!kps){ log('⚠️ 検出0件'); return; }
        lastDet={kps, iw:tmp.naturalWidth||tmp.width, ih:tmp.naturalHeight||tmp.height}; applySideAndUpdate();
      }catch(e){ log('検出エラー: '+(e?.message||e)); }
    }; tmp.onerror=()=>log('⚠️ 画像再ロード失敗'); tmp.src=imgDataURL;
  }
  function applySideAndUpdate(){
    if(!lastDet){ log('⚠️ 検出キャッシュなし'); return; }
    const {kps}=lastDet, L=['left_ear','left_shoulder','left_hip','left_knee','left_ankle'], R=['right_ear','right_shoulder','right_hip','right_knee','right_ankle'];
    const sL=plausibilityScore(kps,L), sR=plausibilityScore(kps,R);
    let autoSide = (sR>sL ? 'right' : (sL>sR ? 'left' : (avgScore(kps,R)>avgScore(kps,L)?'right':'left')));
    const pref=sideSelect?.value||'auto', side=(pref==='auto')?autoSide:pref; lastSide=side;
    const names=(side==='right')?R:L, pickName=n=>kps.find(x=>x.name===n);
    const ear=pickName(names[0]), sh=pickName(names[1]), hip=pickName(names[2]), knee=pickName(names[3]), ankle=pickName(names[4]);
    if(!(ear&&sh&&hip&&knee&&ankle)){ log('⚠️ 必須ランドマーク不足'); return; }
    const r=canvas.getBoundingClientRect();
    const toCanvas=kp=>({ x:clamp(imgFit.dx + kp.x*imgFit.sx, 0, r.width), y:clamp(imgFit.dy + kp.y*imgFit.sy, 0, r.height) });
    points=[ear,sh,hip,knee,ankle].map(toCanvas); pointSources=['auto','auto','auto','auto','auto'];
    setPlumbFromAnkle(); requestDraw(); compute(); log(`AI検出完了 side=${side} (sL=${sL.toFixed(2)}, sR=${sR.toFixed(2)})`);
  }
  sideSelect?.addEventListener('change',()=>{ if(lastDet) applySideAndUpdate(); });
  aiBtn?.addEventListener('click',()=>{ log('AI自動抽出 開始'); runAutoDetect(); });

  // ===== 初期化 =====
  bindThresholdControls(); setupCanvasDPR(); updateImageFit(); requestDraw();
  log('✅ init 完了：ファイル選択・D&D・ペースト・回転・AI(読込後) ready');
}
