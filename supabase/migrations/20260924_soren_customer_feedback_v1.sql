-- Soren customer feedback v1 (customer DB only). Service-role API is the sole access path.
create table if not exists public.soren_customer_feedback_v1 (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('功能建议','网站问题','会员咨询','其他反馈')),
  content text not null check (char_length(btrim(content)) between 1 and 500),
  status text not null default 'pending' check (status in ('pending','replied','resolved')),
  admin_reply text check (admin_reply is null or char_length(btrim(admin_reply)) between 1 and 1000),
  replied_by uuid references auth.users(id) on delete set null,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists soren_feedback_user_date_v1 on public.soren_customer_feedback_v1(user_id,created_at desc);
create index if not exists soren_feedback_status_date_v1 on public.soren_customer_feedback_v1(status,created_at desc);
alter table public.soren_customer_feedback_v1 enable row level security;
revoke all on public.soren_customer_feedback_v1 from anon,authenticated;
grant select,insert,update on public.soren_customer_feedback_v1 to service_role;
create or replace function public.soren_feedback_submission_guard_v1()
returns trigger language plpgsql security definer
set search_path=public,pg_temp as $$
declare recent_count integer; daily_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,20260924));
  select count(*) into recent_count from public.soren_customer_feedback_v1
    where user_id=new.user_id and created_at>now()-interval '10 minutes';
  select count(*) into daily_count from public.soren_customer_feedback_v1
    where user_id=new.user_id and created_at>now()-interval '24 hours';
  if recent_count>=3 or daily_count>=15 then
    raise exception using message='FEEDBACK_RATE_LIMIT',errcode='P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.soren_feedback_submission_guard_v1() from public,anon,authenticated;
drop trigger if exists soren_feedback_submission_guard_v1 on public.soren_customer_feedback_v1;
create trigger soren_feedback_submission_guard_v1 before insert on public.soren_customer_feedback_v1
  for each row execute function public.soren_feedback_submission_guard_v1();
