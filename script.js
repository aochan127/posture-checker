(() => {
const fileInput=document.getElementById('fileInput');
const clearBtn=document.getElementById('clearBtn');
const plumbXInput=document.getElementById('plumbX');
const centerPlumbBtn=document.getElementById('centerPlumbBtn');
const canvas=document.getElementById('canvas');
const ctx=canvas.getContext('2d');
const metricsDiv=document.getElementById('metrics');
const classDiv=document.getElementById('classification');
let img=new Image(),imgLoaded=false,points=[],plumbX=0;
function reset(){points=[];imgLoaded=false;metricsDiv.innerHTML='';classDiv.innerHTML='';ctx.clearRect(0,0,canvas.width,canvas.height);plumbX=0;plumbXInput.value=0;draw();}
clearBtn.addEventListener('click',reset);
function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);
if(imgLoaded){ctx.drawImage(img,0,0,canvas.width,canvas.height);}if(plumbX>0){ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(plumbX,0);ctx.lineTo(plumbX,canvas.height);ctx.stroke();}
points.forEach((p,i)=>{ctx.fillStyle='red';ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fill();ctx.fillStyle='black';ctx.fillText(i+1,p.x+8,p.y-8);});
if(points.length>=2){ctx.strokeStyle='red';ctx.beginPath();for(let i=0;i<points.length-1;i++){ctx.moveTo(points[i].x,points[i].y);ctx.lineTo(points[i+1].x,points[i+1].y);}ctx.stroke();}}
fileInput.addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{img.onload=()=>{imgLoaded=true;draw();};img.src=r.result;};r.readAsDataURL(f);});
canvas.addEventListener('click',e=>{const rect=canvas.getBoundingClientRect();const x=e.clientX-rect.left,y=e.clientY-rect.top;
if(points.length<5){points.push({x,y});compute();}else{points=[{x,y}];metricsDiv.innerHTML='';classDiv.innerHTML='';}draw();});
function compute(){if(points.length<5||plumbX<=0){metricsDiv.innerHTML='<p>5点と基準線を設定してください</p>';return;}
const [ear,shoulder,hip,knee,ankle]=points;const angle=(Math.atan2(ear.y-shoulder.y,ear.x-shoulder.x)*180/Math.PI);const angleES=Math.abs(90-Math.abs(angle));
const hipOffset=hip.x-plumbX;let type='判定不可';if(Math.abs(hipOffset)<10&&angleES<12){type='Ideal';}else if(angleES>20&&hipOffset>20){type='Kyphotic-lordotic';}else if(hipOffset<-10){type='Sway-back';}else{type='Flat-back';}
metricsDiv.innerHTML='<p>FHA角度:'+angleES.toFixed(1)+'°</p><p>大転子オフセット:'+hipOffset.toFixed(0)+'px</p>';classDiv.innerHTML='<b>'+type+'</b>';draw();}
plumbXInput.addEventListener('change',()=>{plumbX=Math.max(0,Math.min(canvas.width,Number(plumbXInput.value||0)));draw();compute();});
centerPlumbBtn.addEventListener('click',()=>{plumbX=Math.round(canvas.width/2);plumbXInput.value=plumbX;draw();compute();});
reset();
})();