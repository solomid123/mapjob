# The API, in a box.
#
# Built on Playwright's own image because getting a browser's system libraries
# right on a bare python image is a day of work that someone has already done.
# The version in the tag must match the playwright pin in requirements.txt --
# the library and the browsers it drives are one thing wearing two labels.
#
# What this image can do: the cloud apply engine, the boards, the letters, the
# documents, the mailbox, and Playwright's own Chromium. What it cannot do:
# the local undetected-Chrome engine, which wants a real desktop Chrome and a
# screen. That engine stays on the desk it was written for.
#
#   docker build -t mapjob-api .
#   docker run -p 8000:8000 --env-file .env -v mapjob-data:/data mapjob-api

FROM mcr.microsoft.com/playwright/python:v1.49.1-jammy

# Python should not buffer its output: the app's log lines are how a run is
# watched, and a buffered line is a line that arrives after the thing it was
# describing has already gone wrong.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    MAPJOB_DATA=/data

WORKDIR /app

# Dependencies first, so that editing a Python file does not reinstall Chromium.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && python -m playwright install chromium

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

