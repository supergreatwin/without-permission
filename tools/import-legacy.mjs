import { readFile, writeFile, readdir } from "node:fs/promises";
import { load } from "cheerio";

const root = new URL("../public/", import.meta.url);
const entries = (await readdir(new URL("archive/",root),{withFileTypes:true}))
  .filter((entry)=>entry.isDirectory() && /^\d{16,22}$/.test(entry.name));
if (entries.length !== 31) throw new Error("Expected all 31 RAW by Vee archive routes");
const routes = ["articles/lip-gloss/", ...entries.map(({name}) => `archive/${name}/`).sort()];
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const sql = [
  "-- Generated from the existing static archive and feature. Source images stay in public/.",
  "with migrated(route,payload) as (values",
];
const rows=[];
for (const route of routes) {
  const $ = load(await readFile(new URL(route+"index.html",root),"utf8"));
  const editions = {};
  let cover = "";
  let coverAlt = "";
  for (const lang of ["ar","en"]) {
    const page=$(`main [data-lang="${lang}"]`).first();
    const content=page.find("article.article-body").first();
    const artwork=content.children(".article-artwork").first();
    const src=artwork.attr("src")?.split("/").at(-1) ?? "";
    if (/^cover-\d+\.jpg$/.test(src)) {
      cover=src;
      coverAlt=artwork.attr("alt") ?? "";
      artwork.remove();
    }
    const title=page.find("h1").first().text().trim();
    if (!title || !content.length) throw new Error("Missing edition: "+route+lang);
    const seoTitle=$("body").attr("data-title-"+lang) || title;
    const description=page.find(".article-deck").first().text().trim();
    editions[lang]={title,description,seoTitle,seoDescription:lang==="ar"?($('meta[name=description]').attr("content")??description):description,body:content.html().trim(),format:"legacy_html"};
  }
  const category=$('main [data-lang="ar"] .eyebrow').first().text().trim();
  const payload={editions,cover,coverAlt,category,byline:"RAW by Vee",tags:[],featured:route.startsWith("articles/")};
  rows.push({route,visible:true,passthrough:true,payload,published_at:"2026-11-15T00:00:00Z"});
  sql.push("(" + quote(route) + "," + quote(JSON.stringify(payload)) + "::jsonb)" + (route===routes.at(-1) ? "" : ","));
}
sql.push(`
), inserted as (
  insert into public.wp_articles(route,payload,revision,state,legacy)
  select route,payload,1,'published',true from migrated on conflict(route) do nothing returning *
), history as (
  insert into public.wp_revisions(article_id,revision,payload)
  select id,1,payload from inserted
)
insert into public.wp_live(article_id,route,payload,passthrough,published_at)
select id,route,payload,true,'2026-11-15T00:00:00Z' from inserted
on conflict(article_id) do nothing;
`);
await writeFile(new URL("../supabase/migrations/202611160003_archive.sql",import.meta.url),sql.join("\n"));
await writeFile(new URL("../tools/legacy-fixture.json",import.meta.url),JSON.stringify({rows,assets:{}},null,2));
console.log(`Migrated ${routes.length} articles and ${2*routes.length} language editions.`);
