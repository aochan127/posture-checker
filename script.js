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
