import assert from "node:assert/strict";

const base = new URL((process.env.WP_SITE_URL || "https://supergreatwin.github.io/without-permission/").trim());
assert.equal(base.protocol, "https:", "Public deployment must use HTTPS");
assert.ok(base.pathname.endsWith("/"), "WP_SITE_URL must end with /");

const stamp = (process.env.GITHUB_SHA || Date.now().toString()).slice(0,12);
const checks = [
  ["", [
    ["Arabic publication title", /من غير إذن/],
    ["Bilingual site", /data-lang="en"/],
    ["Beehiiv newsletter embed", /data-beehiiv-embed=/],
    ["Newsletter fallback", /withouts-newsletter\.beehiiv\.com\/subscribe/],
    ["Branded Open Graph thumbnail", /<meta property="og:image" content="https:\/\/media\.beehiiv\.com\//],
    ["Branded X/Twitter thumbnail", /<meta name="twitter:image" content="https:\/\/media\.beehiiv\.com\//],
  ]],
  ["contribute/", [
    ["Tally pitch embed", /tally\.so\/embed\/je61rx/],
    ["Contributor policy link", /policies\//],
  ]],
  ["policies/", [
    ["Published policy", /سياسات|السياسات/],
    ["Editorial contact", /withoutpermissionmag@gmail\.com/],
  ]],
  ["archive/", [["Legacy archive", /Vee Archive/]]],
  ["archive/7640200060009172245/", [["Preserved archive post", /7640200060009172245/]]],
  ["stories/", [["Stories page", /<main\b/]]],
  ["articles/lip-gloss/", [["Original feature", /<main\b/]]],
  ["links/", [["Links page", /<main\b/]]],
  ["recruit/", [["Recruitment page", /<main\b/]]],
  ["desk/", [["Editorial desk", /desk\.js/], ["Private login desk", /<meta name="robots" content="noindex,nofollow">/]]],
  ["desk/config.js", [["Public-only configuration", /window\.wpConfig=Object\.freeze/]]],
  ["desk/desk.js", [["Built editorial app", /supabase|auth|signInWithPassword/i]]],
  ["site.css", [["Responsive CSS", /@media/]]],
  ["sitemap.xml", [["Sitemap", /<urlset/]]],
  ["feed-ar.xml", [["Arabic RSS", /<rss/]]],
  ["feed-en.xml", [["English RSS", /<rss/]]],
];

async function readDeployed(path) {
  const url = new URL(path,base);
  url.searchParams.set("wp_smoke",stamp);
  let failure;
  for(let attempt=1;attempt<=6;attempt++){
    try{
      const response=await fetch(url,{
        headers:{"Cache-Control":"no-cache"},
        signal:AbortSignal.timeout(15000),
      });
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const body=await response.text();
      assert.ok(body.length>50,`Empty response: ${path||"/"}`);
      return body;
    }catch(error){
      failure=error;
      if(attempt<6)await new Promise(resolve=>setTimeout(resolve,5000));
    }
  }
  throw new Error(`Unable to load ${url.pathname}: ${failure.message}`);
}

const results=await Promise.allSettled(checks.map(async ([path,expectations])=>{
  const content=await readDeployed(path);
  for(const [label,pattern] of expectations){
    assert.match(content,pattern,`${path||"/"}: missing ${label}`);
  }
  if(path==="desk/config.js"){
    const raw=content.match(/window\.wpConfig=Object\.freeze\((\{.*\})\);/s)?.[1];
    assert.ok(raw,"Editorial desk config JSON missing");
    const config=JSON.parse(raw);
    assert.deepEqual(Object.keys(config).filter(key=>
      !["siteUrl","supabaseUrl","supabaseKey","platformUrl","captchaSiteKey","publicRegistration"].includes(key)
    ),[], "Unexpected key in public CMS config");
    assert.ok(config.supabaseUrl && config.supabaseKey && config.platformUrl,
      "Production CMS backend configuration incomplete");
    assert.equal(new URL(config.platformUrl).origin,new URL(config.supabaseUrl).origin,
      "CMS function must share the backend origin");
  }
  return path||"/";
}));
let failed=0;
results.forEach((r,i)=>{
  const path=checks[i][0]||"/";
  if(r.status==="fulfilled")console.log("PASS",path);
  else{failed++; console.error("FAIL",path,r.reason.message);}
});
if(failed)process.exitCode=1;
else console.log(`Public deployment passed ${checks.length} checks at ${base.origin}${base.pathname}`);
