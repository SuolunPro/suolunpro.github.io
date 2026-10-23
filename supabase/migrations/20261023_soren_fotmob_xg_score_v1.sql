-- Strict prematch FotMob xG, isolated from the seven existing module outputs.
create table if not exists ninety_core.soren_fotmob_xg_matches_v1 (
  fotmob_match_id bigint primary key,
  league_id bigint, season_label text, utc_time timestamptz not null,
  home_team_id bigint not null, away_team_id bigint not null,
  home_xg double precision not null check (home_xg between 0 and 15),
  away_xg double precision not null check (away_xg between 0 and 15),
  source_url text not null, fetched_at timestamptz not null default now(),
  check (utc_time < fetched_at - interval '90 minutes')
);
create index if not exists soren_fotmob_xg_team_home_v1 on ninety_core.soren_fotmob_xg_matches_v1(home_team_id,utc_time desc);
create index if not exists soren_fotmob_xg_team_away_v1 on ninety_core.soren_fotmob_xg_matches_v1(away_team_id,utc_time desc);
create index if not exists soren_fotmob_xg_league_v1 on ninety_core.soren_fotmob_xg_matches_v1(league_id,season_label,utc_time desc);
create table if not exists ninety_core.soren_fotmob_score_top4_v1 (
  match_id bigint primary key references ninety_core.soren_matches(id),
  pool_date date not null, match_no text not null, home_team text not null, away_team text not null,
  kickoff_at timestamptz not null, computed_at timestamptz not null,
  lambda_home double precision not null check (lambda_home between 0.2 and 3.8),
  lambda_away double precision not null check (lambda_away between 0.2 and 3.8),
  scores jsonb not null check (jsonb_array_length(scores)=4),
  input_manifest jsonb not null, method text not null default 'FOTMOB_XG_STRICT_PREMATCH_POISSON_DC_V1',
  unique(pool_date,match_no), check(computed_at<kickoff_at)
);
create index if not exists soren_fotmob_score_day_v1 on ninety_core.soren_fotmob_score_top4_v1(pool_date,match_no);
alter table ninety_core.soren_fotmob_xg_matches_v1 enable row level security;
alter table ninety_core.soren_fotmob_score_top4_v1 enable row level security;
grant select,insert,update on ninety_core.soren_fotmob_xg_matches_v1 to service_role;
grant select,insert,update on ninety_core.soren_fotmob_score_top4_v1 to service_role;

create or replace function ninety_core.soren_refresh_fotmob_score_v1(p_date date)
returns jsonb language plpgsql security definer set search_path='ninety_core','pg_temp' as $fn$
declare m record; hn int; an int; ln int; hxgf numeric; hxga numeric; axgf numeric; axga numeric; lg numeric; lh numeric; la numeric;
        ts timestamptz; cutoff timestamptz; picks jsonb; total numeric; written int:=0; insufficient int:=0; eligible int:=0;
begin
  for m in select s.*,e.home_team_id hid,e.away_team_id aid,e.league_id lid,e.season_label season
    from ninety_core.soren_matches s join ninety_core.elo_match_scores e
      on e.match_key=replace(s.pool_date::text,'-','')||'-'||lpad(s.match_no,3,'0')
    where s.pool_date=p_date and coalesce(s.is_world_cup,false)=false
      and (s.source_status->>'pool_status'='ACTIVE' or s.source_status->>'source'='sg_local_hj38_offerings') order by s.match_no loop
    ts:=clock_timestamp();
    cutoff:=least(m.kickoff_at - interval '10 minutes',coalesce(m.cutoff_at,'infinity'::timestamptz),
      (m.pool_date::text||case when extract(isodow from m.pool_date) in (6,7) then ' 23:00:00+08' else ' 22:00:00+08' end)::timestamptz);
    if ts>=cutoff then continue; end if;
    eligible:=eligible+1;
    if m.hid is null or m.aid is null or m.lid is null or m.season is null then insufficient:=insufficient+1;continue;end if;
    select count(*),avg(xgf),avg(xga) into hn,hxgf,hxga from (
      select case when c.home_team_id=m.hid then c.home_xg else c.away_xg end xgf,
             case when c.home_team_id=m.hid then c.away_xg else c.home_xg end xga
      from ninety_core.soren_fotmob_xg_matches_v1 c
      where (c.home_team_id=m.hid or c.away_team_id=m.hid)
        and c.utc_time<m.kickoff_at and c.fetched_at<=ts
      order by c.utc_time desc limit 3) q;
    select count(*),avg(xgf),avg(xga) into an,axgf,axga from (
      select case when c.home_team_id=m.aid then c.home_xg else c.away_xg end xgf,
             case when c.home_team_id=m.aid then c.away_xg else c.home_xg end xga
      from ninety_core.soren_fotmob_xg_matches_v1 c
      where (c.home_team_id=m.aid or c.away_team_id=m.aid)
        and c.utc_time<m.kickoff_at and c.fetched_at<=ts
      order by c.utc_time desc limit 3) q;
    select count(*),avg((c.home_xg+c.away_xg)/2) into ln,lg
      from ninety_core.soren_fotmob_xg_matches_v1 c
      where c.league_id=m.lid and c.season_label=m.season and c.utc_time<m.kickoff_at and c.fetched_at<=ts;
    if hn<3 or an<3 or ln<6 or lg<=0 then insufficient:=insufficient+1;continue;end if;
    lh:=greatest(0.2,least(3.8,0.65*(hxgf*axga/lg)+0.35*lg));
    la:=greatest(0.2,least(3.8,0.65*(axgf*hxga/lg)+0.35*lg));
    with grid as (
      select h,a,exp(-lh)*power(lh,h)/factorial(h)*exp(-la)*power(la,a)/factorial(a)*
        case when h=0 and a=0 then 1-lh*la*(-0.08)
             when h=0 and a=1 then 1+lh*(-0.08)
             when h=1 and a=0 then 1+la*(-0.08)
             when h=1 and a=1 then 1-(-0.08) else 1 end as mass
      from generate_series(0,10) h cross join generate_series(0,10) a
    ), ranked as (
      select h,a,mass/sum(mass) over() probability from grid
    ) select jsonb_agg(jsonb_build_object('score',h::text||'-'||a::text,
       'baseProbability',probability,'probability',probability,'rank',rn) order by rn)
      into picks from (select *,row_number() over(order by probability desc,h+a,h,a) rn
        from ranked order by probability desc,h+a,h,a limit 4) q;
    if jsonb_array_length(picks)<>4 then insufficient:=insufficient+1;continue;end if;
    -- The cutoff is rechecked after computing; upsert only while still lawful.
    ts:=clock_timestamp();
    if ts>=cutoff then continue;end if;
    insert into ninety_core.soren_fotmob_score_top4_v1
      (match_id,pool_date,match_no,home_team,away_team,kickoff_at,computed_at,lambda_home,lambda_away,scores,input_manifest)
    values(m.id,m.pool_date,m.match_no,m.home_team,m.away_team,m.kickoff_at,ts,lh,la,picks,
      jsonb_build_object('source','fotmob_matchDetails.expected_goals','home_hist_n',hn,'away_hist_n',an,
        'league_xg_n',ln,'league_avg_xg',lg,'league_id',m.lid,'season',m.season,
        'rho',-0.08,'computed_at',ts,'sale_cutoff_at',cutoff,'result_used',false,'strict_prematch',true))
    on conflict(match_id) do update set computed_at=excluded.computed_at,lambda_home=excluded.lambda_home,
      lambda_away=excluded.lambda_away,scores=excluded.scores,input_manifest=excluded.input_manifest
      where ninety_core.soren_fotmob_score_top4_v1.computed_at<excluded.computed_at
        and excluded.computed_at<cutoff;
    written:=written+1;
  end loop;
  return jsonb_build_object('eligible',eligible,'written',written,'insufficient',insufficient,
    'method','FOTMOB_XG_STRICT_PREMATCH_POISSON_DC_V1','result_used',false);
end $fn$;
revoke all on function ninety_core.soren_refresh_fotmob_score_v1(date) from public,anon,authenticated;
grant execute on function ninety_core.soren_refresh_fotmob_score_v1(date) to service_role;
