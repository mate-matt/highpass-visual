import type { ShotProgram } from "./shot-sampler.js";
import type { VisionAssetManifest } from "./vision-compiler.js";

export type PreviewPayload = {
  program: ShotProgram;
  manifest: VisionAssetManifest;
  images: Record<string, string>;
  renderSize: { width: number; height: number; maxPixels: number };
};

function embeddedJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

export function inkRevealPreviewHtml(payload: PreviewPayload, samplerRuntimeSource: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; media-src 'none'; font-src 'none'">
<title>Highpass Visual — ${escapeHtml(payload.program.treatment.id)}</title>
<style>
:root{color-scheme:dark;--paper:#e8dcc4;--ink:#0b0d12;--muted:#9ba0ad;--panel:rgba(19,22,29,.88);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -15%,#32394b 0,#151922 38%,#090b10 100%);color:#f5f2eb;display:grid;place-items:center;padding:28px}
.shell{width:min(1080px,100%);display:grid;gap:16px}.heading{display:flex;align-items:end;justify-content:space-between;gap:24px}.eyebrow{letter-spacing:.16em;text-transform:uppercase;color:#cdbd9c;font-size:11px}.heading h1{font-family:Georgia,serif;font-size:clamp(28px,5vw,54px);font-weight:400;margin:5px 0 0}.phase{font-variant-numeric:tabular-nums;color:var(--muted);font-size:13px;text-align:right}
.stage{position:relative;border:1px solid rgba(232,220,196,.18);border-radius:22px;overflow:hidden;background:#080a0f;box-shadow:0 32px 90px rgba(0,0,0,.52)}canvas{display:block;width:100%;height:auto;max-height:72vh;object-fit:contain}.stage:after{content:"";position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 90px rgba(0,0,0,.28)}
.controls{display:grid;grid-template-columns:auto auto auto minmax(180px,1fr) auto auto;align-items:center;gap:10px;padding:12px;border:1px solid rgba(232,220,196,.14);background:var(--panel);backdrop-filter:blur(18px);border-radius:16px}button,select{appearance:none;border:1px solid rgba(232,220,196,.18);background:#242a36;color:#f5f2eb;border-radius:10px;padding:9px 12px;font:inherit;cursor:pointer}button:hover{background:#303746}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #d8bd88;outline-offset:2px}.seek{accent-color:#d8bd88;width:100%}.time{font-variant-numeric:tabular-nums;font-size:12px;color:#d3d0c9;min-width:88px}.reduced{display:flex;align-items:center;gap:7px;color:#c7c4bc;font-size:12px;white-space:nowrap}.reduced input{accent-color:#d8bd88}.hash{font-family:ui-monospace,monospace;color:#747b89;font-size:10px;text-align:right}
@media(max-width:720px){body{padding:14px}.heading{align-items:start}.controls{grid-template-columns:repeat(3,auto);}.seek{grid-column:1/-1;grid-row:2}.reduced{grid-column:1/3}.hash{grid-column:3}.phase{display:none}}
</style>
</head>
<body>
<main class="shell" id="preview" data-ready="false">
  <header class="heading"><div><div class="eyebrow">Highpass Visual / ${escapeHtml(payload.program.treatment.id)}</div><h1>${escapeHtml(payload.program.shot.id)}</h1></div><div class="phase"><div id="phase">atmosphere</div><div>${escapeHtml(payload.program.shot.attentionTarget)}</div></div></header>
  <section class="stage"><canvas id="stage" aria-label="Treatment shot preview"></canvas></section>
  <section class="controls" aria-label="Preview controls">
    <button type="button" id="play">Play</button><button type="button" id="pause">Pause</button><button type="button" id="restart">Restart</button>
    <input class="seek" id="seek" aria-label="Scene Time" type="range" min="0" max="${payload.program.shot.duration}" value="0" step="0.001">
    <select id="speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
    <label class="reduced"><input id="reduced" type="checkbox">Reduced motion</label>
    <div class="time" id="time">0.000 / ${payload.program.shot.duration.toFixed(3)}</div><div class="hash" id="hash">0000000000000000</div>
  </section>
</main>
<script id="payload" type="application/json">${embeddedJson(payload)}</script>
<script type="module">
${samplerRuntimeSource.replaceAll("</script", "<\\/script")}
(() => {
  const payload=JSON.parse(document.getElementById('payload').textContent);const program=payload.program;const manifest=payload.manifest;
  const root=document.getElementById('preview');const canvas=document.getElementById('stage');const ctx=canvas.getContext('2d');
  const seek=document.getElementById('seek');const phaseLabel=document.getElementById('phase');const timeLabel=document.getElementById('time');const hashLabel=document.getElementById('hash');const reduced=document.getElementById('reduced');
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const load=async src=>{const image=new Image();image.src=src;await image.decode();return image};
  const imageEntries=Object.entries(payload.images);Promise.all(imageEntries.map(async([id,src])=>[id,await load(src)])).then(entries=>start(Object.fromEntries(entries))).catch(error=>{root.dataset.error=String(error)});
  function start(images){const width=payload.renderSize.width,height=payload.renderSize.height;canvas.width=width;canvas.height=height;canvas.dataset.maxPixels=String(payload.renderSize.maxPixels);const layer=document.createElement('canvas');layer.width=width;layer.height=height;const lx=layer.getContext('2d');const maskCanvas=document.createElement('canvas');maskCanvas.width=width;maskCanvas.height=height;const mx=maskCanvas.getContext('2d');
    const depthCanvas=document.createElement('canvas');depthCanvas.width=width;depthCanvas.height=height;const dx=depthCanvas.getContext('2d',{willReadFrequently:true});dx.drawImage(images['depth-proxy'],0,0,width,height);const depthPixels=dx.getImageData(0,0,width,height).data;let depthTotal=0;for(let i=0;i<depthPixels.length;i+=4)depthTotal+=depthPixels[i];const depthMean=depthTotal/Math.max(1,width*height)/255;canvas.dataset.depthProxyMean=depthMean.toFixed(6);const middleDepth=clamp(.38+depthMean*.32,.38,.7),foregroundDepth=clamp(.8+depthMean*.2,.8,1);
    function applyCamera(C,name,depth){const offsetX=C.layerOffsets[name+'X']*width,offsetY=C.layerOffsets[name+'Y']*height,depthScale=1+(C.zoom-1)*depth,seamScale=1+2*Math.max(Math.abs(offsetX)/width,Math.abs(offsetY)/height)+.002,scale=Math.max(depthScale,seamScale);ctx.translate(width/2+offsetX,height/2+offsetY);ctx.scale(scale,scale);ctx.translate(-width/2,-height/2)}
    const contourPath=new Path2D();for(const contour of manifest.regionContours){const pts=contour.points;if(!pts.length)continue;contourPath.moveTo(pts[0].x*width,pts[0].y*height);for(let i=1;i<pts.length;i++)contourPath.lineTo(pts[i].x*width,pts[i].y*height);contourPath.closePath()}
    function partialStroke(stroke,progress){const target=stroke.length*progress,pts=stroke.points,cum=stroke.cumulativeLength;if(!pts.length||target<=0)return;ctx.beginPath();ctx.moveTo(pts[0].x*width,pts[0].y*height);for(let i=1;i<pts.length;i++){if(cum[i]<=target){ctx.lineTo(pts[i].x*width,pts[i].y*height);continue}const span=Math.max(1e-9,cum[i]-cum[i-1]);const p=clamp((target-cum[i-1])/span,0,1);ctx.lineTo((pts[i-1].x+(pts[i].x-pts[i-1].x)*p)*width,(pts[i-1].y+(pts[i].y-pts[i-1].y)*p)*height);break}ctx.stroke()}
    function draw(state){const L=state.layers,R=program.treatment.render,C=state.camera;ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.filter='none';ctx.fillStyle=R.backgroundColor;ctx.fillRect(0,0,width,height);ctx.save();applyCamera(C,'background',.22);ctx.drawImage(images['background-plate'],0,0,width,height);ctx.restore();ctx.save();applyCamera(C,'middle',middleDepth);ctx.globalAlpha=L.lowFrequencyOpacity;ctx.filter='blur('+L.blurPx+'px)';ctx.drawImage(images['middle-plate'],0,0,width,height);ctx.restore();ctx.save();applyCamera(C,'foreground',foregroundDepth);ctx.filter='none';
      ctx.save();ctx.globalAlpha=L.inkOpacity*.18;ctx.fillStyle=R.inkColor;ctx.fill(contourPath,'evenodd');ctx.globalAlpha=L.inkOpacity*.5;ctx.strokeStyle=R.inkColor;ctx.lineWidth=R.lineWidth;ctx.stroke(contourPath);ctx.restore();
      if(R.distanceMaskEnabled){const threshold=.5+L.distanceReveal*.5;const inverseThreshold=Math.max(.01,1-threshold);const brightness=Math.min(5000,50/inverseThreshold);const feather=Math.max(.35,R.distanceSoftness*Math.min(width,height));mx.clearRect(0,0,width,height);mx.save();mx.globalCompositeOperation='source-over';mx.filter='invert(1) brightness('+brightness+'%) contrast(2000%) blur('+feather+'px)';mx.drawImage(images['distance-field'],0,0,width,height);mx.restore();mx.globalCompositeOperation='destination-in';mx.drawImage(images['subject-mask'],0,0,width,height);mx.globalCompositeOperation='source-over';lx.clearRect(0,0,width,height);lx.globalCompositeOperation='source-over';lx.globalAlpha=1;lx.drawImage(images['foreground-plate'],0,0,width,height);lx.globalCompositeOperation='destination-in';lx.drawImage(maskCanvas,0,0);ctx.globalAlpha=L.sourceOpacity;ctx.drawImage(layer,0,0);const fullOpacity=clamp((L.sourceOpacity-.88)/.12,0,1);ctx.globalAlpha=fullOpacity;ctx.drawImage(images['foreground-plate'],0,0,width,height)}else{ctx.globalAlpha=L.sourceOpacity;ctx.filter='blur('+L.blurPx+'px)';ctx.drawImage(images['foreground-plate'],0,0,width,height);ctx.filter='none'}
      if(R.signedDarkGain>0){ctx.globalCompositeOperation='multiply';ctx.globalAlpha=L.signedDarkOpacity*R.signedDarkGain;ctx.filter='invert(1)';ctx.drawImage(images['signed-detail-dark'],0,0,width,height);ctx.filter='none'}if(R.signedLightGain>0){ctx.globalCompositeOperation='screen';ctx.globalAlpha=L.signedLightOpacity*R.signedLightGain;ctx.drawImage(images['signed-detail-light'],0,0,width,height)}ctx.globalCompositeOperation='screen';ctx.globalAlpha=L.strongEdgeProgress*R.strongEdgeGain;ctx.drawImage(images['strong-edge'],0,0,width,height);ctx.globalAlpha=L.detailEdgeProgress*R.detailEdgeGain;ctx.drawImage(images['detail-edge'],0,0,width,height);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=L.inkOpacity;ctx.strokeStyle=R.inkColor;ctx.lineWidth=R.lineWidth;ctx.lineCap='round';ctx.lineJoin='round';for(const stroke of manifest.openStrokes)partialStroke(stroke,L.strokeProgress);ctx.restore();ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.fillStyle='#000000';ctx.globalAlpha=1-L.transitionOpacity;ctx.fillRect(0,0,width,height);ctx.globalAlpha=1;
    }
    const motionQuery=window.matchMedia('(prefers-reduced-motion: reduce)');let reducedOverridden=false;reduced.checked=motionQuery.matches;let current=0,playing=false,lastClock=0,speed=1;function render(){const state=sampleShotProgramRuntime(program,current,reduced.checked);draw(state);seek.value=String(state.sceneTime);phaseLabel.textContent=state.activePhase;timeLabel.textContent=state.sceneTime.toFixed(3)+' / '+program.shot.duration.toFixed(3);hashLabel.textContent=state.stateHash;root.dataset.phase=state.activePhase;root.dataset.stateHash=state.stateHash;root.dataset.reduced=String(state.reducedMotion);window.__highpass.state=state}
    function tick(clock){if(playing){if(lastClock)current+=((clock-lastClock)/1000)*speed;lastClock=clock;if(current>=program.shot.duration){current=program.shot.duration;playing=false}render()}requestAnimationFrame(tick)}
    document.getElementById('play').onclick=()=>{playing=true;lastClock=0};document.getElementById('pause').onclick=()=>{playing=false;lastClock=0};document.getElementById('restart').onclick=()=>{current=0;lastClock=0;render()};seek.oninput=()=>{current=Number(seek.value);lastClock=0;render()};document.getElementById('speed').onchange=e=>{speed=Number(e.target.value);lastClock=0};reduced.onchange=()=>{reducedOverridden=true;render()};motionQuery.addEventListener('change',event=>{if(!reducedOverridden){reduced.checked=event.matches;render()}});
    window.addEventListener('message',event=>{if(event.data&&event.data.type==='highpass-render-at'&&Number.isFinite(Number(event.data.time))){current=Number(event.data.time);playing=false;lastClock=0;render()}});
    window.__highpass={program,state:null,renderAt:time=>{current=Number(time);render();return window.__highpass.state},benchmark:(frames=60)=>{const started=performance.now();for(let frame=0;frame<frames;frame++){current=(frame/Math.max(1,frames-1))*program.shot.duration;render()}const totalMs=performance.now()-started;return{frames,totalMs,averageMs:totalMs/frames,width,height}},play:()=>document.getElementById('play').click(),pause:()=>document.getElementById('pause').click()};render();root.dataset.ready='true';requestAnimationFrame(tick);
  }
})();
</script>
</body>
</html>`;
}
