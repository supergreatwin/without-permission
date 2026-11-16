import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    'select nullif(current_setting(''wp.test_user'',true),'''')::uuid';
  grant usage on schema auth to public;
  create schema storage;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated;
  grant select,insert on storage.objects to authenticated;
`);
for (const file of ["202611160001_editorial.sql","202611160002_analytics.sql"])
  await db.exec(await readFile(new URL("../supabase/migrations/" + file, import.meta.url),"utf8"));

const identity = (n) => `00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
const role = async (n, dbRole = "authenticated") => {
  await db.exec("reset role");
  await db.query("select set_config('wp.test_user',$1,false)",[n ? identity(n) : ""]);
  await db.exec("set role " + dbRole);
};
const value = async (query, args = []) => (await db.query(query, args)).rows[0]?.value;
for (let n=1;n<=6;n++) {
  await db.query("insert into auth.users values($1,$2)", [identity(n), n===6 ? null : new Date()]);
}
await db.query("update wp_profiles set role='admin' where id=$1",[identity(4)]);
await role(1);
await db.query("select wp_apply('An article on media and public space in Cairo')");
await assert.rejects(db.query("update wp_profiles set role='admin'"),/permission denied/);
await role(4);
for (const [n, name] of [[1,"contributor"],[2,"editor"],[3,"chief"],[5,"contributor"],[6,"contributor"]]) {
  await db.query("select wp_assign_role($1,$2)",[identity(n),name]);
}
assert.equal(await value("select state as value from wp_applications where user_id=$1",[identity(1)]),"approved");

const input = {editions:{ar:{title:"عنوان",body:"النص"},en:{title:"Title",body:"Article body"}},byline:"Pen name"};
await role(6);
await assert.rejects(db.query("select wp_edit(null,0,'test-unverified',$1)",[input]),/Contributor access required/);
await role(1);
const created = await value("select to_jsonb(wp_edit(null,0,'test-story',$1)) as value",[input]);
const id=created.id;
const transition = async (from,to,note="",when=null) => value(
  "select to_jsonb(wp_transition($1,1,$2,$3,$4,$5)) as value",[id,from,to,note,when],
);
await assert.rejects(transition("draft","published"),/cannot perform/);
await assert.rejects(db.query("select wp_assign_owner($1,$2)",[id,identity(5)]),/Publisher access required/);
await role(5);
assert.equal(await value("select count(*)::int as value from wp_articles"),0);
await assert.rejects(db.query("select wp_comment($1,'private article')",[id]),/unavailable/);
await role(1);
assert.equal((await transition("draft","submitted")).state,"submitted");
await assert.rejects(transition("submitted","in_review"),/cannot perform/);
await role(2);
await transition("submitted","in_review");
await assert.rejects(transition("in_review","approved"),/cannot perform/);
await assert.rejects(transition("in_review","changes_requested"),/Add an editorial note/);
await transition("in_review","changes_requested","Please add a source.");
await role(1);
assert.equal(await value("select message as value from wp_review"),"Please add a source.");
assert.equal(await value("select count(*)::int as value from wp_inbox where action='changes_requested'"),1);
await transition("changes_requested","submitted");
await role(3);
await transition("submitted","in_review");
await transition("in_review","approved");
await transition("approved","scheduled","",new Date(Date.now()+86_400_000).toISOString());
await role(1);
await assert.rejects(db.query("select wp_due()"),/permission denied/);
await role(0,"service_role");
assert.equal(await value("select wp_due() as value"),0);
await db.query("update wp_articles set scheduled_at=now()-interval '1 minute' where id=$1",[id]);
assert.equal(await value("select wp_due() as value"),1);
assert.equal(await value("select wp_due() as value"),0);
assert.equal(await value("select payload->>'byline' as value from wp_live"),"Pen name");
await role(3);
const edited = await value("select to_jsonb(wp_edit($1,1,null,$2)) as value",[id,{...input,byline:"New pen name"}]);
assert.equal(edited.state,"draft");
assert.equal(edited.revision,2);
await assert.rejects(db.query("select wp_edit($1,1,null,$2)",[id,input]),/newer revision/);
const restored = await value("select to_jsonb(wp_restore($1,2,1)) as value",[id]);
assert.equal(restored.revision,3);
assert.equal(restored.payload.byline,"Pen name");
assert.ok((await db.query("select * from wp_assignable_authors()")).rows.some(a=>a.id===identity(5)));
await assert.rejects(db.query("select wp_assign_owner($1,$2)",[id,identity(6)]),/verified contributor/);
await db.query("select wp_assign_owner($1,$2)",[id,identity(5)]);
await role(1);
assert.equal(await value("select count(*)::int as value from wp_articles"),0);
await role(5);
assert.equal(await value("select count(*)::int as value from wp_articles"),1);
await role(3);
await db.query("select wp_transition($1,3,'draft','unpublished')",[id]);
await role(0,"service_role");
assert.equal(await value("select visible as value from wp_live"),false);
assert.equal(await value("select wp_limit('id',1) as value"),true);
assert.equal(await value("select wp_limit('id',1) as value"),false);
for (const event of ["view","view","engaged"])
  await db.query("select wp_record($1,'articles/test-story/','ar','direct',$2)",["a".repeat(64),event]);
await role(2);
const report=await value("select wp_dashboard(7) as value");
assert.equal(report.pageViews,1);
assert.equal(report.engagedViews,1);
assert.equal(report.trend.length,7);
await role(1);
await assert.rejects(db.query("select wp_dashboard(7)"),/Staff access required/);
await role(0,"anon");
await assert.rejects(db.query("select * from wp_articles"),/permission denied/);
await assert.rejects(db.query("select * from wp_live"),/permission denied/);
console.log("Verified role boundaries, privacy, editorial transitions, review feedback, revision conflicts and restoration, scheduling and unpublishing, and analytics deduplication.");
await db.exec("reset role");
await db.exec(await readFile(new URL("../supabase/migrations/202611160003_archive.sql",import.meta.url),"utf8"));
assert.equal(await value("select count(*)::int as value from wp_live where passthrough"),32);
await db.exec(await readFile(new URL("../supabase/migrations/202611160003_archive.sql",import.meta.url),"utf8"));
assert.equal(await value("select count(*)::int as value from wp_live where passthrough"),32);
await db.exec(await readFile(new URL("../supabase/migrations/202611160004_pitch_review.sql",import.meta.url),"utf8"));
const savePitch=(pitch,state,route="",owner=identity(2))=>value(
  "select to_jsonb(wp_save_pitch($1,$2,'sample-tally-id','Test pitch',$3,$4,'2026-12-01','Internal note',$5)) as value",
  [pitch?.id??null,pitch?.version??null,state,owner,route],
);
await role(2);
await assert.rejects(savePitch(null,"published","articles/lip-gloss/"),/start in Received/);
await assert.rejects(savePitch(null,"received","",identity(1)),/verified editorial owner/);
const received=await savePitch(null,"received");
assert.equal(received.state,"received");
await assert.rejects(savePitch(null,"received"),/duplicate key/);
await assert.rejects(savePitch(received,"accepted"),/transition is unavailable/);
await role(1);
assert.equal(await value("select count(*)::int as value from wp_pitches"),0);
await assert.rejects(savePitch(received,"in_review"),/Staff access required/);
await role(0,"anon");
await assert.rejects(db.query("select * from wp_pitches"),/permission denied/);
await role(3);
const review=await savePitch(received,"in_review");
await assert.rejects(savePitch(received,"in_review"),/pitch changed/);
const accepted=await savePitch(review,"accepted");
const editing=await savePitch(accepted,"editing");
await assert.rejects(savePitch(editing,"published","articles/test-story/"),/Enter a published article/);
const published=await savePitch(editing,"published","articles/lip-gloss/");
assert.equal(published.state,"published");
assert.ok(published.article_id);
assert.equal(await value("select count(*)::int as value from wp_audit where action='pitch_review'"),5);
console.log("Verified private Tally pitch intake, assignment, concurrent edits, and publishing transitions.");
await db.close();
