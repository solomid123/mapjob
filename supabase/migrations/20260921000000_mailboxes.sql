-- Migration: 20260921000000_mailboxes.sql
-- Description: one connected Gmail per account, so nobody sends as anybody else.
--
-- Until now the app had one mailbox: three variables in a .env file. Every
-- letter left through it whoever wrote it, which on a deployed install would
-- mean every user of the app sharing one Google account. A mailbox is now
-- something a person connects for themselves through Google's consent screen,
-- and this is where what comes back is kept.
--
-- The refresh_token column is a credential -- it opens somebody's mail until
-- they revoke it. Two consequences, both enforced here:
--
--   * RLS is on and there is no policy, so the anon key shipped in the web
--     bundle can read exactly nothing from this table. Only the server, with
--     the service-role key that never leaves it, can see a row.
--   * No endpoint in this app returns the column. The browser is told an
--     address and a boolean, which is everything a page needs to render
--     "Connected as you@gmail.com" and nothing it could leak.

CREATE TABLE IF NOT EXISTS public.mailboxes (
    user_id TEXT PRIMARY KEY,
    address TEXT NOT NULL DEFAULT '',
    refresh_token TEXT NOT NULL,
    connected_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.mailboxes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.mailboxes IS
    'Per-account Gmail refresh tokens. Service role only: RLS on, no policies.';
COMMENT ON COLUMN public.mailboxes.refresh_token IS
    'Credential. Never selected by any client, never returned by any endpoint.';
