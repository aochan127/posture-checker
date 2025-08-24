/* Posture Checker – ULTRA ROBUST + Side Override + Anterior Auto + Threshold UI
   - tf.min.js / pose-detection.min.js を先に読み込む
   - モデルは ./models/movenet/model.json（tfjs）を想定
*/

(() => {
  // ===== DOM =====
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const aiBtn = document.getElementById('aiBtn');
  const clearBtn = document.getElementById('clearBtn');
  const plumbXInput = document.getElementById('plumbX');
  const centerPlumbBtn = document.getElementById('centerPlumbBtn');
  const togglePlumb = document.getElementById('togglePlumb');
  const sideSelect = document.getElementById('sideSelect'); // "auto"|"left"|"right"
  const metricsDiv = document.getElementById('metrics');
  const classDiv   = document.getElementById('classification');
  const logEl      = document.getElementById('log');

  // 外果基準ライン UI（無くてもOK）
  const plumbOffset     = document.getElementById('plumbOffset');     // number
  const plumbAtAnkleBtn = document.getElementById('plumbAtAnkleBtn'); // button

  // しきい値 UI（無くてもOK）
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

  // ===== State =====
  let img = new Image();
  let imgLoaded = false;
  let imgDataURL = null;
  let points = [null,null,null,null,null]; // 0耳,1肩,2大転子,3膝,4外果
  let currentEdit = 0;
  let plumbX = 0;
  let showPlumb = true;
  let detector = null;

  // AI検出キャッシュ（サイド切替で再利用）
  let lastDet = null; // {kps, iw, ih}

  const COLORS = ["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"];
  const RADIUS = 9;

  // ===== Helpers =====
  function log(msg){
    try{
      if (logEl && 'value' in logEl) {
        logEl.value += (logEl.value? "\n":"") + msg;
        logEl.scrollTop = logEl.scrollHeight;
      } else if (logEl) {
        logEl.textContent += (logEl.textContent? "\n":"") + msg;
        logEl.scrollTop = logEl.scrollHeight;
      }
    }catch{}
    console.log(msg);
  }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  function setupCanvasDPR(){
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  function getCanvasPoint(evt){
    if (typeof evt.offsetX === 'number' && evt.target === canvas){
      const rect = canvas.getBoundingClientRect();
      return { x: clamp(evt.offsetX, 0, rect.width),
               y: clamp(evt.offsetY, 0, rect.height) };
    }
    const rect = canvas.getBoundingClientRect();
    let cx, cy;
    if (evt.touches?.[0])            { cx = evt.touches[0].clientX;       cy = evt.touches[0].clientY; }
    else if (evt.changedTouches?.[0]){ cx = evt.changedTouches[0].clientX; cy = evt.changedTouches[0].clientY; }
    else                             { cx = evt.clientX;                   cy = evt.clientY; }
    return { x: clamp(cx-rect.left,0,rect.width), y: clamp(cy-rect.top,0,rect.height) };
  }

  // ===== Draw =====
  function draw(){
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0,0,rect.width,rect.height);
    if (imgLoaded) ctx.drawImage(img, 0, 0, rect.width, rect.height);

    // plumb
    if (showPlumb && plumbX>0){
      ctx.save();
      ctx.strokeStyle = "rgba(30,41,59,.95)";
      ctx.setLineDash([8,6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(plumbX, 0);
      ctx.lineTo(plumbX, rect.height);
      ctx.stroke();
      ctx.restore();
    }

    // connection
    ctx.save();
    ctx.strokeStyle = "rgba(239,68,68,.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    let started=false;
    for (let i=0;i<points.length;i++){
      const p = points[i];
      if (!p) continue;
      if (!started){ ctx.moveTo(p.x,p.y); started=true; }
      else ctx.lineTo(p.x,p.y);
    }
    if (started) ctx.stroke();
    ctx.restore();

    // nodes
    points.forEach((p,i)=>{
      if (!p) return;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = COLORS[i];
      ctx.arc(p.x,p.y,RADIUS,0,Math.PI*2);
      ctx.fill();
      ctx.font = "bold 13px system-ui,-apple-system,Segoe UI,Noto Sans JP,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,.9)";
      const label = String(i+1);
      ctx.strokeText(label,p.x,p.y);
      ctx.fillStyle = "#fff";
      ctx.fillText(label,p.x,p.y);
      ctx.restore();
    });
  }

  // ===== Thresholds (clinical tunable) =====
  const THR = {
    FHA_IDEAL_MAX: 12,
    FHA_FORWARD_HD: 20,
    HIP_IDEAL_ABS: 10,
    HIP_FWD: 10,
    HIP_BWD: -10,
    KNEE_BACK: -5
  };

  function bindThresholdControls(){
    if (!thrFhaIdeal) return; // パネルがないページも動く
    const sync = ()=>{
      if (vFhaIdeal)   vFhaIdeal.textContent   = THR.FHA_IDEAL_MAX;
      if (vFhaFwd)     vFhaFwd.textContent     = THR.FHA_FORWARD_HD;
      if (vHipNeutral) vHipNeutral.textContent = THR.HIP_IDEAL_ABS;
      if (vHipFwd)     vHipFwd.textContent     = THR.HIP_FWD;
      if (vHipBwd)     vHipBwd.textContent     = THR.HIP_BWD;
      if (vKneeBack)   vKneeBack.textContent   = THR.KNEE_BACK;
    };
    thrFhaIdeal.value   = THR.FHA_IDEAL_MAX;
    thrFhaFwd.value     = THR.FHA_FORWARD_HD;
    thrHipNeutral.value = THR.HIP_IDEAL_ABS;
    thrHipFwd.value     = THR.HIP_FWD;
    thrHipBwd.value     = THR.HIP_BWD;
    thrKneeBack.value   = THR.KNEE_BACK;
    sync();
    const hook = (el,key,cast=Number)=> el.addEventListener('input',()=>{
      THR[key] = cast(el.value);
      if (key==='HIP_IDEAL_ABS') THR[key]=Math.abs(THR[key]);
      sync(); compute();
    });
    hook(thrFhaIdeal,'FHA_IDEAL_MAX');
    hook(thrFhaFwd,'FHA_FORWARD_HD');
    hook(thrHipNeutral,'HIP_IDEAL_ABS');
    hook(thrHipFwd,'HIP_FWD');
    hook(thrHipBwd,'HIP_BWD');
    hook(thrKneeBack,'KNEE_BACK');
    thrReset?.addEventListener('click',()=>{
      THR.FHA_IDEAL_MAX=12; THR.FHA_FORWARD_HD=20;
      THR.HIP_IDEAL_ABS=10; THR.HIP_FWD=10; THR.HIP_BWD=-10; THR.KNEE_BACK=-5;
      thrFhaIdeal.value=12; thrFhaFwd.value=20; thrHipNeutral.value=10; thrHipFwd.value=10; thrHipBwd.value=-10; thrKneeBack.value=-5;
      sync(); compute();
    });
  }

  // ===== Compute & classify =====
  function compute(){
    if (points.filter(Boolean).length < 5 || plumbX<=0){
      metricsDiv && (metricsDiv.innerHTML="<p>5点と鉛直線を設定してください。</p>");
      classDiv && (classDiv.innerHTML="");
      const cd = document.getElementById('classDef'); if (cd) cd.innerHTML="";
      return;
    }
    const [ear, shoulder, hip, knee] = points;

    const angleDeg = Math.atan2(ear.y - shoulder.y, ear.x - shoulder.x) * 180/Math.PI;
    const FHA = Math.abs(90 - Math.abs(angleDeg));
    const hipOffsetPx  = hip.x  - plumbX;
    const kneeOffsetPx = knee.x - plumbX;

    const {FHA_IDEAL_MAX,FHA_FORWARD_HD,HIP_IDEAL_ABS,HIP_FWD,HIP_BWD,KNEE_BACK} = THR;

    let type="判定不可";
    if (Math.abs(hipOffsetPx) <= HIP_IDEAL_ABS && FHA <= FHA_IDEAL_MAX) {
      type = "Ideal";
    } else if (FHA > FHA_FORWARD_HD && hipOffsetPx >= HIP_FWD) {
      type = "Kyphotic-lordotic";
    } else if (hipOffsetPx <= HIP_BWD && FHA >= 8 && kneeOffsetPx <= KNEE_BACK) {
      type = "Sway-back";
    } else {
      if (FHA < 10 && hipOffsetPx < HIP_FWD) type = "Flat-back";
      else type = (hipOffsetPx < 0) ? "Sway-back" : "Flat-back";
    }

    metricsDiv && (metricsDiv.innerHTML = `
      <p><b>FHA角度</b>: ${FHA.toFixed(1)}°</p>
      <p><b>大転子オフセット</b>: ${hipOffsetPx.toFixed(0)} px</p>
      <p><b>膝オフセット</b>: ${kneeOffsetPx.toFixed(0)} px</p>
    `);
    classDiv && (classDiv.innerHTML = `<p><b>${type}</b></p>`);

    const defs = {
      "Ideal": `耳・肩峰・大転子・膝が鉛直線近傍に揃う。FHA ≲ ${FHA_IDEAL_MAX}°、大転子±${HIP_IDEAL_ABS}px以内が目安。`,
      "Kyphotic-lordotic": `胸椎後弯↑＋腰椎前弯↑、骨盤前傾。FHA > ${FHA_FORWARD_HD}°かつ大転子が前方（+${HIP_FWD}px以上）。`,
      "Flat-back": "胸椎後弯↓・腰椎前弯↓、骨盤後傾。FHA < 10°でカーブが平坦、中立〜やや後方。",
      "Sway-back": `骨盤後傾＋股関節伸展で体幹後方シフト。大転子が線より後方（${HIP_BWD}px以下）、膝は線より${KNEE_BACK}px以下で後方傾向。`
    };
    const cd = document.getElementById('classDef');
    if (cd) cd.innerHTML = defs[type] || "";
  }

  // ===== Image loading =====
  function handleDataURL(dataURL){
    imgDataURL = dataURL;
    img.onload = ()=>{
      imgLoaded = true;
      setupCanvasDPR();
      points = [null,null,null,null,null];
      aiBtn && (aiBtn.disabled=false);
      draw();
      log("画像 onload 完了。");
    };
    img.onerror = ()=> log("⚠️ 画像読み込み失敗（img.onerror）");
    img.src = dataURL;
  }
  function readBlobToDataURL(blob){
    if (blob?.type && !/^image\//i.test(blob.type)){ log(`⚠️ 画像ではありません（type=${blob.type}）`); return; }
    const r = new FileReader();
    r.onload = ()=> (typeof r.result==='string') ? handleDataURL(r.result) : log("⚠️ FileReader結果が文字列でない");
    r.onerror = ()=> log("⚠️ FileReader 読み込み失敗");
    r.readAsDataURL(blob);
  }

  // 任意の <input type="file">
  document.addEventListener('change', e=>{
    const t=e.target;
    if (t?.type==='file'){ const f=t.files?.[0]; if(f) readBlobToDataURL(f); }
  }, true);

  // D&D
  function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
  ['dragenter','dragover','dragleave','drop'].forEach(ev=>{
    document.addEventListener(ev, preventDefaults, false);
    canvas.addEventListener(ev, preventDefaults, false);
  });
  document.addEventListener('drop', e=>{
    const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith('image/'));
    if (f) readBlobToDataURL(f);
  });
  // paste
  document.addEventListener('paste', e=>{
    const items = e.clipboardData?.items || [];
    for (const it of items){
      if (it.type?.startsWith('image/')){ const b=it.getAsFile(); if(b){ readBlobToDataURL(b); return; } }
    }
  });

  // ===== Manual points =====
  document.querySelectorAll('input[name="lm"]').forEach(r=>{
    r.addEventListener('change', ()=> currentEdit = Number(r.value||0));
  });
  canvas.addEventListener('pointerdown', e=>{
    e.preventDefault();
    if (!imgLoaded) return;
    const p = getCanvasPoint(e);
    points[currentEdit] = p;
    if (currentEdit===4) setPlumbFromAnkle(); // 外果置いたら自動で線合わせ
    draw(); compute();
  }, {passive:false});

  // ===== Plumb line =====
  plumbXInput && plumbXInput.addEventListener('change', ()=>{
    const rect = canvas.getBoundingClientRect();
    plumbX = clamp(Number(plumbXInput.value||0), 0, rect.width);
    draw(); compute();
  });
  centerPlumbBtn && centerPlumbBtn.addEventListener('click', ()=>{
    const rect = canvas.getBoundingClientRect();
    plumbX = Math.round(rect.width/2);
    plumbXInput && (plumbXInput.value = plumbX);
    draw(); compute();
  });
  togglePlumb && togglePlumb.addEventListener('change', ()=>{
    showPlumb = togglePlumb.checked;
    draw();
  });
  plumbAtAnkleBtn && plumbAtAnkleBtn.addEventListener('click', ()=> setPlumbFromAnkle());
  plumbOffset && plumbOffset.addEventListener('change', ()=> { if(points[4]) setPlumbFromAnkle(); });

  // 前方方向を「膝 vs 外果」で自動推定して配置
  function setPlumbFromAnkle(){
    const ankle = points[4], knee = points[3];
    if (!ankle || !knee){ log("⚠️ まず外果(5)と膝(4)を指定してください。"); return; }
    const rect = canvas.getBoundingClientRect();
    const offsetAbs = Math.abs(Number(plumbOffset?.value ?? 10));
    const anteriorSign = Math.sign(knee.x - ankle.x) || 1; // つま先寄り方向＝前
    plumbX = clamp(ankle.x + anteriorSign*offsetAbs, 0, rect.width);
    plumbXInput && (plumbXInput.value = Math.round(plumbX));
    draw(); compute();
    log(`鉛直線を外果±${offsetAbs}px（前方推定 sign=${anteriorSign}）に合わせました。`);
  }

  // ===== Reset =====
  clearBtn && clearBtn.addEventListener('click', ()=>{
    points=[null,null,null,null,null];
    imgLoaded=false; imgDataURL=null; lastDet=null;
    aiBtn && (aiBtn.disabled=true);
    plumbX=0; plumbXInput && (plumbXInput.value=0);
    metricsDiv && (metricsDiv.innerHTML="");
    classDiv && (classDiv.innerHTML="");
    draw(); log("リセットしました。");
  });

  // ===== Resize =====
  window.addEventListener('resize', ()=>{
    if (!imgLoaded) return;
    const dpr = window.devicePixelRatio||1;
    const oldW = canvas.width/dpr, oldH = canvas.height/dpr;
    const rect = canvas.getBoundingClientRect();
    const rx = oldW? rect.width/oldW : 1;
    const ry = oldH? rect.height/oldH : 1;
    points = points.map(p=> p? {x:p.x*rx, y:p.y*ry} : p);
    plumbX *= rx;
    setupCanvasDPR();
    if (points[4] && points[3]) setPlumbFromAnkle();
    draw(); compute();
  });

  // ===== AI (MoveNet) =====
  function vendorsOK(){
    const ok = !!(window.tf && window.poseDetection);
    if (!window.tf) log("⚠️ tf.min.js が未読込（/vendor/tf.min.js）");
    if (!window.poseDetection) log("⚠️ pose-detection.min.js が未読込（/vendor/pose-detection.min.js）");
    return ok;
  }
  async function ensureDetector(){
    if (detector) return detector;
    if (!vendorsOK()) return null;
    try{
      try{ await tf.setBackend('webgl'); }catch{}
      await tf.ready();
      if (tf.getBackend()!=='webgl'){ await tf.setBackend('cpu'); await tf.ready(); }
      log('TensorFlow.js backend: '+tf.getBackend());
      const mt = (poseDetection.movenet?.modelType?.SINGLEPOSE_LIGHTNING) || 'SINGLEPOSE_LIGHTNING';
      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        { runtime:'tfjs', modelType: mt, modelUrl:'./models/movenet/model.json', enableSmoothing:true }
      );
      log('MoveNet detector 初期化完了（ローカル）');
      return detector;
    }catch(e){
      log('Detector初期化エラー: '+(e?.message||e));
      return null;
    }
  }

  async function runAutoDetect(){
    if (!imgLoaded || !imgDataURL){ log("⚠️ 先に画像を読み込んでください。"); return; }
    const det = await ensureDetector();
    if (!det){ log("⚠️ Detectorの用意に失敗。"); return; }

    const tmp = new Image();
    tmp.onload = async ()=>{
      try{
        const res = await det.estimatePoses(tmp, { flipHorizontal:false });
        const kps = res?.[0]?.keypoints;
        if (!kps){ log("⚠️ 検出結果が空です。"); return; }
        const iw = tmp.naturalWidth||tmp.width, ih = tmp.naturalHeight||tmp.height;
        lastDet = { kps, iw, ih };
        applySideAndUpdate(); // 現在のUI選択で反映
      }catch(e){ log("検出エラー: "+(e?.message||e)); }
    };
    tmp.onerror = ()=> log("⚠️ 画像の再ロード失敗。");
    tmp.src = imgDataURL;
  }

  // sideSelect（auto/left/right）に従って points を作る
  function applySideAndUpdate(){
    if (!lastDet){ log("⚠️ 検出キャッシュなし。AI実行後にサイド切替してください。"); return; }
    const { kps, iw, ih } = lastDet;

    const L=['left_ear','left_shoulder','left_hip','left_knee','left_ankle'];
    const R=['right_ear','right_shoulder','right_hip','right_knee','right_ankle'];

    const avg = names => { let s=0,c=0; for(const n of names){ const kp=kps.find(x=>x.name===n); if(kp?.score!=null){ s+=kp.score; c++; } } return c? s/c:0; };
    const meanX = names => { let s=0,c=0; for(const n of names){ const kp=kps.find(x=>x.name===n); if(kp?.x!=null){ s+=kp.x; c++; } } return c? s/c : Infinity; };

    const avgL=avg(L), avgR=avg(R);
    const mxL=meanX(L), mxR=meanX(R);

    let autoSide = (avgR>avgL ? 'right':'left');
    if (Math.abs(avgR-avgL)<0.1) autoSide = (mxR < mxL ? 'right' : 'left');

    const pref = (sideSelect?.value || 'auto');
    const side = (pref==='auto') ? autoSide : pref;

    const names = (side==='right') ? R : L;
    const pick = {}; for(const n of names){ const kp=kps.find(x=>x.name===n); if(kp) pick[n]=kp; }
    const ear   = pick[names[0]];
    const sh    = pick[names[1]];
    const hip   = pick[names[2]];
    const knee  = pick[names[3]];
    const ankle = pick[names[4]];
    if (!(ear&&sh&&hip&&knee&&ankle)){ log("⚠️ 必須ランドマーク不足（side="+side+"）。"); return; }

    const rect = canvas.getBoundingClientRect();
    const toCanvas = kp => ({ x: clamp(kp.x*(rect.width/iw),0,rect.width), y: clamp(kp.y*(rect.height/ih),0,rect.height) });

    points = [ear,sh,hip,knee,ankle].map(toCanvas);
    setPlumbFromAnkle(); // 膝×外果で前方符号を自動推定して線を再配置
    draw(); compute();
    log(`AI検出完了 side=${side}`);
  }

  // サイド切替で再適用
  sideSelect?.addEventListener('change', ()=>{ if (lastDet) applySideAndUpdate(); });

  // AIボタン
  document.addEventListener('click', e=>{
    const btn = e.target.closest('#aiBtn, [data-ai-detect]');
    if (!btn) return;
    log('AIボタン押下。自動抽出を開始。');
    runAutoDetect();
  });

  // ===== Init =====
  bindThresholdControls?.();
  setupCanvasDPR();
  draw();
})();
