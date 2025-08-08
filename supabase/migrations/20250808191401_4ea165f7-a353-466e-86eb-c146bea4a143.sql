-- Service credentials table for storing encrypted secrets (IMAP/CALDAV/SMTP/etc.)
create table if not exists public.service_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  service text not null check (service in ('imap','smtp','caldav','nylas')),
  username text not null,
  email text,
  host text,
  port integer,
  config jsonb not null default '{}'::jsonb,
  encrypted_secret text not null,
  iv text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.service_credentials enable row level security;

-- RLS policies
create policy "Users can view their own credentials"
  on public.service_credentials for select
  using (auth.uid() = user_id);

create policy "Users can insert their own credentials"
  on public.service_credentials for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own credentials"
  on public.service_credentials for update
  using (auth.uid() = user_id);

-- updated_at trigger
create trigger trg_service_credentials_updated
before update on public.service_credentials
for each row execute function public.update_updated_at_column();