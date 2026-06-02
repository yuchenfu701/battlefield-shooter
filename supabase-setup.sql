-- ================================================
--  战地射击 · Supabase 数据库初始化脚本
--  在 Supabase → SQL Editor 里粘贴并执行
-- ================================================

-- 用户账号表
create table if not exists bf_users (
  id         uuid primary key default gen_random_uuid(),
  phone      text unique not null,
  name       text not null,
  pwd_hash   text not null,
  score      int  default 0,
  kills      int  default 0,
  deaths     int  default 0,
  wins       int  default 0,
  skins      text[] default '{}',
  created_at timestamptz default now()
);
alter table bf_users enable row level security;
create policy "bf_users_select" on bf_users for select using (true);
create policy "bf_users_insert" on bf_users for insert with check (true);
create policy "bf_users_update" on bf_users for update using (true);

-- 游戏房间表
create table if not exists bf_rooms (
  id         text primary key,
  map_seed   int  not null,
  host_id    uuid not null,
  state      text default 'lobby',
  max_teams  int  default 4,
  created_at timestamptz default now()
);
alter table bf_rooms enable row level security;
create policy "bf_rooms_all" on bf_rooms using (true) with check (true);

-- 开启 Realtime（让客户端实时监听房间变化）
alter publication supabase_realtime add table bf_rooms;
