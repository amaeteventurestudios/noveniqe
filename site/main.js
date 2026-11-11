(()=>{
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const G = window.gsap; if(!G) document.documentElement.classList.add('js-off'); if(RM) document.documentElement.classList.add('rm');

/* ticker */
const feed=[['var(--agp)','Nova','pitted on lap 31 in the rain and rejoined P3 in Abuja'],['var(--pal)','Kofi','opened a bakery on Harbour Road in Palasora'],['var(--war)','Iron Seven','held the ridge on Redrock Divide for twelve minutes'],['var(--ana)','Ama','talked Mami Wata down to half the price'],['var(--agp)','Echo','saved the tyres and took fastest lap in Lagos'],['var(--pal)','Bisi','won a corner lot at the town auction'],['var(--war)','Hawk','flanked left through the village and took two'],['var(--ana)','Tunde','got Anansi to pay back ten of forty cowries']];
const t=$('#track'); const h=feed.map(f=>`<span><b style="--c:${f[0]}">${f[1]}</b> ${f[2]}</span>`).join('');t.innerHTML=h+h;

/* hero slides */
const slides=$$('.slide'), wb=$$('.wbtn'); let cur=0, timer;
const DUR=7000;
function go(n){
  if(n===cur && slides[n].classList.contains('on')) {}
  slides.forEach(s=>s.classList.remove('prev'));
  slides[cur].classList.remove('on'); slides[cur].classList.add('prev');
  cur=n; const s=slides[cur]; s.classList.add('on');
  const im=s.querySelector('img,video'); im.style.animation='none'; void im.offsetWidth; im.style.animation='';
  const v=s.querySelector('video'); if(v){v.currentTime=0; v.play().catch(()=>{});}
  wb.forEach((b,i)=>{b.classList.toggle('on',i===cur); const bar=b.querySelector('.bar b'); bar.style.animation='none'; void bar.offsetWidth; bar.style.animation='';});
  clearTimeout(timer); if(!RM) timer=setTimeout(()=>go((cur+1)%slides.length),DUR);
}
wb.forEach((b,i)=>b.addEventListener('click',()=>go(i)));
wb.forEach(b=>b.style.setProperty('--dur',DUR+'ms'));
if(!RM) timer=setTimeout(()=>go(1),DUR); else wb.forEach(b=>b.querySelector('.bar b').style.transform='scaleX(1)');

/* marquee rows */
const pic=src=>`<span class="pic"><img src="${src}" alt="" loading="lazy"></span>`;
const r1=`<span class="w">Race ${pic('a/agp-abuja.webp')} <span class="o">Build</span> ${pic('a/pal-day.webp')} Command ${pic('a/war-village.webp')} <span class="o">Tell stories</span> ${pic('a/cov/the-lightning-bird.webp')}</span>`;
const r2=`<span class="w"><span class="o">Agent Grand Prix</span> ${pic('a/agp-car.webp')} Palasora ${pic('a/pal-night.webp')} <span class="o">Agent Warfront</span> ${pic('a/war-winter.webp')} Anansora ${pic('a/cov/raven-secrets.webp')}</span>`;
$('#m1').innerHTML=r1+r1+r1; $('#m2').innerHTML=r2+r2+r2;

/* radio conversations */
const convo=[
 [['me','You','Box this lap. Inters.'],['ag','Nova · driver','Copy. Boxing. Track is going.'],['ag','Race engineer','Out in P6. Four cars still on slicks.'],['ag','Nova · driver','P3. They did not see that coming.']],
 [['me','You','Open a bakery near the harbour.'],['ag','Kofi · town agent','Found a lot on Harbour Road. 420 Sora.'],['me','You','Do it. Hire someone who starts early.'],['ag','Kofi · town agent','Done. First bread at 5 am tomorrow.']],
 [['me','You','Hold the ridge. Do not chase.'],['ag','Iron Seven · gunner','Holding. Two contacts in the village.'],['me','You','Hawk, flank left through the trees.'],['ag','Hawk · driver','Flanking. Both down. Ridge is ours.']],
 [['ag','Storyteller','Anansi grins and spreads his hands. "Forty cowries? I never had forty cowries."'],['me','You','Then whose are those behind your back?'],['ag','Storyteller','Roll: 17. Success. He laughs and hands you ten.']]
];
const scr=['a/agp-rain.webp','a/pal-day.webp','a/war-village.webp','a/cov/anansi-owes-you.webp'];
const hud=[['Lap 31 of 57','Rain'],['Palasora','Day 12, 07:40'],['Redrock Divide','Wave 3'],['Anansora','The Cowrie Coast']];
let cs=0, ctok=0;
function playConvo(i){
  cs=i; const tok=++ctok; const box=$('#msgs'); box.innerHTML='<div class="typing" id="typ"><i></i><i></i><i></i></div>';
  $('.radio .scr img').src=scr[i]; const hs=$$('.radio .hud span'); hs[0].textContent=hud[i][0]; hs[1].textContent=hud[i][1];
  $$('#rbar button').forEach((b,j)=>b.classList.toggle('on',j===i));
  $$('.beat').forEach(b=>b.classList.remove('on'));
  const typ=$('#typ'); let k=0;
  const step=()=>{ if(tok!==ctok) return; if(k>=convo[i].length){ if(!RM) setTimeout(()=>{ if(tok===ctok) playConvo((cs+1)%4)},3200); return;}
    const [w,who,txt]=convo[i][k]; const d=document.createElement('div'); d.className='msg '+w; d.innerHTML=`<small>${who}</small>${txt}`;
    const b=$$('.beat')[Math.min(k===0?0:(k<convo[i].length-1?1:2),2)]; $$('.beat').forEach(x=>x.classList.toggle('on',x===b));
    if(w==='ag'){typ.classList.add('on'); box.appendChild(typ); setTimeout(()=>{ if(tok!==ctok)return; typ.classList.remove('on'); box.insertBefore(d,typ); requestAnimationFrame(()=>d.classList.add('in')); k++; setTimeout(step,1300)},RM?0:900);}
    else { box.insertBefore(d,typ); requestAnimationFrame(()=>d.classList.add('in')); k++; setTimeout(step,RM?0:1100);} };
  step();
}
$$('#rbar button').forEach((b,i)=>b.addEventListener('click',()=>playConvo(i)));

/* anansora columns */
const cov=[['anansi-owes-you','Anansi Owes You Money'],['mami-wata-bargain',"Mami Wata's Bargain"],['the-lightning-bird','The Lightning Bird'],['longship-to-the-edge','Longship to the Edge'],['teahouse-at-dusk','The Teahouse at Dusk'],['the-drum-that-stopped','The Drum That Stopped'],['weighing-of-the-heart','The Weighing of the Heart'],['raven-secrets','Secrets for a Raven'],['hundred-lanterns','The Bridge of a Hundred Lanterns'],['rolling-calf',"Don't Look at the Rolling Calf"],['stone-city-heist','Gold of the Stone City'],['tanuki-debt',"Ryo and the Tanuki's Debt"],['the-frozen-saga','The Frozen Saga'],['carnival-forever','The Carnival That Never Ends'],['serpent-of-the-pool','The Serpent of the Deep Pool'],['kappa-toll',"The Kappa's Toll"],['scribe-heist',"The Scribe's Heist"],['rain-queen-apprentice',"The Rainmaker's Apprentice"]];
const land={anansi:'Cowrie Coast'};
const colsEl=$('#cols');
for(let c=0;c<3;c++){ const items=cov.filter((_,i)=>i%3===c).map(([id,tt])=>`<div class="cover"><img src="a/cov/${id}.webp" alt="${tt.replace(/"/g,'')}" loading="lazy"><div class="ct"><b>${tt}</b><span>Anansora story</span></div></div>`).join(''); colsEl.insertAdjacentHTML('beforeend',`<div class="col ${c===1?'r':''}">${items+items}</div>`);}

/* jisste phone */
const chat=[['ag','Race over in Abuja. P3 from P9. The rain call was yours.',{img:'a/agp-rain.webp',t:'Grand Prix Wire: Nova storms to the podium'}],['me','Brilliant. Bank the prize.'],['ag','Done: 300 Sora. Want me to put it into the bakery?'],['me','Yes. And tell Hawk the ridge was great.'],['ag','Told him. He says thanks, commander.']];
let chatDone=false;
function playChat(){ if(chatDone) return; chatDone=true; const f=$('#feed'); let k=0;
  const step=()=>{ if(k>=chat.length) return; const [w,txt,card]=chat[k++]; const d=document.createElement('div'); d.className='bub '+(w==='me'?'me':''); d.innerHTML=txt+(card?`<div class="card"><img src="${card.img}" alt=""><div>${card.t}</div></div>`:''); f.appendChild(d); requestAnimationFrame(()=>d.classList.add('in')); setTimeout(step,RM?0:1500);};
  step(); }

/* palasora sun slider */
const sun=$('#sun'); let drag=false;
const setX=p=>{p=Math.max(0,Math.min(100,p)); sun.style.setProperty('--x',p+'%'); sun.setAttribute('aria-valuenow',Math.round(p));};
const fromEv=e=>{const r=sun.getBoundingClientRect(); setX((e.clientX-r.left)/r.width*100);};
sun.addEventListener('pointerdown',e=>{drag=true;sun.setPointerCapture(e.pointerId);fromEv(e)});
sun.addEventListener('pointermove',e=>{if(drag)fromEv(e)});
sun.addEventListener('pointerup',()=>drag=false);
sun.addEventListener('keydown',e=>{const v=+sun.getAttribute('aria-valuenow'); if(e.key==='ArrowLeft')setX(v-5); if(e.key==='ArrowRight')setX(v+5);});

/* noise canvas */
const cv=$('#noise'), cx=cv.getContext('2d'); let nOn=false;
function noise(){ if(!nOn) return; const w=cv.width=160,hh=cv.height=90; const id=cx.createImageData(w,hh); for(let i=0;i<id.data.length;i+=4){const v=Math.random()*255|0; id.data[i]=v*.75;id.data[i+1]=v;id.data[i+2]=v*.4;id.data[i+3]=Math.random()*60|0;} cx.putImageData(id,0,0); setTimeout(()=>requestAnimationFrame(noise),70);}

/* news peek */
const pk=$('#npeek'), pim=pk.querySelector('img');
if(matchMedia('(hover:hover)').matches){ $$('.nrow').forEach(r=>{ r.addEventListener('mouseenter',()=>{pim.src=r.dataset.img;pk.classList.add('on')}); r.addEventListener('mouseleave',()=>pk.classList.remove('on')); r.addEventListener('mousemove',e=>{pk.style.left=e.clientX+'px';pk.style.top=e.clientY+'px'}); }); }

/* nav */
const nav=$('#nav'); let ly=0;
addEventListener('scroll',()=>{const y=scrollY; nav.classList.toggle('solid',y>40); nav.classList.toggle('hide',y>ly&&y>500&&!$('#sheet').classList.contains('open')); ly=y; $('#prog').style.transform=`scaleX(${y/(document.documentElement.scrollHeight-innerHeight)})`;},{passive:true});
const sheet=$('#sheet'), mb=$('#menuB');
mb.addEventListener('click',()=>{const o=sheet.classList.toggle('open'); mb.setAttribute('aria-expanded',o); sheet.setAttribute('aria-hidden',!o); mb.children[0].style.transform=o?'translateY(3px) rotate(45deg)':''; mb.children[1].style.transform=o?'translateY(-3px) rotate(-45deg)':'';});
$$('#sheet a').forEach(a=>a.addEventListener('click',()=>mb.click()));

/* lazy videos + section triggers */
const io=new IntersectionObserver(es=>es.forEach(e=>{const v=e.target; if(e.isIntersecting){ if(v.tagName==='VIDEO'){ v.preload='auto'; v.play().catch(()=>{});} } else if(v.tagName==='VIDEO') v.pause();}),{rootMargin:'200px'});
$$('video[data-lazy]').forEach(v=>io.observe(v));
const once=(el,fn,th=.35)=>{const o=new IntersectionObserver(es=>{if(es[0].isIntersecting){fn();o.disconnect();}},{threshold:th}); o.observe(el);};
once($('.radio'),()=>playConvo(0),.3);
once($('.phone'),playChat,.4);
new IntersectionObserver(es=>{nOn=es[0].isIntersecting; if(nOn) noise();}).observe($('.next'));

/* counters */
const count=el=>{const n=+el.dataset.n; if(RM||!G) return; const o={v:0}; G.to(o,{v:n,duration:1.6,ease:'power3.out',onUpdate:()=>el.textContent=Math.round(o.v)});};
$$('[data-n]').forEach(el=>once(el,()=>count(el),.6));

if(!G||RM){ playConvo; return; }
gsap.registerPlugin(ScrollTrigger);

/* hero intro */
const wm=$('#wm'); wm.innerHTML=[...wm.textContent].map(c=>`<b>${c}</b>`).join('');
const tl=gsap.timeline({defaults:{ease:'expo.out'}});
tl.from('#wm b',{yPercent:110,opacity:0,stagger:.04,duration:.9})
  .from('#h1 .ln>span',{yPercent:110,rotate:3,stagger:.12,duration:1.3},.1)
  .to('.hero .rv',{opacity:1,y:0,stagger:.12,duration:1},.6)
  .from('.ticker',{yPercent:100,duration:1},.8)
  .from('.slide.on img',{scale:1.3,duration:2.4,ease:'power3.out'},0);

/* hero parallax out */
gsap.to('.hero-c',{yPercent:-30,opacity:0,ease:'none',scrollTrigger:{trigger:'.hero',start:'top top',end:'bottom top',scrub:true}});
gsap.to('.slide',{yPercent:18,ease:'none',scrollTrigger:{trigger:'.hero',start:'top top',end:'bottom top',scrub:true}});

/* generic reveals: per section stagger */
$$('section').forEach(sec=>{
  const els=$$('.rv',sec).filter(e=>!e.closest('.hero'));
  if(!els.length) return;
  ScrollTrigger.batch(els,{start:'top 88%',once:true,onEnter:b=>gsap.to(b,{opacity:1,y:0,duration:1,ease:'expo.out',stagger:.08})});
});

/* marquee: scroll velocity driven */
const m1=gsap.to('#m1',{xPercent:-33.333,repeat:-1,duration:40,ease:'none'});
const m2=gsap.fromTo('#m2',{xPercent:-33.333},{xPercent:0,repeat:-1,duration:46,ease:'none'});
ScrollTrigger.create({trigger:'.marq',start:'top bottom',end:'bottom top',onUpdate:s=>{const v=Math.min(Math.abs(s.getVelocity())/300,6); gsap.to([m1,m2],{timeScale:1+v,duration:.3,overwrite:true}); gsap.to([m1,m2],{timeScale:1,duration:1.2,delay:.3});}});

/* parallax backgrounds */
$$('[data-par]').forEach(el=>gsap.fromTo(el,{yPercent:-6},{yPercent:6,ease:'none',scrollTrigger:{trigger:el.parentElement,start:'top bottom',end:'bottom top',scrub:true}}));
/* AGP title clip reveal */
gsap.from('.w-agp .bg img',{scale:1.25,ease:'none',scrollTrigger:{trigger:'.w-agp',start:'top bottom',end:'top top',scrub:true}});
gsap.fromTo('.w-agp',{clipPath:'inset(8% 6% 0 6% round 40px)'},{clipPath:'inset(0% 0% 0 0% round 0px)',ease:'none',scrollTrigger:{trigger:'.w-agp',start:'top bottom',end:'top 20%',scrub:true}});
/* strip slides sideways */
gsap.fromTo('#strip figure',{x:120},{x:-120,ease:'none',scrollTrigger:{trigger:'#strip',start:'top bottom',end:'bottom top',scrub:true}});
/* palasora: sun sweeps once */
ScrollTrigger.create({trigger:'#sun',start:'top 75%',once:true,onEnter:()=>{const o={p:95}; gsap.to(o,{p:50,duration:2.2,ease:'power3.inOut',onUpdate:()=>setX(o.p)});}});
/* warfront mosaic tiles */
gsap.from('.mosaic .t',{clipPath:'inset(0 0 100% 0)',stagger:.15,duration:1.2,ease:'expo.inOut',scrollTrigger:{trigger:'.mosaic',start:'top 80%'}});
/* world tint crossovers */
const tints=[['#games','#040a1e'],['#palasora','#0b1c1f'],['#warfront','#120d06'],['#anansora','#1a0c0b'],['#crew','#07080a'],['#jisste','#0d0b07']];
tints.forEach(([s,c])=>ScrollTrigger.create({trigger:s,start:'top 50%',end:'bottom 50%',onToggle:st=>{if(st.isActive) gsap.to('body',{backgroundColor:c,duration:.6});}}));

/* crew horizontal pin (desktop only) */
ScrollTrigger.matchMedia({
  '(min-width:1001px)':()=>{
    const rail=$('#hrail');
    const dist=()=>rail.scrollWidth-innerWidth;
    const tw=gsap.to(rail,{x:()=>-dist(),ease:'none',scrollTrigger:{trigger:'#hwrap',start:'top 8%',end:()=>'+='+dist(),pin:true,scrub:.6,invalidateOnRefresh:true}});
    $$('.day',rail).forEach(d=>gsap.from($('.dt',d),{y:60,opacity:0,ease:'expo.out',scrollTrigger:{trigger:d,containerAnimation:tw,start:'left 75%',toggleActions:'play none none reverse'}}));
    $$('.day img, .day video',rail).forEach(m=>gsap.fromTo(m,{xPercent:-6,scale:1.15},{xPercent:6,scale:1.15,ease:'none',scrollTrigger:{trigger:m.parentElement,containerAnimation:tw,start:'left right',end:'right left',scrub:true}}));
  },
  '(max-width:1000px)':()=>{
    $$('.day').forEach(d=>gsap.from(d,{y:60,opacity:0,duration:1,ease:'expo.out',scrollTrigger:{trigger:d,start:'top 88%'}}));
  }
});
/* phone tilt */
gsap.fromTo('.phone',{y:80,rotate:-10},{y:-40,rotate:-3,ease:'none',scrollTrigger:{trigger:'.jis',start:'top bottom',end:'bottom top',scrub:true}});
/* numbers lines rise */
gsap.from('.nwall .n b',{yPercent:100,stagger:.08,duration:1.1,ease:'expo.out',scrollTrigger:{trigger:'.nwall',start:'top 85%'}});
/* footer wordmark */
gsap.from('.fbig span',{yPercent:100,opacity:0,stagger:.05,duration:1.1,ease:'expo.out',scrollTrigger:{trigger:'.fbig',start:'top 95%'}});
addEventListener('load',()=>ScrollTrigger.refresh());
})();
