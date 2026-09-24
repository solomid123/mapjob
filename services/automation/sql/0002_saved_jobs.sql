-- Who saved which job.
--
-- `jobs` is a catalogue: one row per advert, keyed on the advert's id, written
-- by whoever came across it first. That is the right shape for a job posting,
-- which is the same posting for everybody -- and the wrong shape for a
-- shortlist, which is not. With the bookmark kept as a status *on the advert*,
-- both accounts read one pile: Chaimaa opened the app and found twenty
-- mechanical engineering jobs in Eindhoven waiting in her wishlist.
--
-- So the bookmark moves out into a row of its own, owned by a person. The
-- advert stays shared; the fact that someone wants it does not.
--
-- No foreign key to app_users: these rows are written from the browser with
-- the anon key, and a shortlist that fails to save because an account row is
-- missing is a worse failure than an orphan. And no row-level security yet,
-- because there is no login behind this -- the app asks who you are and
-- believes you. When it does authenticate, the policy is one line
-- (`user_id = auth.uid()`) and this table is already shaped for it.
create table if not exists saved_jobs (
  user_id    text not null,
  job_id     text not null,
  status     text not null default 'saved',
  updated_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

create index if not exists saved_jobs_user on saved_jobs (user_id, updated_at desc);
