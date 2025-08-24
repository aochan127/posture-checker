/* posture-checker all-in-one + FIT + 5-classes + EXIF(paste) + Rotate (2025-08-24)
   ✅ iPhone対応/高DPR/EXIF回転補正（アップロード/ドラッグ&ドロップ/ペースト）
   ✅ ドラッグ編集/Undo&Redo/拡大鏡（長押し）
   ✅ MoveNet自動抽出 + 左右サイドの妥当性スコア補強 + UIオーバーライド
   ✅ 外果±オフセット（膝×外果で前方符号自動）
   ✅ しきい値スライダー/臨床表示
   ✅ mm換算（身長法/物差し法）
   ✅ 画像アスペクト比維持（レターボックス表示）
   ✅ 軽量化：描画はrequestAnimationFrameで集約、resizeはデバウンス
   ✅ 分類：Ideal + Kypho-lordotic + Lordotic + Flat-back + Sway-back（計5区分）
   ✅ 手動回転（左/右90°）ボタン（存在しなければ自動生成）
   依存: tf.min.js → pose-detection.min.js → script.js
   モデル: ./models/movenet/model.json
*/
(() => {
  console.log("posture-checker loaded v=full-rotate-20250824");

  // ===== DOM =====
  const canvas = document.getElementById('canvas');
  const ctx    = canvas.getContext('2d');

  const aiBtn  = document.getElementById('aiBtn');
  const clearBtn = document.getElementById('clearBtn');

  const plumbXInput     = document.getElementById('plumbX');
  const centerPlumbBtn  = document.getElementById('centerPlumbBtn');
  const togglePlumb     = document.getElementById('togglePlumb');
  const plumbOffset     = document.getElementById('plumbOffset');
  const plumbAtAnkleBtn = document.getElementById('plumbAtAnkleBtn');

  const sideSelect = document.getElementById('sideSelect'); // "auto"|"left"|"right"
  const metricsDiv = document.getElementById('metrics');
  const classDiv   = document.getElementById('classification');
  const logEl      = document.getElementById('log');

  // しきい値 UI（無ければスキップ）
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

  // Undo/Redo（任意）
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');

  // mm換算（任意UI）
  const scaleHeightCm = document.getElementById('scaleHeightCm');
  const scaleBodyPix  = document.getElementById('scaleBodyPix');
  const scaleRefPx    = document.getElementById('scaleRefPx');
  const scaleRefMm    = document.getElementById('scaleRefMm');

  // ===== 状態 =====
  let img = new Image();
  let imgLoaded  = false;
  let imgDataURL = null;

  // 手動5点（0:耳,1:肩峰,2:大転子,3:膝,4:外果）
  let points = [null,null,null,null,null];
  let pointSources = [null,null,null,null,null]; // 'auto' or 'manual'
  let currentEdit = 0;

  // プラムライン
  let plumbX = 0;
  let showPlumb = true;

  // AI
  let detector = null;
  let lastDet  = null; // {kps, iw, ih}
  let lastSide = 'auto';
  let lastAnteriorSign = 1;

  // mm換算
  let PX_PER_MM = null; // px→mm

  // 描画スタイル（小さめ）
  const COLORS    = ["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"];
  const RADIUS    = 7;     // 丸の半径
  const FONT_SIZE = 13;    // 番号フォント

  // magnifier（長押し）
  let magnifier = { active:false, x:0, y:0, scale:2.0, r:60, timer:null };

  // ドラッグ
  let drag = { idx:-1, active:false };

  // Undo/Redo
  const history = [];
  const future  = [];
  function snapshot(){
    history.push(JSON.stringify({points, plumbX}));
    if (history.length>100) history.shift();
    future.length = 0;
  }
  function restore(stateStr){
    try{
      const s = JSON.parse(stateStr);
      points = s.points.map(p=> p? {x:p.x,y:p.y}:p);
      plumbX = s.plumbX||0;
      requestDraw(); compute();
    }catch(e){ log("⚠️ Undo/Redo失敗: " + e); }
  }

  // 計測キャッシュ
  let lastMetrics = null;

  // 画像フィット（レターボックス）情報
  let imgFit = { dx:0, dy:0, dw:0, dh:0, iw:0, ih:0, sx:1, sy:1 };
  function updateImageFit(){
    const rect = canvas.getBoundingClientRect();
    const cw = rect.width, ch = rect.height;
    const iw = imgFit.iw || (img?.naturalWidth  || img?.width  || cw);
    const ih = imgFit.ih || (img?.naturalHeight || img?.height || ch);
    const scale = Math.min(cw/iw, ch/ih);
    const dw = Math.round(iw * scale);
    const dh = Math.round(ih * scale);
    const dx = Math.round((cw - dw)/2);
    const dy = Math.round((ch - dh)/2);
    imgFit = { dx, dy, dw, dh, iw, ih, sx: dw/iw, sy: dh/ih };
  }

  // ===== 軽量化：描画は rAF に集約 =====
  let drawQueued = false;
  function requestDraw(){
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(()=>{ drawQueued=false; draw(); });
  }

  // ===== ユーティリティ =====
  function log(msg){
    try{
      if (logEl && 'value' in logEl){
        logEl.value += (logEl.value? "\n":"")+msg;
        logEl.scrollTop = logEl.scrollHeight;
      } else if (logEl){
        logEl.textContent += (logEl.textContent? "\n":"")+msg;
        logEl.scrollTop = logEl.scrollHeight;
      }
    }catch{}
    // console.log(msg); // 重ければコメントアウト
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

  // ===== EXIF Orientation 読み取り（JPEGのみ） =====
  async function getExifOrientation(blob){
    try{
      const ab = await blob.arrayBuffer();
      const view = new DataView(ab);
      if (view.getUint16(0,false) !== 0xFFD8) return 1; // not JPEG
      let offset = 2;
      while (offset < view.byteLength){
        const marker = view.getUint16(offset,false); offset += 2;
        const size   = view.getUint16(offset,false); offset += 2;
        if (marker === 0xFFE1){
          if (view.getUint32(offset,false) !== 0x45786966) break; // "Exif"
          offset += 6;
          const tiff = offset;
          const little = (view.getUint16(tiff,false) === 0x4949);
          const get16 = (o)=>view.getUint16(o, little);
          const get32 = (o)=>view.getUint32(o, little);
          const ifd0 = tiff + get32(tiff+4);
          const entries = get16(ifd0);
          for (let i=0;i<entries;i++){
            const entry = ifd0 + 2 + i*12;
            const tag = get16(entry);
            if (tag===0x0112){ const val = get16(entry+8); return val || 1; }
          }
          break;
        } else {
          offset += size - 2;
        }
      }
      return 1;
    }catch{ return 1; }
  }
  function drawWithOrientationToDataURL(url, orientation){
  return new Promise((resolve,reject)=>{
    const im = new Image();
    im.onload = ()=>{
      const w = im.naturalWidth || im.width;
      const h = im.naturalHeight|| im.height;

      // 回転系は先にキャンバスサイズを決め、translate → rotate の順で統一
      let outW = w, outH = h;
      if (orientation===5 || orientation===6 || orientation===7 || orientation===8){
        outW = h; outH = w;   // 90°系は幅高を入れ替え
      }
      const off = document.createElement('canvas');
      off.width = outW; off.height = outH;
      const ctx = off.getContext('2d');

      ctx.save();
      switch(orientation){
        case 2: // Mirror horizontal
          ctx.translate(outW, 0);
          ctx.scale(-1, 1);
          break;
        case 3: // Rotate 180
          ctx.translate(outW, outH);
          ctx.rotate(Math.PI);
          break;
        case 4: // Mirror vertical
          ctx.translate(0, outH);
          ctx.scale(1, -1);
          break;
        case 5: // Mirror horizontal and rotate 90 CW
          ctx.translate(outW, 0);
          ctx.scale(-1, 1);
          ctx.rotate(Math.PI/2);
          ctx.translate(0, -h);
          break;
        case 6: // Rotate 90 CW（←iPhone縦撮りで多い）
          ctx.translate(outW, 0);
          ctx.rotate(Math.PI/2);
          ctx.translate(0, -h);
          break;
        case 7: // Mirror horizontal and rotate 90 CCW
          ctx.translate(0, outH);
          ctx.scale(1, -1);
          ctx.rotate(-Math.PI/2);
          ctx.translate(-w, 0);
          break;
        case 8: // Rotate 90 CCW
          ctx.translate(0, outH);
          ctx.rotate(-Math.PI/2);
          ctx.translate(-w, 0);
          break;
        default: // 1 or unknown: そのまま
          // 変換なし
          break;
      }
      ctx.drawImage(im, 0, 0);
      ctx.restore();

      // 念のため：EXIFが壊れていてまだ横なら、縦長推定で追加回転
      // 「人物の全身写真＝縦長が多い」前提の保険
      if ((orientation===6 || orientation===8) && off.width > off.height){
        const off2 = document.createElement('canvas');
        off2.width = off.height; off2.height = off.width;
        const c2 = off2.getContext('2d');
        c2.translate(off2.width, 0);
        c2.rotate(Math.PI/2);
        c2.drawImage(off, 0, 0);
        resolve(off2.toDataURL('image/jpeg', 0.95));
        return;
      }

      resolve(off.toDataURL('image/jpeg', 0.95));
    };
    im.onerror = reject;
    im.src = url;
  });
}
        octx.drawImage(im,0,0);
        octx.restore();
        resolve(off.toDataURL('image/jpeg', 0.95));
      };
      im.onerror = reject;
      im.src = url;
    });
  }

  // ===== 描画 =====
  function draw(){
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0,0,rect.width,rect.height);

    // 画像（アスペクト比維持のfit描画）
    if (imgLoaded){
      ctx.drawImage(img, imgFit.dx, imgFit.dy, imgFit.dw, imgFit.dh);
    }

    // プラムライン
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

    // 接続線
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

    // ノード
    points.forEach((p,i)=>{
      if (!p) return;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = COLORS[i];
      ctx.arc(p.x,p.y,RADIUS,0,Math.PI*2);
      ctx.fill();

      // 番号（白・黒縁）
      ctx.font = `bold ${FONT_SIZE}px system-ui,-apple-system,Segoe UI,Noto Sans JP,sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,.9)";
      const label = String(i+1);
      ctx.strokeText(label,p.x,p.y);
      ctx.fillStyle = "#fff";
      ctx.fillText(label,p.x,p.y);
      ctx.restore();
    });

    // magnifier
    if (magnifier.active){
      const r = magnifier.r;
      ctx.save();
      ctx.beginPath();
      ctx.arc(magnifier.x, magnifier.y, r, 0, Math.PI*2);
      ctx.clip();
      ctx.save();
      ctx.translate(magnifier.x, magnifier.y);
      ctx.scale(magnifier.scale, magnifier.scale);
      ctx.translate(-magnifier.x, -magnifier.y);
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.beginPath(); ctx.arc(magnifier.x, magnifier.y, r, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(magnifier.x - r, magnifier.y);
      ctx.lineTo(magnifier.x + r, magnifier.y);
      ctx.moveTo(magnifier.x, magnifier.y - r);
      ctx.lineTo(magnifier.x, magnifier.y + r);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ===== しきい値 =====
  const THR = {
    FHA_IDEAL_MAX: 12,
    FHA_FORWARD_HD: 20,
    HIP_IDEAL_ABS: 10,
    HIP_FWD: 10,
    HIP_BWD: -10,
    KNEE_BACK: -5
  };

  // 追加の閾値（UIなしで内部固定）
  const EXTRA = {
    LORD_FHA_MAX: 18,   // Lordotic扱いする最大FHA（Kypho-lordoticよりは小さめ）
    KNEE_NEAR_BACK: -6  // 膝がほぼ中立（後方へ最大 -6px を許容）
  };

  function bindThresholdControls(){
    if (!thrFhaIdeal) return;
    const sync=()=>{
      vFhaIdeal && (vFhaIdeal.textContent=THR.FHA_IDEAL_MAX);
      vFhaFwd   && (vFhaFwd.textContent=THR.FHA_FORWARD_HD);
      vHipNeutral && (vHipNeutral.textContent=THR.HIP_IDEAL_ABS);
      vHipFwd   && (vHipFwd.textContent=THR.HIP_FWD);
      vHipBwd   && (vHipBwd.textContent=THR.HIP_BWD);
      vKneeBack && (vKneeBack.textContent=THR.KNEE_BACK);
    };
    thrFhaIdeal.value=THR.FHA_IDEAL_MAX;
    thrFhaFwd.value=THR.FHA_FORWARD_HD;
    thrHipNeutral.value=THR.HIP_IDEAL_ABS;
    thrHipFwd.value=THR.HIP_FWD;
    thrHipBwd.value=THR.HIP_BWD;
    thrKneeBack.value=THR.KNEE_BACK;
    sync();
    const hook=(el,key,cast=Number)=> el.addEventListener('input',()=>{
      THR[key]=cast(el.value); if(key==='HIP_IDEAL_ABS') THR[key]=Math.abs(THR[key]);
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

  // ===== mm換算 =====
  function recomputeScale(){
    const refPx = Number(scaleRefPx?.value || NaN);
    const refMm = Number(scaleRefMm?.value || NaN);
    if (!isNaN(refPx) && refPx>0 && !isNaN(refMm) && refMm>0){
      PX_PER_MM = refPx / refMm; return;
    }
    const hCm = Number(scaleHeightCm?.value || NaN);
    const bodyPix = Number(scaleBodyPix?.value || NaN);
    if (!isNaN(hCm) && hCm>0 && !isNaN(bodyPix) && bodyPix>0){
      PX_PER_MM = bodyPix / (hCm*10.0); return;
    }
    PX_PER_MM = null;
  }
  [scaleRefPx,scaleRefMm,scaleHeightCm,scaleBodyPix].forEach(el=>{
    el?.addEventListener('change', ()=>{ recomputeScale(); compute(); });
  });
  function pxToMm(px){ return PX_PER_MM ? px / PX_PER_MM : null; }

  // ===== 計測 & 判定（5区分） =====
  function compute(){
    if (points.filter(Boolean).length<5 || plumbX<=0){
      metricsDiv && (metricsDiv.innerHTML="<p>5点と鉛直線を設定してください。</p>");
      classDiv && (classDiv.innerHTML="");
      const cd=document.getElementById('classDef'); if(cd) cd.innerHTML="";
      return;
    }
    const [ear, shoulder, hip, knee] = points;
    const angleDeg = Math.atan2(ear.y - shoulder.y, ear.x - shoulder.x) * 180/Math.PI;
    const FHA = Math.abs(90 - Math.abs(angleDeg));   // Head-Forward Angle の近似
    const hipOffsetPx  = hip.x  - plumbX;            // + = 前方, - = 後方
    const kneeOffsetPx = knee.x - plumbX;

    const {FHA_IDEAL_MAX,FHA_FORWARD_HD,HIP_IDEAL_ABS,HIP_FWD,HIP_BWD,KNEE_BACK} = THR;

    // === 分類（Ideal + 4分類）
    let type = "判定不可";

    // 0) Ideal（最優先）
    if (Math.abs(hipOffsetPx) <= HIP_IDEAL_ABS && FHA <= FHA_IDEAL_MAX){
      type = "Ideal";
    }
    // 1) Kyphotic–lordotic：FHA大 + 骨盤前傾（大転子前）
    else if (FHA > FHA_FORWARD_HD && hipOffsetPx >= HIP_FWD){
      type = "Kyphotic-lordotic";
    }
    // 2) Lordotic：FHAは中等度以下（≲18°） + 大転子前方 + 膝が明らかな後方でない
    else if (FHA <= EXTRA.LORD_FHA_MAX && hipOffsetPx >= HIP_FWD && kneeOffsetPx >= EXTRA.KNEE_NEAR_BACK){
      type = "Lordotic";
    }
    // 3) Sway-back：大転子が後方かつ膝も後方
    else if (hipOffsetPx <= HIP_BWD && kneeOffsetPx <= KNEE_BACK){
      type = "Sway-back";
    }
    // 4) Flat-back：FHA小さめ（≲10°）+ 骨盤後傾〜中立
    else if (FHA < 10 && hipOffsetPx < HIP_FWD){
      type = "Flat-back";
    }
    // 5) 境界ケース：膝が後方寄りならSway-back、そうでなければFlat-backへ
    else {
      type = (kneeOffsetPx <= 0) ? "Sway-back" : "Flat-back";
    }

    // mm表示（任意）
    const hipOffsetMm  = pxToMm(hipOffsetPx);
    const kneeOffsetMm = pxToMm(kneeOffsetPx);
    const showMm = (v)=> v!=null ? ` (${v.toFixed(1)} mm)` : "";

    metricsDiv && (metricsDiv.innerHTML = `
      <p><b>FHA角度</b>: ${FHA.toFixed(1)}°</p>
      <p><b>大転子オフセット</b>: ${hipOffsetPx.toFixed(0)} px${showMm(hipOffsetMm)}</p>
      <p><b>膝オフセット</b>: ${kneeOffsetPx.toFixed(0)} px${showMm(kneeOffsetMm)}</p>
    `);
    classDiv && (classDiv.innerHTML = `<p><b>${type}</b></p>`);

    const defs = {
      "Ideal": `耳・肩峰・大転子・膝が鉛直線近傍。FHA≲${FHA_IDEAL_MAX}°、大転子±${HIP_IDEAL_ABS}px以内。`,
      "Kyphotic-lordotic": `胸椎後弯↑＋腰椎前弯↑、骨盤前傾。FHA>${FHA_FORWARD_HD}° かつ大転子が前方（+${HIP_FWD}px以上）。`,
      "Lordotic": `腰椎前弯↑が優位。FHAは中等度以下（≲${EXTRA.LORD_FHA_MAX}°）、大転子は前方、膝は中立〜前方寄り。`,
      "Flat-back": "胸椎後弯↓・腰椎前弯↓、骨盤後傾。FHA<10°で平坦、中立〜やや後方。",
      "Sway-back": `骨盤後傾＋股伸展で体幹後方。大転子が線より後（${HIP_BWD}px以下）、膝も後方（${KNEE_BACK}px以下）。`
    };
    const cd=document.getElementById('classDef');
    if (cd) cd.innerHTML = defs[type] || "";

    lastMetrics = { FHA, hipOffsetPx, kneeOffsetPx, type };
  }

  // ===== 画像読み込み（EXIF補正対応） =====
  async function handleBlobWithExif(blob){
    const url = URL.createObjectURL(blob);
    try{
      const o = await getExifOrientation(blob);
      const dataURL = await blobToDataURL(blob);
      if (o===1){
        handleDataURL(dataURL);
      }else{
        const fixedURL = await drawWithOrientationToDataURL(dataURL, o);
        handleDataURL(fixedURL);
        log(`EXIF Orientation=${o} を補正しました。`);
      }
    }catch(e){
      const dataURL = await blobToDataURL(blob);
      handleDataURL(dataURL);
    }finally{
      URL.revokeObjectURL(url);
    }
  }
  function blobToDataURL(blob){
    return new Promise((resolve,reject)=>{
      const r = new FileReader();
      r.onload  = ()=> (typeof r.result==='string') ? resolve(r.result) : reject(new Error("not string"));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function handleDataURL(dataURL){
    imgDataURL = dataURL;
    img.onload = ()=>{
      imgLoaded=true;
      imgFit.iw = img.naturalWidth || img.width;
      imgFit.ih = img.naturalHeight|| img.height;
      setupCanvasDPR();
      updateImageFit();
      points=[null,null,null,null,null];
      pointSources=[null,null,null,null,null];
      aiBtn && (aiBtn.disabled=false);
      requestDraw(); log("画像 onload 完了。");
      recomputeScale();
    };
    img.onerror = ()=> log("⚠️ 画像読み込み失敗");
    img.src = dataURL;
  }

  // ===== 画像入力（ファイル選択 / D&D / ペースト） =====
  document.addEventListener('change',e=>{
    const t=e.target; if (t?.type==='file'){ const f=t.files?.[0]; if(f){
      // JPEGはEXIF補正、それ以外は素直に読み込み
      if (/image\/jpe?g/i.test(f.type)) handleBlobWithExif(f);
      else blobToDataURL(f).then(handleDataURL);
    }}
  },true);

  function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
  ['dragenter','dragover','dragleave','drop'].forEach(ev=>{
    document.addEventListener(ev, preventDefaults, false);
    canvas.addEventListener(ev, preventDefaults, false);
  });
  document.addEventListener('drop', e=>{
    const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith('image/'));
    if (f){
      if (/image\/jpe?g/i.test(f.type)) handleBlobWithExif(f);
      else blobToDataURL(f).then(handleDataURL);
    }
  });

  // ★ ペーストもJPEGならEXIF補正に変更
  document.addEventListener('paste', e=>{
    const items=e.clipboardData?.items||[];
    for (const it of items){
      if (!it.type?.startsWith('image/')) continue;
      const b = it.getAsFile();
      if (!b) continue;
      if (/image\/jpe?g/i.test(b.type)) {
        handleBlobWithExif(b);
      } else {
        blobToDataURL(b).then(handleDataURL);
      }
      return;
    }
  });

  // ===== 手動回転（UIが無ければ自動生成） =====
  async function rotateCurrentImage(dir){ // dir = +1 (右90°) or -1 (左90°)
    if (!imgDataURL) { log("画像がありません"); return; }
    const src = new Image();
    src.onload = ()=>{
      const w = src.naturalWidth || src.width;
      const h = src.naturalHeight|| src.height;
      const off = document.createElement('canvas');
      off.width  = h;
      off.height = w;
      const octx = off.getContext('2d');
      octx.save();
      if (dir>0){ // 右90°
        octx.translate(h,0);
        octx.rotate(Math.PI/2);
      }else{      // 左90°
        octx.translate(0,w);
        octx.rotate(-Math.PI/2);
      }
      octx.drawImage(src,0,0);
      octx.restore();
      handleDataURL(off.toDataURL('image/jpeg',0.95));
      log(`画像を${dir>0?'右':'左'}90°回転しました。`);
    };
    src.onerror = ()=> log("回転用の画像ロードに失敗しました");
    src.src = imgDataURL;
  }
  // ボタンが無ければ簡易ボタンを自動生成
  (function ensureRotateButtons(){
    const l = document.getElementById('rotateL');
    const r = document.getElementById('rotateR');
    if (l && r) return;
    const wrap = document.createElement('div');
    wrap.style.display='flex'; wrap.style.gap='6px'; wrap.style.margin='6px 0';
    const bl = document.createElement('button'); bl.id='rotateL'; bl.textContent='⟲ 左90°';
    const br = document.createElement('button'); br.id='rotateR'; br.textContent='⟳ 右90°';
    wrap.appendChild(bl); wrap.appendChild(br);
    // 置き場所：canvasの直前 or body先頭
    const parent = canvas?.parentElement || document.body;
    parent.insertBefore(wrap, canvas);
  })();
  document.getElementById('rotateL')?.addEventListener('click', ()=>rotateCurrentImage(-1));
  document.getElementById('rotateR')?.addEventListener('click', ()=>rotateCurrentImage(+1));

  // ===== 手動プロット & ドラッグ =====
  document.querySelectorAll('input[name="lm"]').forEach(r=>{
    r.addEventListener('change', ()=> currentEdit = Number(r.value||0));
  });

  function hitTest(pt){
    const H = Math.max(RADIUS*1.8, 16);
    let best = {idx:-1, dist:1e9};
    points.forEach((p,i)=>{
      if (!p) return;
      const dx=p.x-pt.x, dy=p.y-pt.y;
      const d2=dx*dx+dy*dy;
      if (d2<best.dist && d2<=H*H) best={idx:i, dist:d2};
    });
    return best.idx;
  }

  // 画像矩形外クリックを最近傍にクランプ
  function clampToImageRect(p){
    const x = clamp(p.x, imgFit.dx, imgFit.dx + imgFit.dw);
    const y = clamp(p.y, imgFit.dy, imgFit.dy + imgFit.dh);
    return {x,y};
  }

  function startMagnifier(x,y){
    magnifier.x=x; magnifier.y=y; magnifier.active=true; requestDraw();
  }
  function stopMagnifier(){
    magnifier.active=false; requestDraw();
  }

  canvas.addEventListener('pointerdown', e=>{
    e.preventDefault();
    if (!imgLoaded) return;
    let p = getCanvasPoint(e);
    p = clampToImageRect(p);
    const hitIdx = hitTest(p);

    magnifier.timer && clearTimeout(magnifier.timer);
    magnifier.timer = setTimeout(()=> startMagnifier(p.x,p.y), 350);

    snapshot();

    if (hitIdx>=0){
      drag.idx = hitIdx; drag.active = true;
      currentEdit = hitIdx;
    }else{
      points[currentEdit] = p;
      pointSources[currentEdit]='manual';
      if (currentEdit===4) setPlumbFromAnkle();
      requestDraw(); compute();
    }
  }, {passive:false});

  canvas.addEventListener('pointermove', e=>{
    if (!imgLoaded) return;
    let p = getCanvasPoint(e);
    p = clampToImageRect(p);
    if (magnifier.active){
      magnifier.x=p.x; magnifier.y=p.y; requestDraw();
    }
    if (!drag.active) return;
    points[drag.idx] = p;
    pointSources[drag.idx]='manual';
    if (drag.idx===4) setPlumbFromAnkle();
    requestDraw(); compute();
  });

  function endPointer(){
    magnifier.timer && clearTimeout(magnifier.timer);
    if (magnifier.active) stopMagnifier();
    if (drag.active){
      drag.active=false; drag.idx=-1;
    }
  }
  canvas.addEventListener('pointerup',   endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave',  endPointer);

  // Undo/Redo
  undoBtn?.addEventListener('click', ()=>{
    if (!history.length) { log("⚠️ Undo できません"); return; }
    future.push(JSON.stringify({points, plumbX}));
    const s = history.pop();
    restore(s);
  });
  redoBtn?.addEventListener('click', ()=>{
    if (!future.length) { log("⚠️ Redo できません"); return; }
    history.push(JSON.stringify({points, plumbX}));
    const s = future.pop();
    restore(s);
  });

  // ===== プラムライン操作 =====
  plumbXInput && plumbXInput.addEventListener('change', ()=>{
    const rect=canvas.getBoundingClientRect();
    plumbX = clamp(Number(plumbXInput.value||0), 0, rect.width);
    snapshot(); requestDraw(); compute();
  });
  centerPlumbBtn && centerPlumbBtn.addEventListener('click', ()=>{
    const rect=canvas.getBoundingClientRect();
    snapshot();
    plumbX = Math.round(rect.width/2);
    plumbXInput && (plumbXInput.value=plumbX);
    requestDraw(); compute();
  });
  togglePlumb && togglePlumb.addEventListener('change', ()=>{
    showPlumb = togglePlumb.checked; requestDraw();
  });
  plumbAtAnkleBtn && plumbAtAnkleBtn.addEventListener('click', ()=> { snapshot(); setPlumbFromAnkle(); });
  plumbOffset && plumbOffset.addEventListener('change', ()=> { if(points[4]) { snapshot(); setPlumbFromAnkle(); } });

  // 膝×外果で“前方”方向を推定して外果±オフセットに線を置く
  function setPlumbFromAnkle(){
    const ankle=points[4], knee=points[3];
    if (!ankle || !knee){ log("⚠️ まず外果(5)と膝(4)を指定してください。"); return; }
    const rect=canvas.getBoundingClientRect();
    const offsetAbs=Math.abs(Number(plumbOffset?.value ?? 10));
    const anteriorSign = Math.sign(knee.x - ankle.x) || 1; // 膝が外果より“つま先側”＝前
    plumbX = clamp(ankle.x + anteriorSign*offsetAbs, 0, rect.width);
    plumbXInput && (plumbXInput.value=Math.round(plumbX));
    requestDraw(); compute();
    lastAnteriorSign = anteriorSign;
    log(`鉛直線を外果±${offsetAbs}px（前方推定 sign=${anteriorSign}）に合わせました。`);
  }

  // ===== リセット =====
  clearBtn && clearBtn.addEventListener('click', ()=>{
    points=[null,null,null,null,null];
    pointSources=[null,null,null,null,null];
    imgLoaded=false; imgDataURL=null; lastDet=null; detector=null;
    plumbX=0; plumbXInput && (plumbXInput.value=0);
    aiBtn && (aiBtn.disabled=true);
    metricsDiv && (metricsDiv.innerHTML="");
    classDiv && (classDiv.innerHTML="");
    requestDraw(); log("リセットしました。");
  });

  // ===== リサイズ（デバウンス） =====
  let resizeTimer=null;
  window.addEventListener('resize', ()=>{
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(()=>{
      if (!imgLoaded) { setupCanvasDPR(); updateImageFit(); requestDraw(); return; }
      const dpr=window.devicePixelRatio||1;
      const oldW=canvas.width/dpr, oldH=canvas.height/dpr;
      const rect=canvas.getBoundingClientRect();
      const rx = oldW? rect.width/oldW : 1;
      const ry = oldH? rect.height/oldH : 1;
      points = points.map(p=> p? {x:p.x*rx, y:p.y*ry} : p);
      plumbX *= rx;
      setupCanvasDPR();
      updateImageFit();
      if (points[4] && points[3]) setPlumbFromAnkle();
      requestDraw(); compute();
    }, 120);
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
      log('MoveNet detector 初期化完了（ローカルモデル）');
      return detector;
    }catch(e){
      log('Detector初期化エラー: '+(e?.message||e));
      return null;
    }
  }

  function avgScore(kps, names){
    let s=0,c=0; for(const n of names){ const kp=kps.find(x=>x.name===n); if(kp?.score!=null){ s+=kp.score; c++; } }
    return c? s/c:0;
  }
  function plausibilityScore(kps, names){
    const pick = n => kps.find(k=>k.name===n);
    const pts = names.map(n=>pick(n));
    if (pts.some(p=>!p)) return -1e9;
    let penalty = 0;
    for (let i=0;i<pts.length-1;i++){ if (pts[i].y >= pts[i+1].y) penalty += 1; }
    const ankleY = pts[4].y;
    const maxY   = Math.max(...pts.map(p=>p.y));
    const ankleBonus = (ankleY === maxY) ? 1.0 : 0;
    const kneeAhead = Math.abs((pts[3].x - pts[4].x))>2 ? 0.3 : 0;
    const conf = pts.reduce((s,p)=>s+(p.score||0),0)/pts.length;
    return 0.7*conf + ankleBonus - 0.5*penalty + kneeAhead;
  }

  async function runAutoDetect(){
    if (!imgLoaded || !imgDataURL){ log("⚠️ 先に画像を読み込んでください。"); return; }
    const det = await ensureDetector();
    if (!det){ log("⚠️ Detectorの用意に失敗。"); return; }

    const tmp=new Image();
    tmp.onload = async ()=>{
      try{
        const res = await det.estimatePoses(tmp, { flipHorizontal:false });
        const kps = res?.[0]?.keypoints;
        if (!kps){ log("⚠️ 検出結果が空です。"); return; }
        const iw=tmp.naturalWidth||tmp.width, ih=tmp.naturalHeight||tmp.height;
        lastDet={kps, iw, ih};
        applySideAndUpdate();
      }catch(e){ log("検出エラー: "+(e?.message||e)); }
    };
    tmp.onerror = ()=> log("⚠️ 画像の再ロード失敗。");
    tmp.src = imgDataURL;
  }

  // サイドの適用（auto/left/right） with 妥当性スコア補強
  function applySideAndUpdate(){
    if (!lastDet){ log("⚠️ 検出キャッシュなし。AI実行後にサイド切替してください。"); return; }
    const { kps } = lastDet;

    const L=['left_ear','left_shoulder','left_hip','left_knee','left_ankle'];
    const R=['right_ear','right_shoulder','right_hip','right_knee','right_ankle'];

    const sL = plausibilityScore(kps, L);
    const sR = plausibilityScore(kps, R);
    let autoSide = (sR > sL ? 'right' : (sL > sR ? 'left'
                    : (avgScore(kps,R) > avgScore(kps,L) ? 'right' : 'left')));

    const pref = sideSelect?.value || 'auto';
    const side = (pref==='auto') ? autoSide : pref;
    lastSide = side;

    const names = (side==='right') ? R : L;
    const pick={}; for(const n of names){ const kp=kps.find(x=>x.name===n); if(kp) pick[n]=kp; }
    const ear=pick[names[0]], sh=pick[names[1]], hip=pick[names[2]], knee=pick[names[3]], ankle=pick[names[4]];
    if (!(ear&&sh&&hip&&knee&&ankle)){ log("⚠️ 必須ランドマーク不足（side="+side+"）。"); return; }

    const rect=canvas.getBoundingClientRect();
    // 画像座標 → キャンバス（レターボックス後）座標に投影
    const toCanvas = kp => ({
      x: clamp(imgFit.dx + kp.x * imgFit.sx, 0, rect.width),
      y: clamp(imgFit.dy + kp.y * imgFit.sy, 0, rect.height)
    });
    points = [ear,sh,hip,knee,ankle].map(toCanvas);
    pointSources = ['auto','auto','auto','auto','auto'];

    setPlumbFromAnkle();
    requestDraw(); compute();
    log(`AI検出完了 side=${side} (sL=${sL.toFixed(2)}, sR=${sR.toFixed(2)})`);
  }

  sideSelect?.addEventListener('change', ()=>{ if(lastDet) applySideAndUpdate(); });

  // AIボタン
  document.addEventListener('click', e=>{
    const btn=e.target.closest('#aiBtn,[data-ai-detect]');
    if (!btn) return;
    log('AI自動抽出を開始。');
    runAutoDetect();
  });

  // ===== 初期化 =====
  bindThresholdControls?.();
  setupCanvasDPR();
  updateImageFit();
  requestDraw();
})();
