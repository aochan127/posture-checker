/* Posture Checker – Clinical FULL BUILD
   - 画像取り込み：任意<input type="file"> / D&D / ペースト
   - iPhoneタップずれ補正（DPR + offsetX優先）
   - Kendall準拠：鉛直線＝外果の“やや前方”（オフセット可変）
   - 自動分類：FHA/大転子/膝の可変しきい値（臨床UIつき）
   - MoveNet(TFJS)で姿勢推定 → A方式：大転子=ヒップから外側輪郭へスナップ
*/

(() => {
  // ---------- DOM ----------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const aiBtn = document.getElementById('aiBtn');
  const clearBtn = document.getElementById('clearBtn');
  const sideSelect = document.getElementById('sideSelect');

  // Plumb line
  const plumbXInput = document.getElementById('plumbX');
  const centerPlumbBtn = document.getElementById('centerPlumbBtn');
  const togglePlumb = document.getElementById('togglePlumb');
  const plumbOffset     = document.getElementById('plumbOffset');      // px
  const plumbAtAnkleBtn = document.getElementById('plumbAtAnkleBtn');

  // Threshold UI
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

  // Output
  const metricsDiv = document.getElementById('metrics');
  const classDiv   = document.getElementById('classification');
  const classDefEl = document.getElementById('classDef');
  const logEl      = document.getElementById('log');

  // ---------- 状態 ----------
  let img = new Image();
  let imgLoaded = false;
  let imgDataURL = null;
  // 0:耳, 1:肩, 2:大転子(推定/手動), 3:膝, 4:外果
  let points = [null, null, null, null, null];
  let currentEdit = 0;
  let plumbX = 0;
  let showPlumb = true;
  let detector = null;

  const COLORS = ["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"];
  const RADIUS = 14;

  // しきい値（臨床UIで変更可）
  const THR = {
    FHA_IDEAL_MAX: 12,
    FHA_FORWARD_HD: 20,
    HIP_IDEAL_ABS: 10,
    HIP_FWD: 10,
    HIP_BWD: -10,
    KNEE_BACK: -5
  };

  // ---------- ログ ----------
  function log(msg){
    if (!logEl) { console.log(msg); return; }
    if ('value' in logEl) {
      logEl.value += (logEl.value ? "\n" : "") + msg;
      logEl.scrollTop = logEl.scrollHeight;
    } else {
      logEl.textContent += (logEl.textContent ? "\n" : "") + msg;
      logEl.scrollTop = logEl.scrollHeight;
    }
    console.log(msg);
  }

  // ---------- ユーティリティ ----------
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
      return {
        x: clamp(evt.offsetX, 0, rect.width),
        y: clamp(evt.offsetY, 0, rect.height)
      };
    }
    const rect = canvas.getBoundingClientRect();
    let cx, cy;
    if (evt.touches?.[0])            { cx = evt.touches[0].clientX;       cy = evt.touches[0].clientY; }
    else if (evt.changedTouches?.[0]){ cx = evt.changedTouches[0].clientX; cy = evt.changedTouches[0].clientY; }
    else                             { cx = evt.clientX;                   cy = evt.clientY; }
    return {
      x: clamp(cx - rect.left, 0, rect.width),
      y: clamp(cy - rect.top , 0, rect.height)
    };
  }

  // ---------- 描画 ----------
  function draw(){
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0,0,rect.width,rect.height);
    if (imgLoaded) ctx.drawImage(img, 0, 0, rect.width, rect.height);

    // Plumb line
    if (showPlumb && plumbX > 0){
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

    // 接続ライン
    ctx.save();
    ctx.strokeStyle = "rgba(239,68,68,.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    let started = false;
    for (let i=0;i<points.length;i++){
      const p = points[i];
      if (!p) continue;
      if (!started){ ctx.moveTo(p.x,p.y); started=true; }
      else ctx.lineTo(p.x,p.y);
    }
    if (started) ctx.stroke();
    ctx.restore();

    // ランドマーク
    points.forEach((p,i)=>{
      if (!p) return;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = COLORS[i];
      ctx.arc(p.x,p.y,RADIUS,0,Math.PI*2);
      ctx.fill();
      ctx.font = "bold 16px system-ui,-apple-system,Segoe UI,Noto Sans JP,sans-serif";
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

  // ---------- 計測・分類 ----------
  function compute(){
    if (points.filter(Boolean).length < 5 || plumbX <= 0){
      metricsDiv && (metricsDiv.innerHTML = "<p>5点と鉛直線を設定してください。</p>");
      classDiv && (classDiv.innerHTML = "");
      classDefEl && (classDefEl.innerHTML = "");
      return;
    }
    const [ear, shoulder, hip, knee] = points;

    // FHA（簡易）：耳—肩の線の傾き
    const angleDeg = Math.atan2(ear.y - shoulder.y, ear.x - shoulder.x) * 180/Math.PI;
    const FHA = Math.abs(90 - Math.abs(angleDeg));

    // オフセット（+前 / -後）
    const hipOffsetPx  = hip.x  - plumbX;
    const kneeOffsetPx = knee.x - plumbX;

    const {
      FHA_IDEAL_MAX, FHA_FORWARD_HD,
      HIP_IDEAL_ABS, HIP_FWD, HIP_BWD,
      KNEE_BACK
    } = THR;

    let type = "判定不可";
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
      "Flat-back": "胸椎後弯↓・腰椎前弯↓、骨盤後傾。FHA < 10°でカーブが平坦、大転子は中立〜やや後方。",
      "Sway-back": `骨盤後傾＋股関節伸展で体幹後方シフト。大転子が鉛直線より後方（${HIP_BWD}px以下）、膝は${KNEE_BACK}px以下で後方。`
    };
    classDefEl && (classDefEl.innerHTML = defs[type] || "");
  }

  // ---------- しきい値UI ----------
  function bindThresholdControls(){
    if (!thrFhaIdeal) return;
    const sync = () => {
      vFhaIdeal.textContent   = THR.FHA_IDEAL_MAX;
      vFhaFwd.textContent     = THR.FHA_FORWARD_HD;
      vHipNeutral.textContent = THR.HIP_IDEAL_ABS;
      vHipFwd.textContent     = THR.HIP_FWD;
      vHipBwd.textContent     = THR.HIP_BWD;
      vKneeBack.textContent   = THR.KNEE_BACK;
    };
    // 初期値反映
    thrFhaIdeal.value   = THR.FHA_IDEAL_MAX;
    thrFhaFwd.value     = THR.FHA_FORWARD_HD;
    thrHipNeutral.value = THR.HIP_IDEAL_ABS;
    thrHipFwd.value     = THR.HIP_FWD;
    thrHipBwd.value     = THR.HIP_BWD;
    thrKneeBack.value   = THR.KNEE_BACK; sync();

    const hook = (el, key, cast=Number) => {
      el.addEventListener('input', ()=>{
        THR[key] = cast(el.value);
        sync(); compute();
      });
    };
    hook(thrFhaIdeal,   'FHA_IDEAL_MAX');
    hook(thrFhaFwd,     'FHA_FORWARD_HD');
    hook(thrHipNeutral, 'HIP_IDEAL_ABS', v=>Math.abs(Number(v)));
    hook(thrHipFwd,     'HIP_FWD');
    hook(thrHipBwd,     'HIP_BWD');
    hook(thrKneeBack,   'KNEE_BACK');

    thrReset?.addEventListener('click', ()=>{
      THR.FHA_IDEAL_MAX = 12;
      THR.FHA_FORWARD_HD = 20;
      THR.HIP_IDEAL_ABS  = 10;
      THR.HIP_FWD = 10;
      THR.HIP_BWD = -10;
      THR.KNEE_BACK = -5;
      thrFhaIdeal.value   = THR.FHA_IDEAL_MAX;
      thrFhaFwd.value     = THR.FHA_FORWARD_HD;
      thrHipNeutral.value = THR.HIP_IDEAL_ABS;
      thrHipFwd.value     = THR.HIP_FWD;
      thrHipBwd.value     = THR.HIP_BWD;
      thrKneeBack.value   = THR.KNEE_BACK; sync(); compute();
    });
  }
  bindThresholdControls();

  // ---------- 画像読み込み（ULTRA） ----------
  function handleDataURL(dataURL){
    imgDataURL = dataURL;
    img.onload = ()=>{
      imgLoaded = true;
      setupCanvasDPR();
      points = [null,null,null,null,null];
      aiBtn && (aiBtn.disabled = false);
      draw(); log("画像 onload 完了。");
    };
    img.onerror = ()=> log("⚠️ 画像の読み込みに失敗しました。");
    img.src = dataURL;
  }
  function readBlobToDataURL(blob){
    if (blob.type && !/^image\//i.test(blob.type)){
      log(`⚠️ 画像ではありません（type=${blob.type}）`);
      return;
    }
    const r = new FileReader();
    r.onload = ()=> { if (typeof r.result === 'string') handleDataURL(r.result); };
    r.onerror = ()=> log("⚠️ 画像の読み込みに失敗しました（FileReader）。");
    r.readAsDataURL(blob);
  }
  document.addEventListener('change', (e)=>{
    const t = e.target;
    if (t && t.type === 'file'){
      const f = t.files?.[0];
      if (f) readBlobToDataURL(f);
    }
  }, true);
  function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
  ['dragenter','dragover','dragleave','drop'].forEach(ev=>{
    document.addEventListener(ev, preventDefaults, false);
    canvas.addEventListener(ev, preventDefaults, false);
  });
  document.addEventListener('drop', e=>{
    const f = [...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith('image/'));
    if (f) readBlobToDataURL(f);
  });
  document.addEventListener('paste', e=>{
    const items = e.clipboardData?.items || [];
    for (const it of items){
      if (it.type?.startsWith('image/')){
        const b = it.getAsFile(); if (b) { readBlobToDataURL(b); return; }
      }
    }
  });

  // ---------- 手動編集 ----------
  document.querySelectorAll('input[name="lm"]').forEach(r=>{
    r.addEventListener('change', ()=> currentEdit = Number(r.value||0));
  });

  canvas.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    if (!imgLoaded) return;
    const p = getCanvasPoint(e);
    points[currentEdit] = p;
    if (currentEdit === 4) setPlumbFromAnkle();
    draw(); compute();
  }, { passive:false });

  // ---------- Plumb line ----------
  function setPlumbFromAnkle(){
    const ankle = points[4];
    if (!ankle){ log("⚠️ まず外果（5点目）を指定してください。"); return; }
    const rect = canvas.getBoundingClientRect();
    const offsetPx = Number(plumbOffset?.value ?? 10);
    plumbX = clamp(ankle.x + offsetPx, 0, rect.width);
    plumbXInput && (plumbXInput.value = Math.round(plumbX));
    draw(); compute();
    log(`鉛直線を外果＋${offsetPx}pxに合わせました。`);
  }
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
    showPlumb = togglePlumb.checked; draw();
  });
  plumbAtAnkleBtn && plumbAtAnkleBtn.addEventListener('click', ()=> setPlumbFromAnkle());
  plumbOffset && plumbOffset.addEventListener('change', ()=> { if (points[4]) setPlumbFromAnkle(); });

  // ---------- リセット＆リサイズ ----------
  clearBtn && clearBtn.addEventListener('click', ()=>{
    points = [null,null,null,null,null];
    imgLoaded = false; imgDataURL = null;
    aiBtn && (aiBtn.disabled = true);
    plumbX = 0; plumbXInput && (plumbXInput.value = 0);
    metricsDiv && (metricsDiv.innerHTML = "");
    classDiv && (classDiv.innerHTML = "");
    classDefEl && (classDefEl.innerHTML = "");
    draw(); log("リセットしました。");
  });
  window.addEventListener('resize', ()=>{
    if (!imgLoaded) return;
    const dpr = window.devicePixelRatio || 1;
    const oldW = canvas.width/dpr, oldH = canvas.height/dpr;
    const rect = canvas.getBoundingClientRect();
    const rx = oldW ? rect.width/oldW : 1, ry = oldH ? rect.height/oldH : 1;
    points = points.map(p => p ? { x:p.x*rx, y:p.y*ry } : p);
    plumbX *= rx;
    setupCanvasDPR();
    if (points[4]) setPlumbFromAnkle();
    draw(); compute();
  });

  // ---------- AI（MoveNet）＋ A方式：大転子推定 ----------
  function vendorsOK(){
    const ok = !!(window.tf && window.poseDetection);
    if (!window.tf) log("⚠️ tf.min.js が読み込まれていません（/vendor/tf.min.js）");
    if (!window.poseDetection) log("⚠️ pose-detection.min.js が読み込まれていません（/vendor/pose-detection.min.js）");
    return ok;
  }

  async function ensureDetector(){
    if (detector) return detector;
    if (!vendorsOK()) return null;
    try{
      try { await tf.setBackend('webgl'); } catch(e){}
      await tf.ready();
      if (tf.getBackend() !== 'webgl'){ await tf.setBackend('cpu'); await tf.ready(); }
      log('TensorFlow.js backend: ' + tf.getBackend());
      const mt = (poseDetection.movenet?.modelType?.SINGLEPOSE_LIGHTNING) || 'SINGLEPOSE_LIGHTNING';
      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        { runtime:'tfjs', modelType: mt, modelUrl:'./models/movenet/model.json', enableSmoothing:true }
      );
      log('MoveNet detector 初期化完了（ローカル）');
      return detector;
    }catch(e){
      log('Detector初期化エラー: ' + (e?.message || e));
      return null;
    }
  }

  // --- 画像→ImageData（canvasサイズ基準）
  function getImageDataForCanvas(){
    const rect = canvas.getBoundingClientRect();
    const tmp = document.createElement('canvas');
    tmp.width = rect.width; tmp.height = rect.height;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0, rect.width, rect.height);
    return tctx.getImageData(0,0,rect.width,rect.height);
  }

  // --- Sobel強度（簡易Canny代替）
  function sobelMagnitude(imgData, x, y){
    const {width, height, data} = imgData;
    if (x<=1 || y<=1 || x>=width-2 || y>=height-2) return 0;
    const idx = (xx,yy)=> ((yy*width+xx)<<2);
    const gray = (i)=> 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];

    // サンプリング
    const g = [];
    for(let j=-1;j<=1;j++){
      for(let i=-1;i<=1;i++){
        const id = idx(x+i,y+j);
        g.push(gray(id));
      }
    }
    // Sobel kernel
    const gx = (-1*g[0] + 0*g[1] + 1*g[2]) +
               (-2*g[3] + 0*g[4] + 2*g[5]) +
               (-1*g[6] + 0*g[7] + 1*g[8]);
    const gy = (-1*g[0] -2*g[1] -1*g[2]) +
               ( 0*g[3] +0*g[4] +0*g[5]) +
               ( 1*g[6] +2*g[7] +1*g[8]);
    return Math.hypot(gx, gy);
  }

  // --- A方式：ヒップ→膝ベクトルの法線方向に外側へ走査し、最大エッジへスナップ
  function estimateTrochanterByContour(imgData, hip, knee, side){
    const L = Math.hypot(knee.x-hip.x, knee.y-hip.y) || 1;
    const vx = (knee.x-hip.x) / L, vy = (knee.y-hip.y) / L;      // 大腿軸
    // 体外側向き法線
    let nx =  vy, ny = -vx; // 右向きがデフォ
    if (side === 'left') { nx = -nx; ny = -ny; }

    // 探索設定（px）
    const rmin = Math.max(8,  0.02*L);
    const rmax = Math.min(40, 0.18*L);
    const step = 1;

    let best = {score: -1, x: hip.x, y: hip.y};
    for (let r = rmin; r <= rmax; r += step){
      const x = Math.round(hip.x + nx * r);
      const y = Math.round(hip.y + ny * r);
      const s = sobelMagnitude(imgData, x, y);
      // 外側ほど少しボーナス（張り出し優先）
      const bonus = 0.05 * (r - rmin);
      const score = s + bonus;
      if (score > best.score){
        best = {score, x, y, r};
      }
    }
    // 妥当性チェック（距離が短すぎ/長すぎたらヒップを返す）
    if (!best || best.score < 20 || best.r < 0.02*L || best.r > 0.2*L){
      return {x: hip.x, y: hip.y}; // フォールバック：関節中心
    }
    return {x: best.x, y: best.y};
  }

  async function runAutoDetect(){
    if (!imgLoaded || !imgDataURL){ log("⚠️ 先に画像を読み込んでください。"); return; }
    const det = await ensureDetector();
    if (!det){ log("⚠️ Detectorの用意に失敗しました。"); return; }

    const tmp = new Image();
    tmp.onload = async ()=>{
      try{
        const res = await det.estimatePoses(tmp, { flipHorizontal:false });
        const kps = res?.[0]?.keypoints;
        if (!kps){ log("⚠️ 検出結果が空です。"); return; }

        // 片側選択
        const Lnames=['left_ear','left_shoulder','left_hip','left_knee','left_ankle'];
        const Rnames=['right_ear','right_shoulder','right_hip','right_knee','right_ankle'];
        const avg = names => {
          let s=0,c=0; names.forEach(n=>{ const kp=kps.find(x=>x.name===n); if(kp?.score!=null){ s+=kp.score; c++; }});
          return c? s/c : 0;
        };
        const pref = sideSelect?.value || 'auto';
        let side = 'left';
        if (pref==='left') side='left';
        else if (pref==='right') side='right';
        else side = (avg(Rnames) > avg(Lnames)) ? 'right' : 'left';
        const N = (side==='right') ? Rnames : Lnames;
        const get = n => kps.find(x=>x.name===n);

        const ear   = get(N[0]), sh = get(N[1]);
        const hipKP = get(N[2]), kneeKP = get(N[3]), ankleKP = get(N[4]);
        if (!(ear&&sh&&hipKP&&kneeKP&&ankleKP)){ log("⚠️ 必要ランドマーク不足。"); return; }

        // Canvas座標
        const rect = canvas.getBoundingClientRect();
        const iw = tmp.naturalWidth||tmp.width, ih = tmp.naturalHeight||tmp.height;
        const toCanvas = (kp)=>({ x: clamp(kp.x*(rect.width/iw), 0, rect.width),
                                  y: clamp(kp.y*(rect.height/ih),0, rect.height) });
        const earC   = toCanvas(ear);
        const shC    = toCanvas(sh);
        const hipC0  = toCanvas(hipKP);    // 初期ヒップ（関節中心）
        const kneeC  = toCanvas(kneeKP);
        const ankleC = toCanvas(ankleKP);

        // 画像の勾配（canvasスケール）取得
        const imgData = getImageDataForCanvas();
        // A方式：ヒップ→膝の法線方向に外側へ走査し、大転子へスナップ
        const troC = estimateTrochanterByContour(imgData, hipC0, kneeC, side);

        points = [earC, shC, troC, kneeC, ankleC];

        // 外果基準でPlumb line
        setPlumbFromAnkle();

        draw(); compute();
        log(`AI検出完了（side: ${side}／Trochanter snap 使用）`);
      }catch(e){
        log("検出エラー: " + (e?.message || e));
      }
    };
    tmp.onerror = ()=> log("⚠️ 画像の再ロードに失敗しました。");
    tmp.src = imgDataURL;
  }

  // AIボタン（id / data-ai-detect どちらでも）
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('#aiBtn, [data-ai-detect]');
    if (!btn) return;
    log('AIボタン押下を検知しました。自動抽出を開始します。');
    runAutoDetect();
  });

  // 初期化
  setupCanvasDPR(); draw();
})();
