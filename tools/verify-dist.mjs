import { readFile, readdir, stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { load } from "cheerio";

const path = (name) => new URL("../dist/" + name, import.meta.url);
const inspect = async (name) => load(await readFile(path(name), "utf8"));
const home = await inspect("index.html");
assert.equal(home("[data-beehiiv-embed]").length,2);
assert.match(home(".manifesto h2").first().html(), /احنا مش<br>هنتكلم بصوت واطي/);
const contribute = await inspect("contribute/index.html");
assert.match(contribute("iframe.pitch-frame").attr("src"), /^https:\/\/tally\.so\/embed\/je61rx/);
const archive = (await readdir(path("archive/"),{withFileTypes:true}))
  .filter((entry) => entry.isDirectory() && /^\d{16,22}$/.test(entry.name));
assert.equal(archive.length,31);
for (const entry of archive) {
  const page = await inspect(`archive/${entry.name}/index.html`);
  assert.equal(page('link[rel=canonical]').attr('href').split('/').at(-2),entry.name);
}
const desk=await inspect("desk/index.html");
assert.equal(desk('meta[name=robots]').attr('content'),'noindex,nofollow');
assert.ok((await stat(path("desk/desk.js"))).size>10000);
const config=await readFile(path("desk/config.js"),"utf8");
const publicConfig=JSON.parse(config.match(/Object\.freeze\((\{.*\})\)/s)?.[1]??"null");
assert.ok(publicConfig);
assert.ok(Object.keys(publicConfig).every(key=>["siteUrl","supabaseUrl","supabaseKey","platformUrl","captchaSiteKey","publicRegistration"].includes(key)));
if(publicConfig.supabaseKey){
  assert.match(publicConfig.supabaseKey,/^sb_publishable_[A-Za-z0-9_-]+$|^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(new URL(publicConfig.platformUrl).origin,new URL(publicConfig.supabaseUrl).origin);
  const auth=await fetch(new URL("/auth/v1/health",publicConfig.supabaseUrl),{
    headers:{apikey:publicConfig.supabaseKey},
    signal:AbortSignal.timeout(12000),
  });
  assert.equal(auth.status,200);
  const privateTable=await fetch(new URL("/rest/v1/wp_articles?select=id&limit=1",publicConfig.supabaseUrl),{
    headers:{apikey:publicConfig.supabaseKey},
    signal:AbortSignal.timeout(12000),
  });
  assert.ok([401,403].includes(privateTable.status),"Signed-out requests must not access editorial articles");
}
console.log("Built site verified: 31 preserved archive URLs, embedded newsletter and pitch forms, and a protected editorial desk.");
