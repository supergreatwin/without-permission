create table public.wp_traffic (
  day date not null default (now() at time zone 'UTC')::date,
  visitor text not null check(visitor ~ '^[a-f0-9]{64}$'),
  route text not null check (char_length(route) <= 140),
  language text not null check(language in ('ar','en')),
  source text not null check(source in ('direct','internal','search','social','newsletter','referral')),
  event text not null check(event in ('view','engaged')),
  primary key(day,visitor,route,language,event)
);

create table public.wp_rate (
  minute bigint not null,
  client text not null,
  hits integer not null,
  primary key(minute,client)
);

alter table public.wp_traffic enable row level security;
alter table public.wp_rate enable row level security;
revoke all on public.wp_traffic,public.wp_rate from public,anon,authenticated;

create function public.wp_limit(_client text,_limit integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare _hits integer;
begin
  insert into public.wp_rate(minute,client,hits) values(floor(extract(epoch from now())/60),_client,1)
    on conflict(minute,client) do update set hits=public.wp_rate.hits+1 returning hits into _hits;
  return _hits<=_limit;
end $$;

create function public.wp_record(_visitor text,_route text,_language text,_source text,_event text)
returns void language sql security definer set search_path='' as $$
  insert into public.wp_traffic(visitor,route,language,source,event)
  values(_visitor,_route,_language,_source,_event) on conflict do nothing
$$;

create function public.wp_cleanup() returns void language sql security definer set search_path='' as $$
  delete from public.wp_rate where minute < floor(extract(epoch from now())/60)-60;
  delete from public.wp_traffic where day < (now() at time zone 'UTC')::date - 95;
$$;

create function public.wp_dashboard(_days integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  _from date;
  _result jsonb;
begin
  if not public.wp_is_staff() then raise exception 'Staff access required.'; end if;
  if _days not in (7,30,90) then raise exception 'Invalid reporting period.'; end if;
  _from:=(now() at time zone 'UTC')::date - (_days-1);
  with views as (select * from public.wp_traffic where day>=_from and event='view'),
  dates as (select d::date as day from generate_series(_from,(now() at time zone 'UTC')::date,interval '1 day') d),
  daily as (
    select dates.day,count(views.day) as views,count(distinct views.visitor) as visitors
    from dates left join views using(day) group by dates.day order by dates.day
  ),
  popular as (
    select route,count(*) as views from views
    where route like 'articles/%' or route ~ '^archive/[0-9]+/$'
    group by route order by views desc,route limit 10
  ),
  languages as (select language,count(*) as views from views group by language),
  sources as (select source,count(*) as views from views group by source),
  desk as (
    select action,count(*) as total from public.wp_audit
    where created_at>=(_from::timestamp at time zone 'UTC')
      and action in ('submitted','approved','published','changes_requested','application','rejected')
    group by action
  ),
  status as (select state,count(*) as total from public.wp_articles group by state)
  select jsonb_build_object(
    'pageViews',(select count(*) from views),
    'dailyVisitors',(select coalesce(sum(visitors),0) from daily),
    'engagedViews',(select count(*) from public.wp_traffic where day>=_from and event='engaged'),
    'trend',(select coalesce(jsonb_agg(to_jsonb(daily) order by day),'[]') from daily),
    'popular',(select coalesce(jsonb_agg(to_jsonb(popular) order by views desc),'[]') from popular),
    'languages',(select coalesce(jsonb_agg(to_jsonb(languages)),'[]') from languages),
    'sources',(select coalesce(jsonb_agg(to_jsonb(sources)),'[]') from sources),
    'desk',(select coalesce(jsonb_agg(to_jsonb(desk)),'[]') from desk),
    'status',(select coalesce(jsonb_agg(to_jsonb(status)),'[]') from status)
  ) into _result;
  return _result;
end $$;

revoke execute on function public.wp_limit(text,integer),public.wp_record(text,text,text,text,text),
  public.wp_dashboard(integer),public.wp_cleanup() from public,anon,authenticated;
grant execute on function public.wp_limit(text,integer),public.wp_record(text,text,text,text,text),public.wp_cleanup() to service_role;
grant execute on function public.wp_dashboard(integer) to authenticated;
