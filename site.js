(()=>{'use strict';
const base=new URL('.',document.currentScript.src);
const params=new URLSearchParams(location.search);
const language=params.get('lang')==='en'?'en':'ar';
document.documentElement.lang=language==='en'?'en':'ar-EG';
document.documentElement.dir=language==='en'?'ltr':'rtl';
document.querySelectorAll('[data-lang]').forEach(el=>{el.hidden=el.dataset.lang!==language;});
document.querySelectorAll('[data-title-ar]').forEach(el=>{document.title=el.dataset['title'+(language==='en'?'En':'Ar')];});if(language==='en'){const heading=document.querySelector('main [data-lang="en"] h1');if(heading)document.title=heading.textContent.replace(/\s+/g,' ').trim()+' | Without Permission';}
document.querySelectorAll('.lang-switch').forEach(link=>{const u=new URL(location.href);if(language==='en')u.searchParams.delete('lang');else u.searchParams.set('lang','en');link.href=u.pathname+u.search+u.hash;});
document.querySelectorAll('a[href]').forEach(a=>{if(language!=='en'||a.classList.contains('lang-switch'))return;const href=a.getAttribute('href');if(!href||href.startsWith('#')||href.startsWith('mailto:')||href.startsWith('tel:'))return;try{const url=new URL(href,location.href);if(url.origin!==location.origin||!url.pathname.startsWith(base.pathname))return;url.searchParams.set('lang','en');a.href=url.pathname+url.search+url.hash;}catch{}});
const old=decodeURIComponent(location.hash);
if(location.pathname===base.pathname||/\/index\.html$/.test(location.pathname)&&location.pathname.replace(/index\.html$/,'')===base.pathname){
const r=old.match(/^#(?:post-|raw-)(\d{16,22})$/);
const target=r?'archive/'+r[1]+'/':old==='#lip-gloss'?'articles/lip-gloss/':old==='#raw-archive'?'archive/':old==='#articles'?'stories/':old==='#about'?'about/':'';
if(target){const u=new URL(target,base);if(language==='en')u.searchParams.set('lang','en');history.replaceState(null,'',u.href);location.replace(u.href);return;}
}
function updateCollection(section){
const q=(section.querySelector('[data-search]')?.value||'').normalize('NFKC').toLowerCase().trim();
const active=section.querySelector('[data-filter].is-active')?.dataset.filter||'all';
let visible=0;section.querySelectorAll('[data-card]').forEach(card=>{const text=(card.dataset.search||card.textContent).normalize('NFKC').toLowerCase();const pass=(active==='all'||card.dataset.category===active)&&(!q||text.includes(q));card.hidden=!pass;if(pass)visible++;});
const count=section.querySelector('[data-count]');if(count)count.textContent=String(visible);
const empty=section.querySelector('[data-empty]');if(empty)empty.hidden=visible!==0;
}
document.querySelectorAll('[data-collection]').forEach(s=>{const initial=params.get('category');if(initial){const match=s.querySelector('[data-filter="'+initial.replace(/[^a-z]/g,'')+'"]');if(match){s.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('is-active',x===match));}}s.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{s.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('is-active',x===b));updateCollection(s);}));s.querySelector('[data-search]')?.addEventListener('input',()=>updateCollection(s));updateCollection(s);});
document.querySelectorAll('.mobile-menu a').forEach(a=>a.addEventListener('click',()=>{const menu=a.closest('details');if(menu)menu.open=false;}));
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);b.textContent=language==='en'?'Link copied':'تم نسخ الرابط';}catch{b.textContent=language==='en'?'Copy address from browser':'انسخي الرابط من المتصفح';}}));
document.querySelectorAll('.embed-card').forEach(card=>{const btn=card.querySelector('.embed-button');const target=card.querySelector('.embed-target');if(!btn||!target)return;btn.hidden=false;btn.addEventListener('click',()=>{if(target.querySelector('iframe'))return;const player=card.dataset.player;if(!player||!/^https:\/\/www\.tiktok\.com\/player\//.test(player))return;const iframe=document.createElement('iframe');iframe.src=player.replace(/&amp;/g,'&');iframe.title=card.dataset.title||'TikTok post';iframe.loading='lazy';iframe.allow='fullscreen';iframe.referrerPolicy='strict-origin-when-cross-origin';target.append(iframe);btn.hidden=true;});});
const dateEl=document.querySelector('[data-year]');if(dateEl)dateEl.textContent=String(new Date().getFullYear());
})();