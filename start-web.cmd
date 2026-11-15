@echo off
rem ---------------------------------------------------------------------------
rem  Attendance Register - web version, on a COPY of the desktop app's real data
rem
rem    start-web.cmd          start (copies the real database the first time)
rem    start-web.cmd fresh    take a new copy of the real database, then start
rem
rem  The copy lives in db\web\attendance.db. The desktop app's own database is
rem  never written to. Close the desktop app before "fresh" so the copy is whole.
rem  Open http://127.0.0.1:3000 and sign in with your usual account.
rem  Press Ctrl+C in this window to stop.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "REAL=%APPDATA%\attendance-register\database"
set "COPY=%~dp0db\web"

if /I "%~1"=="fresh" if exist "%COPY%\attendance.db" (
  echo Taking a new copy of the real database...
  del /q "%COPY%\attendance.db" "%COPY%\attendance.db-wal" "%COPY%\attendance.db-shm" 2>nul
)
if not exist "%COPY%\attendance.db" (
  if not exist "%REAL%\attendance.db" (
    echo Could not find the desktop app's database in "%REAL%".
    echo Install and open the desktop app once, then run this again.
    goto :fail
  )
  echo Copying the real database from "%REAL%"...
  if not exist "%COPY%" mkdir "%COPY%"
  copy /y "%REAL%\attendance.db" "%COPY%\attendance.db" >nul || goto :fail
  if exist "%REAL%\attendance.db-wal" copy /y "%REAL%\attendance.db-wal" "%COPY%\attendance.db-wal" >nul
  if exist "%REAL%\attendance.db-shm" copy /y "%REAL%\attendance.db-shm" "%COPY%\attendance.db-shm" >nul
)

if not exist node_modules (
  echo Installing packages, first run only...
  call npm install || goto :fail
)

echo Building the latest version of the app...
call npm run build || goto :fail

rem Sign-in cookies need a secret; keep one beside the copy so sign-ins last.
if not exist "%COPY%\session.key" node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "%COPY%\session.key"
set /p SESSION_SECRET=<"%COPY%\session.key"

set "DB_DRIVER=sqlite"
set "DB_FILE=%COPY%\attendance.db"
set "HOST=127.0.0.1"
set "PORT=3000"
echo.
echo  Web version running at  http://127.0.0.1:3000
echo  Data: "%DB_FILE%"  (a copy of the desktop app's database)
echo  Press Ctrl+C to stop.
echo.
start "" "http://127.0.0.1:3000"
node .output\server\index.mjs
goto :eof

:fail
echo.
echo Something went wrong above. Nothing in the desktop app was changed.
pause
exit /b 1
