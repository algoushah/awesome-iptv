// 📺 ايوب TV — IPTV browser on Cloudflare Workers
// Data: https://iptv-org.github.io/api/  (channels, streams, logos, countries, categories, blocklist)
// No secrets / env vars needed.

const API = 'https://iptv-org.github.io/api/';
const TTL = 6 * 60 * 60 * 1000; // 6h
const LOGO = 'https://r2.ayb7.com/public/logo-ayoub/';
let MEM = { t: 0, data: null, p: null };

async function getJSON(name, optional) {
  try {
    const r = await fetch(API + name, { cf: { cacheTtl: 21600, cacheEverything: true } });
    if (!r.ok) throw new Error(name + ' ' + r.status);
    return await r.json();
  } catch (e) {
    if (optional) return [];
    throw e;
  }
}

async function build() {
  const [channels, streams, logos, countries, cats, blocklist] = await Promise.all([
    getJSON('channels.json'),
    getJSON('streams.json'),
    getJSON('logos.json', true),
    getJSON('countries.json', true),
    getJSON('categories.json', true),
    getJSON('blocklist.json', true),
  ]);
  const blocked = new Set((blocklist || []).map((b) => b.channel));
  const chMap = new Map();
  for (const c of channels) chMap.set(c.id, c);
  const logoMap = new Map();
  for (const l of logos || []) if (l.channel && l.url && !logoMap.has(l.channel)) logoMap.set(l.channel, l.url);

  const byCh = new Map();
  for (const s of streams) {
    if (!s.channel || !s.url) continue;
    const c = chMap.get(s.channel);
    if (!c || c.is_nsfw || c.closed || blocked.has(c.id)) continue;
    let it = byCh.get(c.id);
    if (!it) {
      it = {
        id: c.id,
        n: c.name,
        c: c.country || '',
        k: c.categories || [],
        l: logoMap.get(c.id) || c.logo || '',
        s: [],
        _s: (c.name + ' ' + (c.alt_names || []).join(' ')).toLowerCase(),
      };
      byCh.set(c.id, it);
    }
    if (it.s.length < 3 && !it.s.some((x) => x[0] === s.url)) it.s.push([s.url, s.quality || '']);
  }
  const items = [...byCh.values()].sort((a, b) => a.n.localeCompare(b.n));

  const cCount = {}, kCount = {};
  for (const it of items) {
    if (it.c) cCount[it.c] = (cCount[it.c] || 0) + 1;
    for (const k of it.k) kCount[k] = (kCount[k] || 0) + 1;
  }
  const meta = {
    total: items.length,
    updated: new Date().toISOString(),
    countries: (countries || [])
      .filter((c) => cCount[c.code])
      .map((c) => ({ code: c.code, name: c.name, flag: c.flag || '', count: cCount[c.code] }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    categories: (cats || [])
      .filter((k) => kCount[k.id])
      .map((k) => ({ id: k.id, name: k.name, count: kCount[k.id] }))
      .sort((a, b) => b.count - a.count),
  };
  return { items, meta };
}

async function getIndex() {
  const now = Date.now();
  if (MEM.data && now - MEM.t < TTL) return MEM.data;
  if (!MEM.p) {
    MEM.p = build()
      .then((d) => { MEM.data = d; MEM.t = Date.now(); return d; })
      .finally(() => { MEM.p = null; });
  }
  try {
    return await MEM.p;
  } catch (e) {
    if (MEM.data) return MEM.data; // serve stale on failure
    throw e;
  }
}

function filterItems(idx, p) {
  const q = (p.get('q') || '').trim().toLowerCase();
  const country = (p.get('country') || '').toUpperCase();
  const cat = p.get('cat') || '';
  const https = p.get('https') === '1';
  const ids = p.get('ids') ? new Set(p.get('ids').split(',').slice(0, 500)) : null;
  const out = [];
  for (const it of idx.items) {
    if (ids && !ids.has(it.id)) continue;
    if (country && it.c !== country) continue;
    if (cat && !it.k.includes(cat)) continue;
    if (q && !it._s.includes(q)) continue;
    let s = it.s;
    if (https) {
      s = s.filter((x) => x[0].startsWith('https://'));
      if (!s.length) continue;
    }
    out.push({ id: it.id, n: it.n, c: it.c, k: it.k, l: it.l, s });
  }
  return out;
}

const J = (o, cache) =>
  new Response(JSON.stringify(o), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache || 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    const path = url.pathname;

    if (path === '/favicon.ico') return Response.redirect(LOGO + 'favicon.ico', 302);

    if (path === '/' || path === '/index.html') {
      return new Response(HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        },
      });
    }

    if (path === '/api/meta' || path === '/api/channels' || path === '/playlist.m3u') {
      let idx;
      try {
        idx = await getIndex();
      } catch (e) {
        return J({ error: 'upstream_unavailable' }, 'no-store');
      }
      if (path === '/api/meta') return J(idx.meta);

      const list = filterItems(idx, url.searchParams);
      if (path === '/api/channels') {
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '48', 10) || 48));
        return J({ total: list.length, items: list.slice(offset, offset + limit) });
      }
      // playlist.m3u (first stream of each channel, max 3000)
      const clean = (s) => String(s || '').replace(/[\r\n",]/g, ' ');
      let m3u = '#EXTM3U\n';
      for (const it of list.slice(0, 3000)) {
        if (!it.s.length) continue;
        m3u += '#EXTINF:-1 tvg-id="' + clean(it.id) + '" tvg-logo="' + clean(it.l) + '" group-title="' + clean(it.k[0] || 'general') + '",' + clean(it.n) + '\n' + it.s[0][0] + '\n';
      }
      return new Response(m3u, {
        headers: {
          'content-type': 'audio/x-mpegurl; charset=utf-8',
          'content-disposition': 'attachment; filename="ayoub-tv.m3u"',
          'cache-control': 'public, max-age=300',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

// ───────────────────────── Front-end (ريشة design) ─────────────────────────
const HTML = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ايوب TV 📺 — قنوات IPTV</title>
<meta name="description" content="Browse and watch free public IPTV channels from around the world.">
<link rel="icon" href="https://r2.ayb7.com/public/logo-ayoub/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="https://r2.ayb7.com/public/logo-ayoub/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="https://r2.ayb7.com/public/logo-ayoub/favicon-16x16.png">
<link rel="apple-touch-icon" href="https://r2.ayb7.com/public/logo-ayoub/apple-touch-icon.png">
<link rel="manifest" href="https://r2.ayb7.com/public/logo-ayoub/site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Almarai:wght@400;700&family=Cairo+Play:wght@500;700;900&family=Fraunces:opsz,wght@9..144,600;9..144,800&family=Nunito+Sans:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#FAF7F0; --fg:#1d2216; --mut:#5b6250; --card:#fff; --line:#e4dfd0;
  --vi:#6D4AAE; --or:#C1499B; --sk:#4A87C7; --te:#23A6A0; --em:#4CAF6D;
  --grad:linear-gradient(120deg,#6D4AAE,#C1499B 28%,#4A87C7 55%,#23A6A0 78%,#4CAF6D);
  --glow:.16;
}
@media(prefers-color-scheme:dark){
  :root{--bg:#12160D; --fg:#f1eee4; --mut:#a9b09a; --card:#1a2013; --line:#2c3421; --glow:.26}
}
*{box-sizing:border-box}
html{scroll-padding-top:env(safe-area-inset-top,0px)}
body{margin:0;background:var(--bg);color:var(--fg);min-height:100vh;
  padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);
  font-family:'Nunito Sans',system-ui,sans-serif;line-height:1.6}
html[lang=ar] body{font-family:'Almarai','Nunito Sans',system-ui,sans-serif}
h1,h2,h3{font-family:'Fraunces',Georgia,serif;margin:0}
html[lang=ar] h1,html[lang=ar] h2,html[lang=ar] h3{font-family:'Cairo Play','Fraunces',sans-serif}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:var(--glow);
  background:radial-gradient(420px 420px at 12% 8%,#6D4AAE,transparent 70%),
             radial-gradient(480px 480px at 92% 30%,#23A6A0,transparent 70%),
             radial-gradient(460px 460px at 30% 95%,#C1499B,transparent 70%);filter:blur(40px)}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
nav{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.15rem;text-decoration:none;color:var(--fg)}
.brand img{width:44px;height:44px;border-radius:62% 38% 55% 45%/48% 58% 42% 52%;border:2px solid transparent;
  background:linear-gradient(var(--card),var(--card)) padding-box,var(--grad) border-box;box-shadow:0 6px 18px rgba(109,74,174,.25)}
.gb{border:2px solid transparent;background:linear-gradient(var(--card),var(--card)) padding-box,var(--grad) border-box}
button,select,input{font:inherit;color:inherit}
.tbtn{cursor:pointer;border-radius:999px;padding:6px 14px;font-weight:700}
.hero{text-align:center;padding:28px 0 8px}
.hero h1{font-size:clamp(2rem,6vw,3.4rem);line-height:1.15;font-weight:800;
  background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{color:var(--mut);max-width:620px;margin:10px auto 0}
.stat{display:inline-block;margin-top:12px;padding:4px 14px;border-radius:999px;font-weight:700;font-size:.9rem}
.bar{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 12px}
.bar input[type=search]{flex:1 1 240px;min-width:0;padding:12px 16px;border-radius:14px;background:var(--card)}
.bar select{padding:12px 14px;border-radius:14px;background:var(--card);max-width:100%}
.chk{display:flex;align-items:center;gap:6px;font-size:.92rem;color:var(--mut);padding:0 6px;cursor:pointer}
.chips{display:flex;gap:8px;overflow-x:auto;padding:4px 2px 10px;scrollbar-width:thin}
.chip{flex:0 0 auto;cursor:pointer;border-radius:999px;padding:5px 14px;font-size:.9rem;font-weight:600;white-space:nowrap}
.chip.on{background:var(--grad);border-color:transparent;color:#fff}
h2{font-size:1.5rem;margin:18px 0 14px}
h2::after{content:"";display:block;width:56px;height:4px;border-radius:4px;background:var(--grad);margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
.card{border-radius:18px;padding:14px;cursor:pointer;position:relative;display:flex;flex-direction:column;gap:8px;min-height:150px}
.card:focus-visible,button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid var(--sk);outline-offset:2px}
.lg{height:64px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(127,127,127,.08)}
.lg img{max-width:100%;max-height:56px;object-fit:contain}
.lg span{font-size:2rem}
.cn{font-weight:800;font-size:1rem;line-height:1.3;word-break:break-word}
.meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;color:var(--mut);font-size:.82rem}
.tag{padding:1px 9px;border-radius:999px;font-size:.75rem;font-weight:700}
.star{position:absolute;top:8px;inset-inline-end:8px;background:none;border:0;font-size:1.25rem;cursor:pointer;line-height:1}
.more{display:block;margin:22px auto;padding:12px 28px;border-radius:999px;background:var(--grad);color:#fff;border:0;font-weight:800;cursor:pointer}
.empty{text-align:center;color:var(--mut);padding:40px 0}
footer{text-align:center;color:var(--mut);padding:34px 0 28px;font-size:.92rem}
footer a{color:var(--sk)}
.ov{position:fixed;inset:0;background:rgba(10,12,6,.78);display:none;align-items:center;justify-content:center;padding:14px;z-index:50}
.ov.open{display:flex}
.pl{width:min(900px,100%);max-height:100%;overflow:auto;border-radius:20px;padding:14px}
.pl video{width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;display:block}
.ph{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
.ph h3{font-size:1.15rem}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}
.btn{cursor:pointer;border-radius:12px;padding:8px 14px;font-weight:700;background:var(--card)}
.msg{margin-top:10px;font-size:.92rem;color:var(--mut)}
.msg.err{color:var(--or)}
@media(prefers-reduced-motion:no-preference){
  .card{transition:transform .2s,box-shadow .2s;animation:up .5s both}
  .card:hover{transform:translateY(-4px);box-shadow:0 10px 26px rgba(109,74,174,.22)}
  @keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
}
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <a class="brand" href="/"><img src="https://r2.ayb7.com/public/logo-ayoub/android-chrome-192x192.png" alt="Logo" width="44" height="44"><span>ايوب TV 📺</span></a>
    <div style="display:flex;gap:8px;align-items:center">
      <a class="tbtn gb" id="plBtn" href="/playlist.m3u" style="text-decoration:none;color:inherit" data-i="m3u">⬇️ M3U</a>
      <button class="tbtn gb" id="langBtn" type="button" style="background-color:transparent">EN 🌐</button>
    </div>
  </nav>

  <section class="hero">
    <h1 data-i="title">قنوات التلفزيون من كل العالم</h1>
    <p data-i="sub">تصفّح آلاف القنوات العامة المجانية وشغّلها مباشرة من المتصفح 🌍</p>
    <span class="stat gb" id="stat">…</span>
  </section>

  <div class="bar">
    <input id="q" class="gb" type="search" autocomplete="off" aria-label="search">
    <select id="country" class="gb" aria-label="country"></select>
    <label class="chk"><input id="https" type="checkbox" checked> <span data-i="httpsOnly">HTTPS فقط 🔒</span></label>
    <button id="favBtn" class="tbtn gb" type="button" style="background-color:transparent" data-i="favs">⭐ المفضلة</button>
  </div>
  <div class="chips" id="chips"></div>

  <h2 id="h2" data-i="channels">📺 القنوات</h2>
  <div class="grid" id="grid"></div>
  <div class="empty" id="empty" hidden data-i="none">ما لقينا قنوات 😅</div>
  <button class="more" id="more" hidden data-i="more">⬇️ عرض المزيد</button>

  <footer>
    <div>Made with love and coffee ❤️☕</div>
    <div style="margin-top:6px"><span data-i="credit">البيانات من</span> <a href="https://github.com/iptv-org/iptv" target="_blank" rel="noopener noreferrer">iptv-org</a></div>
  </footer>
</div>

<div class="ov" id="ov" role="dialog" aria-modal="true">
  <div class="pl gb" style="background-color:var(--card)">
    <div class="ph"><h3 id="pt"></h3><button class="btn gb" id="px" type="button" aria-label="close">✖️</button></div>
    <video id="vid" controls autoplay playsinline></video>
    <div class="row" id="srcs"></div>
    <div class="row">
      <button class="btn gb" id="cp" type="button" data-i="copy">📋 نسخ الرابط</button>
      <button class="btn gb" id="pf" type="button">⭐</button>
    </div>
    <div class="msg" id="pm"></div>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js"></script>
<script>
(function(){
var $=function(s){return document.querySelector(s)};
var T={
 ar:{title:'قنوات التلفزيون من كل العالم',sub:'تصفّح آلاف القنوات العامة المجانية وشغّلها مباشرة من المتصفح 🌍',
  search:'🔍 ابحث عن قناة…',all:'كل الدول 🌍',allc:'الكل ✨',httpsOnly:'HTTPS فقط 🔒',favs:'⭐ المفضلة',
  channels:'📺 القنوات',more:'⬇️ عرض المزيد',none:'ما لقينا قنوات 😅',credit:'البيانات من',copy:'📋 نسخ الرابط',
  copied:'تم النسخ ✅',m3u:'⬇️ M3U',n:'قناة',src:'مصدر',loading:'⏳ جاري التحميل…',
  mixed:'⚠️ هذا الرابط HTTP والمتصفح يمنعه داخل موقع HTTPS. انسخ الرابط وشغّله في VLC.',
  fail:'❌ ما اشتغل هنا (القناة متوقفة أو السيرفر يمنع المتصفح). جرّب مصدر ثاني أو انسخ الرابط وشغّله في VLC.',
  live:'🔴 مباشر',err:'تعذر تحميل القنوات، حاول لاحقاً 🙏'},
 en:{title:'TV channels from around the world',sub:'Browse thousands of free public channels and play them right in your browser 🌍',
  search:'🔍 Search channels…',all:'All countries 🌍',allc:'All ✨',httpsOnly:'HTTPS only 🔒',favs:'⭐ Favorites',
  channels:'📺 Channels',more:'⬇️ Load more',none:'No channels found 😅',credit:'Data from',copy:'📋 Copy link',
  copied:'Copied ✅',m3u:'⬇️ M3U',n:'channels',src:'Source',loading:'⏳ Loading…',
  mixed:'⚠️ This link is HTTP and browsers block it inside an HTTPS site. Copy it and open it in VLC.',
  fail:'❌ Could not play here (channel offline or the server blocks browsers). Try another source or copy the link into VLC.',
  live:'🔴 Live',err:'Could not load channels, try again later 🙏'}
};
var lang='ar',favs=[],st={q:'',country:'',cat:'',https:true,fav:false,offset:0,total:0},flags={},hls=null,cur=null,curSrc='',timer=null;
try{lang=localStorage.getItem('iptv_lang')||'ar'}catch(e){}
try{favs=JSON.parse(localStorage.getItem('iptv_fav')||'[]')}catch(e){}
function t(k){return T[lang][k]||k}
function saveFav(){try{localStorage.setItem('iptv_fav',JSON.stringify(favs))}catch(e){}}
function applyLang(){
  document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';
  document.querySelectorAll('[data-i]').forEach(function(el){el.textContent=t(el.getAttribute('data-i'))});
  $('#q').placeholder=t('search');$('#langBtn').textContent=lang==='ar'?'EN 🌐':'عربي 🌐';
  if(meta)renderFilters();updateStat();
}
var meta=null;
function updateStat(){if(meta)$('#stat').textContent='📡 '+meta.total.toLocaleString()+' '+t('n')}
function renderFilters(){
  var s=$('#country'),v=st.country;s.textContent='';
  var o=document.createElement('option');o.value='';o.textContent=t('all');s.appendChild(o);
  meta.countries.forEach(function(c){var op=document.createElement('option');op.value=c.code;op.textContent=(c.flag||'')+' '+c.name+' ('+c.count+')';s.appendChild(op)});
  s.value=v;
  var ch=$('#chips');ch.textContent='';
  function chip(id,label){var b=document.createElement('button');b.type='button';b.className='chip gb'+(st.cat===id?' on':'');b.textContent=label;b.onclick=function(){st.cat=id;renderFilters();load(true)};ch.appendChild(b)}
  chip('',t('allc'));
  meta.categories.forEach(function(k){chip(k.id,k.name)});
}
function qs(extra){
  var p=new URLSearchParams();
  if(st.q)p.set('q',st.q);if(st.country)p.set('country',st.country);if(st.cat)p.set('cat',st.cat);
  if(st.https)p.set('https','1');
  if(st.fav)p.set('ids',favs.join(',')||'__none__');
  for(var k in extra)p.set(k,extra[k]);return p.toString();
}
function card(it){
  var d=document.createElement('div');d.className='card gb';d.tabIndex=0;d.setAttribute('role','button');
  var lg=document.createElement('div');lg.className='lg';
  if(it.l){var im=document.createElement('img');im.src=it.l;im.alt=it.n;im.loading='lazy';im.referrerPolicy='no-referrer';
    im.onerror=function(){lg.textContent='';var sp=document.createElement('span');sp.textContent='📺';lg.appendChild(sp)};lg.appendChild(im)}
  else{var sp=document.createElement('span');sp.textContent='📺';lg.appendChild(sp)}
  var nm=document.createElement('div');nm.className='cn';nm.textContent=it.n;
  var mt=document.createElement('div');mt.className='meta';
  if(it.c){var f=document.createElement('span');f.textContent=(flags[it.c]||'🏳️')+' '+it.c;mt.appendChild(f)}
  if(it.k[0]){var tg=document.createElement('span');tg.className='tag gb';tg.textContent=it.k[0];mt.appendChild(tg)}
  var q=it.s[0]&&it.s[0][1];if(q){var qt=document.createElement('span');qt.className='tag gb';qt.textContent=q;mt.appendChild(qt)}
  var star=document.createElement('button');star.type='button';star.className='star';star.setAttribute('aria-label','favorite');
  function paint(){star.textContent=favs.indexOf(it.id)>-1?'⭐':'☆'}paint();
  star.onclick=function(e){e.stopPropagation();toggleFav(it.id);paint()};
  d.appendChild(star);d.appendChild(lg);d.appendChild(nm);d.appendChild(mt);
  d.onclick=function(){openPlayer(it)};
  d.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();openPlayer(it)}};
  return d;
}
function toggleFav(id){
  var i=favs.indexOf(id);if(i>-1)favs.splice(i,1);else favs.push(id);saveFav();
  if(cur)$('#pf').textContent=favs.indexOf(cur.id)>-1?'⭐':'☆';
}
function load(reset){
  if(reset){st.offset=0;$('#grid').textContent=''}
  fetch('/api/channels?'+qs({offset:st.offset,limit:48})).then(function(r){return r.json()}).then(function(d){
    if(d.error)throw new Error(d.error);
    st.total=d.total;d.items.forEach(function(it){$('#grid').appendChild(card(it))});
    st.offset+=d.items.length;
    $('#empty').hidden=st.total>0;$('#more').hidden=st.offset>=st.total;
  }).catch(function(){$('#empty').hidden=false;$('#empty').textContent=t('err');$('#more').hidden=true});
}
function stop(){if(hls){hls.destroy();hls=null}var v=$('#vid');v.pause();v.removeAttribute('src');v.load()}
function play(url){
  var v=$('#vid'),m=$('#pm');stop();curSrc=url;m.className='msg';m.textContent=t('loading');
  if(location.protocol==='https:'&&url.indexOf('http://')===0){m.className='msg err';m.textContent=t('mixed');return}
  function fail(){m.className='msg err';m.textContent=t('fail')}
  if(window.Hls&&Hls.isSupported()){
    hls=new Hls({maxBufferLength:20});hls.loadSource(url);hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED,function(){m.textContent=t('live');v.play().catch(function(){})});
    hls.on(Hls.Events.ERROR,function(e,data){if(data&&data.fatal)fail()});
  }else if(v.canPlayType('application/vnd.apple.mpegurl')){
    v.src=url;v.onloadedmetadata=function(){m.textContent=t('live')};v.onerror=fail;v.play().catch(function(){});
  }else fail();
}
function openPlayer(it){
  cur=it;$('#pt').textContent=(flags[it.c]||'📺')+' '+it.n;
  var sr=$('#srcs');sr.textContent='';
  it.s.forEach(function(s,i){var b=document.createElement('button');b.type='button';b.className='btn gb';b.textContent=t('src')+' '+(i+1)+(s[1]?' · '+s[1]:'');b.onclick=function(){play(s[0])};sr.appendChild(b)});
  $('#pf').textContent=favs.indexOf(it.id)>-1?'⭐':'☆';
  $('#ov').classList.add('open');play(it.s[0][0]);
}
function closePlayer(){$('#ov').classList.remove('open');stop();cur=null}
$('#px').onclick=closePlayer;
$('#ov').onclick=function(e){if(e.target===this)closePlayer()};
document.addEventListener('keydown',function(e){if(e.key==='Escape')closePlayer()});
$('#pf').onclick=function(){if(cur)toggleFav(cur.id)};
$('#cp').onclick=function(){
  if(!curSrc)return;
  var done=function(){var b=$('#cp');var o=b.textContent;b.textContent=t('copied');setTimeout(function(){b.textContent=t('copy')},1500)};
  if(navigator.clipboard)navigator.clipboard.writeText(curSrc).then(done,function(){});
};
$('#q').addEventListener('input',function(){clearTimeout(timer);var v=this.value;timer=setTimeout(function(){st.q=v;load(true)},300)});
$('#country').onchange=function(){st.country=this.value;load(true);syncPl()};
$('#https').onchange=function(){st.https=this.checked;load(true);syncPl()};
$('#favBtn').onclick=function(){st.fav=!st.fav;this.style.background=st.fav?'var(--grad)':'transparent';this.style.color=st.fav?'#fff':'inherit';load(true)};
$('#more').onclick=function(){load(false)};
$('#langBtn').onclick=function(){lang=lang==='ar'?'en':'ar';try{localStorage.setItem('iptv_lang',lang)}catch(e){}applyLang()};
function syncPl(){var p=new URLSearchParams();if(st.country)p.set('country',st.country);if(st.cat)p.set('cat',st.cat);if(st.https)p.set('https','1');$('#plBtn').href='/playlist.m3u?'+p.toString()}
var oldChip=renderFilters;renderFilters=function(){oldChip();syncPl()};
applyLang();
fetch('/api/meta').then(function(r){return r.json()}).then(function(m){
  if(m.error)throw new Error(m.error);
  meta=m;m.countries.forEach(function(c){flags[c.code]=c.flag});renderFilters();updateStat();load(true);
}).catch(function(){$('#stat').textContent='⚠️';$('#empty').hidden=false;$('#empty').textContent=t('err')});
})();
</script>
</body>
</html>`;
