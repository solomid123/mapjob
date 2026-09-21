# Putting MapJOB somewhere other than this desk

The app is two halves with two different needs, and most of the confusion
about deploying it comes from treating them as one thing.

| Half | What it is | What it needs |
| --- | --- | --- |
| The SPA | `npm run build` → a folder of static files | a CDN. Any of them. |
| The API | FastAPI, background threads, Playwright, SQLite and JSON on disk | one long-lived process with a disk that survives a restart |

Vercel and Cloudflare Workers can host the first and cannot host the second.
Not "would be slow" — cannot: a serverless function has no process between
requests, no writable disk, and a ceiling of seconds, while an apply run takes
minutes and keeps its state in module globals. The API also runs one worker on
purpose, because a second worker is a second app that disagrees with the first
about which runs are in flight.

## The front half: Cloudflare Pages

Build command `npm run build`, output directory `dist`, and one environment
variable:

    VITE_API_BASE_URL = https://api.example.com

That variable is not optional for a deployed build. The SPA and the API are on
different hostnames and nothing in the browser can guess the second from the
first. Without it the app falls back to its own origin and every call 404s —
loudly, which is the intended failure.

## The back half, free: this machine behind a Cloudflare Tunnel

The cheapest honest answer. The API keeps running where it already runs, and
the tunnel gives it a public hostname without an open port, a static IP, or a
bill.

    winget install --id Cloudflare.cloudflared
    cloudflared tunnel login
    cloudflared tunnel create mapjob
    cloudflared tunnel route dns mapjob api.example.com
    # copy cloudflared.example.yml to ~/.cloudflared/config.yml, edit the names
    cloudflared tunnel run mapjob

This is also the only arrangement where the cookie vault, the Chrome profiles
and the candidate's personal data stay on a disk you own.

## The back half, off this machine: Fly or Railway

A real container with a volume. Roughly $3–5 a month.

    docker build -t mapjob-api .
    docker run -p 8000:8000 --env-file .env -v mapjob-data:/data mapjob-api

The volume matters. Every stateful file the backend keeps — `applications.jsonl`,
the three SQLite databases, the profile, the cookie vault, the generated
documents — lives next to the module that writes it, which is fine on a desk
and would be erased by every deploy in a container. `entrypoint.sh` links each
of those names out to `/data` before uvicorn starts, and carries the image's
copy across on first boot. Adding a new stateful file means adding a line to
the `NAMES` list in that script; forgetting to is how it gets lost.

On Fly: `fly launch --no-deploy`, then `fly volumes create mapjob_data --size 3`,
then a `[mounts]` section pointing `/data` at it, then `fly secrets set` for
everything in `.env`.

### Render's free tier is the wrong choice here

It sleeps after fifteen minutes of no traffic, which kills a run in flight, and
its free disk is ephemeral, so the ledger and the SQLite files disappear on
each deploy. Those are the two things this app most needs not to happen.

## What the container cannot do

The local undetected-Chrome engine. It wants a real desktop Chrome and a
screen, and the image has neither — it ships Playwright's Chromium. The cloud
apply engine, the boards, the letters, the documents and the mailbox all work.
If the local engine matters, the tunnel arrangement is the one to pick.

## Before pointing a public hostname at it

Worth knowing rather than discovering: every route still answers for whatever
`user=` it is handed, and CORS is `*`. That is a deliberate choice for a
personal app behind a hostname nobody else has, and it stops being safe the
moment the hostname is shared. Cloudflare Access in front of the tunnel is the
small version of the fix — an email code, no code changes — if that ever
changes.

Secrets reach the container through `--env-file .env` or `fly secrets`, never
through the image: `.dockerignore` excludes `.env`, the cookie vault, the
Chrome profiles and the generated documents, and the Dockerfile copies only
`services/` and `scripts/`.

