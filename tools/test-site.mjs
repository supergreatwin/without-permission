import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { load } from "cheerio";
import { renderArticle, updateListing } from "./render.mjs";

const source=new URL("../public/",import.meta.url);
const fixture=JSON.parse(await readFile(new URL("./legacy-fixture.json",import.meta.url)));
const liveSite="https://supergreatwin.github.io/without-permission/";
const archive=fixture.rows.filter(row=>row.route.startsWith("archive/"));
assert.equal(archive.length,31);
assert.equal((await readdir(new URL("archive/",source),{withFileTypes:true})).filter(e=>e.isDirectory()).length,31);
for(const row of fixture.rows){
  const origin=load(await readFile(new URL(row.route+"index.html",source),"utf8"));
  assert.equal(origin("link[rel=canonical]").attr("href"),liveSite+row.route);
  for(const lang of ["ar","en"]){
    const edition=origin(`main [data-lang="${lang}"]`);
    assert.equal(row.payload.editions[lang].title,edition.find("h1").text().trim());
    assert.ok(row.payload.editions[lang].body.length>50);
    if(row.route.startsWith("archive/")){
      assert.match(row.payload.editions[lang].body,/tiktok\.com/);
      const refreshed=load(renderArticle({...row,passthrough:false},origin.html(),liveSite,lang));
      assert.ok(refreshed("article a[href*='tiktok.com']").length);
      assert.ok(refreshed("article button.embed-button").length);
    }
  }
  if(row.payload.cover)assert.ok((await readFile(new URL(row.payload.cover,source))).length>300);
}
const main=await readFile(new URL("index.html",source),"utf8");
assert.match(main,/احنا مش<br>هنتكلم بصوت واطي/);
assert.equal(load(main)("[data-beehiiv-embed]").length,2);
const social=load(main);
assert.equal(social('meta[property="og:image"]').attr("content"),"https://media.beehiiv.com/cdn-cgi/image/fit=scale-down,format=auto,onerror=redirect,quality=80/uploads/publication/thumbnail/7c5dd2ec-d1b7-4383-9692-6bc1c9a59b8a/without_permission_beehiiv_thumbnail_1200x630__4_.png");
assert.equal(social('meta[name="twitter:image"]').attr("content"),"https://media.beehiiv.com/cdn-cgi/image/fit=scale-down,format=auto,onerror=redirect,quality=80/uploads/publication/thumbnail/7c5dd2ec-d1b7-4383-9692-6bc1c9a59b8a/without_permission_beehiiv_thumbnail_1200x630__4_.png");
assert.equal(social('meta[property="og:image:width"]').attr("content"),"1200");
assert.equal(social('meta[property="og:image:height"]').attr("content"),"630");

const contribute=load(await readFile(new URL("contribute/index.html",source),"utf8"));
assert.match(contribute("iframe.pitch-frame").attr("src"),/tally\.so\/embed\/je61rx/);

const article=structuredClone(fixture.rows[0]);
article.route="articles/editorial-smoke/";
article.passthrough=false;
article.payload.byline="Pen <name>";
article.payload.editions.en.seoTitle="Search title";
article.payload.editions.en.body="# Feature\n\n## Heading\n\n<script>alert(1)</script> [unsafe](javascript:evil)\n\n[Link](https://example.com/)";
article.payload.editions.en.format="markdown";
article.payload.editions.ar.body='<p>Arabic original</p><script>alert(1)</script><img src="https://bad.example/track" onerror="x()">';
const template=await readFile(new URL("articles/lip-gloss/index.html",source),"utf8");
const rendered=load(renderArticle(article,template,liveSite,"en"));
assert.equal(rendered("html").attr("dir"),"ltr");
assert.equal(rendered("title").text(),"Search title");
assert.equal(rendered("link[rel=canonical]").attr("href"),liveSite+article.route+"en/");
assert.equal(rendered("link[hreflang=ar]").attr("href"),liveSite+article.route);
assert.equal(rendered("main script").length,0);
assert.equal(rendered("main img[src*=bad]").length,0);
assert.equal(rendered("main a[href^=javascript]").length,0);
assert.equal(rendered("article a[href='https://example.com/']").length,1);
assert.equal(rendered("main .meta span").first().text(),"Pen <name>");
assert.match(updateListing(main,[article],"home"),/articles\/editorial-smoke\//);
const tombstone=load(renderArticle({...article,visible:false},template,liveSite));
assert.equal(tombstone("meta[name=robots]").attr("content"),"noindex");
assert.equal(tombstone("main article").length,0);
console.log("Verified 31 preserved archive URLs, both language editions, in-site embeds, editor selections, generated SEO and unpublishing, and HTML sanitization.");
