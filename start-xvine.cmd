@echo off
rem xVine launcher (stand-in until the installer): starts the server and opens
rem your browser. If xVine is already running it just opens the browser.
where node >nul 2>nul
if errorlevel 1 (
	echo xVine needs Node.js 22.15 or newer: https://nodejs.org/
	pause
	exit /b 1
)
node "%~dp0server\main.js" %*
