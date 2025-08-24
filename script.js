(() => {
  const logEl = document.getElementById('log');
  const fileInput = document.getElementById('fileInput');
  const aiBtn = document.getElementById('aiBtn');
  const clearBtn = document.getElementById('clearBtn');
  const plumbXInput = document.getElementById('plumbX');
  const centerPlumbBtn = document.getElementById('centerPlumbBtn');
  const togglePlumb = document.getElementById('togglePlumb');
  const sideSelect = document.getElementById('sideSelect');

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const metricsDiv = document.getElementById('metrics');
  const classDiv = document.getElementById('classification');

  let currentEdit = 0;
  document.querySelectorAll('input[name=\"lm\"]').forEach(r => r.addEventListener('change', ()=> currentEdit = Number(r.value)));

  let img = new Image();
  let imgLoaded = false;
  let points = [];
  let plumbX = 0;
  let showPlumb = true;

  const COLORS = [\"#ef4444\",\"#f59e0b\",\"#eab308\",\"#3b82f6\",\"#10b981\"]; // ear, shoulder, hip, knee, ankle
  const RADIUS = 14;

  function log(msg){ logEl.textContent += (logEl.textContent ? \"\\n\" : \"\") + msg; logEl.scrollTop = logEl.scrollHeight; }

  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (imgLoaded) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    if (showPlumb && plumbX>0){
      ctx.save();
      ctx.strokeStyle = \"rgba(30,41,59,.95)\";
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
      ctx.strokeStyle = \"rgba(239,68,68,.8)\";
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
      ctx.strokeStyle = \"rgba(0,0,0,.85)\";
      ctx.font = \"bold 16px system-ui, -apple-system, Segoe UI, Noto Sans JP, sans-serif\";
      ctx.textAlign = \"center\";
      ctx.textBaseline = \"middle\";
      ctx.strokeText(label, p.x, p.y);
      ctx.fillStyle = \"#fff\";
      ctx.fillText(label, p.x, p.y);
      ctx.restore();
    });
  }

  function compute(){
    if (points.filter(Boolean).length < 5 || plumbX<=0){
      metricsDiv.innerHTML = \"<p>5点と鉛直線を設定してください。</p>\";
      classDiv.innerHTML = \"\";
      return;
    }
    const [ear, shoulder, hip, knee, ankle] = points;
    const angle = Math.atan2(ear.y - shoulder.y, ear.x - shoulder.x) * 180/Math.PI;
    const angleES = Math.abs(90 - Math.abs(angle)); // FHA proxy
    const hipOffset = hip.x - plumbX;

    let type=\"判定不可\";
    if (Math.abs(hipOffset) < 10 && angleES < 12) type = \"Ideal\";
    else if (angleES > 20 && hipOffset > 20) type = \"Kyphotic-lordotic\";
    else if (hipOffset < -10) type = \"Sway-back\";
    else type = \"Flat-back\";

    metricsDiv.innerHTML = `
      <p><b>FHA角度</b>: ${angleES.toFixed(1)}°</p>
      <p><b>大転子オフセット</b>: ${hipOffset.toFixed(0)} px</p>
    `;
    classDiv.innerHTML = `<p><b>${type}</b></p>`;
  }

  // ==== v3bの画像読み込み ====
  fileInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f){ log(\"⚠️ ファイル未選択\"); return; }
    const r = new FileReader();
    r.onload = () => {
      img = new Image();
      img.onload = () => {
        imgLoaded = true;
        points = [];
        aiBtn.disabled = false;
        draw();
        log(\"画像を読み込みました。AIボタンが有効になりました。\");
      };
      img.onerror = () => { log(\"⚠️ 画像読み込みに失敗しました。\"); };
      img.src = r.result;
    };
    r.onerror = () => log(\"⚠️ FileReader 読み込みに失敗しました。\");
    r.readAsDataURL(f);
  });

  // キャンバスクリックでランドマーク修正
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
    metricsDiv.innerHTML = \"\";
    classDiv.innerHTML = \"\";
    draw();
    log(\"リセットしました。\"); 
  });

  // ====== ローカル同梱のAIを使用 ======
  let detector=null;
  function assertVendors(){
    const ok = !!(window.tf && window.poseDetection);
    if(!window.tf) log(\"⚠️ tf.min.js が読み込まれていません。/vendor/tf.min.js を配置してください。\");
    if(!window.poseDetection) log(\"⚠️ pose-detection.min.js が読み込まれていません。/vendor/pose-detection.min.js を配置してください。\");
    return ok;
  }
  async function ensureDetectorLocal(){
    if(detector) return detector;
    if(!assertVendors()) return null;
    try{
      await tf.setBackend('webgl'); await tf.ready();
      log('TensorFlow.js backend: '+tf.getBackend());
      detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
        modelType: 'Lightning',
        runtime: 'tfjs',
        modelUrl: './models/movenet/model.json' // ← ローカルモデル
      });
      log('MoveNet detector 初期化完了（ローカル）。');
      return detector;
    }catch(e){
      log('⚠️ Detector初期化エラー: '+e.message+'（models/movenet/ 以下に model.json と bin を配置しているか確認）');
      return null;
    }
  }

  function sideByScore(kps){
    const map=Object.fromEntries(kps.map(k=>[k.name,k]));
    const ls=['left_ear','left_shoulder','left_hip','left_knee','left_ankle'].reduce((s,n)=>s+(map[n]?.score||0),0);
    const rs=['right_ear','right_shoulder','right_hip','right_knee','right_ankle'].reduce((s,n)=>s+(map[n]?.score||0),0);
    return (ls>=rs)?'left':'right';
  }

  async function runAIDetect(){
    try{
      if(!imgLoaded){ log(\"⚠️ 先に画像を読み込んでください。\"); return; }
      const det = await ensureDetectorLocal(); if(!det) return;
      const off=document.createElement('canvas'); off.width=canvas.width; off.height=canvas.height;
      const octx=off.getContext('2d'); octx.drawImage(img,0,0,off.width,off.height);
      const poses = await det.estimatePoses(off,{flipHorizontal:false});
      if(!poses || !poses.length){ log(\"⚠️ 検出できませんでした。全身が写る横向き写真でお試しください。\"); return; }
      const kp=poses[0].keypoints; let side=sideSelect.value; if(side==='auto') side=sideByScore(kp);
      const map=Object.fromEntries(kp.map(k=>[k.name,k]));
      const sel = side==='left' ? [map['left_ear'],map['left_shoulder'],map['left_hip'],map['left_knee'],map['left_ankle']] : [map['right_ear'],map['right_shoulder'],map['right_hip'],map['right_knee'],map['right_ankle']];
      points = sel.map(k => ({x:k.x, y:k.y}));
      plumbX = Math.round(points[4].x + 8); plumbXInput.value = plumbX;
      draw(); compute(); log(`AI検出完了（側: ${side}）。`);
    }catch(e){ log(\"AIエラー: \"+(e && e.message ? e.message : e)); }
  }

  aiBtn.addEventListener('click', runAIDetect);
  draw();
})();