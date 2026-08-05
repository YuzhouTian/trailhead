@echo off
cd /d "%~dp0"
echo Starting Trailhead... your browser will open in a moment.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:5173"
npm run dev
