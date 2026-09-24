create table if not exists app_users (
  id                 text primary key,
  display_name       text not null,
  focus              text not null default '',
  letter_language    text not null default 'en',
  interview_language text not null default 'en',
  country            text not null default '',
  -- 'pair' (a letter and a CV) or 'german_dossier' (Deckblatt, Anschreiben,
  -- Lebenslauf, Zeugnisse, bound into one file). It belongs to the person and
  -- not to the vacancy: see people.application_style.
  application_style  text not null default 'pair',
  created_at         timestamptz not null default now()
);

-- For a database created before the column existed.
alter table app_users
  add column if not exists application_style text not null default 'pair';

create table if not exists candidate_profiles (
  user_id    text primary key references app_users(id) on delete cascade,
  overlay    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists held_documents (
  id                text primary key,
  user_id           text not null references app_users(id) on delete cascade,
  title             text not null default '',
  kind              text not null default 'other',
  filename          text not null,
  storage_path      text not null,
  mime              text not null default 'application/octet-stream',
  bytes             bigint not null default 0,
  pages             integer not null default 0,
  mergeable         boolean not null default false,
  sha256            text not null default '',
  attach_by_default boolean not null default false,
  added_at          timestamptz not null default now()
);
create index if not exists held_documents_user on held_documents (user_id, added_at);

alter table app_users          enable row level security;
alter table candidate_profiles enable row level security;
alter table held_documents     enable row level security;
