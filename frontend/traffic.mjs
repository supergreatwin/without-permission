(() => {
  const cfg=window.wpConfig;
  if(!cfg?.platformUrl || navigator.doNotTrack==="1" || navigator.globalPrivacyControl===true) return;
  const base=new URL(cfg.siteUrl);
  if(location.origin!==base.origin || !location.pathname.startsWith(base.pathname))return;
  let route=location.pathname.slice(base.pathname.length).replace(/index\.html$/,"");
  route=route.replace(/^(articles\/[^/]+\/|archive\/\d+\/)en\/$/,"$1");
  if(/^(?:desk|editorial-media)(?:\/|$)/.test(route))return;
  let visit;
  try {
    visit=sessionStorage.getItem("wp-visit");
    if(!visit){
      visit=crypto.randomUUID();
      sessionStorage.setItem("wp-visit",visit);
    }
  } catch { return; }
  let source="direct";
  if(new URLSearchParams(location.search).get("utm_medium")==="email")source="newsletter";
  else if(document.referrer){
    const referrer=new URL(document.referrer);
    if(referrer.origin===location.origin)source="internal";
    else if(/(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com)$/.test(referrer.hostname))source="search";
    else if(/(^|\.)(tiktok\.com|facebook\.com|instagram\.com|reddit\.com|x\.com|twitter\.com)$/.test(referrer.hostname))source="social";
    else source="referral";
  }
  const language=document.documentElement.lang.startsWith("en")?"en":"ar";
  const send=(event)=>fetch(cfg.platformUrl+"/traffic",{
    method:"POST",headers:{"Content-Type":"text/plain"},
    body:JSON.stringify({visit,route,language,source,event}),keepalive:true,credentials:"omit",
  }).catch(()=>{});
  send("view");
  if(!/^(archive\/\d+|articles\/[^/]+)\/$/.test(route))return;
  let elapsed=0, last=visibilityState();
  function visibilityState(){return document.visibilityState==="visible"?performance.now():0;}
  const count=()=>{
    const now=performance.now();
    if(last)elapsed+=now-last;
    last=visibilityState();
    if(elapsed>=30_000){
      clearInterval(timer);
      document.removeEventListener("visibilitychange",count);
      send("engaged");
    }
  };
  const timer=setInterval(count,5000);
  document.addEventListener("visibilitychange",count);
})();
