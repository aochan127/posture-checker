(() => {
  // UI refs
  const fileInput = document.getElementById('fileInput');
  const cameraBtn = document.getElementById('cameraBtn');
  const snapBtn = document.getElementById('snapBtn');
  const aiBtn = document.getElementById('aiBtn');
  const clearBtn = document.getElementById('clearBtn');
  const plumbXInput = document.getElementById('plumbX');
  const centerPlumbBtn = document.getElementById('centerPlumbBtn');
  const togglePlumb = document.getElementById('togglePlumb');
  const sideSelect = document.getElementById('sideSelect');

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const video = document.getElementById('video');
  const metricsDiv = document.getElementById('metrics');
  const classDiv = document.getElementById('classification');

  // Radio for editable landmark
  let currentEdit = 0;
  document.querySelectorAll('input[name="lm"]').forEach(r => {
    r.addEventListener('change', () => currentEdit = Number(r.value));
  });

  // State
  let img = new Image();
  let imgLoaded = false;
  let stream = null;
  let points = []; // 5 points
  let plumbX = 0;
  let showPlumb = true;

  const COLORS = ["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"]; // ear, shoulder, hip, knee, ankle
  const RADIUS = 14;

  // Draw
  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (imgLoaded) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    if (showPlumb && plumbX>0){
      ctx.save();
      ctx.strokeStyle = "rgba(30,41,59,.95)";
      ctx.setLineDash([8,6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(plumbX, 0);
      ctx.lineTo(plumbX, canvas.height);
      ctx.stroke();
      ctx.restore();
    }
    if (points.length >= 2){
      ctx.save();
      ctx.strokeStyle = "rgba(239,68,68,.8)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i=0;i<points.length-1;i++){
        const a = points[i], b = points[i+1];
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    }
    points.forEach((p,i)=>{
      if (!p) return;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = COLORS[i];
      ctx.arc(p.x, p.y, RADIUS, 0, Math.PI*2);
      ctx.fill();
      const label = String(i+1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,.85)";
      ctx.font = "bold 16px system-ui, -apple-system, Segoe UI, Noto Sans JP, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeText(label, p.x, p.y);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, p.x, p.y);
      ctx.restore();
    });
  }

  // Compute metrics and classify (heuristic)
  function compute(){
    if (points.filter(Boolean).length < 5 || plumbX<=0){
      metricsDiv.innerHTML = "<p>5点と鉛直線を設定してください。</p>";
      classDiv.innerHTML = "";
      return;
    }
    const [ear, shoulder, hip, knee, ankle] = points;
    const angle = Math.atan2(ear.y - shoulder.y, ear.x - shoulder.x) * 180/Math.PI;
    const angleES = Math.abs(90 - Math.abs(angle)); // FHA proxy
    const hipOffset = hip.x - plumbX;

    let type="判定不可";
    if (Math.abs(hipOffset) < 10 && angleES < 12) type = "Ideal";
    else if (angleES > 20 && hipOffset > 20) type = "Kyphotic-lordotic";
    else if (hipOffset < -10) type = "Sway-back";
    else type = "Flat-back";

    metricsDiv.innerHTML = `
      <p><b>FHA角度</b>: ${angleES.toFixed(1)}°</p>
      <p><b>大転子オフセット</b>: ${hipOffset.toFixed(0)} px</p>
    `;
    classDiv.innerHTML = `<p><b>${type}</b></p>`;
  }

  // Image load
  fileInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      img.onload = () => {
        imgLoaded = true;
        points = [];
        aiBtn.disabled = false;
        draw();
      };
      img.src = r.result;
    };
    r.readAsDataURL(f);
  });

  // Canvas click -> set selected landmark
  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    points[currentEdit] = {x,y};
    draw();
    compute();
  });

  // Plumb controls
  plumbXInput.addEventListener('change', () => {
    plumbX = Math.max(0, Math.min(canvas.width, Number(plumbXInput.value || 0)));
    draw(); compute();
  });
  centerPlumbBtn.addEventListener('click', () => {
    plumbX = Math.round(canvas.width/2);
    plumbXInput.value = plumbX;
    draw(); compute();
  });
  togglePlumb.addEventListener('change', () => {
    showPlumb = togglePlumb.checked;
    draw();
  });

  clearBtn.addEventListener('click', () => {
    points = [];
    imgLoaded = false;
    aiBtn.disabled = true;
    plumbX = 0;
    plumbXInput.value = 0;
    metricsDiv.innerHTML = "";
    classDiv.innerHTML = "";
    draw();
  });

  // ====== AI detection (MediaPipe Pose) ======
  let poseInstance = null;
  function ensurePose(){
    if (poseInstance) return poseInstance;
    if (!window.Pose){
      alert("MediaPipe Poseの読み込みに失敗しました。ネットワークをご確認ください。");
      return null;
    }
    // Base assets via CDN
    const base = "https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/";
    poseInstance = new window.Pose.Pose({locateFile: (file)=> base + file});
    poseInstance.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
      selfieMode: false
    });
    return poseInstance;
  }

  function sideByVisibility(ls){
    // indices: left ear 7, right ear 8, left shoulder 11, right shoulder 12, left hip 23, right hip 24, left knee 25, right knee 26, left ankle 27, right ankle 28
    function v(i){ return (ls[i] && typeof ls[i].visibility === 'number') ? ls[i].visibility : 0; }
    const leftScore  = v(7)+v(11)+v(23)+v(25)+v(27);
    const rightScore = v(8)+v(12)+v(24)+v(26)+v(28);
    return (leftScore >= rightScore) ? "left" : "right";
  }

  function pickIndex(side, leftIdx, rightIdx){
    if (side === "left") return leftIdx;
    if (side === "right") return rightIdx;
    return null;
  }

  async function runAIDetect(){
    const p = ensurePose();
    if (!p || !imgLoaded) return;

    // Draw the image into an offscreen canvas of the same size we use for rendering to keep coordinates consistent
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0, off.width, off.height);

    let results = null;
    p.onResults(r => { results = r; });
    await p.send({image: off});

    if (!results || !results.poseLandmarks){
      alert("ランドマークが検出できませんでした。別の写真でお試しください。");
      return;
    }
    const ls = results.poseLandmarks;

    let side = sideSelect.value;
    if (side === "auto"){
      side = sideByVisibility(ls);
    }

    const idxEar = side === "left" ? 7 : 8;
    const idxSh  = side === "left" ? 11: 12;
    const idxHip = side === "left" ? 23: 24;
    const idxKne = side === "left" ? 25: 26;
    const idxAnk = side === "left" ? 27: 28;

    const sel = [idxEar, idxSh, idxHip, idxKne, idxAnk].map(i => ls[i]);

    // landmarks are normalized [0..1]; map to canvas
    points = sel.map(lm => ({ x: lm.x * canvas.width, y: lm.y * canvas.height }));

    // Set a default plumb line near the ankle (slightly anterior, ~8px)
    plumbX = Math.round(points[4].x + 8);
    plumbXInput.value = plumbX;

    draw();
    compute();
  }

  aiBtn.addEventListener('click', runAIDetect);

  // Init
  draw();
})();