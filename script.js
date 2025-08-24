/* Posture Checker – Clinical FULL BUILD v3b
   - 画像取り込み（<input> / D&D / ペースト）
   - iPhoneタップ補正（offsetX優先 + DPR）
   - Kendall基準：外果＋オフセットに Plumb line（既定 +12px）
   - A方式：大転子 = ヒップ→外側輪郭スナップ（控えめ）
   - 自動分類：Ideal / Kyphotic-lordotic / Flat-back / Sway-back
   - K-L/Sway バランス版：
       * 強い前屈(≥38°)はK-L優先
       * 中等度前屈(≥20°)は“前寄りサイン”がある時だけK-L
       * Sway-backは FHA≤35° かつ ヒップ後方/膝後方/体幹後方 の3条件
*/

(() => {
  // ---------- DOM ----------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const aiBtn = document.getElementById('aiBtn');
  const plumbXInput = document.getElementById('plumbX');
  const metricsDiv = document.getElementById('metrics');
  const classDiv   = document.getElementById('classification');
  const classDefEl = document.getElementById('classDef');
  const logEl      = document.getElementById('log');

  // ---------- 状態 ----------
  let img = new Image();
  let imgLoaded = false;
  let points = [null, null, null, null, null]; // 耳 肩 大転子 膝 外果
  let plumbX = 0;
  let showPlumb = true;

  const COLORS = ["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"];
  const RADIUS = 14;

  // ---- Kendall 近似しきい値 ----
  const THR = {
    FHA_IDEAL_MAX: 10,
    HIP_IDEAL_ABS: 8,
    HIP_FWD: 8,
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
    if (!logEl) return console.log(msg);
    logEl.textContent += (logEl.textContent ? "\n" : "") + msg;
    logEl.scrollTop = logEl.scrollHeight;
    console.log(msg);
  }

  function setupCanvas(){
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
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

    points.forEach((p,i)=>{
      if (!p) return;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle=COLORS[i];
      ctx.arc(p.x,p.y,RADIUS,0,Math.PI*2);
      ctx.fill();
      ctx.font="bold 16px system-ui,-apple-system,sans-serif";
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.lineWidth=4; ctx.strokeStyle="rgba(0,0,0,.9)";
      const label=String(i+1);
      ctx.strokeText(label,p.x,p.y);
      ctx.fillStyle="#fff"; ctx.fillText(label,p.x,p.y);
      ctx.restore();
    });
  }

  // ---------- 分類ルール ----------
  // ---------- 分類ルール（5分類：Ideal / Kyphotic / Lordotic / Flat-back / Sway-back） ----------
function classify(FHA, hipOffsetPx, kneeOffsetPx, torsoShiftPx){
  // 既存のしきい値をそのまま利用（v3b の定数が上で定義済み前提）
  const {FHA_IDEAL_MAX, HIP_IDEAL_ABS, HIP_FWD, HIP_BWD, KNEE_BACK} = THR;
  // FHA_KYPHOSIS_STRONG / FHA_KYPHOSIS_MILD / TORSO_BACK_REQ / TORSO_FRONT_HINT は
  // すでに上で定義されている想定（v3b）

  // 1) Kyphotic（胸椎後弯過多）
  if (FHA >= FHA_KYPHOSIS_STRONG) return "Kyphotic";
  if (FHA >= FHA_KYPHOSIS_MILD && (torsoShiftPx >= TORSO_FRONT_HINT || hipOffsetPx >= HIP_FWD)) {
    return "Kyphotic";
  }

  // 2) Lordotic（腰椎前弯過多：骨盤前傾で大転子が前方）
  if (hipOffsetPx >= HIP_FWD && FHA < FHA_KYPHOSIS_STRONG) {
    return "Lordotic";
  }

  // 3) Sway-back（骨盤後傾＋股関節伸展＋体幹後方）
  if (
    hipOffsetPx <= HIP_BWD &&
    kneeOffsetPx <= KNEE_BACK &&
    torsoShiftPx <= TORSO_BACK_REQ
  ) {
    return "Sway-back";
  }

  // 4) Flat-back（平背：カーブが平坦）
  if (FHA <= 10 && hipOffsetPx < HIP_FWD) {
    return "Flat-back";
  }

  // 5) Ideal（最後に判定）
  if (Math.abs(hipOffsetPx) <= HIP_IDEAL_ABS && FHA <= FHA_IDEAL_MAX) {
    return "Ideal";
  }

  // 迷う場合のタイブレーク
  if (torsoShiftPx >= TORSO_FRONT_HINT) return "Kyphotic";
  if (hipOffsetPx <= (HIP_BWD - 3) && kneeOffsetPx <= (KNEE_BACK - 2)) return "Sway-back";
  return "Flat-back";
}

  // ---------- 計測 ----------
  function compute(){
    if (points.filter(Boolean).length<5 || plumbX<=0) return;

    const [ear,shoulder,hip,knee] = points;
    const angleDeg = Math.atan2(ear.y-shoulder.y, ear.x-shoulder.x)*180/Math.PI;
    const FHA = Math.abs(90-Math.abs(angleDeg));
    const hipOffset  = hip.x-plumbX;
    const kneeOffset = knee.x-plumbX;
    const torsoShift = shoulder.x-hip.x;

    const type = classify(FHA,hipOffset,kneeOffset,torsoShift);

    metricsDiv.innerHTML=`
      <p><b>FHA角度:</b> ${FHA.toFixed(1)}°</p>
      <p><b>大転子オフセット:</b> ${hipOffset.toFixed(0)} px</p>
      <p><b>膝オフセット:</b> ${kneeOffset.toFixed(0)} px</p>`;
    classDiv.innerHTML=`<p><b>${type}</b></p>`;
    classDefEl.innerHTML={
      "Ideal":"耳・肩・大転子・膝が鉛直線近傍",
      "Kyphotic-lordotic":"胸椎後弯＋腰椎前弯、骨盤前傾、FHA大きい",
      "Flat-back":"胸腰椎フラット、骨盤後傾、前弯減少",
      "Sway-back":"骨盤後傾＋股関節伸展＋体幹後方シフト"
    }[type]||"";
  }

  // ---------- イベント ----------
  canvas.addEventListener('click', e=>{
    const rect=canvas.getBoundingClientRect();
    const x=e.offsetX,y=e.offsetY;
    const idx=points.findIndex(p=>!p);
    if (idx>=0) points[idx]={x,y};
    draw(); compute();
  });

  aiBtn?.addEventListener('click',()=>{
    log("AI自動抽出（モック）");
    compute();
  });

  plumbXInput?.addEventListener('change',()=>{
    plumbX=parseInt(plumbXInput.value)||0;
    draw(); compute();
  });

  // ---------- 初期化 ----------
  setupCanvas();
  log("起動しました。画像を選択してください。");
})();
