import { readFile, readdir, stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { load } from "cheerio";

const path = (name) => new URL("../dist/" + name, import.meta.url);
const inspect = async (name) => load(await readFile(path(name), "utf8"));
const home = await inspect("index.html");
assert.equal(home("[data-beehiiv-embed]").length,2);
const socialImage="https://media.beehiiv.com/cdn-cgi/image/fit=scale-down,format=auto,onerror=redirect,quality=80/uploads/publication/thumbnail/7c5dd2ec-d1b7-4383-9692-6bc1c9a59b8a/without_permission_beehiiv_thumbnail_1200x630__4_.png";
assert.equal(home('meta[property="og:image"]').attr("content"),socialImage,"Homepage must use branded publication artwork");
assert.equal(home('meta[property="og:image:secure_url"]').attr("content"),socialImage);
assert.equal(home('meta[name="twitter:image"]').attr("content"),socialImage);
assert.equal(home('meta[property="og:image:width"]').attr("content"),"1200");
assert.equal(home('meta[property="og:image:height"]').attr("content"),"630");

assert.match(home(".manifesto h2").first().html(), /احنا مش<br>هنتكلم بصوت واطي/);
const contribute = await inspect("contribute/index.html");
assert.match(contribute("iframe.pitch-frame").attr("src"), /^https:\/\/tally\.so\/embed\/je61rx/);
for(const route of ["links","policies","recruit"]){
  const page=await inspect(`${route}/index.html`);
  assert.equal(page("main h1").length,2);
  assert.equal(home(`.footer nav a[href="./${route}/"]`).length,1);
}
const feature=await inspect("articles/lip-gloss/en/index.html");
assert.equal(feature("html").attr("lang"),"en");
assert.match(feature('link[rel="canonical"]').attr("href"),/\/articles\/lip-gloss\/en\/$/);
assert.equal(JSON.parse(feature('script[type="application/ld+json"]').text()).inLanguage,"en");
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
// Every public article in the sitemap must appear on the Stories page.
const sitemapText = await readFile(path("sitemap.xml"), "utf8");
const publishedArticlePaths = [...new Set([...sitemapText.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((match) => new URL(match[1]).pathname.match(/\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/)?.[1])
  .filter(Boolean).map((slug) => `articles/${slug}/`))];
assert.ok(publishedArticlePaths.length, "No published articles found in the sitemap");
const stories = await inspect("stories/index.html");
for (const route of publishedArticlePaths) {
  assert.ok(stories(`main a[href="../${route}"]`).length,
    `Published article ${route} is missing from the Stories listing`);
  const page = await inspect(`${route}index.html`);
  assert.ok(page("main article").length, `Published article ${route} has no article body`);
  assert.equal(page('meta[name="robots"][content*="noindex"]').length, 0,
    `Published article ${route} must be indexable`);
}
console.log(`Verified ${publishedArticlePaths.length} public articles and their Stories listing links.`);

console.log("Built site verified: 31 preserved archive URLs, embedded newsletter and pitch forms, and a protected editorial desk.");
