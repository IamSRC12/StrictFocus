@echo off
setlocal EnableDelayedExpansion
title StrictFocus Installer Builder
color 0A

echo.
echo  ===================================================
echo   StrictFocus Windows Installer Builder
echo   Builds the .exe installer using Inno Setup
echo  ===================================================
echo.

:: ─────────────────────────────────────────────────────────────
:: STEP 1: Check prerequisites
:: ─────────────────────────────────────────────────────────────
echo [1/5] Checking prerequisites...

:: Check for Inno Setup
set ISCC=
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" (
    set ISCC="%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
) else if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" (
    set ISCC="%ProgramFiles%\Inno Setup 6\ISCC.exe"
) else (
    echo.
    echo  [ERROR] Inno Setup 6 not found!
    echo.
    echo  Please download and install it from:
    echo    https://jrsoftware.org/isdl.php
    echo.
    echo  Then run this script again.
    pause
    exit /b 1
)
echo  ✓ Inno Setup found: !ISCC!

:: Check for ADB binaries
if not exist "adb\adb.exe" (
    echo.
    echo  [ERROR] ADB binaries not found in .\adb\
    echo.
    echo  Please download Android Platform Tools from:
    echo    https://developer.android.com/studio/releases/platform-tools
    echo.
    echo  Extract the following files into the .\adb\ folder:
    echo    - adb.exe
    echo    - AdbWinApi.dll
    echo    - AdbWinUsbApi.dll
    echo.
    pause
    exit /b 1
)
echo  ✓ ADB binaries found

:: Check for APK
if not exist "apk\StrictFocus.apk" (
    echo.
    echo  [WARNING] APK not found at .\apk\StrictFocus.apk
    echo.
    echo  Build the APK first:
    echo    1. Open the StrictFocus project in Android Studio
    echo    2. Build ^> Generate Signed APK (or use debug APK for testing)
    echo    3. Copy the .apk file to .\apk\StrictFocus.apk
    echo.
    set /p CONTINUE="Continue anyway to test installer structure? (y/n): "
    if /i "!CONTINUE!" neq "y" exit /b 1
)
echo  ✓ APK found (or skipped)

:: Create required directories
if not exist "assets"          mkdir assets
if not exist "installer_output" mkdir installer_output

:: ─────────────────────────────────────────────────────────────
:: STEP 2: Generate placeholder icon if missing
:: ─────────────────────────────────────────────────────────────
echo.
echo [2/5] Checking assets...

if not exist "assets\icon.ico" (
    echo  [INFO] icon.ico not found — using default Windows icon
    :: Copy a system icon as placeholder
    copy /Y "%SystemRoot%\system32\shell32.dll" "assets\icon.ico" >nul 2>&1
    echo  ✓ Placeholder icon created (replace assets\icon.ico with your real icon)
) else (
    echo  ✓ Icon found
)

:: ─────────────────────────────────────────────────────────────
:: STEP 3: Compile the installer
:: ─────────────────────────────────────────────────────────────
echo.
echo [3/5] Compiling installer...
echo.

!ISCC! "StrictFocusSetup.iss"

if !ERRORLEVEL! neq 0 (
    echo.
    echo  [ERROR] Inno Setup compilation failed! (Exit code: !ERRORLEVEL!)
    echo  Check the output above for errors.
    pause
    exit /b !ERRORLEVEL!
)

echo.
echo  ✓ Installer compiled successfully!

:: ─────────────────────────────────────────────────────────────
:: STEP 4: Verify output
:: ─────────────────────────────────────────────────────────────
echo.
echo [4/5] Verifying output...

if exist "installer_output\StrictFocusSetup.exe" (
    for %%A in ("installer_output\StrictFocusSetup.exe") do (
        set SIZE=%%~zA
        set /a SIZE_MB=!SIZE! / 1048576
    )
    echo  ✓ Output: installer_output\StrictFocusSetup.exe  (!SIZE_MB! MB)
) else (
    echo  [ERROR] Output file not found!
    pause
    exit /b 1
)

:: ─────────────────────────────────────────────────────────────
:: STEP 5: Done
:: ─────────────────────────────────────────────────────────────
echo.
echo [5/5] Build complete!
echo.
echo  ===================================================
echo   OUTPUT: installer_output\StrictFocusSetup.exe
echo  ===================================================
echo.
echo  To distribute:
echo    - Share installer_output\StrictFocusSetup.exe
echo    - Users run it on Windows with phone connected via USB
echo.

:: Ask to open output folder
set /p OPEN_FOLDER="Open output folder now? (y/n): "
if /i "%OPEN_FOLDER%"=="y" (
    explorer "installer_output"
)

endlocal
pause
