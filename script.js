/* Kendall Posture Checker — 5分類版（Ideal / Kyphotic / Lordotic / Flat-back / Sway-back）
   - 画像読込：<input> / D&D / ペースト
   - iPhoneタップ補正：offsetX優先
   - Plumb line：外果＋前方オフセット（既定 +12px）
   - MoveNet + 輪郭スナップ(A方式)で大転子控えめ補正
   - 5分類ロジック実装（Kyphotic / Lordotic を分離）
*/

(() => {
  // ---------- DOM ----------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const fileInput = document.getElementById('fileInput');

  const aiBtn = document.getElementById('aiBtn');
  const clearBtn = document.getElementById('clearBtn');
  const sideSelect = document.getElementById('sideSelect');

  // Plumb line
  const plumbXInput = document.getElementById('plumbX');
  const centerPlumbBtn = document.getElementById('centerPlumbBtn');
  const togglePlumb = document.getElementById('togglePlumb');
  const plumbOffset     = document.getElementById('plumbOffset');
  const plumbAtAnkleBtn = document.getElementById('plumbAtAnkleBtn');

  // Threshold UI
  const thrFhaIdeal   = document.getElementById('thrFhaIdeal');
  const thrHipNeutral = document.getElementById('thrHipNeutral');
  const thrHipFwd     = document.getElementById('thrHipFwd');
  const thrHipBwd     = document.getElementById('thrHipBwd');
  const thrKneeBack   = document.getElementById('thrKneeBack');
  const vFhaIdeal     = document.getElementById('vFhaIdeal');
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
  // 0:耳 1:肩 2:大転子 3:膝 4:外果
  let points = [null, null, null, null, null];
  let currentEdit = 0;
  let plumbX = 0;
  let showPlumb = true;
  let detector = null;

  const COLORS = ["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"];
  const RADIUS = 14;

  // ---- しきい値（推奨初期値：外来バランス） ----
  const THR = {
    FHA_IDEAL_MAX: 10,  // Ideal のFHA上限
    HIP_IDEAL_ABS: 8,   // 大転子の中立幅 ±px
    HIP_FWD: 10,        // Lordotic / 前寄り判定の基準
    HIP_BWD: -15,       // Sway-back：大転子が後方
    KNEE_BACK: -2       // Sway-back：膝が後方
  };
  // Kyphotic / Sway 調整
  const FHA_KYPHOSIS_STRONG = 38; // これ以上はKyphotic最優先
  const FHA_KYPHOSIS_MILD   = 20; // 中等度（前寄りサインあればKyphotic）
  const FHA_SWAY_MAX        = 35; // これ以下ならSway-backを許容
  const TORSO_BACK_REQ      = -6; // 体幹（肩）が骨盤より後
  const TORSO_FRONT_HINT    = +6; // 体幹（肩）が骨盤より前

  // ---------- Utils ----------
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
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
      return { x: clamp(evt.offsetX,0,rect.width), y: clamp(evt.offsetY,0,rect.height) };
    }
    const rect = canvas.getBoundingClientRect();
    let cx,cy;
    if (evt.touches?.[0])            { cx=evt.touches[0].clientX; cy=evt.touches[0].clientY; }
    else if (evt.changedTouches?.[0]){ cx=evt.changedTouches[0].clientX; cy=evt.changedTouches[0].clientY; }
    else                             { cx=evt.clientX; cy=evt.clientY; }
    return { x: clamp(cx-rect.left,0,rect.width), y: clamp(cy-rect.top,0,rect.height) };
  }

  // ---------- 描画 ----------
  function draw(){
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0,0,rect.width,rect.height);
    if (imgLoaded) ctx.drawImage(img,0,0,rect.width,rect.height);

    if (showPlumb && plumbX>0){
      ctx.save();
      ctx.strokeStyle="rgba(30,41,59,.95)";
      ctx.setLineDash([8,6]);
      ctx.lineWidth=2;
      ctx.beginPath();
      ctx.moveTo(plumbX,0); ctx.lineTo(plumbX,rect.height); ctx.stroke();
      ctx.restore();
    }

    // 接続ライン
    ctx.save();
    ctx.strokeStyle="rgba(239,68,68,.85)";
    ctx.lineWidth=3;
    ctx.beginPath();
    let started=false;
    for (let p of points){
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
      ctx.fillStyle=COLORS[i];
      ctx.arc(p.x,p.y,RADIUS,0,Math.PI*2);
      ctx.fill();
      ctx.font="bold 16px system-ui,-apple-system,Segoe UI,Noto Sans JP,sans-serif";
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.lineWidth=4; ctx.strokeStyle="rgba(0,0,0,.9)";
      const label=String(i+1);
      ctx.strokeText(label,p.x,p.y);
      ctx.fillStyle="#fff"; ctx.fillText(label,p.x,p.y);
      ctx.restore();
    });
  }

  // ---------- 分類（5分類） ----------
  function classify(FHA, hipOffsetPx, kneeOffsetPx, torsoShiftPx){
    const {FHA_IDEAL_MAX, HIP_IDEAL_ABS, HIP_FWD, HIP_BWD, KNEE_BACK} = THR;

    // 1) Kyphotic（胸椎後弯過多）
    if (FHA >= FHA_KYPHOSIS_STRONG) return "Kyphotic";
    if (FHA >= FHA_KYPHOSIS_MILD && torsoShiftPx >= TORSO_FRONT_HINT) return "Kyphotic";

    // 2) Ideal（先に拾う）
    if (Math.abs(hipOffsetPx) <= HIP_IDEAL_ABS && FHA <= FHA_IDEAL_MAX) return "Ideal";

    // 3) Sway-back（骨盤後傾＋股関節伸展＋体幹後方）
    if (
      FHA <= FHA_SWAY_MAX &&
      hipOffsetPx <= HIP_BWD &&
      kneeOffsetPx <= KNEE_BACK &&
      torsoShiftPx <= TORSO_BACK_REQ
    ) return "Sway-back";

    // 4) Lordotic（腰椎前弯過多：骨盤前傾）
    if (hipOffsetPx >= HIP_FWD && FHA < FHA_KYPHOSIS_STRONG) return "Lordotic";

    // 5) Flat-back（平背）
    if (FHA <= 10 && hipOffsetPx < HIP_FWD) return "Flat-back";

    // タイブレーク
    if (torsoShiftPx >= (TORSO_FRONT_HINT+2)) return "Kyphotic";
    if (hipOffsetPx <= (HIP_BWD-3) && kneeOffsetPx <= (KNEE_BACK-2)) return "Sway-back";
    if (hipOffsetPx >= (HIP_FWD+3)) return "Lordotic";
    if (Math.abs(hipOffsetPx) <= (HIP_IDEAL_ABS+2) && FHA <= (FHA_IDEAL_MAX+2)) return "Ideal";
    return "Flat-back";
  }

  // ---------- 計測 ----------
  function compute(){
    if (points.filter(Boolean).length<5 || plumbX<=0){
      metricsDiv.innerHTML="<p>5点と鉛直線を設定してください。</p>";
      classDiv.innerHTML=""; classDefEl.innerHTML="";
      return;
    }
    const [ear,shoulder,hip,knee] = points;

    // FHA ≈ 耳-肩の線の傾きからの近似
    const angleDeg = Math.atan2(ear.y-shoulder.y, ear.x-shoulder.x)*180/Math.PI;
    const FHA = Math.abs(90-Math.abs(angleDeg));

    const hipOffsetPx  = hip.x  - plumbX;  // +前 / -後
    const kneeOffsetPx = knee.x - plumbX;  // +前 / -後
    const torsoShiftPx = shoulder.x - hip.x; // ＋肩が前 / －肩が後

    const type = classify(FHA, hipOffsetPx, kneeOffsetPx, torsoShiftPx);

    metricsDiv.innerHTML=`
      <p><b>FHA角度</b>: ${FHA.toFixed(1)}°</p>
      <p><b>大転子オフセット</b>: ${hipOffsetPx.toFixed(0)} px</p>
      <p><b>膝オフセット</b>: ${kneeOffsetPx.toFixed(0)} px</p>
    `;
    classDiv.textContent = type;

    const DEF = {
      "Ideal"     : "耳・肩・大転子・膝が鉛直線近傍。胸椎後弯/腰椎前弯は正常範囲で骨盤中間位。",
      "Kyphotic"  : "胸椎後弯↑。体幹が前方にシフトしやすく、頭部前方位を伴うことが多い。",
      "Lordotic"  : "腰椎前弯↑・骨盤前傾。大転子が鉛直線より前方に位置しやすい。",
      "Flat-back" : "胸腰椎カーブが平坦。骨盤後傾傾向でFHAは小さめ。",
      "Sway-back" : "骨盤後傾＋股関節伸展＋体幹後方。ヒップ/膝が線より後方、肩も骨盤より後ろ。"
    };
    classDefEl.textContent = DEF[type] || "";
  }

  // ---------- しきい値 UI ----------
  function bindThresholdControls(){
    const sync=()=>{
      vFhaIdeal.textContent=THR.FHA_IDEAL_MAX;
      vHipNeutral.textContent=THR.HIP_IDEAL_ABS;
      vHipFwd.textContent=THR.HIP_FWD;
      vHipBwd.textContent=THR.HIP_BWD;
      vKneeBack.textContent=THR.KNEE_BACK;
    };
    thrFhaIdeal.value=THR.FHA_IDEAL_MAX;
    thrHipNeutral.value=THR.HIP_IDEAL_ABS;
    thrHipFwd.value=THR.HIP_FWD;
    thrHipBwd.value=THR.HIP_BWD;
    thrKneeBack.value=THR.KNEE_BACK; sync();
    const hook=(el,key,cast=Number)=>el?.addEventListener('input',()=>{THR[key]=cast(el.value);sync();compute();});
    hook(thrFhaIdeal,'FHA_IDEAL_MAX');
    hook(thrHipNeutral,'HIP_IDEAL_ABS',v=>Math.abs(Number(v)));
    hook(thrHipFwd,'HIP_FWD');
    hook(thrHipBwd,'HIP_BWD');
    hook(thrKneeBack,'KNEE_BACK');
    thrReset?.addEventListener('click',()=>{
      THR.FHA_IDEAL_MAX=10; THR.HIP_IDEAL_ABS=8; THR.HIP_FWD=10; THR.HIP_BWD=-15; THR.KNEE_BACK=-2;
      thrFhaIdeal.value=THR.FHA_IDEAL_MAX; thrHipNeutral.value=THR.HIP_IDEAL_ABS;
      thrHipFwd.value=THR.HIP_FWD; thrHipBwd.value=THR.HIP_BWD; thrKneeBack.value=THR.KNEE_BACK;
      sync(); compute();
    });
  }

  // ---------- Plumb line ----------
  function setPlumbFromAnkle(){
    const ankle=points[4];
    if (!ankle){ log("⚠️ 外果を先に指定してください"); return; }
    const rect=canvas.getBoundingClientRect();
    const offsetPx=Number(plumbOffset?.value ?? 12);
    plumbX=clamp(ankle.x+offsetPx,0,rect.width);
    plumbXInput.value=Math.round(plumbX);
    draw(); compute();
  }

  // ---------- 画像取り込み ----------
  function handleDataURL(dataURL){
    imgDataURL = dataURL;
    img.onload = ()=>{
      imgLoaded = true;
      setupCanvasDPR();
      points = [null,null,null,null,null];
      draw(); log("画像 onload 完了。");
    };
    img.onerror = ()=> log("⚠️ 画像の読み込みに失敗しました（img.onerror）");
    img.src = dataURL;
  }
  function readBlobToDataURL(blob){
    if (blob.type && !/^image\//i.test(blob.type)){ log(`⚠️ 画像ではありません（type=${blob.type}）`); return; }
    const r = new FileReader();
    r.onload = ()=> { if (typeof r.result === 'string') handleDataURL(r.result); };
    r.onerror = ()=> log("⚠️ 画像の読み込みに失敗しました（FileReader）");
    r.readAsDataURL(blob);
  }

  // <input>
  fileInput?.addEventListener('change', e=>{
    const f=e.target.files?.[0]; if (f) readBlobToDataURL(f);
  });
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
    const items=e.clipboardData?.items||[];
    for (const it of items){
      if (it.type?.startsWith('image/')){ const b=it.getAsFile(); if (b) { readBlobToDataURL(b); return; } }
    }
  });

  // ---------- 手動編集 ----------
  document.querySelectorAll('input[name="lm"]').forEach(r=>{
    r.addEventListener('change', ()=> currentEdit = Number(r.value||0));
  });
  canvas.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    if (!imgLoaded) return;
    const p=getCanvasPoint(e);
    points[currentEdit]=p;
    if (currentEdit===4) setPlumbFromAnkle();
    draw(); compute();
  }, {passive:false});

  // ---------- リセット＆リサイズ ----------
  clearBtn?.addEventListener('click', ()=>{
    points=[null,null,null,null,null];
    imgLoaded=false; imgDataURL=null;
    plumbX=0; plumbXInput.value=0;
    metricsDiv.innerHTML=""; classDiv.innerHTML=""; classDefEl.innerHTML="";
    draw(); log("リセットしました。");
  });
  window.addEventListener('resize', ()=>{
    if (!imgLoaded) return;
    const dpr=window.devicePixelRatio||1;
    const oldW=canvas.width/dpr, oldH=canvas.height/dpr;
    const rect=canvas.getBoundingClientRect();
    const rx=oldW?rect.width/oldW:1, ry=oldH?rect.height/oldH:1;
    points=points.map(p=>p?{x:p.x*rx,y:p.y*ry}:p);
    plumbX*=rx;
    setupCanvasDPR();
    if (points[4]) setPlumbFromAnkle();
    draw(); compute();
  });

  // ---------- AI（MoveNet + 大転子スナップ） ----------
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
      log('MoveNet 初期化完了（ローカル）');
      return detector;
    }catch(e){
      log('Detector初期化エラー: ' + (e?.message || e));
      return null;
    }
  }

  function getImageDataForCanvas(){
    const rect = canvas.getBoundingClientRect();
    const tmp = document.createElement('canvas');
    tmp.width = rect.width; tmp.height = rect.height;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0, rect.width, rect.height);
    return tctx.getImageData(0,0,rect.width,rect.height);
  }
  function sobelMagnitude(imgData,x,y){
    const {width,height,data}=imgData;
    if (x<=1||y<=1||x>=width-2||y>=height-2) return 0;
    const idx=(xx,yy)=>((yy*width+xx)<<2);
    const gray=i=>0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
    const g=[];
    for(let j=-1;j<=1;j++) for(let i=-1;i<=1;i++){ g.push(gray(idx(x+i,y+j))); }
    const gx=(-1*g[0]+g[2])+(-2*g[3]+2*g[5])+(-1*g[6]+g[8]);
    const gy=(-1*g[0]-2*g[1]-g[2])+(g[6]+2*g[7]+g[8]);
    return Math.hypot(gx,gy);
  }
  function estimateTrochanterByContour(imgData, hip, knee, side){
    const L=Math.hypot(knee.x-hip.x,knee.y-hip.y)||1;
    let nx=(knee.y-hip.y)/L, ny=-(knee.x-hip.x)/L;  // 体外側向き
    if (side==='left'){ nx=-nx; ny=-ny; }
    const rmin=Math.max(8,0.02*L);
    const rmax=Math.min(40,0.14*L);  // 控えめ
    let best={score:-1,x:hip.x,y:hip.y,r:0};
    for (let r=rmin;r<=rmax;r++){
      const x=Math.round(hip.x+nx*r), y=Math.round(hip.y+ny*r);
      const s=sobelMagnitude(imgData,x,y);
      const score=s + 0.03*(r-rmin); // 外側ボーナス弱め
      if (score>best.score) best={score,x,y,r};
    }
    if (!best || best.score<30 || best.r<0.02*L || best.r>0.2*L) return hip; // フォールバック
    return {x:best.x,y:best.y};
  }

  async function runAutoDetect(){
    if (!imgLoaded || !imgDataURL){ log("⚠️ 画像を先に読み込んでください。"); return; }
    const det = await ensureDetector(); if (!det) return;

    const tmp=new Image();
    tmp.onload=async()=>{
      try{
        const res=await det.estimatePoses(tmp,{flipHorizontal:false});
        const kps=res?.[0]?.keypoints; if(!kps){ log("⚠️ 検出失敗"); return; }

        const L=['left_ear','left_shoulder','left_hip','left_knee','left_ankle'];
        const R=['right_ear','right_shoulder','right_hip','right_knee','right_ankle'];
        const avg=names=>{let s=0,c=0; for(const n of names){const kp=kps.find(x=>x.name===n); if(kp?.score!=null){s+=kp.score;c++;}} return c?s/c:0;};
        let side=(sideSelect?.value==='left')?'left':(sideSelect?.value==='right')?'right':(avg(R)>avg(L)?'right':'left');
        const N=(side==='right')?R:L;
        const get=n=>kps.find(x=>x.name===n);

        const ear=get(N[0]), sh=get(N[1]), hipKP=get(N[2]), kneeKP=get(N[3]), ankleKP=get(N[4]);
        if (!(ear&&sh&&hipKP&&kneeKP&&ankleKP)){ log("⚠️ 必要ランドマーク不足"); return; }

        const rect=canvas.getBoundingClientRect();
        const iw=tmp.naturalWidth||tmp.width, ih=tmp.naturalHeight||tmp.height;
        const toC=kp=>({x:clamp(kp.x*(rect.width/iw),0,rect.width), y:clamp(kp.y*(rect.height/ih),0,rect.height)});
        const earC=toC(ear), shC=toC(sh), hipC0=toC(hipKP), kneeC=toC(kneeKP), ankleC=toC(ankleKP);

        const imgData=getImageDataForCanvas();
        const troC=estimateTrochanterByContour(imgData, hipC0, kneeC, side);

        points=[earC, shC, troC, kneeC, ankleC];

        setPlumbFromAnkle();
        draw(); compute(); log(`AI検出完了 side=${side}`);
      }catch(e){
        log("検出エラー: " + (e?.message || e));
      }
    };
    tmp.onerror=()=>log("⚠️ 画像の再ロードに失敗しました。");
    tmp.src=imgDataURL;
  }

  // ---------- クリック系 ----------
  document.querySelectorAll('input[name="lm"]').forEach(r=>{
    r.addEventListener('change', ()=> currentEdit = Number(r.value||0));
  });
  canvas.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    if (!imgLoaded) return;
    const p=getCanvasPoint(e);
    points[currentEdit]=p;
    if (currentEdit===4) setPlumbFromAnkle();
    draw(); compute();
  }, {passive:false});

  // ---------- Plumbイベント ----------
  plumbAtAnkleBtn?.addEventListener('click',()=>setPlumbFromAnkle());
  plumbOffset?.addEventListener('change',()=>{ if(points[4]) setPlumbFromAnkle(); });
  plumbXInput?.addEventListener('change', ()=>{
    const rect=canvas.getBoundingClientRect();
    plumbX=clamp(Number(plumbXInput.value||0),0,rect.width);
    draw(); compute();
  });
  centerPlumbBtn?.addEventListener('click', ()=>{
    const rect=canvas.getBoundingClientRect();
    plumbX=Math.round(rect.width/2);
    plumbXInput.value=plumbX;
    draw(); compute();
  });
  togglePlumb?.addEventListener('change', ()=>{
    showPlumb=togglePlumb.checked; draw();
  });

  // ---------- ボタン ----------
  aiBtn?.addEventListener('click', ()=>{ log("AIで自動抽出…"); runAutoDetect(); });
  clearBtn?.addEventListener('click', ()=>{
    points=[null,null,null,null,null]; imgLoaded=false; imgDataURL=null;
    plumbX=0; plumbXInput.value=0;
    metricsDiv.innerHTML=""; classDiv.innerHTML=""; classDefEl.innerHTML="";
    draw(); log("リセットしました。");
  });

  // ---------- 画像入力イベント ----------
  fileInput?.addEventListener('change', e=>{
    const f=e.target.files?.[0]; if (f) readBlobToDataURL(f);
  });

  // ---------- 初期化 ----------
  function init(){
    setupCanvasDPR();
    bindThresholdControls();
    draw();
    log("起動しました。画像を選択してください。");
  }
  init();

})();
