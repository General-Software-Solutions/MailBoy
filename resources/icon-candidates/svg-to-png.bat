@echo off
rem svg-to-png.bat
rem Converts every *.svg file in the folder this script is run from into
rem PNGs at 16/32/48/128px (or sizes passed as arguments), using headless
rem Chrome. Output PNGs are written alongside the source SVGs as
rem "<name>-<size>.png".
rem
rem Usage:
rem   svg-to-png.bat                 -> sizes 16 32 48 128
rem   svg-to-png.bat 16 32 48 128 256 -> custom sizes

setlocal enabledelayedexpansion

rem === Locate chrome.exe ===
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME (
    echo [ERROR] Could not find chrome.exe in the usual locations.
    echo         Edit this script and set CHROME manually near the top.
    pause
    exit /b 1
)

rem === Sizes ===
if "%~1"=="" (
    set "SIZES=16 32 48 128"
) else (
    set "SIZES=%*"
)

set "SRCDIR=%cd%"
set "TMPDIR=%TEMP%\svg2png_%RANDOM%"
mkdir "%TMPDIR%" >nul 2>&1

set "FOUND=0"
for %%F in ("%SRCDIR%\*.svg") do (
    set "FOUND=1"
    set "SVGPATH=%%~fF"
    set "BASENAME=%%~nF"
    set "SVGURL=!SVGPATH:\=/!"
    set "SVGURL=!SVGURL: =%%20!"
    echo Converting %%~nxF ...
    for %%S in (!SIZES!) do (
        set "WRAPPER=!TMPDIR!\wrapper_!BASENAME!_%%S.html"
        set "WRAPPERURL=!WRAPPER:\=/!"
        set "WRAPPERURL=!WRAPPERURL: =%%20!"
        (
            echo ^<!DOCTYPE html^>
            echo ^<html^>^<head^>^<style^>
            echo html,body{margin:0;padding:0;background:transparent;}
            echo img{width:%%Spx;height:%%Spx;display:block;}
            echo ^</style^>^</head^>
            echo ^<body^>^<img src="file:///!SVGURL!"^>^</body^>^</html^>
        ) > "!WRAPPER!"

        "!CHROME!" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 --window-size=%%S,%%S --screenshot="!SRCDIR!\!BASENAME!-%%S.png" "file:///!WRAPPERURL!" >nul 2>&1
        echo   -^> !BASENAME!-%%S.png
    )
)

rmdir /s /q "%TMPDIR%" >nul 2>&1

echo.
if "%FOUND%"=="0" (
    echo No SVG files found in "%SRCDIR%".
) else (
    echo Done. PNGs written to "%SRCDIR%".
)

pause
endlocal
