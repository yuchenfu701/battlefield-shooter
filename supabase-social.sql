-- ====================================================
--  战地射击 · 社交系统数据库扩展
--  在 Supabase SQL Editor 执行
-- ====================================================

-- 扩展用户表（添加头像、签名、名片可见性）
alter table bf_users
  add column if not exists avatar  text default '😎',
  add column if not exists bio     text default '',
  add column if not exists profile_vis text default 'all';  -- all / friends

-- 好友关系表（双向存储）
create table if not exists bf_friendships (
  id        uuid primary key default gen_random_uuid(),
  user1_id  uuid not null,
  user2_id  uuid not null,
  created_at timestamptz default now(),
  unique(user1_id, user2_id)
);
alter table bf_friendships enable row level security;
drop policy if exists "bf_fs_all" on bf_friendships;
create policy "bf_fs_all" on bf_friendships using (true) with check (true);

-- 好友申请表
create table if not exists bf_friend_reqs (
  id        uuid primary key default gen_random_uuid(),
  from_id   uuid not null,
  from_name text not null,
  from_avatar text default '😎',
  to_id     uuid not null,
  status    text default 'pending',   -- pending / accepted / rejected
  created_at timestamptz default now()
);
alter table bf_friend_reqs enable row level security;
drop policy if exists "bf_fr_all" on bf_friend_reqs;
create policy "bf_fr_all" on bf_friend_reqs using (true) with check (true);

-- 私信表
create table if not exists bf_priv_msgs (
  id        uuid primary key default gen_random_uuid(),
  from_id   uuid not null,
  from_name text not null,
  to_id     uuid not null,
  content   text not null,
  read      boolean default false,
  created_at timestamptz default now()
);
alter table bf_priv_msgs enable row level security;
drop policy if exists "bf_pm_all" on bf_priv_msgs;
create policy "bf_pm_all" on bf_priv_msgs using (true) with check (true);

-- 帖子表（世界论坛 + 朋友圈）
create table if not exists bf_posts (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null,
  author_name  text not null,
  author_avatar text default '😎',
  content      text not null,
  post_type    text default 'forum',   -- forum / moments
  likes        text[] default '{}',    -- array of user IDs who liked
  created_at   timestamptz default now()
);
alter table bf_posts enable row level security;
drop policy if exists "bf_post_all" on bf_posts;
create policy "bf_post_all" on bf_posts using (true) with check (true);

-- 开启 Realtime（实时推送新消息/新申请/新帖子）
alter publication supabase_realtime add table bf_friend_reqs;
alter publication supabase_realtime add table bf_priv_msgs;
alter publication supabase_realtime add table bf_posts;
