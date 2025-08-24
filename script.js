/* Posture Checker v3b – standalone script.js (full replace)
   - 画像読込（FileReader）
   - 手動ランドマーク（5点）
   - 鉛直線
   - FHA/大転子オフセットの計算
   - MoveNet(TFJS) ローカル同梱モデルでの自動抽出
*/

(() => {
  // ---------- DOM 取得 ----------
  const logEl = document.getElementById('log');
  const fileInputBtn = document.getElementById('fileInputBtn');
  const fileInputPlain = document.getElementById('fileInputPlain');
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

  // ---------- 状態 ----------
  let img = new Image();
  let imgLoaded = false;
  let imgDataURL = null;
  let points = []; // [{x,y}, ...] 0:耳,1:肩,2:大転子,3:膝,4:外果
  let currentEdit = 0;
  let plumbX = 0;
  let showPlumb = true;

  const COLORS = ["#ef4444", "#f59e0b", "#eab308", "#3b82f6", "#10b981"];
  const RADIUS = 14;

  // ---------- ユーティリティ ----------
  function log(msg) {
    if (!logEl) return;
    logEl.textContent += (logEl.textContent ? "\n" : "") + msg;
    logEl.scrollTop = logEl.scrollHeight;
    console.log(msg);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---------- 描画 ----------
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (imgLoaded) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // 鉛直線
    if (showPlumb && plumbX > 0) {
      ctx.save();
      ctx.strokeStyle = "rgba(30,41,59,.95)";
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(plumbX, 0);
      ctx.lineTo(plumbX, canvas.height);
      ctx.stroke();
      ctx.restore();
    }

    // 接続ライン（耳→肩→大転子→膝→外果）
    if (points.filter(Boolean).length >= 2) {
      ctx.save();
      ctx.strokeStyle = "rgba(239,68,68,.8)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ランドマーク
    points.forEach((p, i) => {
      if (!p) return;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = COLORS[i];
      ctx.arc(p.x, p.y, RADIUS, 0, Math.PI * 2);
      ctx.fill();

      const label = String(i + 1);
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

  // ---------- 計算 ----------
  function compute() {
    if (points.filter(Boolean).length < 5 || plumbX <= 0) {
      metricsDiv.innerHTML = "<p>5点と鉛直線を設定してください。</p>";
      classDiv.innerHTML = "";
      return;
    }
    const [ear, shoulder, hip, knee, ankle] = points;

    const angle = Math.atan2(ear.y - shoulder.y, ear.x - shoulder.x) * 180 / Math.PI;
    const fha = Math.abs(90 - Math.abs(angle)); // FHA (耳-肩の水平からの傾き)
    const hipOffset = hip.x - plumbX; // 大転子の鉛直線からのオフセット(+前/-後)

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

  // ---------- 入力（ファイル/キャンバス/UI） ----------
  document.querySelectorAll('input[name="lm"]').forEach(r =>
    r.addEventListener('change', () => currentEdit = Number(r.value || 0))
  );

  function handleDataURL(dataURL) {
    imgDataURL = dataURL;
    img = new Image();
    img.onload = () => {
      imgLoaded = true;
      points = [];
      if (aiBtn) aiBtn.disabled = false;
      draw();
      log("画像 onload 完了。");
    };
    img.onerror = () => log("⚠️ 画像の読み込みに失敗しました。");
    img.src = dataURL;
  }

  function handleFile(file) {
    if (!file) { log("⚠️ ファイル未選択"); return; }
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result !== "string") { log("⚠️ FileReader結果が文字列ではありません。"); return; }
      log("FileReader 読み込み成功。");
      handleDataURL(r.result);
    };
    r.onerror = () => log("⚠️ FileReader 読み込みに失敗しました。");
    r.readAsDataURL(file);
  }

  if (fileInputBtn) fileInputBtn.addEventListener('change', e => handleFile(e.target.files[0]));
  if (fileInputPlain) fileInputPlain.addEventListener('change', e => handleFile(e.target.files[0]));

  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, canvas.width);
    const y = clamp(e.clientY - rect.top, 0, canvas.height);
    points[currentEdit] = { x, y };
    draw(); compute();
  });

  if (plumbXInput) plumbXInput.addEventListener('change', () => {
    plumbX = clamp(Number(plumbXInput.value || 0), 0, canvas.width);
    draw(); compute();
  });
  if (centerPlumbBtn) centerPlumbBtn.addEventListener('click', () => {
    plumbX = Math.round(canvas.width / 2);
    if (plumbXInput) plumbXInput.value = plumbX;
    draw(); compute();
  });
  if (togglePlumb) togglePlumb.addEventListener('change', () => {
    showPlumb = togglePlumb.checked;
    draw();
  });

  if (clearBtn) clearBtn.addEventListener('click', () => {
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

  // ---------- AI：ローカルMoveNet 初期化 ----------
  let detector = null;

  function assertVendors() {
    const ok = !!(window.tf && window.poseDetection);
    if (!window.tf) log("⚠️ tf.min.js が読み込まれていません（/vendor/tf.min.js）");
    if (!window.poseDetection) log("⚠️ pose-detection.min.js が読み込まれていません（/vendor/pose-detection.min.js）");
    return ok;
  }

  async function ensureDetectorLocal() {
    if (detector) return detector;
    if (!assertVendors()) return null;

    try {
      // backend: webgl → cpu フォールバック
      try { await tf.setBackend('webgl'); } catch (e) { /* ignore */ }
      await tf.ready();
      if (tf.getBackend() !== 'webgl') {
        await tf.setBackend('cpu');
        await tf.ready();
      }
      log('TensorFlow.js backend: ' + tf.getBackend());

      const mt =
        (poseDetection.movenet?.modelType?.SINGLEPOSE_LIGHTNING) ||
        'SINGLEPOSE_LIGHTNING';

      detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        {
          runtime: 'tfjs',
          modelType: mt,
          modelUrl: './models/movenet/model.json', // ローカル参照
          enableSmoothing: true
        }
      );
      log('MoveNet detector 初期化完了（ローカル）');
      return detector;
    } catch (e) {
      log('Detector初期化エラー: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  // ---------- AI：自動抽出（5点へマッピング） ----------
  function pickSideKeypoints(kps) {
    // left/right それぞれの平均scoreで良い方を採用
    const LEFT = ['left_ear','left_shoulder','left_hip','left_knee','left_ankle'];
    const RIGHT = ['right_ear','right_shoulder','right_hip','right_knee','right_ankle'];

    function avgScore(names){
      let s=0,c=0;
      names.forEach(n=>{
        const kp = kps.find(x=>x.name===n);
        if(kp && kp.score!=null){ s+=kp.score; c++; }
      });
      return c? s/c : 0;
    }
    const leftAvg = avgScore(LEFT);
    const rightAvg = avgScore(RIGHT);

    const sideSel = (sideSelect && sideSelect.value) || 'auto';
    let useRight = false;
    if (sideSel === 'left') useRight = false;
    else if (sideSel === 'right') useRight = true;
    else useRight = (rightAvg > leftAvg);

    const names = useRight ? RIGHT : LEFT;
    const picked = {};
    names.forEach(n => {
      const kp = kps.find(x=>x.name===n);
      if (kp) picked[n] = kp;
    });
    return { picked, side: useRight ? 'right' : 'left' };
  }

  function mapToCanvasCoord(kp, imgW, imgH) {
    // canvas は画像をちょうど (0,0)-(cw,ch) にフィット描画している前提
    return {
      x: clamp(kp.x * (canvas.width  / imgW), 0, canvas.width),
      y: clamp(kp.y * (canvas.height / imgH), 0, canvas.height)
    };
  }

  async function runAutoDetect() {
    if (!imgLoaded || !imgDataURL) { log("⚠️ 先に画像を読み込んでください。"); return; }

    const det = await ensureDetectorLocal();
    if (!det) { log("⚠️ Detectorの用意に失敗しました。"); return; }

    // 画像をImage要素で処理（自然サイズを取得）
    const tmp = new Image();
    tmp.onload = async () => {
      try {
        const result = await det.estimatePoses(tmp, { flipHorizontal: false });
        if (!result || !result[0] || !result[0].keypoints) {
          log("⚠️ 検出結果が空です。");
          return;
        }
        const kps = result[0].keypoints;
        const { picked, side } = pickSideKeypoints(kps);

        // 5点にマッピング
        const ear   = picked[(side==='right')?'right_ear':'left_ear'];
        const sh    = picked[(side==='right')?'right_shoulder':'left_shoulder'];
        const hip   = picked[(side==='right')?'right_hip':'left_hip'];
        const knee  = picked[(side==='right')?'right_knee':'left_knee'];
        const ankle = picked[(side==='right')?'right_ankle':'left_ankle'];

        if (!(ear&&sh&&hip&&knee&&ankle)) {
          log("⚠️ 必要ランドマークを十分に検出できませんでした。");
          return;
        }

        const pEar   = mapToCanvasCoord(ear,   tmp.naturalWidth||tmp.width, tmp.naturalHeight||tmp.height);
        const pSh    = mapToCanvasCoord(sh,    tmp.naturalWidth||tmp.width, tmp.naturalHeight||tmp.height);
        const pHip   = mapToCanvasCoord(hip,   tmp.naturalWidth||tmp.width, tmp.naturalHeight||tmp.height);
        const pKnee  = mapToCanvasCoord(knee,  tmp.naturalWidth||tmp.width, tmp.naturalHeight||tmp.height);
        const pAnkle = mapToCanvasCoord(ankle, tmp.naturalWidth||tmp.width, tmp.naturalHeight||tmp.height);

        points = [pEar, pSh, pHip, pKnee, pAnkle];
        draw(); compute();
        log(`AI検出完了（side: ${side}）`);
      } catch (e) {
        log("検出エラー: " + (e && e.message ? e.message : e));
      }
    };
    tmp.onerror = () => log("⚠️ 画像の再ロードに失敗しました。");
    tmp.src = imgDataURL;
  }

  if (aiBtn) aiBtn.addEventListener('click', runAutoDetect);

  // ---------- 初期描画 ----------
  draw();
   // --- 強制クリック検知（ID違い/無効化に対応） ---
(function ensureAIBind(){
  // 1) クリックで常に拾う（#aiBtn か [data-ai-detect] にマッチしたら発火）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#aiBtn, [data-ai-detect]');
    if (!btn) return;
    log('AIボタン押下を検知しました。自動抽出を開始します。');
    runAutoDetect(); // ← 既存の関数を呼ぶ
  });

  // 2) 画像ロード後にAIボタンを有効化（ID違いでも data 属性で拾う）
  function enableAIButtons(){
    const b1 = document.getElementById('aiBtn');
    if (b1) b1.disabled = false;
    document.querySelectorAll('[data-ai-detect]').forEach(b => b.disabled = false);
  }

  // 画像onload時に enableAIButtons() を呼べるよう、既存の onload 後にも呼ぶ
  const _handleDataURL = window.__handleDataURL__ || null;
  // 既存コードで handleDataURL をローカルに持っている場合は以下で直接呼び出す
  // ここでは毎秒チェックしてボタンがあれば有効化（安全策）
  let tries = 0;
  const t = setInterval(() => {
    enableAIButtons();
    tries++;
    if (tries > 5) clearInterval(t);
  }, 800);
})();

})();
