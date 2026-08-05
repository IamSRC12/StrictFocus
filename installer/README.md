# StrictFocus Windows Installer

This folder contains everything needed to build a **Windows setup .exe** that installs the StrictFocus APK onto an Android device over USB.

---

## Required Folder Structure

```
installer/
├── StrictFocusSetup.iss        ← Inno Setup script (the installer definition)
├── build_installer.bat         ← Build script (run this to compile the .exe)
│
├── adb/                        ← ADB binaries (download separately — see below)
│   ├── adb.exe
│   ├── AdbWinApi.dll
│   └── AdbWinUsbApi.dll
│
├── apk/                        ← Built APK (build from Android Studio)
│   └── StrictFocus.apk
│
├── assets/                     ← Icons and wizard images
│   ├── icon.ico                ← App icon (32x32 or 256x256 ICO)
│   ├── wizard_banner.bmp       ← Wizard left banner (164x314 px BMP)
│   └── wizard_small.bmp        ← Wizard top-right image (55x55 px BMP)
│
└── installer_output/           ← Created automatically
    └── StrictFocusSetup.exe    ← Final output
```

---

## Step 1 — Install Inno Setup

Download **Inno Setup 6** from:  
👉 https://jrsoftware.org/isdl.php

Run the installer and accept defaults.

---

## Step 2 — Download ADB Platform Tools

Download from:  
👉 https://developer.android.com/studio/releases/platform-tools

1. Download `platform-tools-latest-windows.zip`
2. Extract and copy these 3 files into `installer\adb\`:
   - `adb.exe`
   - `AdbWinApi.dll`
   - `AdbWinUsbApi.dll`

---

## Step 3 — Build the APK

In **Android Studio**:

1. Open `a:\Antigravity\Projects\StrictFocus`
2. `Build → Generate Signed Bundle / APK → APK`
3. Copy the output `.apk` to `installer\apk\StrictFocus.apk`

> For testing you can use the debug APK:  
> `app\build\outputs\apk\debug\app-debug.apk`

---

## Step 4 — Build the Installer

```bat
cd a:\Antigravity\Projects\StrictFocus\installer
build_installer.bat
```

The output will be: `installer_output\StrictFocusSetup.exe`

---

## What the Installer Does

When the user runs `StrictFocusSetup.exe`:

| Step | Description |
|------|-------------|
| Welcome | Instructions on enabling USB Debugging |
| Device Check | Custom wizard page — auto-detects connected device via ADB |
| (Blocks Next if no device) | User must connect phone before proceeding |
| Directory Select | Installer files go to `%ProgramFiles%\StrictFocus` |
| Install | Copies ADB + APK to install dir; runs `adb install` |
| Post-Install | Shows phone-side setup instructions (Device Admin, Accessibility) |
| Finish | Done — app is on the phone |

---

## Optional: Custom Branding Assets

| Asset | Size | Format |
|-------|------|--------|
| `assets/icon.ico` | 256×256 | ICO |
| `assets/wizard_banner.bmp` | 164×314 | BMP (24-bit) |
| `assets/wizard_small.bmp` | 55×55 | BMP (24-bit) |

Use [IcoFX](https://icofx.ro/) or [GIMP](https://www.gimp.org/) to create the ICO.  
Use Paint or any image editor for BMP files.

---

## Troubleshooting

**"No device detected"**
- Make sure USB Debugging is on (`Settings → Developer Options → USB Debugging`)
- Tap "Allow" on your phone's USB Debugging dialog
- Try a different USB cable (data cable, not charge-only)
- Install phone USB drivers from manufacturer's website

**"APK installation failed"**
- Unlock your phone screen before installing
- Go to `Settings → Security → Install unknown apps` and allow for the installer
- Try manually: `adb install -r apk\StrictFocus.apk`

**"Inno Setup not found"**
- Make sure Inno Setup 6 is installed (not Inno Setup 5)
- Default install path: `C:\Program Files (x86)\Inno Setup 6\`
