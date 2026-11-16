import { load } from "cheerio";
import MarkdownIt from "markdown-it";
import sanitize from "sanitize-html";

const md=new MarkdownIt({html:false, linkify:true});
const safeHtml={
  allowedTags:[...sanitize.defaults.allowedTags,"img","button","nav","figure","figcaption","details","summary","time","svg","path"],
  allowedAttributes:{
    "*":["class","id","dir","lang","aria-hidden","aria-label","role","title"],
    a:["href","rel","target"], img:["src","alt","width","height","loading","decoding","data-cover"],
    button:["type","hidden"], div:["data-embed","data-player","data-title"],
    svg:["width","height","viewBox","fill","stroke","stroke-width","aria-hidden"],path:["d","fill","stroke"],
  },
  allowedSchemes:["http","https","mailto"],
  allowProtocolRelative:false,
  parser:{lowerCaseTags:false},
  transformTags:{
    a:(tagName,attribs)=>({tagName,attribs:{...attribs,...(attribs.target==="_blank"?{rel:"noopener noreferrer"}:{})}}),
  },
  exclusiveFilter: (node) => node.tag==="img" && !/^(?:\.\.\/)*cover-\d+[.]jpg$/.test(node.attribs.src??""),
};
const escape=(value="")=>String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
export const articleRoute=/^(?:articles\/[a-z0-9]+(?:-[a-z0-9]+)*|archive\/\d{16,22})\/$/;
export const assetPath=/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:png|jpeg|jpg|webp|avif|gif)$/;
export const selected=(row,lang)=> {
  const e=row.payload.editions;
  return e[lang]?.title && e[lang]?.body ? e[lang] : e[lang==="ar"?"en":"ar"];
};
export const coverUrl=(row,prefix="")=>{
  const cover=row.payload?.cover??"";
  if (assetPath.test(cover)) return prefix+"editorial-media/"+cover;
  return /^cover-\d+\.jpg$/.test(cover)?prefix+cover:"";
};

export function renderArticle(row, shell, site, locale="ar") {
  const $=load(shell);
  const prefix=locale==="en"?"../../../":"../../";
  if (locale==="en") {
    for (const elem of $("[href], [src]").toArray()) {
      for (const attr of ["href","src"]) {
        const current=$(elem).attr(attr);
        if (current?.startsWith("../../")) $(elem).attr(attr,"../"+current);
      }
    }
  }
  const canonical=site+row.route+(locale==="en"?"en/":"");
  $("html").attr("lang",locale==="ar"?"ar-EG":"en").attr("dir",locale==="ar"?"rtl":"ltr");
  $("body").attr("data-default-lang",locale);
  $('link[rel="canonical"]').attr("href",canonical);
  $('meta[property="og:url"]').attr("content",canonical);
  $('meta[property="og:type"]').attr("content","article");
  $('link[rel="alternate"][hreflang]').remove();

  const heading=locale==="en"?"Article unavailable":"المقال مش متاح";
  if (!row.visible) {
    $("title").text(heading);
    $("body").attr("data-title-ar","المقال مش متاح").attr("data-title-en","Article unavailable");
    $('meta[property^="og:"],meta[name="description"]').remove();
    $("head").append('<meta name="robots" content="noindex">');
    $("main").html('<section class="shell section"><h1 data-lang="ar">المقال مش متاح</h1><h1 data-lang="en" hidden>Article unavailable</h1></section>');
    return $.html();
  }

  const display=selected(row,locale);
  $("title").text(display.seoTitle||display.title);
  $('meta[property="og:title"]').attr("content",display.seoTitle||display.title);
  $('meta[name="description"],meta[property="og:description"]').attr("content",display.seoDescription||display.description);
  $('meta[property="og:image"]').remove();
  const image=coverUrl(row);
  if (image) $("head").append(`<meta property="og:image" content="${escape(site+image)}">`);
  for (const lang of ["ar","en"]) {
    if (!row.payload.editions[lang]?.title || !row.payload.editions[lang]?.body) continue;
    $("head").append(`<link rel="alternate" hreflang="${lang}" href="${escape(site+row.route+(lang==="en"?"en/":""))}">`);
  }
  $("body").attr("data-title-ar",selected(row,"ar").seoTitle||selected(row,"ar").title)
    .attr("data-title-en",selected(row,"en").seoTitle||selected(row,"en").title);

  const back=row.route.startsWith("archive/")?"archive/":"stories/";
  const sections=["ar","en"].map((lang)=>{
    const edition=selected(row,lang);
    const isEnglish=lang==="en";
    const imageMarkup=image?`<img class="article-artwork" src="${escape(prefix+image)}" alt="${escape(row.payload.coverAlt||edition.title)}" decoding="async">`:"";
    const content=edition.format==="legacy_html"?edition.body:md.render(edition.body);
    let body=sanitize(content,safeHtml);
    if (locale==="en" && edition.format==="legacy_html") body=body.replace(/src="\.\.\/\.\.\/(cover-\d+\.jpg)"/g,'src="../../../$1"');
    return `<div data-lang="${lang}"${lang!==locale?" hidden":""}>
      <div class="article-head"><div class="reading">
        <a class="back-link" href="${prefix+back}">${isEnglish?"Back →":"→ رجوع"}</a>
        <p class="eyebrow" dir="auto">${escape(row.payload.category)}</p>
        <h1 dir="auto">${escape(edition.title)}</h1>
        <p class="article-deck" dir="auto">${escape(edition.description)}</p>
        <div class="meta"><span dir="auto">${escape(row.payload.byline)}</span></div>
      </div></div>
      <article class="reading article-body" dir="auto">${imageMarkup}${body}</article>
      <div class="read-footer reading"><a class="btn outline" href="${prefix+back}">${isEnglish?"Back to stories":"العودة"}</a>
        <button type="button" data-copy class="copy-link">${isEnglish?"Copy link":"نسخ رابط الصفحة"}</button></div>
    </div>`;
  });
  $("main").html(sections.join("\n"));
  return $.html();
}

export function updateListing(html, rows, type) {
  const $=load(html);
  const blog=rows.filter(row=>row.visible && row.route.startsWith("articles/") && !row.passthrough);
  const pins=blog.filter(row=>row.payload.featured);
  for (const row of rows.filter(row=>!row.visible)) {
    for (const link of $("main a[href]").toArray()) {
      if (!$(link).attr("href").replace(/^(?:\.\.\/|\.\/)+/,"").includes(row.route)) continue;
      const item=$(link).closest(".featured,.story,[data-card]");
      if (item.length) item.remove();
      else $(link).remove();
    }
  }
  if (type==="archive") {
    for (const row of rows.filter(row=>row.visible && !row.passthrough && row.route.startsWith("archive/"))) {
      const id=row.route.split("/")[1];
      for (const lang of ["ar","en"]) {
        const edition=selected(row,lang);
        const card=$(`main [data-lang="${lang}"] a[data-card]`).filter((_,a)=>$(a).attr("href")?.includes(id));
        card.find("h3").text(edition.title);
        card.find(".story-body p").text(edition.description);
        card.attr("data-search",[edition.title,edition.description,...row.payload.tags].join(" "));
      }
    }
  }
  const list=type==="home"?pins:type==="features"?blog:[];
  if (list.length) for (const lang of ["ar","en"]) {
    const prefix=type==="home"?"./":"../";
    const section=`<section class="section shell"><div class="section-head"><h2>${
      type==="home"?(lang==="ar"?"مختارات التحرير.":"Editor’s picks."):(lang==="ar"?"أحدث المقالات.":"Latest features.")}</h2></div><div class="grid">`;
    const cards=list.slice(0,type==="home"?3:30).map(row=>{
      const edition=selected(row,lang);
      const image=coverUrl(row,prefix);
      return `<a class="story" href="${escape(prefix+row.route)}">${image?`<img src="${escape(image)}" alt="${escape(row.payload.coverAlt||edition.title)}" loading="lazy">`:""}
        <div class="story-body"><h3 dir="auto">${escape(edition.title)}</h3><p dir="auto">${escape(edition.description)}</p></div></a>`;
    }).join("");
    const target=$(`main > [data-lang="${lang}"]`);
    const anchor=target.children(type==="home"?".hero":".page-head").first();
    anchor.after(section+cards+"</div></section>");
  }
  return $.html();
}
