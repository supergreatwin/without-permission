import { createClient } from "@supabase/supabase-js";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const root = document.querySelector("#app");
const status = document.querySelector("#desk-status");
const english = new URLSearchParams(location.search).get("lang") === "en";
const t = (ar, en) => english ? en : ar;
const conf = window.wpConfig;
const md = new MarkdownIt({html:false,linkify:true});
let client, session, profile, article, autosave, saving, needsSave, recovery = false;
let tab = "articles";
let inbox = [];
const staff = () => ["admin","chief","editor"].includes(profile?.role);
const publisher = () => ["admin","chief"].includes(profile?.role);
const deskUrl = () => location.origin + location.pathname + location.search;
const statusNames = {
  draft:t("مسودة","Draft"), submitted:t("اتبعثت","Submitted"), in_review:t("قيد المراجعة","In review"),
  changes_requested:t("تعديلات مطلوبة","Changes requested"), approved:t("اتوافقت","Approved"),
  scheduled:t("مجدولة","Scheduled"), published:t("منشورة","Published"), unpublished:t("اتسحب نشرها","Unpublished"),
  rejected:t("مرفوضة","Rejected"), pending:t("قيد المراجعة","Pending"), declined:t("مرفوض","Declined"),
  application_declined:t("طلب المساهمة اترفض","Application declined"), application:t("طلب مساهمة","Application"),
  edit:t("تعديل","Edit"), restored:t("استعادة نسخة","Revision restored"), role_changed:t("تغيير الصلاحية","Role changed"),
  ownership:t("تغيير مسؤولية المقال","Article ownership changed"),
  pitch_review:t("تحديث مراجعة فكرة","Pitch review updated"),
};
const pitchStates={
  received:t("وصلت","Received"), in_review:t("قيد المراجعة","Under review"),
  accepted:t("اتقبلت","Accepted"), editing:t("قيد التحرير","Editing"),
  published:t("اتنشرت","Published"), declined:t("اعتذرنا عنها","Declined"),
};
const pitchNext={
  received:["in_review","declined"], in_review:["accepted","declined"],
  accepted:["editing"], editing:["published"], published:[], declined:["in_review"],
};
const roleNames = {
  admin:t("مدير","Administrator"), chief:t("رئيس التحرير","Editor-in-Chief"),
  editor:t("محرر","Editor"), contributor:t("مساهم","Contributor"), reader:t("قارئ","Reader"),
};
const textOf = (name) => statusNames[name] ?? (name.startsWith("role:") ? roleNames[name.slice(5)] : name);
const fmt = (date) => date ? new Date(date).toLocaleString(t("ar-EG","en-GB")) : "";
const message = (value = "", error = false) => {
  status.textContent = value;
  status.toggleAttribute("data-error",error);
};

function element(tag, props={}, ...children) {
  const node=document.createElement(tag);
  for (const [key,value] of Object.entries(props)) {
    if (value===undefined || value===null) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2),value);
    else if (key in node && !key.startsWith("aria")) node[key]=value;
    else node.setAttribute(key,String(value));
  }
  for (const child of children.flat()) {
    if (child!==null && child!==undefined) node.append(child);
  }
  return node;
}
function button(label, callback, primary=false) {
  const control=element("button",{type:"button",className:"btn"+(primary?"":" outline")},label);
  control.addEventListener("click",async()=>{
    control.disabled=true;
    try { await callback(); }
    catch(error) { message(error.message,true); }
    finally { control.disabled=false; }
  });
  return control;
}
function field(title, input) {
  return element("label",{},title,input);
}
function select(options, value) {
  const node=element("select",{},options.map(([v,label])=>element("option",{value:v},label)));
  if(value)node.value=value;
  return node;
}
function panel(title,...children) {
  return element("section",{className:"panel"},title?element("h2",{},title):null,children);
}
async function result(promise) {
  const {data,error}=await promise;
  if(error)throw new Error(error.message);
  return data;
}
const rpc = (name, params) => result(client.rpc("wp_"+name,params));

function authView(mode = "login") {
  root.replaceChildren();
  if(recovery)mode="recover";
  if(mode==="signup" && !conf.publicRegistration)mode="login";
  const submitGuard=localStorage.getItem("wp-reset-pending");
  const email=element("input",{type:"email",required:true,autocomplete:"email",maxLength:254});
  const password=element("input",{type:"password",required:true,minLength:12,autocomplete:mode==="login"?"current-password":"new-password"});
  const authLabels={
    login:t("تسجيل الدخول","Sign in"), signup:t("إنشاء حساب","Create account"),
    reset:t("ابعتي رابط استعادة كلمة السر","Send reset link"), recover:t("احفظي كلمة السر الجديدة","Save new password"),
  };
  const submit=element("button",{type:"submit",className:"btn"},authLabels[mode]);
  const form=element("form",{},mode!=="recover"?field(t("البريد الإلكتروني","Email"),email):null,
    mode!=="reset"?field(t("كلمة السر","Password"),password):null,submit);
  if(conf.captchaSiteKey && !["recover"].includes(mode)){
    const challenge=element("div");
    form.prepend(challenge);
    waitForTurnstile(challenge);
    form.challenge=challenge;
  }
  form.addEventListener("submit",async(event)=>{
    event.preventDefault();
    submit.disabled=true;
    const captchaToken=form.challenge?.dataset.token;
    try {
      if(form.challenge && !captchaToken)throw new Error(t("كمّلي التحقق الأول.","Complete the verification first."));
      if(mode==="login") {
        await result(client.auth.signInWithPassword({email:email.value,password:password.value,options:{captchaToken}}));
        await enter();
      } else if(mode==="signup") {
        await result(client.auth.signUp({email:email.value,password:password.value,options:{emailRedirectTo:deskUrl(),captchaToken}}));
        message(t("افتحي بريدك لتأكيد الحساب.","Check your email to confirm your account."));
      } else if(mode==="reset") {
        await result(client.auth.resetPasswordForEmail(email.value,{redirectTo:deskUrl(),captchaToken}));
        message(t("لو الإيميل مسجّل، هيوصلك رابط الاستعادة.","A reset link will arrive if the address is registered."));
      } else {
        await result(client.auth.updateUser({password:password.value}));
        recovery=false;
        localStorage.removeItem("wp-reset-pending");
        await enter();
        message(t("تم حفظ كلمة السر الجديدة.","Password updated."));
      }
    } catch(error) { message(error.message,true); }
    finally { submit.disabled=false; if(form.challenge?.dataset.widget)window.turnstile?.reset(form.challenge.dataset.widget); }
  });
  const switcher=element("div",{className:"row"},
    mode!=="login" && mode!=="recover"?button(authLabels.login,()=>authView()):null,
    conf.publicRegistration && mode!=="signup" && mode!=="recover"?button(authLabels.signup,()=>authView("signup")):null,
    mode!=="reset" && mode!=="recover"?button(t("نسيت كلمة السر؟","Forgot password?"),()=>authView("reset")):null,
  );
  const pitch=mode==="login" && !conf.publicRegistration ? element("p",{},
    t("لو حابة تكتبي معانا، ","New contributors can "),
    element("a",{href:"../contribute/"+(english?"?lang=en":""),className:"text-link"},
      t("ابعتي فكرة عن طريق استمارة المساهمات","send a pitch through the contribution form")),".") : null;
  const main=panel(authLabels[mode],form,switcher,pitch);
  main.classList.add("auth");
  root.append(main);
  if(submitGuard==="true" && mode==="login")message(t("افتحي رابط الاستعادة من بريدك.","Open the recovery link from your inbox."));
}

function waitForTurnstile(slot) {
  function render(){
    if(slot.isConnected)slot.dataset.widget=window.turnstile.render(slot,{
      sitekey:conf.captchaSiteKey,callback:(token)=>{slot.dataset.token=token;},
      "expired-callback":()=>{delete slot.dataset.token;},
    });
  }
  if(window.turnstile){render();return;}
  let script=document.querySelector("script[data-captcha]");
  if(!script) {
    script=element("script",{src:"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",async:true,"data-captcha":""});
    document.head.append(script);
  }
  script.addEventListener("load",render,{once:true});
}

async function enter() {
  session=(await result(client.auth.getSession())).session;
  if(recovery || !session) { authView();return; }
  const role=await rpc("my_role");
  if(!role) { await client.auth.signOut(); authView();message(t("أكّدي بريدك الأول.","Confirm your email first."));return; }
  profile=await result(client.from("wp_profiles").select("*").eq("id",session.user.id).single());
  inbox=await result(client.from("wp_inbox").select("*").order("id",{ascending:false}).limit(50));
  await show();
}

async function show() {
  const menu=element("nav",{className:"row","aria-label":t("مكتب التحرير","Editorial desk")});
  const options=[
    ...(profile.role==="reader"?[["apply",t("طلب مساهمة","Contribute")]]:[["articles",t("المقالات","Articles")]]),
    ["inbox",t("الإشعارات","Notifications")+` (${inbox.filter(item=>!item.read_at).length})`],
    ["profile",t("الملف الشخصي","Profile")],
    ...(staff()?[["pitches",t("الأفكار الواردة","Pitches")],["analytics",t("الإحصائيات","Analytics")],["audit",t("سجل التحرير","Audit log")]]:[]),
    ...(profile.role==="admin"?[["accounts",t("الحسابات","Accounts")]]:[]),
  ];
  if(!options.some(([key])=>key===tab))tab=options[0][0];
  for(const [key,label] of options)menu.append(button(label,async()=>{
    await flush();
    article=null; tab=key;
    await show();
  },tab===key));
  menu.append(button(t("خروج","Sign out"),async()=>{
    await flush();
    await result(client.auth.signOut());
    profile=article=session=null;
    authView();
  }));
  const section=element("div",{id:"view"});
  root.replaceChildren(element("p",{className:"small"},[profile.pen_name||profile.display_name,roleNames[profile.role]].filter(Boolean).join(" · ")),menu,section);
  if(tab==="apply")await application(section);
  if(tab==="articles")await articleList(section);
  if(tab==="pitches")await pitches(section);
  if(tab==="profile")profileForm(section);
  if(tab==="inbox")await notifications(section);
  if(tab==="accounts")await accounts(section);
  if(tab==="audit")await audit(section);
  if(tab==="analytics")await analytics(section);
}

async function pitches(parent) {
  const owners=await rpc("pitch_owners");
  const list=element("div");
  const filter=select([["active",t("الأفكار المفتوحة","Open pitches")],...Object.entries(pitchStates)]);
  const editor=element("div");
  const formFor=(pitch)=>{
    const id=element("input",{required:true,readOnly:!!pitch,value:pitch?.tally_id||"",maxLength:100});
    const title=element("input",{required:true,maxLength:180,value:pitch?.title||"",dir:"auto"});
    const owner=select([["",t("اختاري محرر","Choose an editor")],...owners.map(item=>[item.id,item.label])],
      pitch?pitch.owner_id:profile.id);
    owner.required=true;
    const state=pitch?.state||"received";
    const phase=select([state,...(pitch?pitchNext[state]:[])].map(key=>[key,pitchStates[key]]),state);
    const deadline=element("input",{type:"date",value:pitch?.deadline||""});
    const note=element("textarea",{maxLength:1500,dir:"auto",value:pitch?.note||""});
    const route=element("input",{value:pitch?.article?.route||"",placeholder:"articles/story-slug/",dir:"ltr"});
    const routeField=field(t("مسار المقال المنشور","Published article path"),route);
    const updateRoute=()=>{
      routeField.hidden=phase.value!=="published";
      route.required=!routeField.hidden;
    };
    phase.addEventListener("change",updateRoute);
    updateRoute();
    const submit=element("button",{type:"submit",className:"btn"},t("حفظ الفكرة","Save pitch"));
    const form=element("form",{},field(t("معرّف الإرسال في Tally","Tally submission ID"),id),
      field(t("عنوان الفكرة","Working title"),title),
      element("div",{className:"columns"},field(t("المحرر المسؤول","Assigned editor"),owner),
        field(t("موعد المتابعة","Follow-up deadline"),deadline),field(t("الحالة","Status"),phase)),
      field(t("ملاحظات التحرير","Editorial notes"),note),routeField,submit);
    form.addEventListener("submit",async(event)=>{
      event.preventDefault();
      submit.disabled=true;
      try {
        await rpc("save_pitch",{_id:pitch?.id??null,_version:pitch?.version??null,_tally_id:id.value,
          _title:title.value,_state:phase.value,_owner:owner.value,_deadline:deadline.value||null,
          _note:note.value,_article_route:route.value});
        editor.replaceChildren(formFor(null));
        await refresh();
        message(t("تم حفظ الفكرة.","Pitch saved."));
      } catch(error) { message(error.message,true); }
      finally { submit.disabled=false; }
    });
    return panel(pitch?t("تعديل الفكرة","Edit pitch"):t("تسجيل فكرة من Tally","Log a Tally pitch"),form);
  };
  const refresh=async()=>{
    const query=client.from("wp_pitches").select("*,article:wp_articles(route)")
      .order("deadline",{nullsFirst:false}).order("updated_at",{ascending:false}).limit(100);
    const rows=await result(filter.value==="active"?query.in("state",["received","in_review","accepted","editing"]):query.eq("state",filter.value));
    list.replaceChildren(rows.length?element("ul",{className:"section-list"},rows.map(pitch=>element("li",{},
      element("strong",{dir:"auto"},pitch.title)," · ",pitchStates[pitch.state]," · ",
      owners.find(item=>item.id===pitch.owner_id)?.label||t("من غير مسؤول","Unassigned"),
      pitch.deadline?" · "+pitch.deadline:"",
      " ",button(t("فتح","Open"),()=>{editor.replaceChildren(formFor(pitch));editor.querySelector("input")?.focus();})
    ))):element("p",{},t("مفيش أفكار بالحالة دي.","No pitches in this view.")));
  };
  filter.addEventListener("change",()=>refresh().catch(error=>message(error.message,true)));
  parent.append(panel(t("مراجعة الأفكار","Pitch review"),
    element("p",{},element("a",{href:"https://tally.so/forms/je61rx/submissions",target:"_blank",rel:"noopener noreferrer",className:"text-link"},
      t("افتحي إرساليات Tally","Open Tally submissions"))),
    element("p",{},t("سجّلي معرّف الإرسال والعنوان. خَلّي الإيميل والمرفقات في Tally.","Log the submission ID and title here. Keep contact details and attachments in Tally.")),
    field(t("عرض حسب الحالة","Filter by status"),filter),list),editor);
  editor.replaceChildren(formFor(null));
  await refresh();
}

function profileForm(parent) {
  const name=element("input",{value:profile.display_name,maxLength:90});
  const pen=element("input",{value:profile.pen_name,maxLength:90});
  const bio=element("textarea",{value:profile.bio,maxLength:1200});
  const save=button(t("حفظ الملف","Save profile"),async()=>{
    await rpc("profile",{_display:name.value,_pen:pen.value,_bio:bio.value});
    await enter();
    message(t("تم الحفظ.","Saved."));
  },true);
  parent.append(panel(t("الملف الشخصي","Profile"),field(t("الاسم داخل المكتب","Name within the desk"),name),
    field(t("اسم مستعار للنشر","Public pen name"),pen),field(t("نبذة للفريق","Bio for the editors"),bio),save));
}

async function application(parent) {
  const data=await result(client.from("wp_applications").select("*").eq("user_id",profile.id).maybeSingle());
  const state=data ? textOf(data.state) : "";
  const statement=element("textarea",{maxLength:2000,placeholder:t("احكي لنا عن اهتماماتك وأفكارك.","Tell us what you want to write about.")});
  parent.append(panel(t("طلب المساهمة","Contributor application"),
    state?element("p",{},state):null,
    data?.state==="pending"?null:field(t("ليه حابة تكتبي معانا؟","Why would you like to contribute?"),statement),
    data?.state==="pending"?null:button(t("ابعتي الطلب","Submit application"),async()=>{
      await rpc("apply",{_statement:statement.value});
      await show();
    },true),
    element("p",{},element("a",{className:"text-link",href:"../contribute/"+(english?"?lang=en":"")},t("ابعتي فكرة من صفحة المساهمات","Send a pitch from the Contribute page")))));
}

async function notifications(parent) {
  inbox=await result(client.from("wp_inbox").select("*").order("id",{ascending:false}).limit(50));
  const list=element("ul",{className:"section-list"},inbox.map(item=>element("li",{},
    element("time",{},fmt(item.created_at))," · ",textOf(item.action)," ",
    item.article_id?button(t("افتحي المقال","Open article"),async()=>{tab="articles";await show();await openArticle(item.article_id);}):null)));
  parent.append(panel(t("الإشعارات","Notifications"),inbox.length?list:element("p",{},t("مفيش إشعارات لسه.","No notifications yet.")),
    button(t("علّمي الكل كمقروء","Mark all read"),async()=>{await rpc("read_notifications");await enter();})));
}

async function accounts(parent) {
  const [users, applications]=await Promise.all([
    result(client.from("wp_profiles").select("*").order("display_name").limit(200)),
    result(client.from("wp_applications").select("*").eq("state","pending").order("submitted_at")),
  ]);
  const names=new Map(users.map(user=>[user.id,user.pen_name||user.display_name||user.id.slice(0,8)]));
  parent.append(panel(t("طلبات المساهمة","Contributor applications"),applications.length?
    element("ul",{className:"section-list"},applications.map(item=>element("li",{},
      element("strong",{},names.get(item.user_id)||item.user_id),
      element("p",{dir:"auto"},item.statement),
      element("div",{className:"row"},
        button(t("اقبلي كمساهمة","Approve contributor"),async()=>{await rpc("assign_role",{_user:item.user_id,_role:"contributor"});await show();},true),
        button(t("ارفُضي","Decline"),async()=>{await rpc("decline",{_user:item.user_id});await show();}))
    ))):element("p",{},t("مفيش طلبات معلقة.","No pending applications."))));
  const list=element("ul",{className:"section-list"},users.map(user=>{
    const pick=select(Object.entries(roleNames),user.role);
    return element("li",{},element("div",{className:"row"},element("strong",{},names.get(user.id)),user.id===profile.id?
      roleNames[user.role]:[pick,button(t("حفظ الصلاحية","Save role"),async()=>{
        await rpc("assign_role",{_user:user.id,_role:pick.value});
        await show(); message(t("تم تحديث الصلاحية.","Role updated."));
      })]));
  }));
  parent.append(panel(t("صلاحيات الحسابات","Account roles"),list));
}

async function audit(parent) {
  const rows=await result(client.from("wp_audit").select("*").order("id",{ascending:false}).limit(100));
  parent.append(panel(t("سجل التحرير","Editorial audit"),element("ul",{className:"section-list"},rows.map(row=>element("li",{},
    element("time",{},fmt(row.created_at))," · ",textOf(row.action)," ",
    row.details?.revision?`#${row.details.revision}`:"",
    row.article_id?button(t("المقال","Article"),async()=>{tab="articles";await show();await openArticle(row.article_id);}):null
  )))));
}

async function articleList(parent) {
  const articles=await result(client.from("wp_articles").select("id,route,state,payload,updated_at")
    .order("updated_at",{ascending:false}).limit(200));
  const listTarget=element("div");
  const filter=element("input",{type:"search",placeholder:t("ابحثي عن عنوان أو رابط","Search title or URL"),"aria-label":t("بحث","Search")});
  function list() {
    const query=filter.value.trim().toLocaleLowerCase();
    const rows=articles.filter((a)=>[a.route,a.payload.editions?.ar?.title,a.payload.editions?.en?.title]
      .some(v=>v?.toLocaleLowerCase().includes(query)));
    listTarget.replaceChildren(element("ul",{className:"section-list"},rows.map(a=>{
      const title=a.payload.editions?.[english?"en":"ar"]?.title || a.payload.editions?.[english?"ar":"en"]?.title || a.route;
      return element("li",{},element("div",{className:"row"},button(title,()=>openArticle(a.id)),
        element("span",{className:"small"},`${textOf(a.state)} · ${fmt(a.updated_at)}`)));
    })));
  }
  filter.addEventListener("input",list);
  list();
  parent.replaceChildren(panel(t("المقالات","Articles"),element("div",{className:"row"},
    button(t("مسودة جديدة","New draft"),()=>openArticle(null),true),filter),listTarget));
}

async function openArticle(id) {
  await flush();
  const view=document.querySelector("#view");
  if(!view)return;
  article=id ? await result(client.from("wp_articles").select("*").eq("id",id).single()) : {
    id:null,state:"draft",revision:0,route:"",payload:{editions:{},tags:[],byline:profile.pen_name||""},
  };
  await articleEditor(view);
}

function safePreview(markup, legacy=false) {
  const safe=DOMPurify.sanitize(markup, {
    FORBID_TAGS:["iframe","style","form",...(legacy?[]:["img"])],
    FORBID_ATTR:["srcset","style"],
    ALLOW_DATA_ATTR:legacy,
    RETURN_DOM_FRAGMENT:true,
  });
  for(const image of safe.querySelectorAll("img")){
    if(!/^(?:\.\.\/)*cover-\d+[.]jpg$/.test(image.getAttribute("src")||""))image.remove();
  }
  for(const link of safe.querySelectorAll("a[target='_blank']"))link.rel="noopener noreferrer";
  const template=document.createElement("template");
  template.content.append(safe);
  return template.innerHTML;
}

function formatToolbar(area) {
  const add=(name,left,right="")=>button(name,()=>{
    const start=area.selectionStart, end=area.selectionEnd;
    area.setRangeText(left+area.value.slice(start,end)+right,start,end,"select");
    area.dispatchEvent(new Event("input",{bubbles:true}));
    area.focus();
  });
  return element("div",{className:"row"},add(t("عنوان فرعي","Heading"),"\n## ","\n"),
    add(t("خط عريض","Bold"),"**","**"),add(t("مائل","Italic"),"*","*"),
    add(t("اقتباس","Quote"),"\n> ","\n"),add(t("نقطة","List item"),"\n- ","\n"));
}

async function articleEditor(parent) {
  const draft=article;
  const current=draft.payload;
  const isLive=draft.id && await rpc("public_state",{_article:draft.id});
  const editable=!["scheduled","approved","rejected"].includes(draft.state)
    && (staff() || ["draft","changes_requested","unpublished"].includes(draft.state));
  const slug=element("input",{value:draft.route.split("/")[1]||"",dir:"ltr",maxLength:115,disabled:Boolean(draft.id)});
  const byline=element("input",{value:current.byline||"",maxLength:90,dir:"auto",disabled:!editable});
  const category=element("input",{value:current.category||"",maxLength:90,dir:"auto",disabled:!editable});
  const tags=element("input",{value:(current.tags||[]).join(", "),dir:"auto",disabled:!editable});
  const coverAlt=element("input",{value:current.coverAlt||"",maxLength:250,dir:"auto",disabled:!editable});
  const featured=element("input",{type:"checkbox",checked:current.featured||false,disabled:!editable});
  const cover=select([["",t("بدون غلاف","No cover")]],"");
  if(current.cover)cover.append(element("option",{value:current.cover},current.cover.startsWith("cover-")?
    t("الغلاف الحالي من الأرشيف","Current archive cover"):t("الغلاف الحالي","Current uploaded cover")));
  cover.value=current.cover||"";
  cover.disabled=!editable;
  const file=element("input",{type:"file",accept:"image/jpeg,image/png,image/webp,image/avif,image/gif",disabled:!editable});
  const notStored=element("span",{className:"small"});
  const mediaPanel=element("div",{},field(t("الغلاف","Cover"),cover),
    field(t("وصف الغلاف لقارئات الشاشة","Cover alt text"),coverAlt),
    editable?element("div",{className:"row"},file,button(t("ارفعي صورة","Upload image"),async()=>{
      const selected=file.files[0];
      if(!selected || selected.size>8*1024*1024)throw new Error(t("اختاري صورة أصغر من ٨ ميجابايت.","Choose an image up to 8 MB."));
      const extensions={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/avif":"avif","image/gif":"gif"};
      const extension=extensions[selected.type];
      if(!extension)throw new Error(t("صيغة الصورة غير مدعومة.","Unsupported image format."));
      const path=profile.id+"/"+crypto.randomUUID()+"."+extension;
      await result(client.storage.from("editorial-assets").upload(path,selected,{contentType:selected.type}));
      cover.append(element("option",{value:path},selected.name));
      cover.value=path;
      file.value="";
      formChanged();
    }),button(t("صوري السابقة","My uploaded images"),async()=>{
      const images=await result(client.storage.from("editorial-assets").list(profile.id,{limit:100,sortBy:{column:"created_at",order:"desc"}}));
      for(const image of images) {
        const path=profile.id+"/"+image.name;
        if(![...cover.options].some(option=>option.value===path)){
          cover.append(element("option",{value:path},(fmt(image.created_at)+" · "+image.name.slice(-13)).trim()));
        }
      }
      notStored.textContent=t("اختاري الصورة من حقل الغلاف.","Choose an uploaded image in the cover field.");
    })):null,notStored);
  const inputs={};
  const previews={};
  const editions=element("div",{className:"columns"});
  for(const [lang,label] of [["ar",t("النسخة العربية","Arabic edition")],["en",t("النسخة الإنجليزية","English edition")]]) {
    const existing=current.editions?.[lang]||{};
    const dir=lang==="ar"?"rtl":"ltr";
    const fields={};
    for(const [key,caption,length] of [
      ["title",t("العنوان","Title"),180],
      ["description",t("الوصف المختصر","Standfirst"),600],
      ["seoTitle",t("عنوان محركات البحث والمشاركة","Search and social title"),180],
      ["seoDescription",t("وصف محركات البحث والمشاركة","Search and social description"),600],
    ]) {
      fields[key]=element("input",{value:existing[key]||"",maxLength:length,dir,disabled:!editable});
      fields[key].setAttribute("aria-label",label+" · "+caption);
      fields[key].caption=caption;
    }
    const legacy=existing.format==="legacy_html";
    const body=legacy?element("div",{className:"editor",contentEditable:editable?"true":"false",dir,
      role:"textbox","aria-multiline":"true","aria-label":label+" · "+t("نص المقال","Article text")}):
      element("textarea",{className:"article-text",dir,value:existing.body||"",maxLength:200000,disabled:!editable});
    if(legacy){
      body.innerHTML=safePreview(existing.body,true).replaceAll('src="../../cover-','src="../cover-');
      body.addEventListener("paste",(event)=>{
        event.preventDefault();
        document.execCommand("insertText",false,event.clipboardData.getData("text/plain"));
      });
      body.addEventListener("drop",(event)=>event.preventDefault());
    }
    const preview=element("div",{className:"article-body preview",dir});
    previews[lang]=preview;
    const toolbar=!editable?null:legacy?element("div",{className:"row"},
      ...[[t("خط عريض","Bold"),"bold"],[t("مائل","Italic"),"italic"],[t("قائمة","List"),"insertUnorderedList"]].map(([name,command])=>{
        const control=button(name,()=>{document.execCommand(command,false);formChanged();});
        control.addEventListener("mousedown",(event)=>event.preventDefault());
        return control;
      })):formatToolbar(body);
    editions.append(panel(label,
      ...Object.values(fields).map(input=>field(input.caption,input)),
      element("p",{},t("نص المقال","Article text")),toolbar,
      legacy?body:field(t("اكتبي هنا","Write here"),body),
      element("details",{},element("summary",{},t("معاينة النسخة","Preview edition")),preview)));
    inputs[lang]={fields,body,legacy,original:existing.body||"",modified:false};
    body.addEventListener("input",()=>{inputs[lang].modified=true;});
    if(legacy)body.addEventListener("blur",()=>{
      if(body.innerHTML!==safePreview(existing.body,true).replaceAll('src="../../cover-','src="../cover-'))inputs[lang].modified=true;
    });
  }
  const form=element("form",{},field(t("رابط المقال","Article slug"),slug),
    !draft.id?element("p",{className:"small"},t("حروف إنجليزية صغيرة وأرقام وشرطات. الرابط بيفضل ثابت بعد أول حفظ.","Use lowercase English letters, numbers and hyphens. The URL stays fixed after the first save.")):null,
    field(t("الاسم اللي يظهر مع المقال","Public byline"),byline),field(t("القسم","Category"),category),
    field(t("وسوم مفصولة بفواصل","Tags, separated by commas"),tags),publisher()?field(t("اعرضي في مختارات التحرير","Feature in editor’s picks"),featured):null,
    mediaPanel,editions);
  const save=button(t("حفظ","Save"),async()=>{needsSave=true;await persist();},true);
  if(editable){
    form.append(save);
    slug.addEventListener("blur",()=>{
      if(!draft.id && slug.value && needsSave){
        clearTimeout(autosave);
        autosave=setTimeout(()=>persist().catch(error=>message(error.message,true)),1200);
      }
    });
  }
  form.addEventListener("submit",(event)=>event.preventDefault());

  function payload() {
    const editionData={};
    for(const [lang,{fields,body,legacy,original,modified}] of Object.entries(inputs)) {
      editionData[lang]=Object.fromEntries(Object.entries(fields).map(([name,input])=>[name,input.value]));
      editionData[lang].format=legacy?"legacy_html":"markdown";
      editionData[lang].body=legacy?
        (modified?safePreview(body.innerHTML,true).replaceAll('src="../cover-','src="../../cover-'):original):body.value;
    }
    return {editions:editionData,byline:byline.value,category:category.value,
      tags:tags.value.split(/[,،]/).map(tag=>tag.trim()).filter(Boolean),cover:cover.value,coverAlt:coverAlt.value,featured:featured.checked};
  }
  let previewSequence=0;
  const previewLinks=new Map();
  async function preview() {
    const token=++previewSequence;
    const data=payload();
    let previewCover="";
    if(data.cover.startsWith("cover-"))previewCover="../"+data.cover;
    if(data.cover.includes("/")){
      if(!previewLinks.has(data.cover)){
        previewLinks.set(data.cover,result(client.storage.from("editorial-assets").createSignedUrl(data.cover,300))
          .then(saved=>saved.signedUrl).catch(()=>""));
      }
      previewCover=await previewLinks.get(data.cover);
    }
    if(token!==previewSequence)return;
    for(const [lang,target] of Object.entries(previews)) {
      const e=data.editions[lang];
      target.innerHTML="";
      const heading=element("h2",{},e.title);
      const copy=element("div");
      copy.innerHTML=safePreview(e.format==="legacy_html"?e.body:md.render(e.body),e.format==="legacy_html")
        .replaceAll('src="../../cover-','src="../cover-');
      target.append(heading,element("p",{},e.description));
      if(previewCover)target.append(element("img",{src:previewCover,alt:data.coverAlt||e.title}));
      target.append(copy);
    }
  }
  async function persist() {
    if(saving)await saving;
    if(!needsSave || !editable)return;
    if(!draft.id && !slug.value.trim())throw new Error(t("اكتبي رابط المقال الأول.","Enter an article slug first."));
    needsSave=false;
    const data=payload();
    saving=(async()=>{
      try {
        const saved=await rpc("edit",{_article:draft.id,_slug:slug.value,_revision:draft.revision,_input:data});
        const stateChanged=saved.state!==draft.state;
        const wasNew=!draft.id;
        Object.assign(draft,saved);
        slug.disabled=true;
        if((wasNew || stateChanged) && !needsSave){
          await renderWorkflow();
        }
        message(t("المسودة محفوظة.","Draft saved."));
      } catch(error) {
        needsSave=true;
        throw error;
      } finally { saving=null; }
    })();
    await saving;
  }
  function formChanged() {
    if(!editable)return;
    needsSave=true;
    preview();
    clearTimeout(autosave);
    if(!draft.id)return;
    message(t("فيه تغييرات لسه ما اتحفظتش.","Unsaved changes"));
    if(draft.id || slug.value.trim())autosave=setTimeout(()=>persist().catch(error=>message(error.message,true)),1200);
  }
  form.addEventListener("input",formChanged);
  form.addEventListener("change",formChanged);
  const workflow=element("div");
  const title=element("p",{className:"small"},draft.route);
  const controls=element("div",{className:"row"},button(t("رجوع للمقالات","Back to articles"),async()=>{
    if(!draft.id && needsSave && !slug.value.trim()){
      if(!confirm(t("ترجعي من غير حفظ المسودة؟","Go back without saving this draft?")))return;
      needsSave=false;
    }
    await flush();
    article=null;
    await articleList(parent);
  }),isLive?element("a",{href:"../"+draft.route+(english?"?lang=en":""),className:"text-link",target:"_blank",rel:"noopener"},t("افتحي النسخة المنشورة","Open published version")):null);
  parent.replaceChildren(panel(t("تحرير المقال","Article editor"),controls,title,form),workflow);
  await preview();
  async function renderWorkflow() {
    title.textContent=draft.route;
    if(!draft.id){workflow.replaceChildren();return;}
    await editorialActions(workflow,draft,async()=>{
      await flush();
      await openArticle(draft.id);
    },persist);
  }
  await renderWorkflow();
  activeSave=persist;
}

let activeSave=async()=>{};
async function flush() {
  clearTimeout(autosave);
  while(needsSave || saving) await activeSave();
}
window.addEventListener("beforeunload",(event)=>{
  if(needsSave || saving){event.preventDefault();event.returnValue="";}
});

async function editorialActions(parent,a,reload,persist) {
  const isLive=await rpc("public_state",{_article:a.id});
  const actions=[];
  if(["draft","changes_requested","unpublished"].includes(a.state))actions.push("submitted");
  if(staff() && a.state==="submitted")actions.push("in_review");
  if(staff() && a.state==="in_review")actions.push("changes_requested");
  if(publisher() && a.state==="in_review")actions.push("approved");
  if(publisher() && ["submitted","in_review"].includes(a.state))actions.push("rejected");
  if(publisher() && ["approved","scheduled","rejected"].includes(a.state))actions.push("in_review");
  if(publisher() && ["approved","scheduled"].includes(a.state))actions.push("published");
  if(publisher() && a.state==="approved")actions.push("scheduled");
  if(publisher() && isLive)actions.push("unpublished");
  const actionNames={
    submitted:t("ابعتي للمراجعة","Submit for review"),in_review:t("افتحي المراجعة","Move into review"),
    changes_requested:t("اطلبي تعديلات","Request changes"),approved:t("وافقي","Approve"),
    rejected:t("ارفُضي المقال","Reject article"),published:t("انشري","Publish"),
    scheduled:t("جدولي النشر","Schedule"),unpublished:t("اسحبي النشر","Unpublish"),
  };
  const note=element("textarea",{maxLength:2500,dir:"auto"});
  const when=element("input",{type:"datetime-local"});
  const dateOptions=actions.includes("scheduled")?field(t("وقت النشر حسب منطقتك الزمنية","Publication time in your local timezone"),when):null;
  let ownerPanel;
  if(publisher()){
    const authors=await rpc("assignable_authors");
    const person=select([["",t("بدون حساب مرتبط","No linked account")],...authors.map(author=>[author.id,author.label])],a.owner_id||"");
    ownerPanel=element("div",{},field(t("الحساب المسؤول عن المقال","Account responsible for the article"),person),
      button(t("حفظ المسؤول","Save owner"),async()=>{
        await persist();
        await rpc("assign_owner",{_article:a.id,_owner:person.value||null});
        await reload();
        message(t("اتحدّثت مسؤولية المقال.","Article ownership updated."));
      }));
  }
  const buttons=actions.map(action=>button(actionNames[action],async()=>{
    await persist();
    const schedule=action==="scheduled" && when.value ? new Date(when.value).toISOString() : null;
    if(action==="scheduled" && !schedule)throw new Error(t("اختاري وقت النشر.","Choose a publication time."));
    if(action==="unpublished" && !confirm(t("تسحبي نشر المقال؟","Unpublish this article?")))return;
    await rpc("transition",{_article:a.id,_revision:a.revision,_from:a.state,_state:action,_note:note.value,_when:schedule});
    await reload();
    message(t("اتحدّثت حالة المقال.","Article status updated."));
  },action==="published"||action==="submitted"));
  const [reviews,revisions]=await Promise.all([
    result(client.from("wp_review").select("actor_label,message,created_at").eq("article_id",a.id).order("id")),
    result(client.from("wp_revisions").select("revision,created_at").eq("article_id",a.id).order("revision",{ascending:false}).limit(40)),
  ]);
  const comments=element("ul",{className:"section-list"},reviews.map(review=>element("li",{},
    element("strong",{},review.actor_label)," · ",fmt(review.created_at),element("p",{dir:"auto"},review.message))));
  const revisionPicker=select(revisions.map(r=>[String(r.revision),`#${r.revision} · ${fmt(r.created_at)}`]));
  const mayRestore=!["scheduled","approved","rejected"].includes(a.state)
    && (staff()||["draft","changes_requested","unpublished"].includes(a.state));
  parent.replaceChildren(panel(t("المراجعة والنشر","Review and publication"),
    element("p",{},`${textOf(a.state)}${a.scheduled_at?" · "+fmt(a.scheduled_at):""}`),ownerPanel,dateOptions,
    field(t("ملاحظة لفريق التحرير والكاتب","Note for the editors and writer"),note),element("div",{className:"row"},
      button(t("أضيفي تعليق","Add comment"),async()=>{await rpc("comment",{_article:a.id,_message:note.value});await reload();}),buttons),comments),
    panel(t("النسخ السابقة","Revision history"),revisionPicker,mayRestore?button(t("استرجعي النسخة","Restore selected revision"),async()=>{
      await persist();
      await rpc("restore",{_article:a.id,_current:a.revision,_old:Number(revisionPicker.value)});
      await reload();
      message(t("اتحفظت النسخة المسترجعة كنسخة جديدة.","Restored as a new revision."));
    }):null));
}

function table(headers,rows) {
  return element("div",{className:"table-scroll"},element("table",{},
    element("thead",{},element("tr",{},headers.map(header=>element("th",{scope:"col"},header)))),
    element("tbody",{},rows.map(values=>element("tr",{},values.map(value=>element("td",{},String(value??"—"))))))));
}

async function analytics(parent) {
  const range=select([7,30,90].map(days=>[String(days),t(`آخر ${days} يوم`,`Last ${days} days`)]),"30");
  range.setAttribute("aria-label",t("الفترة الزمنية","Reporting period"));
  const charts=element("div");
  const output=element("div");
  let request=0;
  async function loadMetrics() {
    const token=++request;
    const days=Number(range.value);
    charts.replaceChildren(element("p",{},t("جاري تحميل الإحصائيات…","Loading analytics…")));
    output.replaceChildren();
    const data=await rpc("dashboard",{_days:days});
    if(token!==request)return;
    const views=t("المشاهدات","Views");
    const totals=t("العدد","Total");
    charts.replaceChildren(panel(t("القراء","Readership"),
      table([t("المقياس","Metric"),totals],[
        [views,data.pageViews],[t("زيارات يومية تقديرية","Estimated daily visitors"),data.dailyVisitors],
        [t("قراءات تفاعلية","Engaged views"),data.engagedViews],
      ]),
      element("details",{},element("summary",{},t("الاتجاه يوم بيوم","Daily trends")),
        table([t("اليوم","Date"),views,t("الزيارات","Visitors")],data.trend.map(row=>[row.day,row.views,row.visitors])))),
      element("div",{className:"columns"},
        panel(t("الأكثر قراءة","Most read"),table([t("المقال","Article"),views],data.popular.map(row=>[row.route,row.views]))),
        panel(t("اللغة ومصدر الزيارة","Language and traffic source"),
          table([t("اللغة","Language"),views],data.languages.map(row=>[row.language,row.views])),
          table([t("المصدر","Source"),views],data.sources.map(row=>[row.source,row.views])))),
      panel(t("نشاط التحرير","Editorial activity"),
        table([t("الإجراء","Action"),totals],data.desk.map(row=>[textOf(row.action),row.total])),
        table([t("الحالة الحالية","Current status"),totals],data.status.map(row=>[textOf(row.state),row.total]))));
    try {
      const dataSession=await result(client.auth.getSession());
      const reply=await fetch(conf.platformUrl+"/newsletter?days="+days,{headers:{Authorization:"Bearer "+dataSession.session.access_token}});
      const bee=await reply.json();
      if(token!==request)return;
      if(!reply.ok)throw new Error(bee.error || t("الإحصائيات غير متاحة.","Newsletter metrics unavailable."));
      const conversion=bee.complete && bee.websiteSignups!==null && data.dailyVisitors>0
        ?(100*bee.websiteSignups/data.dailyVisitors).toFixed(1)+"%":"—";
      output.replaceChildren(panel(t("النشرة البريدية","Newsletter"),
        table([t("المقياس","Metric"),totals],[
          [t("اشتراكات جديدة","New signups"),bee.signups],
          [t("اشتراكات منسوبة للموقع","Signups attributed to the website"),bee.websiteSignups],
          [t("معدل الاشتراك التقديري","Estimated signup conversion"),conversion],
        ]),
        table([t("حالة المشترك","Subscription status"),totals],Object.entries(bee.groups)),
        bee.complete?null:element("p",{className:"small"},t("نتائج جزئية بسبب حد التقرير.","Partial results due to the report limit."))));
    } catch(error) {
      if(token===request)output.replaceChildren(panel(t("النشرة البريدية","Newsletter"),element("p",{},error.message)));
    }
  }
  parent.append(panel(t("لوحة الإحصائيات","Analytics dashboard"),range),charts,output);
  range.addEventListener("change",()=>loadMetrics().catch(error=>message(error.message,true)));
  await loadMetrics();
}

document.documentElement.lang=english?"en":"ar-EG";
document.documentElement.dir=english?"ltr":"rtl";
document.title=t("مكتب التحرير | من غير إذن","Editorial desk | Without Permission");
document.querySelector("#desk-title").textContent=t("مكتب التحرير.","Editorial desk.");
const language=document.querySelector("#language");
language.href=english?"./":"?lang=en";
language.hreflang=t("en","ar");
language.textContent=t("English","العربية");
try {
  document.documentElement.dataset.theme=localStorage.getItem("without-permission-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
} catch {
  document.documentElement.dataset.theme="light";
}
if(!conf?.supabaseUrl || !conf?.supabaseKey || !conf?.platformUrl) {
  message(t("مكتب التحرير محتاج إعداد خدمة تسجيل الدخول وقاعدة البيانات.","The desk requires its authentication and database configuration."),true);
} else {
  client=createClient(conf.supabaseUrl,conf.supabaseKey);
  client.auth.onAuthStateChange((event)=>{
    if(event==="PASSWORD_RECOVERY"){
      recovery=true;
      localStorage.setItem("wp-reset-pending","true");
      setTimeout(()=>authView("recover"),0);
    }
  });
  if(new URLSearchParams(location.hash.slice(1)).get("type")==="recovery")recovery=true;
  if(localStorage.getItem("wp-reset-pending")==="true"){
    client.auth.getSession().then(({data})=>{if(data.session){recovery=true;authView("recover");}});
  }
  enter().catch(error=>message(error.message,true));
}
