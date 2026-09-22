# The API, in a box. No browser in it, on purpose.
#
# Applications are submitted by the cloud engine, which means the browser runs
# on Browser Use's machines and this container only talks to it over the
# network. The one place Playwright is still used -- seeding the rented
# browser with cookies -- connects to that remote browser rather than starting
# a local one, so no Chromium needs to be installed here.
#
# That keeps the image around 400MB instead of 2GB, which is the difference
# between a deploy that takes a minute and one that takes fifteen.
#
# What this image cannot do: the local undetected-Chrome engine, which wants a
# real desktop Chrome and a screen. That engine stays on the desk it was
# written for. If it is ever needed in a container, the base line below
# becomes mcr.microsoft.com/playwright/python:v1.49.1-jammy and the browser
# download comes back.
#
#   docker build -t mapjob-api .
#   docker run -p 8000:8000 --env-file .env -v mapjob-data:/data mapjob-api

FROM python:3.12-slim

# Python should not buffer its output: the app's log lines are how a run is
# watched, and a buffered line is a line that arrives after the thing it was
# describing has already gone wrong.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    MAPJOB_DATA=/data \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# curl is the health check; the rest of the dependencies arrive as wheels and
# need no compiler.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first, so editing a Python file does not reinstall everything.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY services ./services
COPY scripts ./scripts
COPY deploy/entrypoint.sh /usr/local/bin/mapjob-entrypoint
RUN chmod +x /usr/local/bin/mapjob-entrypoint

# Everything the app remembers -- the ledger, the three SQLite files, the
# profile, the cookie vault, the generated documents -- lives here, outside
# the image, so that a redeploy is not an amnesia. entrypoint.sh links each
# name into place before the server starts.
VOLUME ["/data"]

EXPOSE 8000

# One worker, deliberately. Run state lives in module globals and background
# threads; a second worker would be a second app that disagrees with the first
# about which runs are in flight.
ENTRYPOINT ["/usr/local/bin/mapjob-entrypoint"]
CMD ["python", "-m", "uvicorn", "services.automation.api_server:app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "1", \
     "--timeout-keep-alive", "75"]

