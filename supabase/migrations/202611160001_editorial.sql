create type public.wp_role as enum ('reader','contributor','editor','chief','admin');
create type public.wp_status as enum (
  'draft','submitted','in_review','changes_requested','approved','scheduled','published','unpublished','rejected'
);

create table public.wp_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 90),
  pen_name text not null default '' check (char_length(pen_name) <= 90),
  bio text not null default '' check (char_length(bio) <= 1200),
  role public.wp_role not null default 'reader'
);

create table public.wp_applications (
  user_id uuid primary key references public.wp_profiles(id) on delete cascade,
  statement text not null check (char_length(statement) between 20 and 2000),
  state text not null default 'pending' check (state in ('pending','approved','declined')),
  submitted_at timestamptz not null default now()
);

create table public.wp_articles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.wp_profiles(id) on delete set null,
  route text unique not null check (route ~ '^(articles/[a-z0-9]+(-[a-z0-9]+)*|archive/[0-9]{16,22})/$' and char_length(route) <= 130),
  state public.wp_status not null default 'draft',
  revision integer not null default 0,
  payload jsonb not null default '{}',
  legacy boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  scheduled_at timestamptz
);

create table public.wp_revisions (
  article_id uuid references public.wp_articles(id) on delete cascade,
  revision integer not null,
  payload jsonb not null,
  actor uuid references public.wp_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (article_id, revision)
);

create table public.wp_live (
  article_id uuid primary key references public.wp_articles(id),
  route text not null unique,
  visible boolean not null default true,
  passthrough boolean not null default false,
  payload jsonb not null,
  published_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table public.wp_review (
  id bigint generated always as identity primary key,
  article_id uuid not null references public.wp_articles(id),
  actor uuid references public.wp_profiles(id) on delete set null,
  actor_label text not null default 'Editorial desk',
  message text not null check (char_length(message) between 1 and 2500),
  created_at timestamptz not null default now()
);

create table public.wp_audit (
  id bigint generated always as identity primary key,
  article_id uuid references public.wp_articles(id),
  actor uuid references public.wp_profiles(id) on delete set null,
  action text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.wp_inbox (
  id bigint generated always as identity primary key,
  recipient uuid not null references public.wp_profiles(id) on delete cascade,
  article_id uuid references public.wp_articles(id),
  action text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index wp_articles_owner on public.wp_articles(owner_id);
create index wp_articles_scheduled on public.wp_articles(scheduled_at) where state='scheduled';
create index wp_review_article on public.wp_review(article_id,id);
create index wp_audit_article on public.wp_audit(article_id,id);
create index wp_inbox_recipient on public.wp_inbox(recipient,id desc);

create function public.wp_register_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.wp_profiles(id) values(new.id) on conflict do nothing;
  return new;
end $$;

create trigger wp_register_profile after insert on auth.users
for each row execute function public.wp_register_profile();
insert into public.wp_profiles(id) select id from auth.users on conflict do nothing;

create function public.wp_my_role() returns public.wp_role language sql stable security definer set search_path='' as $$
  select p.role from public.wp_profiles p join auth.users u using (id)
  where p.id=auth.uid() and u.email_confirmed_at is not null
$$;

create function public.wp_is_staff() returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(public.wp_my_role() in ('editor','chief','admin'), false)
$$;

create function public.wp_can_read(_article uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists (select 1 from public.wp_articles a where a.id=_article and
    (public.wp_is_staff() or (a.owner_id=auth.uid() and public.wp_my_role()='contributor')))
$$;

alter table public.wp_profiles enable row level security;
alter table public.wp_applications enable row level security;
alter table public.wp_articles enable row level security;
alter table public.wp_revisions enable row level security;
alter table public.wp_review enable row level security;
alter table public.wp_audit enable row level security;
alter table public.wp_inbox enable row level security;
alter table public.wp_live enable row level security;

revoke all on public.wp_profiles, public.wp_applications, public.wp_articles, public.wp_revisions,
  public.wp_review, public.wp_audit, public.wp_inbox, public.wp_live from anon, authenticated, public;
grant select on public.wp_profiles, public.wp_applications, public.wp_articles, public.wp_revisions,
  public.wp_review, public.wp_audit, public.wp_inbox to authenticated;
grant select, insert, update on public.wp_articles, public.wp_revisions, public.wp_live to service_role;
grant select on public.wp_profiles to service_role;

create policy wp_read_profile on public.wp_profiles for select to authenticated using
  (id=auth.uid() or public.wp_my_role()='admin');
create policy wp_read_application on public.wp_applications for select to authenticated using
  (user_id=auth.uid() or public.wp_my_role()='admin');
create policy wp_read_article on public.wp_articles for select to authenticated using
  (public.wp_is_staff() or (owner_id=auth.uid() and public.wp_my_role()='contributor'));
create policy wp_read_revision on public.wp_revisions for select to authenticated using (public.wp_can_read(article_id));
create policy wp_read_review on public.wp_review for select to authenticated using (public.wp_can_read(article_id));
create policy wp_read_audit on public.wp_audit for select to authenticated using (public.wp_is_staff());
create policy wp_read_inbox on public.wp_inbox for select to authenticated using (recipient=auth.uid());

create function public.wp_profile(_display text,_pen text,_bio text) returns void language plpgsql security definer set search_path='' as $$
begin
  if public.wp_my_role() is null then raise exception 'Verify your account first.'; end if;
  update public.wp_profiles set display_name=trim(_display), pen_name=trim(_pen), bio=trim(_bio) where id=auth.uid();
end $$;

create function public.wp_apply(_statement text) returns void language plpgsql security definer set search_path='' as $$
begin
  if public.wp_my_role() is distinct from 'reader' then raise exception 'A verified reader account is required.'; end if;
  insert into public.wp_applications(user_id,statement) values(auth.uid(),trim(_statement))
  on conflict(user_id) do update set statement=excluded.statement,state='pending',submitted_at=now()
    where public.wp_applications.state='declined' and public.wp_applications.submitted_at < now()-interval '1 day';
  if not found then raise exception 'Your application is already with the editorial team.'; end if;
  insert into public.wp_audit(actor,action) values(auth.uid(),'application');
end $$;

create function public.wp_assign_role(_user uuid,_role public.wp_role) returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(56789011);
  if public.wp_my_role() is distinct from 'admin' or _user=auth.uid() then
    raise exception 'Only another administrator can change this role.';
  end if;
  update public.wp_profiles set role=_role where id=_user;
  if not found then raise exception 'Account not found.'; end if;
  if _role='contributor' then update public.wp_applications set state='approved' where user_id=_user and state='pending'; end if;
  insert into public.wp_inbox(recipient,action) values(_user,'role:'||_role);
  insert into public.wp_audit(actor,action,details) values(auth.uid(),'role_changed',jsonb_build_object('user',_user,'role',_role));
end $$;

create function public.wp_decline(_user uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  if public.wp_my_role() is distinct from 'admin' then raise exception 'Administrator access required.'; end if;
  update public.wp_applications set state='declined' where user_id=_user and state='pending';
  if not found then raise exception 'Application is no longer pending.'; end if;
  insert into public.wp_inbox(recipient,action) values(_user,'application_declined');
  insert into public.wp_audit(actor,action,details) values(auth.uid(),'application_declined',jsonb_build_object('user',_user));
end $$;

create function public.wp_clean_payload(_input jsonb,_old jsonb,_can_feature boolean) returns jsonb
language plpgsql set search_path='' as $$
declare
  _language text;
  _edition jsonb;
  _key text;
  _value text;
  _editions jsonb := '{}';
  _path text := coalesce(_input->>'cover','');
  _featured boolean := coalesce((_old->>'featured')::boolean,false);
  _tags jsonb := coalesce(_input->'tags','[]');
begin
  if jsonb_typeof(_input) is distinct from 'object' or pg_column_size(_input)>750000 then raise exception 'Invalid article content.'; end if;
  if jsonb_typeof(_tags) is distinct from 'array' then raise exception 'Invalid tags.'; end if;
  if jsonb_array_length(_tags)>20 or exists(select 1 from jsonb_array_elements(_tags) t where jsonb_typeof(t)<>'string' or char_length(t #>> '{}')>60) then
    raise exception 'Use up to 20 tags, each up to 60 characters.';
  end if;
  if _path<>'' and (_path !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}[.](png|jpeg|jpg|webp|avif|gif)$' and _path !~ '^cover-[0-9]+[.]jpg$') then
    raise exception 'Select a supported cover image.';
  end if;
  if _path<>'' and _path not like 'cover-%' and _path is distinct from (_old->>'cover')
     and not exists(select 1 from storage.objects where bucket_id='editorial-assets' and name=_path
       and (split_part(name,'/',1)=auth.uid()::text or public.wp_is_staff())) then
    raise exception 'The selected cover is unavailable.';
  end if;
  if char_length(coalesce(_input->>'byline',''))>90 or char_length(coalesce(_input->>'category',''))>90
     or char_length(coalesce(_input->>'coverAlt',''))>250 then raise exception 'Attribution or metadata is too long.'; end if;
  if _can_feature then _featured:=coalesce((_input->>'featured')::boolean,false); end if;

  foreach _language in array array['ar','en'] loop
    _edition:=coalesce(_input->'editions'->_language,'{}');
    if jsonb_typeof(_edition) is distinct from 'object' then raise exception 'Invalid language edition.'; end if;
    foreach _key in array array['title','description','seoTitle','seoDescription','body','format'] loop
      _value:=coalesce(_edition->>_key,'');
      if char_length(_value)> (case when _key='body' then 200000 when _key in ('title','seoTitle') then 180 else 600 end) then
        raise exception 'Article field is too long (%).',_key;
      end if;
    end loop;
    if _edition->>'format'='legacy_html' and _old->'editions'->_language->>'format' is distinct from 'legacy_html' then
      raise exception 'New content uses Markdown.';
    end if;
    _editions:=_editions || jsonb_build_object(_language, jsonb_build_object(
      'title',trim(coalesce(_edition->>'title','')), 'description',trim(coalesce(_edition->>'description','')),
      'seoTitle',trim(coalesce(_edition->>'seoTitle','')), 'seoDescription',trim(coalesce(_edition->>'seoDescription','')),
      'body',coalesce(_edition->>'body',''), 'format',case when _edition->>'format'='legacy_html' then 'legacy_html' else 'markdown' end));
  end loop;
  return jsonb_build_object('editions',_editions,'byline',trim(coalesce(_input->>'byline','')),
    'category',trim(coalesce(_input->>'category','')),'tags',_tags,'cover',_path,
    'coverAlt',trim(coalesce(_input->>'coverAlt','')),'featured',_featured);
end $$;

create function public.wp_notify(_a public.wp_articles,_action text) returns void
language plpgsql set search_path='' as $$
begin
  insert into public.wp_inbox(recipient,article_id,action)
    select p.id,_a.id,_action from public.wp_profiles p
    where p.id is distinct from auth.uid() and
      (p.id=_a.owner_id or (_action in ('submitted','scheduled','published') and p.role in ('editor','chief','admin')));
end $$;

create function public.wp_edit(
  _article uuid, _revision integer, _slug text, _input jsonb
) returns public.wp_articles language plpgsql security definer set search_path='' as $$
declare
  _role public.wp_role:=public.wp_my_role();
  _a public.wp_articles;
  _clean jsonb;
begin
  if _role is null or _role='reader' then raise exception 'Contributor access required.'; end if;
  if _article is null then
    if _slug is null or _slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'Use a URL slug with lowercase letters, numbers, and hyphens.'; end if;
    insert into public.wp_articles(owner_id,route) values(auth.uid(),'articles/'||_slug||'/') returning * into _a;
  else
    select * into _a from public.wp_articles where id=_article for update;
    if not found or not public.wp_can_read(_article) then raise exception 'Article unavailable.'; end if;
    if _a.revision is distinct from _revision then raise exception 'A newer revision exists. Reload before saving.'; end if;
    if _role='contributor' and _a.state not in ('draft','changes_requested','unpublished') then raise exception 'This article is with the editors.'; end if;
    if _a.state in ('scheduled','approved','rejected') then raise exception 'Return the article to editing before changing approved or closed content.'; end if;
  end if;
  _clean:=public.wp_clean_payload(_input,_a.payload,_role in ('chief','admin'));
  if _a.revision>0 and _clean=_a.payload then return _a; end if;
  update public.wp_articles set payload=_clean,revision=revision+1,updated_at=now(),
    state=case when state='published' then 'draft'::public.wp_status else state end
    where id=_a.id returning * into _a;
  insert into public.wp_revisions(article_id,revision,payload,actor) values(_a.id,_a.revision,_a.payload,auth.uid());
  insert into public.wp_audit(article_id,actor,action,details) values(_a.id,auth.uid(),'edit',jsonb_build_object('revision',_a.revision));
  return _a;
end $$;

create function public.wp_restore(_article uuid,_current integer,_old integer) returns public.wp_articles
language plpgsql security definer set search_path='' as $$
declare
  _a public.wp_articles;
  _old_payload jsonb;
begin
  if not public.wp_can_read(_article) then raise exception 'Article unavailable.'; end if;
  select payload into _old_payload from public.wp_revisions where article_id=_article and revision=_old;
  if not found then raise exception 'Revision unavailable.'; end if;
  _a:=public.wp_edit(_article,_current,null,_old_payload);
  insert into public.wp_audit(article_id,actor,action,details) values(_article,auth.uid(),'restored',jsonb_build_object('revision',_old));
  return _a;
end $$;

create function public.wp_comment(_article uuid,_message text) returns void language plpgsql security definer set search_path='' as $$
declare _label text;
begin
  if not public.wp_can_read(_article) then raise exception 'Article unavailable.'; end if;
  if char_length(trim(coalesce(_message,''))) not between 1 and 2500 then raise exception 'Enter a comment of up to 2,500 characters.'; end if;
  if exists(select 1 from public.wp_review where actor=auth.uid() and created_at>now()-interval '5 seconds') then raise exception 'Wait a moment between comments.'; end if;
  select coalesce(nullif(pen_name,''),nullif(display_name,''),'Editorial desk') into _label from public.wp_profiles where id=auth.uid();
  insert into public.wp_review(article_id,actor,actor_label,message) values(_article,auth.uid(),_label,trim(_message));
end $$;

create function public.wp_publish_snapshot(_a public.wp_articles) returns void language plpgsql set search_path='' as $$
begin
  insert into public.wp_live(article_id,route,visible,passthrough,payload,published_at,updated_at)
    values(_a.id,_a.route,true,false,_a.payload,now(),now())
  on conflict(article_id) do update set visible=true,passthrough=false,payload=excluded.payload,
    updated_at=now();
end $$;

create function public.wp_transition(
  _article uuid, _revision integer, _from public.wp_status, _state public.wp_status,
  _note text default '', _when timestamptz default null
) returns public.wp_articles language plpgsql security definer set search_path='' as $$
declare
  _a public.wp_articles;
  _role public.wp_role:=public.wp_my_role();
  _staff boolean:=public.wp_is_staff();
  _publisher boolean:=coalesce(_role in ('chief','admin'),false);
  _allowed boolean:=false;
begin
  select * into _a from public.wp_articles where id=_article for update;
  if not found or not public.wp_can_read(_article) then raise exception 'Article unavailable.'; end if;
  if _a.revision is distinct from _revision or _a.state is distinct from _from then
    raise exception 'The article changed. Reload it before continuing.';
  end if;
  case _state
    when 'submitted' then _allowed:=_a.state in ('draft','changes_requested','unpublished') and (_a.owner_id=auth.uid() or _staff);
    when 'in_review' then _allowed:=(_staff and _a.state='submitted') or (_publisher and _a.state in ('approved','scheduled','rejected'));
    when 'changes_requested' then _allowed:=_staff and _a.state='in_review';
    when 'approved' then _allowed:=_publisher and _a.state='in_review';
    when 'scheduled' then _allowed:=_publisher and _a.state='approved' and coalesce(_when>now() and _when<now()+interval '2 years',false);
    when 'published' then _allowed:=_publisher and _a.state in ('approved','scheduled');
    when 'unpublished' then _allowed:=_publisher and exists(select 1 from public.wp_live where article_id=_a.id and visible);
    when 'rejected' then _allowed:=_publisher and _a.state in ('submitted','in_review');
    else _allowed:=false;
  end case;
  if _allowed is distinct from true then raise exception 'This role or status cannot perform that action.'; end if;
  if _state in ('changes_requested','rejected') and char_length(trim(coalesce(_note,'')))=0 then
    raise exception 'Add an editorial note explaining this decision.';
  end if;
  if _state in ('submitted','approved','published','scheduled') and not exists (
    select 1 from jsonb_each(coalesce(_a.payload->'editions','{}')) e
      where length(trim(e.value->>'title'))>0 and length(trim(e.value->>'body'))>0
  ) then raise exception 'Add a title and article text in at least one language.'; end if;
  if length(trim(coalesce(_note,'')))>0 then perform public.wp_comment(_article,_note); end if;
  update public.wp_articles set state=_state, scheduled_at=case when _state='scheduled' then _when end,updated_at=now()
    where id=_article returning * into _a;
  if _state='published' then perform public.wp_publish_snapshot(_a); end if;
  if _state='unpublished' then update public.wp_live set visible=false,updated_at=now() where article_id=_article; end if;
  insert into public.wp_audit(article_id,actor,action,details)
    values(_article,auth.uid(),_state,jsonb_build_object('previous',_from,'revision',_revision,'scheduled_at',_a.scheduled_at));
  perform public.wp_notify(_a,_state::text);
  return _a;
end $$;

create function public.wp_due() returns integer language plpgsql security definer set search_path='' as $$
declare _a public.wp_articles; _published integer:=0;
begin
  for _a in select * from public.wp_articles where state='scheduled' and scheduled_at<=now() for update skip locked loop
    perform public.wp_publish_snapshot(_a);
    update public.wp_articles set state='published',scheduled_at=null,updated_at=now() where id=_a.id;
    insert into public.wp_audit(article_id,action,details) values(_a.id,'published',jsonb_build_object('scheduled',true,'revision',_a.revision));
    perform public.wp_notify(_a,'published');
    _published:=_published+1;
  end loop;
  return _published;
end $$;

create function public.wp_assignable_authors() returns table(id uuid,label text)
language plpgsql stable security definer set search_path='' as $$
begin
  if public.wp_my_role() is null or public.wp_my_role() not in ('chief','admin') then raise exception 'Publisher access required.'; end if;
  return query select p.id,coalesce(nullif(p.pen_name,''),nullif(p.display_name,''),left(p.id::text,8))
    from public.wp_profiles p join auth.users u using(id)
    where p.role<>'reader' and u.email_confirmed_at is not null order by 2 limit 500;
end $$;

create function public.wp_assign_owner(_article uuid,_owner uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if public.wp_my_role() is null or public.wp_my_role() not in ('chief','admin') then raise exception 'Publisher access required.'; end if;
  if _owner is not null and not exists (
      select 1 from public.wp_profiles p join auth.users u using(id)
      where p.id=_owner and p.role<>'reader' and u.email_confirmed_at is not null
  ) then raise exception 'Choose a verified contributor or editor.'; end if;
  update public.wp_articles set owner_id=_owner,updated_at=now() where id=_article;
  if not found then raise exception 'Article unavailable.'; end if;
  if _owner is not null then insert into public.wp_inbox(recipient,article_id,action) values(_owner,_article,'ownership'); end if;
  insert into public.wp_audit(article_id,actor,action) values(_article,auth.uid(),'ownership');
end $$;

create function public.wp_read_notifications() returns void language sql security definer set search_path='' as $$
  update public.wp_inbox set read_at=now() where recipient=auth.uid() and read_at is null;
$$;

create function public.wp_public_state(_article uuid) returns boolean language sql stable security definer set search_path='' as $$
  select public.wp_can_read(_article) and exists(select 1 from public.wp_live where article_id=_article and visible)
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('editorial-assets','editorial-assets',false,8388608,
  array['image/jpeg','image/png','image/webp','image/avif','image/gif'])
on conflict(id) do nothing;

create policy wp_upload_asset on storage.objects for insert to authenticated with check
  (bucket_id='editorial-assets' and split_part(name,'/',1)=auth.uid()::text and
    name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}[.](png|jpeg|jpg|webp|avif|gif)$'
    and public.wp_my_role() in ('contributor','editor','chief','admin'));
create policy wp_read_asset on storage.objects for select to authenticated using
  (bucket_id='editorial-assets' and (public.wp_is_staff() or
    (split_part(name,'/',1)=auth.uid()::text and public.wp_my_role()='contributor')));

do $$
declare fn record;
begin
  for fn in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'wp\_%' escape '\' loop
    execute format('revoke execute on function %s from public, anon, authenticated',fn.signature);
  end loop;
end $$;

grant execute on function public.wp_my_role(),public.wp_is_staff(),public.wp_can_read(uuid),
  public.wp_profile(text,text,text),public.wp_apply(text),public.wp_assign_role(uuid,public.wp_role),public.wp_decline(uuid),
  public.wp_edit(uuid,integer,text,jsonb),public.wp_restore(uuid,integer,integer),public.wp_comment(uuid,text),
  public.wp_transition(uuid,integer,public.wp_status,public.wp_status,text,timestamptz),public.wp_read_notifications(),
  public.wp_public_state(uuid),public.wp_assign_owner(uuid,uuid),public.wp_assignable_authors() to authenticated;
grant execute on function public.wp_due() to service_role;
