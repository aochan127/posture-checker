/* Kendall Posture Checker — 5分類・診断版 v2
   画像読込まわりを堅牢化＆詳細ログ追加
*/

(() => {
  // ---------- DOM ----------
  const $ = s => document.querySelector(s);
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');

  const fileInput = $('#fileInput');
  const aiBtn = $('#aiBtn');
  const clearBtn = $('#clearBtn');
  const sideSelect = $('#sideSelect');

  const plumbXInput = $('#plumbX');
  const centerPlumbBtn = $('#centerPlumbBtn');
  const togglePlumb = $('#togglePlumb');
  const plumbOffset = $('#plumbOffset');
  const plumbAtAnkleBtn = $('#plumbAtAnkleBtn');

  const thrFhaIdeal = $('#thrFhaIdeal');
  const thrHipNeutral = $('#thrHipNeutral');
  const thrHipFwd = $('#thrHipFwd');
  const thrHipBwd = $('#thrHipBwd');
  const thrKneeBack = $('#thrKneeBack');
  const vFhaIdeal = $('#vFhaIdeal');
  const vHipNeutral = $('#vHipNeutral');
  const vHipFwd = $('#vHipFwd');
  const vHipBwd = $('#vHipBwd');
  const vKneeBack = $('#vKneeBack');
  const thrReset = $('#thrReset');

  const metricsDiv = $('#metrics');
  const classDiv = $('#classification');
  const classDefEl = $('#classDef');
  const logEl = $('#log');

  // ---------- 状態 ----------
  let img = new Image();
  let imgLoaded = false;
  let imgDataURL = null;
  let points = [null,null,null,null,null]; // 耳 肩 大転子 膝 外果
  let currentEdit = 0;
  let plumbX = 0;
  let showPlumb = true;
  let detector = null;

  const COLORS = ["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"];
  const RADIUS = 14;

  // ---- しきい値 ----
  const THR = {
    FHA_IDEAL_MAX: 10,
    HIP_IDEAL_ABS: 8,
    HIP_FWD: 10,
    HIP_BWD: -15,
    KNEE_BACK: -2
  };
  const FHA_KYPHOSIS_STRONG = 38;
  const FHA_KYPHOSIS_MILD   = 20;
  const FHA_SWAY_MAX        = 35;
  const TORSO_BACK_REQ      = -6;
  const TORSO_FRONT_HINT    = +6;

  // ---------- Utils ----------
  function log(msg){
    if (logEl) {
      logEl.value = (logEl.value ? logEl.value + "\n" : "") + msg;
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

  // ---------- 5分類 ----------
  function classify(FHA, hipOffsetPx, kneeOffsetPx, torsoShiftPx){
    const {FHA_IDEAL_MAX, HIP_IDEAL_ABS, HIP_FWD, HIP_BWD, KNEE_BACK} = THR;

    if (FHA >= FHA_KYPHOSIS_STRONG) return "Kyphotic";
    if (FHA >= FHA_KYPHOSIS_MILD && torsoShiftPx >= TORSO_FRONT_HINT) return "Kyphotic";

    if (Math.abs(hipOffsetPx) <= HIP_IDEAL_ABS && FHA <= FHA_IDEAL_MAX) return "Ideal";

    if (
      FHA <= FHA_SWAY_MAX &&
      hipOffsetPx <= HIP_BWD &&
      kneeOffsetPx <= KNEE_BACK &&
      torsoShiftPx <= TORSO_BACK_REQ
    ) return "Sway-back";

    if (hipOffsetPx >= HIP_FWD && FHA < FHA_KYPHOSIS_STRONG) return "Lordotic";

    if (FHA <= 10 && hipOffsetPx < HIP_FWD) return "Flat-back";

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

    const angleDeg = Math.atan2(ear.y-shoulder.y, ear.x-shoulder.x)*180/Math.PI;
    const FHA = Math.abs(90-Math.abs(angleDeg));

    const hipOffsetPx  = hip.x  - plumbX;
    const kneeOffsetPx = knee.x - plumbX;
    const torsoShiftPx = shoulder.x - hip.x;

    const type = classify(FHA, hipOffsetPx, kneeOffsetPx, torsoShiftPx);

    metricsDiv.innerHTML=`
      <p><b>FHA角度</b>: ${FHA.toFixed(1)}°</p>
      <p><b>大転子オフセット</b>: ${hipOffsetPx.toFixed(0)} px</p>
      <p><b>膝オフセット</b>: ${kneeOffsetPx.toFixed(0)} px</p>
    `;
    classDiv.textContent = type;

    const DEF = {
      "Ideal"     : "耳・肩・大転子・膝が鉛直線近傍。",
      "Kyphotic"  : "胸椎後弯↑（体幹前方/頭部前方）。",
      "Lordotic"  : "腰椎前弯↑・骨盤前傾（ヒップ前方）。",
      "Flat-back" : "胸腰椎カーブが平坦、骨盤後傾傾向。",
      "Sway-back" : "骨盤後傾＋股関節伸展＋体幹後方。"
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
    log(`FileReader 結果: dataURL length=${dataURL.length}`);
    img.onload = ()=>{
      imgLoaded = true;
      log(`画像 onload 完了: natural=${img.naturalWidth}x${img.naturalHeight}`);
      setupCanvasDPR();
      points = [null,null,null,null,null];
      aiBtn.disabled = false;
      draw();
    };
    img.onerror = ()=> log("⚠️ 画像の読み込みに失敗しました（img.onerror）");
    img.src = dataURL;
  }
  function readBlobToDataURL(blob){
    if (blob.type && !/^image\//i.test(blob.type)){
      log(`⚠️ 画像ではありません（type=${blob.type}）`);
      return;
    }
    log(`FileReader 開始: ${blob.name||'(no name)'} size=${blob.size} type=${blob.type}`);
    const r = new FileReader();
    r.onload = ()=> { if (typeof r.result === 'string') handleDataURL(r.result); };
    r.onerror = ()=> log("⚠️ FileReader エラー（読み取り失敗）");
    r.readAsDataURL(blob);
  }

  // a) <input>
  fileInput?.addEventListener('change', e=>{
    const f=e.target.files?.[0];
    if (f) readBlobToDataURL(f);
    else log("⚠️ fileInput: ファイル未選択");
  });
  // b) ドキュメント全体の change（iOSの挙動対策）
  document.addEventListener('change', e=>{
    const t=e.target;
    if (t && t.type==='file'){ const f=t.files?.[0]; if (f){ log("document.change 経由で拾いました"); readBlobToDataURL(f); } }
  }, true);
  // c) D&D
  function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
  ['dragenter','dragover','dragleave','drop'].forEach(ev=>{
    document.addEventListener(ev, preventDefaults, false);
    canvas.addEventListener(ev, preventDefaults, false);
  });
  document.addEventListener('drop', e=>{
    const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith('image/'));
    if (f) readBlobToDataURL(f);
  });
  // d) ペースト
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
    if (!imgLoaded) { log("⚠️ まず画像を読み込んでください"); return; }
    const p=getCanvasPoint(e);
    points[currentEdit]=p;
    if (currentEdit===4) setPlumbFromAnkle();
    draw(); compute();
  }, {passive:false});

  // ---------- リセット＆リサイズ ----------
  clearBtn?.addEventListener('click', ()=>{
    points=[null,null,null,null,null];
    imgLoaded=false; imgDataURL=null;
    aiBtn.disabled=true;
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

  // ---------- AI（MoveNet） ----------
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
    let nx=(knee.y-hip.y)/L, ny=-(knee.x-hip.x)/L;
    if (side==='left'){ nx=-nx; ny=-ny; }
    const rmin=Math.max(8,0.02*L);
    const rmax=Math.min(40,0.14*L);
    let best={score:-1,x:hip.x,y:hip.y,r:0};
    for (let r=rmin;r<=rmax;r++){
      const x=Math.round(hip.x+nx*r), y=Math.round(hip.y+ny*r);
      const s=sobelMagnitude(imgData,x,y);
      const score=s + 0.03*(r-rmin);
      if (score>best.score) best={score,x,y,r};
    }
    if (!best || best.score<30 || best.r<0.02*L || best.r>0.2*L) return hip;
    return {x:best.x,y:best.y};
  }

  async function runAutoDetect(){
    if (!imgLoaded || !imgDataURL){ log("⚠️ 先に画像を読み込んでください"); return; }
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

  // ---------- その他イベント ----------
  document.querySelectorAll('input[name="lm"]').forEach(r=>{
    r.addEventListener('change', ()=> currentEdit = Number(r.value||0));
  });
  canvas.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    if (!imgLoaded) { log("⚠️ まず画像を読み込んでください"); return; }
    const p=getCanvasPoint(e);
    points[currentEdit]=p;
    if (currentEdit===4) setPlumbFromAnkle();
    draw(); compute();
  }, {passive:false});

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

  aiBtn?.addEventListener('click', ()=>{ log("AIで自動抽出…"); runAutoDetect(); });
  clearBtn?.addEventListener('click', ()=>{
    points=[null,null,null,null,null];
    imgLoaded=false; imgDataURL=null;
    aiBtn.disabled=true;
    plumbX=0; plumbXInput.value=0;
    metricsDiv.innerHTML=""; classDiv.innerHTML=""; classDefEl.innerHTML="";
    draw(); log("リセットしました。");
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
