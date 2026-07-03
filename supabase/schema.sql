create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  sender_id uuid not null references auth.users(id) on delete cascade,
  sender_name text not null check (char_length(sender_name) between 1 and 24),
  content text not null check (char_length(content) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at);

alter table public.messages enable row level security;

grant usage on schema public to authenticated;
grant select, insert on table public.messages to authenticated;

drop policy if exists "Anonymous users can read room messages" on public.messages;
create policy "Anonymous users can read room messages"
  on public.messages for select to authenticated using (
    auth.uid()::text = any(string_to_array(room_id, ':'))
  );

drop policy if exists "Anonymous users can send their own messages" on public.messages;
create policy "Anonymous users can send their own messages"
  on public.messages for insert to authenticated with check (
    sender_id = auth.uid()
    and auth.uid()::text = any(string_to_array(room_id, ':'))
  );

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
