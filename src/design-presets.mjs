export const designPresets=[
  {key:'blank',label:'طرح خالی',html:'<section class="custom-section"><h2>طرح اختصاصی شما</h2><p>HTML، CSS و JavaScript را ویرایش کنید.</p></section>',css:'body{margin:0;font-family:system-ui;background:#f1f5f9;color:#172b41} .custom-section{padding:48px;text-align:center}',js:"console.log('طرح آماده است.');"},
  {key:'three-hero',label:'معرفی سه‌بعدی',html:'<section class="hero"><div class="copy"><span>طراحی، فراتر از صفحه</span><h2>ایده شما در بُعدی تازه</h2><p>این نمونه با کد قابل تغییر است. توضیح، رنگ، هندسه و حرکت را مطابق برند مشتری طراحی کنید.</p><button id="toggle-motion" type="button" aria-pressed="false">توقف حرکت</button><p id="fallback" role="status" hidden>نمای سه‌بعدی در این دستگاه در دسترس نیست؛ محتوای صفحه همچنان قابل خواندن است.</p></div><div id="scene" role="img" aria-label="حلقه سه‌بعدی آبی با نور و سایه"></div></section>',css:'*{box-sizing:border-box}body{margin:0;color:#e6f6ff;background:#0b182b;font-family:system-ui}.hero{display:grid;grid-template-columns:1fr 1fr;min-height:480px;align-items:center;gap:24px;padding:32px}.copy{max-width:600px}.copy span{color:#7ee5ec}h2{font-size:clamp(28px,4vw,54px);line-height:1.3;margin:16px 0}p{line-height:1.9;color:#c5d4e5}button{font:inherit;color:#0b182b;background:#7ee5ec;border:0;border-radius:12px;padding:12px 22px;cursor:pointer}button:focus-visible{outline:3px solid white;outline-offset:5px}#scene{height:400px;min-width:0;background:radial-gradient(ellipse,#163c55,transparent 70%);border-radius:24px}canvas{display:block;width:100%;height:100%}@media(max-width:650px){.hero{grid-template-columns:1fr;padding:24px;min-height:0}#scene{height:260px}}',js:`import * as THREE from 'three';
const container=document.querySelector('#scene'),button=document.querySelector('#toggle-motion');
let renderer;
try { renderer=new THREE.WebGLRenderer({antialias:true,alpha:true}); }
catch { document.querySelector('#fallback').hidden=false;button.hidden=true; }
if(renderer){
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));container.append(renderer.domElement);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,1,.1,50);camera.position.z=6;
  const geometry=new THREE.TorusKnotGeometry(1,.3,96,16);
  const material=new THREE.MeshStandardMaterial({color:0x60ddea,metalness:.5,roughness:.25});
  const mesh=new THREE.Mesh(geometry,material);scene.add(mesh);
  scene.add(new THREE.HemisphereLight(0xd5faff,0x10304c,3));
  const light=new THREE.DirectionalLight(0xffffff,5);light.position.set(3,4,5);scene.add(light);
  const motion=matchMedia('(prefers-reduced-motion: reduce)');let paused=motion.matches;
  const label=()=>{button.textContent=paused?'شروع حرکت':'توقف حرکت';button.setAttribute('aria-pressed',String(paused));};label();
  let visible=true,frame=0,last=0;
  const draw=()=>{renderer.render(scene,camera);renderer.domElement.dataset.triangles=String(renderer.info.render.triangles);};
  function animate(time){frame=0;if(!visible || document.hidden || paused)return;const delta=Math.min((time-last)/1000,.05);last=time;mesh.rotation.y+=delta*.3;mesh.rotation.x+=delta*.12;draw();frame=requestAnimationFrame(animate);}
  function sync(){cancelAnimationFrame(frame);frame=0;last=performance.now();draw();if(visible && !document.hidden && !paused)frame=requestAnimationFrame(animate);}
  button.onclick=()=>{paused=!paused;label();sync();};
  motion.addEventListener('change',()=>{paused=motion.matches;label();sync();});
  document.addEventListener('visibilitychange',sync);
  const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync();});observer.observe(container);
  const resize=new ResizeObserver(()=>{const w=container.clientWidth,h=container.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();sync();});resize.observe(container);
  addEventListener('pagehide',()=>{cancelAnimationFrame(frame);observer.disconnect();resize.disconnect();geometry.dispose();material.dispose();renderer.dispose();},{once:true});
  renderer.domElement.dataset.renderer='three';console.log('Three.js renderer آماده است.');
}`},
];

for(const preset of designPresets){preset.html=preset.html.replace(/></g,'>\n<');preset.css=preset.css.replace(/}/g,'}\n');}
