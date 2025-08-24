/* Posture Checker v3b – standalone script.js (ALL-IN-ONE)
   - 画像読込（FileReader：iPhone対策で通常inputもOK）
   - DPR対応（iPhoneのタップずれ解消）
   - 手動ランドマーク5点（耳/肩/大転子/膝/外果）＋修正
   - 鉛直線の表示/数値入力/中央寄せ
   - FHA・大転子オフセット算出＋簡易分類
   - MoveNet(TFJS) ローカル同梱モデルで自動抽出（CPUフォールバック）
*/

(() => {
  // ---------- DOM ----------
  const logEl = document.getElementById('log');
  const fileInputBtn = document.getElementById('fileInputBtn');     // ボタン型input
  const fileInputPlain = document.getElementById('fileInputPlain'); // 通常input（iPhone対策）
  const aiBtn = document.getElementById('aiBtn');
  const clearBtn = document.getElementById('clearBtn');
  const plumbXInput = document.getElementById('plumbX');
  const centerPlumbBtn = document.getElementById('centerPlumbBtn');
  const togglePlumb = document.getElementById('togglePlumb');
  const sideSelect = document.getElementById('sideSelect'); // auto/left/right
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const metricsDiv = document.getElementById('metrics');
  const classDiv = document.getElementById('classification');

  // ---------- 状態 ----------
  let img = new Image();
  let imgLoaded = false;
  let imgDataURL = null;
  let points = []; // [{x,y}, ...] 0:耳 1:肩 2:大転子 3:膝 4:外果
  let currentEdit = 0; // 修正対象
  let plumbX = 0;
  let showPlumb = true;

  // 表示
  const COLORS = ["#ef4444", "#f59e0b", "#eab308", "#3b82f6", "#10b981"];
  const RADIUS = 14;

  // ---------- ユーティリティ ----------
  function log(msg) {
    if (!logEl) return;
    logEl.textContent += (logEl.textContent ? "\n" : "") + msg;
    logEl.scrollTop = logEl.scrollHeight;
    console.log(msg);
  }
  function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

  // DPR対応のキャンバス初期化（タップずれ防止）
  function setupCanvasDPR() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // 内部ピクセル解像度だけ上げる
    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    // 以後はCSSピクセルで記述できるようにスケール
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // pointer/touch/mouse をキャンバス座標(CSS px)へ
  function getCanvasPoint(evt){
    const rect = canvas.getBoundingClientRect();
    let cx, cy;
    if (evt.touches?.[0]) { cx = evt.touches[0].clientX; cy = evt.touches[0].clientY; }
    else if (evt.changedTouches?.[0]) { cx = evt.changedTouches[0].clientX; cy = evt.changedTouches[0].clientY; }
    else { cx = evt.clientX; cy = evt.clientY; }
    const x = clamp(cx - rect.left, 0, rect.width);
    const y = clamp(cy - rect.top,  0, rect.height);
    return { x, y };
  }

  // ---------- 描画 ----------
  function draw(){
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0,0,rect.width,rect.height);

    if (imgLoaded){
      // 画像はキャンバスCSSサイズちょうどにフィット表示
      ctx.drawImage(img, 0, 0, rect.width, rect.height);
    }

    // 鉛直線
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
    const valid = points.filter(Boolean);
    if (valid.length >= 2){
      ctx.save();
      ctx.strokeStyle = "rgba(239,68,68,.85)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i=0;i<points.length-1;i++){
        const a=points[i], b=points[i+1];
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ランドマーク描画（番号は白＋黒縁）
    points.forEach((p,i)=>{
      if(!p) return;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = COLORS[i];
      ctx.arc(p.x,p.y,RADIUS,0,Math.PI*2);
      ctx.fill();

      ctx.font = "bold 16px system-ui, -apple-system, Segoe UI, Noto Sans JP, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = String(i+1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,.9)";
      ctx.strokeText(label,p.x,p.y);
      ctx.fillStyle = "#fff";
      ctx.fillText(label,p.x,p.y);
      ctx.restore();
    });
  }

  // ---------- 計算 ----------
  function compute(){
    if (points.filter(Boolean).length < 5 || plumbX <= 0){
      metricsDiv.innerHTML = "<p>5点と鉛直線を設定してください。</p>";
      classDiv.innerHTML = "";
      return;
    }
    const [ear, shoulder, hip, knee, ankle] = points;

    // FHA（耳-肩）の角度（簡易）
    const angle = Math.atan2(ear.y - shoulder.y, ear.x - shoulder.x) * 180/Math.PI;
    const fha = Math.abs(90 - Math.abs(angle));

    // 大転子の鉛直線からの水平距離（+前/-後）
    const hipOffset = hip.x - plumbX;

    // 超簡易分類
    let type = "判定不可";
    if (Math.abs(hipOffset) < 10 && fha < 12) type = "Ideal";
    else if (fha > 20 && hipOffset > 20) type = "Kyphotic-lordotic";
    else if (hipOffset < -10) type = "Sway-back";
    else type = "Flat-back";

    metricsDiv.innerHTML = `
      <p><b>FHA角度</b>: ${fha.toFixed(1)}°</p>
      <p><b>大転子オフセット</b>: ${hipOffset.toFixed(0)} px</p>
    `;
    classDiv.innerHTML = `<p><b>${type}</b></p>`;
  }

  // ---------- 入力（ファイル/ボタン/タップ） ----------
  // ラジオ：編集対象ランドマーク
  document.querySelectorAll('input[name="lm"]').forEach(r=>{
    r.addEventListener('change', ()=> currentEdit = Number(r.value||0));
  });

  // 画像をDataURLで受け取り
  function handleDataURL(dataURL){
    imgDataURL = dataURL;
    img = new Image();
    img.onload = () => {
      // 画像が表示される領域のサイズでDPR初期化
      setupCanvasDPR();
      imgLoaded = true;
      points = [];
      if (aiBtn) aiBtn.disabled = false;
      draw();
      log("画像 onload 完了。");
    };
    img.onerror = ()=> log("⚠️ 画像の読み込みに失敗しました。");
    img.src = dataURL;
  }

  // ファイルを読み込む
  function handleFile(file){
    if (!file){ log("⚠️ ファイル未選択"); return; }
    const r = new FileReader();
    r.onload = ()=>{
      if (typeof r.result !== "string"){ log("⚠️ FileReader結果が文字列ではありません。"); return; }
      log("FileReader 読み込み成功。");
      handleDataURL(r.result);
    };
    r.onerror = ()=> log("⚠️ FileReader 読み込みに失敗しました。");
    r.readAsDataURL(file);
  }

  if (fileInputBtn)   fileInputBtn.addEventListener('change', e=> handleFile(e.target.files[0]));
  if (fileInputPlain) fileInputPlain.addEventListener('change', e=> handleFile(e.target.files[0]));

  // タップでランドマーク修正（ズレないpointer）
  canvas.addEventListener('pointerdown', (e)=>{
    e.preventDefault();
    if (!imgLoaded) return;
    const p = getCanvasPoint(e);
    points[currentEdit] = p;
    draw(); compute();
  }, { passive:false });

  // 鉛直線
  if (plumbXInput) plumbXInput.addEventListener('change', ()=>{
    const rect = canvas.getBoundingClientRect();
    plumbX = clamp(Number(plumbXInput.value||0), 0, rect.width);
    draw(); compute();
  });
  if (centerPlumbBtn) centerPlumbBtn.addEventListener('click', ()=>{
    const rect = canvas.getBoundingClientRect();
    plumbX = Math.round(rect.width/2);
    if (plumbXInput) plumbXInput.value = plumbX;
    draw(); compute();
  });
  if (togglePlumb) togglePlumb.addEventListener('change', ()=>{
    showPlumb = togglePlumb.checked;
    draw();
  });

  // リセット
  if (clearBtn) clearBtn.addEventListener('click', ()=>{
    points = [];
    imgLoaded = false;
    imgDataURL = null;
    if (aiBtn) aiBtn.disabled = true;
    plumbX = 0;
    if (plumbXInput) plumbXInput.value = 0;
    metricsDiv.innerHTML = "";
    classDiv.innerHTML = "";
    draw();
    log("リセットしました。");
  });

  // ウィンドウリサイズ時（比率維持）
  window.addEventListener('resize', ()=>{
    if (!imgLoaded) return;
    const dpr = window.devicePixelRatio || 1;
    const oldW = canvas.width/dpr, oldH = canvas.height/dpr;
    const rect = canvas.getBoundingClientRect();
    const rx = oldW ? rect.width/oldW : 1;
    const ry = oldH ? rect.height/oldH : 1;
    points = points.map(p => p ? {x:p.x*rx, y:p.y*ry} : p);
    plumbX *= rx;
    setupCanvasDPR();
    draw(); compute();
  });

  // ---------- AI: MoveNet(TFJS) ----------
  let detector = null;

  function assertVendors(){
    const ok = !!(window.tf && window.poseDetection);
    if (!window.tf) log("⚠️ tf.min.js が読み込まれていません（/vendor/tf.min.js）");
    if (!window.poseDetection) log("⚠️ pose-detection.min.js が読み込まれていません（/vendor/pose-detection.min.js）");
    return ok;
  }

  async function ensureDetectorLocal(){
    if (detector) return detector;
    if (!assertVendors()) return null;

    try{
      // backend: webgl → cpu
      try { await tf.setBackend('webgl'); } catch(e){}
      await tf.ready();
      if (tf.getBackend() !== 'webgl'){
        await tf.setBackend('cpu');
        await tf.ready();
      }
      log('TensorFlow.js backend: ' + tf.getBackend());

      // モデルタイプ表記差を吸収
      const mt = (poseDetection.movenet?.modelType?.SINGLEPOSE_LIGHTNING) || 'SINGLEPOSE_LIGHTNING';

      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {
          runtime: 'tfjs',
          modelType: mt,
          modelUrl: './models/movenet/model.json',
          enableSmoothing: true
        }
      );
      log('MoveNet detector 初期化完了（ローカル）');
      return detector;
    }catch(e){
      log('Detector初期化エラー: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  // 片側キー点を選ぶ
  function pickSideKeypoints(kps){
    const L = ['left_ear','left_shoulder','left_hip','left_knee','left_ankle'];
    const R = ['right_ear','right_shoulder','right_hip','right_knee','right_ankle'];
    const avg = names => {
      let s=0,c=0; names.forEach(n=>{ const kp=kps.find(x=>x.name===n); if(kp?.score!=null){ s+=kp.score; c++; }});
      return c? s/c : 0;
    };
    const sideSel = (sideSelect && sideSelect.value) || 'auto';
    let useRight;
    if (sideSel==='left') useRight=false;
    else if (sideSel==='right') useRight=true;
    else useRight = (avg(R) > avg(L));
    const names = useRight? R : L;
    const picked = {};
    names.forEach(n=>{ const kp=kps.find(x=>x.name===n); if(kp) picked[n]=kp; });
    return { picked, side: useRight?'right':'left' };
  }

  // キャンバス座標へマッピング
  function mapToCanvasCoord(kp, imgW, imgH){
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp(kp.x * (rect.width  / imgW), 0, rect.width),
      y: clamp(kp.y * (rect.height / imgH), 0, rect.height),
    };
  }

  async function runAutoDetect(){
    if (!imgLoaded || !imgDataURL){ log("⚠️ 先に画像を読み込んでください。"); return; }

    const det = await ensureDetectorLocal();
    if (!det){ log("⚠️ Detectorの用意に失敗しました。"); return; }

    const tmp = new Image();
    tmp.onload = async ()=>{
      try{
        const res = await det.estimatePoses(tmp, { flipHorizontal:false });
        const kps = res?.[0]?.keypoints;
        if (!kps){ log("⚠️ 検出結果が空です。"); return; }

        const { picked, side } = pickSideKeypoints(kps);
        const ear   = picked[(side==='right')?'right_ear':'left_ear'];
        const sh    = picked[(side==='right')?'right_shoulder':'left_shoulder'];
        const hip   = picked[(side==='right')?'right_hip':'left_hip'];
        const knee  = picked[(side==='right')?'right_knee':'left_knee'];
        const ankle = picked[(side==='right')?'right_ankle':'left_ankle'];
        if (!(ear&&sh&&hip&&knee&&ankle)){ log("⚠️ 必要ランドマークを十分に検出できませんでした。"); return; }

        const iw = tmp.naturalWidth||tmp.width, ih = tmp.naturalHeight||tmp.height;
        points = [
          mapToCanvasCoord(ear,   iw, ih),
          mapToCanvasCoord(sh,    iw, ih),
          mapToCanvasCoord(hip,   iw, ih),
          mapToCanvasCoord(knee,  iw, ih),
          mapToCanvasCoord(ankle, iw, ih)
        ];

        draw(); compute();
        log(`AI検出完了（side: ${side}）`);
      }catch(e){
        log("検出エラー: " + (e && e.message ? e.message : e));
      }
    };
    tmp.onerror = ()=> log("⚠️ 画像の再ロードに失敗しました。");
    tmp.src = imgDataURL;
  }

  // --- AIボタン押下を確実に拾う（ID or data属性どちらでも） ---
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('#aiBtn, [data-ai-detect]');
    if (!btn) return;
    log('AIボタン押下を検知しました。自動抽出を開始します。');
    runAutoDetect();
  });

  // 初期描画
  setupCanvasDPR();
  draw();
})();





// ============================================================
// Kendal Posture Checker (with AI + iPhone tap fix)
// ============================================================

// キャンバスとコンテキスト
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// 入力画像
const img = new Image();
let imgLoaded = false;

// 5点ランドマーク
let points = [null, null, null, null, null];
let currentEdit = 0;

// ランドマークの色と番号
const colors = ["red", "orange", "yellow", "blue", "green"];

// ========== 画像読み込み ==========

function loadImage(file) {
  const reader = new FileReader();
  reader.onload = e => {
    img.onload = () => {
      imgLoaded = true;
      resizeCanvas();
      draw();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

document.getElementById('fileInput').addEventListener('change', e => {
  if (e.target.files[0]) loadImage(e.target.files[0]);
});

// キャンバスサイズを画像に合わせる
function resizeCanvas() {
  canvas.width = img.width;
  canvas.height = img.height;
}

// ========== 描画処理 ==========

function draw() {
  if (!imgLoaded) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);

  // 縦の基準線（鉛直線）
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 2;
  const x = canvas.width / 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();

  // 各ランドマーク
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    ctx.beginPath();
    ctx.fillStyle = colors[i];
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000";
    ctx.stroke();

    // 番号（中央に白文字＋黒縁）
    ctx.fillStyle = "white";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "black";
    ctx.lineWidth = 4;
    ctx.strokeText((i + 1).toString(), p.x, p.y);
    ctx.fillText((i + 1).toString(), p.x, p.y);
  }

  // 接続線
  ctx.strokeStyle = "red";
  ctx.lineWidth = 3;
  ctx.beginPath();
  let first = true;
  for (let p of points) {
    if (!p) continue;
    if (first) { ctx.moveTo(p.x, p.y); first = false; }
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

// ========== iPhoneタップ補正付き 座標取得 ==========

function getCanvasPoint(evt) {
  // Safari対応: offsetX/offsetY を優先
  if (typeof evt.offsetX === 'number' && evt.target === canvas) {
    const x = Math.max(0, Math.min(canvas.width, evt.offsetX));
    const y = Math.max(0, Math.min(canvas.height, evt.offsetY));
    return { x, y };
  }

  // fallback
  const rect = canvas.getBoundingClientRect();
  let cx, cy;
  if (evt.touches?.[0]) {
    cx = evt.touches[0].clientX; cy = evt.touches[0].clientY;
  } else if (evt.changedTouches?.[0]) {
    cx = evt.changedTouches[0].clientX; cy = evt.changedTouches[0].clientY;
  } else {
    cx = evt.clientX; cy = evt.clientY;
  }
  const x = Math.max(0, Math.min(canvas.width,  (cx - rect.left) * (canvas.width / rect.width)));
  const y = Math.max(0, Math.min(canvas.height, (cy - rect.top)  * (canvas.height / rect.height)));
  return { x, y };
}

// ========== タップイベント ==========

canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (!imgLoaded) return;
  const p = getCanvasPoint(e);
  points[currentEdit] = p;
  draw();
  compute();
}, { passive: false });

// ========== AI自動抽出 ==========

async function runAutoDetect() {
  if (!imgLoaded) return;

  if (!window.poseDetection || !window.tf) {
    log("⚠️ AIライブラリが読み込まれていません");
    return;
  }

  log("AI Detector 初期化開始…");

  const detector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
  );

  const poses = await detector.estimatePoses(img);
  if (!poses.length) {
    log("⚠️ ポーズを検出できませんでした");
    return;
  }

  const kp = poses[0].keypoints;
  // ここでランドマーク座標を拾って points に入れる
  points[0] = { x: kp[0].x, y: kp[0].y };  // 耳（近似で鼻/耳）
  points[1] = { x: kp[6].x, y: kp[6].y };  // 肩
  points[2] = { x: kp[12].x, y: kp[12].y }; // 大転子（腰近似）
  points[3] = { x: kp[14].x, y: kp[14].y }; // 膝
  points[4] = { x: kp[16].x, y: kp[16].y }; // 足首

  draw();
  compute();
  log("AI自動抽出 完了");
}

// ========== 結果計算（ダミー版） ==========

function compute() {
  const result = document.getElementById('result');
  result.innerText = "FHA角度: 0° / 大転子オフセット: 0px\n(計算ロジックは省略)";
}

// ========== ログ出力 ==========

function log(msg) {
  const logBox = document.getElementById('log');
  logBox.value += msg + "\n";
  logBox.scrollTop = logBox.scrollHeight;
}

// AIボタン
document.getElementById('aiBtn').addEventListener('click', runAutoDetect);
