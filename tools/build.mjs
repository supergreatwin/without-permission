import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { extname, dirname, join, resolve, sep } from "node:path";
import { build } from "esbuild";
import { load } from "cheerio";
import { articleRoute, assetPath, renderArticle, selected, updateListing } from "./render.mjs";

const target=resolve("dist");
const template=resolve("public");
const fixture=process.argv.includes("--fixture");
const site=process.env.WP_SITE_URL ?? "https://supergreatwin.github.io/without-permission/";
if(!new URL(site).pathname.endsWith("/"))throw new Error("WP_SITE_URL requires a trailing slash");
const supabaseUrl=process.env.SUPABASE_URL;
const supabaseKey=process.env.SUPABASE_PUBLISHABLE_KEY;
const platformUrl=supabaseUrl && new URL("/functions/v1/platform",supabaseUrl).href;
if(supabaseUrl && new URL(supabaseUrl).protocol!=="https:" && !fixture)throw new Error("Use an HTTPS Supabase origin");
if(supabaseKey?.startsWith("sb_publishable_")){
  if(!/^sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/.test(supabaseKey)){
    throw new Error("SUPABASE_PUBLISHABLE_KEY must contain exactly one Supabase publishable key");
  }
} else if(supabaseKey){
  const claims=JSON.parse(Buffer.from(supabaseKey.split(".")[1]||"", "base64url").toString("utf8"));
  if(claims.role!=="anon")throw new Error("Only the existing anon or publishable key can be shipped to the browser");
}
let exported={rows:[],assets:{}};
if(fixture)exported=JSON.parse(await readFile("tools/legacy-fixture.json","utf-8"));
else {
  if(!platformUrl||!supabaseKey||!process.env.WP_EXPORT_TOKEN)throw new Error("Live build requires the Supabase URL, publishable key and export token");
  const response=await fetch(platformUrl+"/export",{headers:{Authorization:"Bearer "+process.env.WP_EXPORT_TOKEN},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error("Platform export failed ("+response.status+")");
  exported=await response.json();
}
if(!Array.isArray(exported.rows)||exported.rows.filter(row=>/^archive\/\d{16,22}\/$/.test(row.route)).length<31){
  throw new Error("The complete legacy archive must be imported before publishing");
}

await rm(target,{recursive:true,force:true});
await cp(template,target,{recursive:true});
const config={siteUrl:site,supabaseUrl,supabaseKey,platformUrl,captchaSiteKey:process.env.TURNSTILE_SITE_KEY,publicRegistration:process.env.WP_PUBLIC_REGISTRATION==="true"};
await writeFile(join(target,"desk/config.js"),"window.wpConfig=Object.freeze("+JSON.stringify(config)+");\n");
await build({entryPoints:["frontend/desk.mjs"],outfile:join(target,"desk/desk.js"),bundle:true,platform:"browser",format:"iife",target:"es2022", minify:true});
await cp("frontend/traffic.mjs",join(target,"traffic.js"));
const shell=await readFile(join(template,"articles/lip-gloss/index.html"),"utf8");

function validImage(format, bytes){
  const prefix=bytes.subarray(0,12);
  if(format===".png")return prefix.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"));
  if(format===".jpg"||format===".jpeg")return prefix.subarray(0,3).equals(Buffer.from("ffd8ff","hex"));
  if(format===".gif")return /^GIF8[79]a/.test(prefix.toString("ascii"));
  if(format===".webp")return prefix.subarray(0,4).toString()==="RIFF" && prefix.subarray(8,12).toString()==="WEBP";
  if(format===".avif")return prefix.subarray(4,8).toString()==="ftyp" && ["avif","avis"].includes(prefix.subarray(8,12).toString());
  return false;
}

for(const [path,signed] of Object.entries(exported.assets)){
  if(!assetPath.test(path) || new URL(signed).origin!==new URL(supabaseUrl).origin)throw new Error("Unexpected published asset URL");
  const reply=await fetch(signed,{redirect:"error",signal:AbortSignal.timeout(15000)});
  if(!reply.ok)throw new Error("Published image is unavailable");
  const bytes=Buffer.from(await reply.arrayBuffer());
  if(bytes.length>8*1024*1024||!validImage(extname(path),bytes))throw new Error("Published image is invalid");
  const file=join(target,"editorial-media",path);
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,bytes);
}

const rows=exported.rows.sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at));
for(const row of rows){
  if(!articleRoute.test(row.route))throw new Error("Unexpected article route");
  if(row.passthrough && row.visible){
    await access(join(target,row.route,"index.html"));
    continue;
  }
  const ownShell=row.route.startsWith("archive/")?await readFile(join(template,row.route,"index.html"),"utf8"):shell;
  const file=join(target,row.route,"index.html");
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,renderArticle(row,ownShell,site,"ar"));
  if(!row.visible || row.payload.editions.en?.title && row.payload.editions.en?.body) {
    const english=join(target,row.route,"en","index.html");
    await mkdir(dirname(english),{recursive:true});
    await writeFile(english,renderArticle(row,ownShell,site,"en"));
  }
}
if(rows.some(row=>!row.passthrough || !row.visible)){
  for(const [path,kind] of [["index.html","home"],["stories/index.html","features"],["archive/index.html","archive"]]){
    const file=join(target,path);
    await writeFile(file,updateListing(await readFile(file,"utf8"),rows,kind));
  }
}

const xml=(text)=>String(text).replace(/[<>&"']/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"})[c]);
const sitemap=join(target,"sitemap.xml");
let oldMap=await readFile(sitemap,"utf8");
for(const row of rows.filter(row=>!row.passthrough || !row.visible)){
  const base=site+row.route;
  oldMap=oldMap.replace(/<url>\s*<loc>(.*?)<\/loc>[\s\S]*?<\/url>/g,(match,loc)=>loc===base?"":match);
  if(row.visible){
    const date=new Date(row.updated_at||row.published_at).toISOString().slice(0,10);
    for (const url of [base,...(row.payload.editions.en?.title && row.payload.editions.en?.body?[base+"en/"]:[])]){
      oldMap=oldMap.replace("</urlset>",`  <url><loc>${xml(url)}</loc><lastmod>${date}</lastmod></url>\n</urlset>`);
    }
  }
}
await writeFile(sitemap,oldMap);
for(const lang of ["ar","en"]){
  const articles=rows.filter(row=>row.visible && row.route.startsWith("articles/") &&
    row.payload.editions[lang]?.title && row.payload.editions[lang]?.body).slice(0,40);
  const items=articles.map(row=>{
    const e=selected(row,lang);
    const url=site+row.route+(lang==="en"?(row.passthrough?"?lang=en":"en/"):"");
    return `<item><title>${xml(e.title)}</title><link>${xml(url)}</link><guid>${xml(url)}</guid><description>${xml(e.description)}</description><pubDate>${new Date(row.published_at).toUTCString()}</pubDate></item>`;
  });
  const name=lang==="ar"?"من غير إذن":"Without Permission";
  await writeFile(join(target,`feed-${lang}.xml`),`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${name}</title><link>${xml(site)}</link><description>${name}</description><language>${lang}</language>${items.join("\n")}</channel></rss>\n`);
}

if(!fixture){
  const files=await readdir(target,{recursive:true});
  for(const filename of files.filter(file=>file.endsWith("index.html")&&!file.startsWith("desk"+sep))){
    const file=join(target,filename);
    const html=await readFile(file,"utf8");
    const $=load(html);
    const prefix="../".repeat(filename.split(sep).length-1)||"./";
    for(const nav of $(".footer nav").toArray()){
      const en=$(nav).closest("footer").attr("data-lang")==="en";
      const href=prefix+"desk/"+(en?"?lang=en":"");
      $(nav).append(`<a href="${href}">${en?"Editorial desk":"مكتب التحرير"}</a>`);
    }
    $("body").append(`<script src="${prefix}desk/config.js" defer></script><script src="${prefix}traffic.js" defer></script>`);
    if(filename==="index.html"){
      $("head").append('<link rel="alternate" type="application/rss+xml" href="./feed-ar.xml" title="من غير إذن"><link rel="alternate" type="application/rss+xml" href="./feed-en.xml" title="Without Permission">');
    }
    await writeFile(file,$.html());
  }
}
console.log(`Built ${rows.filter(r=>r.visible).length} public article routes (including the RAW by Vee archive).`);
