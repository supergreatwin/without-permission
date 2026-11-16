create type public.wp_pitch_status as enum (
  'received', 'in_review', 'accepted', 'editing', 'published', 'declined'
);

create table public.wp_pitches (
  id uuid primary key default gen_random_uuid(),
  tally_id text not null unique check (tally_id ~ '^[a-zA-Z0-9_-]{6,100}$'),
  title text not null check (char_length(title) between 1 and 180),
  state public.wp_pitch_status not null default 'received',
  owner_id uuid references public.wp_profiles(id) on delete set null,
  deadline date,
  note text not null default '' check (char_length(note) <= 1500),
  article_id uuid references public.wp_articles(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'published' or article_id is not null)
);

create index wp_pitches_state_deadline on public.wp_pitches(state, deadline, updated_at desc);
alter table public.wp_pitches enable row level security;
revoke all on public.wp_pitches from public, anon, authenticated;
grant select on public.wp_pitches to authenticated;
create policy wp_staff_read_pitches on public.wp_pitches
  for select to authenticated using (public.wp_is_staff());

create function public.wp_pitch_owners() returns table(id uuid, label text)
language plpgsql stable security definer set search_path='' as $$
begin
  if not public.wp_is_staff() then raise exception 'Staff access required.'; end if;
  return query
    select p.id, coalesce(nullif(p.pen_name,''), nullif(p.display_name,''), left(p.id::text,8))
    from public.wp_profiles p join auth.users u using(id)
    where p.role in ('admin','chief','editor') and u.email_confirmed_at is not null
    order by 2;
end $$;

create function public.wp_save_pitch(
  _id uuid, _version integer, _tally_id text, _title text, _state public.wp_pitch_status,
  _owner uuid, _deadline date, _note text, _article_route text
) returns public.wp_pitches
language plpgsql security definer set search_path='' as $$
declare
  pitch public.wp_pitches;
  previous public.wp_pitch_status;
  published_article uuid;
begin
  if not public.wp_is_staff() then raise exception 'Staff access required.'; end if;
  if _state is null then raise exception 'Choose a pitch status.'; end if;
  if not exists (select from public.wp_pitch_owners() where id=_owner) then
    raise exception 'Choose a verified editorial owner.';
  end if;
  if _state='published' then
    select article_id into published_article
    from public.wp_live where route=trim(_article_route) and visible;
    if published_article is null then raise exception 'Enter a published article path.'; end if;
  end if;

  if _id is null then
    if _state is distinct from 'received' then raise exception 'New pitches start in Received.'; end if;
    insert into public.wp_pitches(tally_id,title,owner_id,deadline,note)
    values(trim(_tally_id),trim(_title),_owner,_deadline,coalesce(trim(_note),''))
    returning * into pitch;
  else
    select * into pitch from public.wp_pitches where id=_id for update;
    if not found or pitch.version is distinct from _version then
      raise exception 'The pitch changed. Refresh the list and retry.';
    end if;
    previous:=pitch.state;
    if _state is distinct from previous and not (
      (previous='received' and _state in ('in_review','declined')) or
      (previous='in_review' and _state in ('accepted','declined')) or
      (previous='accepted' and _state='editing') or
      (previous='editing' and _state='published') or
      (previous='declined' and _state='in_review')
    ) then
      raise exception 'That pitch transition is unavailable.';
    end if;
    update public.wp_pitches
    set title=trim(_title),state=_state,owner_id=_owner,deadline=_deadline,
      note=coalesce(trim(_note),''),article_id=published_article,
      version=version+1,updated_at=now()
    where id=_id returning * into pitch;
  end if;
  insert into public.wp_audit(actor,article_id,action,details)
  values(auth.uid(),pitch.article_id,'pitch_review',
    jsonb_build_object('pitch',pitch.id,'previous',previous,'state',pitch.state,
      'owner',pitch.owner_id,'deadline',pitch.deadline));
  return pitch;
end $$;

revoke all on function public.wp_pitch_owners() from public, anon, authenticated;
revoke all on function public.wp_save_pitch(uuid,integer,text,text,public.wp_pitch_status,uuid,date,text,text)
  from public, anon, authenticated;
grant execute on function public.wp_pitch_owners() to authenticated;
grant execute on function public.wp_save_pitch(uuid,integer,text,text,public.wp_pitch_status,uuid,date,text,text)
  to authenticated;
