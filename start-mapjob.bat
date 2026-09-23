@echo off
rem Starts MapJOB on this PC: the Python backend on port 8000 and the website
rem on port 5173, each in its own window, then opens the app in the browser.
rem
rem These keep running until you close their windows -- unlike the servers
rem Claude starts, which stop when the chat goes quiet.

cd /d "%~dp0"

rem Already running? Then just open it, rather than starting a second copy
rem that would fail on the busy port.
netstat -ano | findstr /r /c:":8000 .*LISTENING" >nul
if %errorlevel%==0 (
  echo Backend already running on port 8000.
) else (
  start "MapJOB backend (port 8000)" cmd /k python -m uvicorn services.automation.api_server:app --host 127.0.0.1 --port 8000
)

netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul
if %errorlevel%==0 (
  echo Website already running on port 5173.
) else (
  start "MapJOB website (port 5173)" cmd /k npm run dev -- --port 5173 --strictPort
)

rem Give the website a few seconds to come up before opening it.
timeout /t 6 /nobreak >nul
start "" http://localhost:5173/

