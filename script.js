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
  document.querySelectorAll('input[name="lm"]').forEach(r => r.addEventListener('change', ()=> currentEdit = Number(r.value)));

  let img = new Image();
  let imgLoaded = false;
  let points = [];
  let plumbX = 0, showPlumb = true;

  const COLORS = ["#ef4444","#f59e0b","#eab308","#3b82f6","#10b981"];
  const RADIUS = 14;

  function log(msg){ logEl.textContent += (logEl.textContent ? "\n" : "") + msg; logEl.scrollTop = logEl.scrollHeight; }

  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (imgLoaded) ctx.drawImage(img,0,0,canvas.width,canvas.height);

    if (showPlumb && plumbX>0){
      ctx.save(); ctx.strokeStyle="rgba(30,41,59,.95)"; ctx.setLineDash([8,6]); ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(plumbX,0); ctx.lineTo(plumbX,canvas.height); ctx.stroke(); ctx.restore();
    }
    if (points.filter(Boolean).length>=2){
      ctx.save(); ctx.strokeStyle="rgba(239,68,68,.8)"; ctx.lineWidth=3; ctx.beginPath();
      for(let i=0;i<points.length-1;i++){ const a=points[i], b=points[i+1]; if(!a||!b) continue; ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); }
      ctx.stroke(); ctx.restore();
    }
    points.forEach((p,i)=>{
      if(!p) return;
      ctx.save();
      ctx.beginPath(); ctx.fillStyle=COLORS[i]; ctx.arc(p.x,p.y,RADIUS,0,Math.PI*2); ctx.fill();
      const label=String(i+1); ctx.lineWidth=4; ctx.strokeStyle="rgba(0,0,0,.85)";
      ctx.font="bold 16px system-ui,-apple-system,Segoe UI,Noto Sans JP,sans-serif";
      ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.strokeText(label,p.x,p.y); ctx.fillStyle="#fff"; ctx.fillText(label,p.x,p.y);
      ctx.restore();
    });
  }

  function compute(){
    if(points.filter(Boolean).length<5 || plumbX<=0){
      metricsDiv.innerHTML = "<p>5点と鉛直線を設定してください。</p>"; classDiv.innerHTML="";
      return;
    }
    const [ear,shoulder,hip,knee,ankle]=points;
    const angle = Math.atan2(ear.y-shoulder.y, ear.x-shoulder.x)*180/Math.PI;
    const angleES = Math.abs(90 - Math.abs(angle));
    const hipOffset = hip.x - plumbX;
    let type="判定不可";
    if(Math.abs(hipOffset)<10 && angleES<12) type="Ideal";
    else if(angleES>20 && hipOffset>20) type="Kyphotic-lordotic";
    else if(hipOffset<-10) type="Sway-back";
    else type="Flat-back";
    metricsDiv.innerHTML=`<p><b>FHA角度</b>: ${angleES.toFixed(1)}°</p><p><b>大転子オフセット</b>: ${hipOffset.toFixed(0)} px</p>`;
    classDiv.innerHTML=`<p><b>${type}</b></p>`;
  }

  fileInput.addEventListener('change', e=>{
    const f=e.target.files[0]; if(!f) return;
    const r=new FileReader();
    r.onload=()=>{ img.onload=()=>{ imgLoaded=true; aiBtn.disabled=false; points=[]; draw(); log("画像を読み込みました。AIボタンが有効になりました。"); }; img.src=r.result; };
    r.readAsDataURL(f);
  });

  canvas.addEventListener('click', e=>{
    const rect=canvas.getBoundingClientRect(); const x=e.clientX-rect.left, y=e.clientY-rect.top;
    points[currentEdit]={x,y}; draw(); compute();
  });

  plumbXInput.addEventListener('change',()=>{ plumbX=Math.max(0,Math.min(canvas.width,Number(plumbXInput.value||0))); draw(); compute(); });
  centerPlumbBtn.addEventListener('click',()=>{ plumbX=Math.round(canvas.width/2); plumbXInput.value=plumbX; draw(); compute(); });
  togglePlumb.addEventListener('change',()=>{ showPlumb=togglePlumb.checked; draw(); });

  clearBtn.addEventListener('click',()=>{
    points=[]; imgLoaded=false; aiBtn.disabled=true; plumbX=0; plumbXInput.value=0; metricsDiv.innerHTML=""; classDiv.innerHTML=""; draw(); log("リセットしました。");
  });

  // ===== AI: MediaPipe Pose with diagnostics =====
  let poseInstance=null;
  function ensurePose(){
    try{
      if(poseInstance) return poseInstance;
      if(!window.Pose){ log("⚠️ MediaPipe Pose が読み込まれていません。ネットワークやCDNブロックをご確認ください。"); return null; }
      const base="https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/";
      poseInstance = new window.Pose.Pose({ locateFile: (file)=> base + file });
      poseInstance.setOptions({ modelComplexity:1, smoothLandmarks:true, minDetectionConfidence:0.5, minTrackingConfidence:0.5, selfieMode:false });
      log("MediaPipe Pose 初期化完了。");
      return poseInstance;
    }catch(e){
      log("Pose 初期化エラー: "+e.message);
      return null;
    }
  }

  function sideByVisibility(ls){
    const v = i => (ls[i] && typeof ls[i].visibility==='number') ? ls[i].visibility : 0;
    const leftScore = v(7)+v(11)+v(23)+v(25)+v(27);
    const rightScore= v(8)+v(12)+v(24)+v(26)+v(28);
    return (leftScore>=rightScore)?'left':'right';
  }

  async function runAIDetect(){
    try{
      if(!imgLoaded){ log("⚠️ 先に画像を読み込んでください。"); return; }
      const p=ensurePose(); if(!p) { log("⚠️ Poseが利用できません。"); return; }

      const off=document.createElement('canvas'); off.width=canvas.width; off.height=canvas.height;
      const octx=off.getContext('2d'); octx.drawImage(img,0,0,off.width,off.height);

      let results=null; p.onResults(r=>{ results=r; });
      await p.send({image: off});
      if(!results || !results.poseLandmarks){ log("⚠️ ランドマーク検出に失敗しました。全身が写る横向き写真でお試しください。"); return; }
      const ls=results.poseLandmarks;
      let side=sideSelect.value; if(side==='auto') side=sideByVisibility(ls);

      const idx = side==='left'
        ? {ear:7, sh:11, hip:23, kne:25, ank:27}
        : {ear:8, sh:12, hip:24, kne:26, ank:28};

      points = [ls[idx.ear], ls[idx.sh], ls[idx.hip], ls[idx.kne], ls[idx.ank]].map(lm => ({
        x: lm.x*canvas.width, y: lm.y*canvas.height
      }));

      plumbX = Math.round(points[4].x + 8);
      plumbXInput.value = plumbX;

      draw(); compute();
      log(`AI検出完了（側: ${side}）。`);
    }catch(e){
      log("AIエラー: "+(e && e.message ? e.message : e));
    }
  }

  aiBtn.addEventListener('click', runAIDetect);

  // init
  log("読み込み完了。画像を選択してください。");
  draw();
})();