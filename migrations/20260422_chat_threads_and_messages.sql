-- =============================================================================
-- Chat feature: guests talk to operators/admins; not to other guests.
-- Threads carry metadata + unread counters; messages are append-only and drive
-- realtime channel subscriptions on the client.
--
-- Already applied to project ehlbdulcjzijgojntoye via Supabase MCP. Kept in
-- source for future environments + audit trail.
-- =============================================================================

-- 1. Thread status enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'chat_thread_status') then
    create type public.chat_thread_status as enum ('open', 'accepted', 'closed');
  end if;
end$$;

-- 2. chat_threads table
create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references auth.users(id) on delete cascade,
  operator_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  status public.chat_thread_status not null default 'open',
  last_message_at timestamptz,
  last_message_preview text,
  unread_for_guest int not null default 0,
  unread_for_operator int not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_threads_no_self check (guest_id <> operator_id)
);

create index if not exists idx_chat_threads_guest on public.chat_threads(guest_id);
create index if not exists idx_chat_threads_operator on public.chat_threads(operator_id);
create index if not exists idx_chat_threads_last_msg on public.chat_threads(last_message_at desc nulls last);

-- 3. chat_messages table
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  sender_role text not null check (sender_role in ('GUEST', 'OPERATOR', 'ADMIN', 'SYSTEM')),
  body text not null,
  message_type text not null default 'text' check (message_type in ('text', 'system', 'attachment')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_thread on public.chat_messages(thread_id, created_at desc);

-- 4. updated_at trigger for threads
drop trigger if exists trg_chat_threads_updated_at on public.chat_threads;
create trigger trg_chat_threads_updated_at
  before update on public.chat_threads
  for each row execute function public.set_updated_at();

-- 5. Post-insert trigger: bump thread preview + unread counters.
create or replace function public.handle_new_chat_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  preview text;
begin
  preview := left(new.body, 140);

  if new.sender_role = 'GUEST' then
    update public.chat_threads
       set last_message_at = new.created_at,
           last_message_preview = preview,
           unread_for_operator = unread_for_operator + 1
     where id = new.thread_id;
  elsif new.sender_role in ('OPERATOR', 'ADMIN') then
    update public.chat_threads
       set last_message_at = new.created_at,
           last_message_preview = preview,
           unread_for_guest = unread_for_guest + 1
     where id = new.thread_id;
  else
    update public.chat_threads
       set last_message_at = new.created_at,
           last_message_preview = preview
     where id = new.thread_id;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_chat_message_insert on public.chat_messages;
create trigger trg_chat_message_insert
  after insert on public.chat_messages
  for each row execute function public.handle_new_chat_message();

-- 6. RLS
alter table public.chat_threads  enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "chat_threads_select_participant" on public.chat_threads;
create policy "chat_threads_select_participant" on public.chat_threads
  for select using (auth.uid() = guest_id or auth.uid() = operator_id);

drop policy if exists "chat_threads_update_participant" on public.chat_threads;
create policy "chat_threads_update_participant" on public.chat_threads
  for update using (auth.uid() = guest_id or auth.uid() = operator_id);

drop policy if exists "chat_messages_select_participant" on public.chat_messages;
create policy "chat_messages_select_participant" on public.chat_messages
  for select using (
    exists (
      select 1 from public.chat_threads t
       where t.id = chat_messages.thread_id
         and (auth.uid() = t.guest_id or auth.uid() = t.operator_id)
    )
  );

-- 7. Realtime publication for live subscriptions.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  begin
    execute 'alter publication supabase_realtime add table public.chat_messages';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table public.chat_threads';
  exception when duplicate_object then null;
  end;
end$$;
