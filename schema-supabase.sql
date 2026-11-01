-- NSH.bot: افزونه جداول اختصاصی برای ورود شماره‌محور و همگام‌سازی
-- در Supabase SQL Editor اجرا شود.
create extension if not exists pgcrypto;
create table if not exists public.nsh_users (
 id uuid primary key default gen_random_uuid(),
 phone text not null unique,
 status text not null default 'active' check (status in ('active','disabled')),
 role text not null default 'user' check (role in ('user','owner')),
 created_at timestamptz not null default now()
);
create table if not exists public.nsh_sessions (
 id uuid primary key default gen_random_uuid(),
 token_hash text not null unique,
 user_id uuid not null references public.nsh_users(id) on delete cascade,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index if not exists nsh_sessions_user_idx on public.nsh_sessions(user_id);
create table if not exists public.nsh_user_sync (
 user_id uuid primary key references public.nsh_users(id) on delete cascade,
 data_json jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now()
);
alter table public.nsh_users enable row level security;
alter table public.nsh_sessions enable row level security;
alter table public.nsh_user_sync enable row level security;
revoke all on public.nsh_users, public.nsh_sessions, public.nsh_user_sync from anon, authenticated;
-- عملیات فقط از Edge Function با service-role انجام می‌شود.
