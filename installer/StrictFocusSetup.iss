; ============================================================
; StrictFocus Windows Installer
; Built with Inno Setup 6.x
; https://jrsoftware.org/isinfo.php
;
; What this installer does:
;   1. Checks if the connected Android device is available via ADB
;   2. Installs the StrictFocus APK onto the device
;   3. Guides the user through enabling Device Admin + Accessibility
;   4. Bundles ADB binaries so no manual SDK setup is needed
; ============================================================

#define AppName      "StrictFocus"
#define AppVersion   "1.0.0"
#define AppPublisher "StrictFocus"
#define AppURL       "https://github.com/strictfocus/app"
#define AppExeName   "StrictFocusInstaller.exe"
#define ApkName      "StrictFocus.apk"
#define PackageName  "com.strictfocus.app"

[Setup]
AppId={{8F2A1D3E-47BC-4E9F-B2C1-A5D8F0E6C934}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
OutputDir=installer_output
OutputBaseFilename=StrictFocusSetup
SetupIconFile=assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardResizable=no
DisableProgramGroupPage=yes
DisableReadyPage=no
DisableFinishedPage=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\assets\icon.ico
ShowLanguageDialog=no
WizardSmallImageFile=assets\wizard_small.bmp
WizardImageFile=assets\wizard_banner.bmp
; Minimum Windows version: Windows 10
MinVersion=10.0.10240

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel1=Welcome to the {#AppName} Setup Wizard
WelcomeLabel2=This wizard will install {#AppName} onto your Android device.%n%nBefore you continue, make sure your Android phone is:%n%n  [1] Connected via USB cable%n  [2] USB Debugging is enabled%n  [3] Screen is unlocked%n%nClick Next to continue.
FinishedHeadingLabel=Completing {#AppName} Setup
FinishedLabel=Setup has successfully installed {#AppName} on your Android device.%n%nIMPORTANT NEXT STEPS ON YOUR PHONE:%n%n  1. Open StrictFocus%n  2. Tap "Grant" for Device Administrator%n  3. Tap "Grant" for Accessibility Service%n%nThe app is now ready to use!

[Files]
; ── ADB Binaries (bundled — no Android Studio needed) ─────────────────────
; Download from: https://developer.android.com/studio/releases/platform-tools
Source: "adb\adb.exe";          DestDir: "{app}\adb"; Flags: ignoreversion
Source: "adb\AdbWinApi.dll";    DestDir: "{app}\adb"; Flags: ignoreversion
Source: "adb\AdbWinUsbApi.dll"; DestDir: "{app}\adb"; Flags: ignoreversion

; ── StrictFocus APK ────────────────────────────────────────────────────────
Source: "apk\{#ApkName}";       DestDir: "{app}\apk"; Flags: ignoreversion

; ── USB Drivers (optional — for devices not auto-detected) ─────────────────
; Source: "drivers\usb_driver_installer.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

; ── Assets ─────────────────────────────────────────────────────────────────
Source: "assets\icon.ico";      DestDir: "{app}\assets"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName} Installer"; Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
; Show the ADB installation step, then APK install step
Filename: "{app}\adb\adb.exe"; Parameters: "install -r ""{app}\apk\{#ApkName}"""; \
    WorkingDir: "{app}\adb"; \
    StatusMsg: "Installing StrictFocus on your Android device..."; \
    Flags: runhidden waituntilterminated

[Code]

// ============================================================
// GLOBAL STATE
// ============================================================
var
  AdbPath       : String;
  DeviceId      : String;
  DeviceFound   : Boolean;
  InstallPage   : TWizardPage;
  StatusLabel   : TLabel;
  DeviceLabel   : TLabel;
  RefreshButton : TButton;
  PageIDs       : array[0..4] of Integer;

// ============================================================
// UTILITY: Execute a command and capture stdout
// ============================================================
function ExecWithOutput(const Cmd, Params, WorkDir: String;
                        var Output: AnsiString): Integer;
var
  TmpFile : String;
  ExitCode: Integer;
begin
  TmpFile := ExpandConstant('{tmp}\adb_out.txt');
  Exec(
    ExpandConstant('{cmd}'),
    '/C "' + Cmd + ' ' + Params + ' > "' + TmpFile + '" 2>&1"',
    WorkDir,
    SW_HIDE,
    ewWaitUntilTerminated,
    ExitCode
  );
  if FileExists(TmpFile) then
    LoadStringFromFile(TmpFile, Output)
  else
    Output := '';
  Result := ExitCode;
end;

// ============================================================
// ADB HELPERS
// ============================================================

// Locate ADB — first check bundled, then PATH
function FindAdb(): String;
var
  BundledAdb : String;
  EnvPath    : String;
begin
  BundledAdb := ExpandConstant('{app}\adb\adb.exe');
  if FileExists(BundledAdb) then
  begin
    Result := BundledAdb;
    Exit;
  end;

  // Fall back to PATH
  EnvPath := GetEnv('PATH');
  // Return empty if not found (will be caught later)
  Result := 'adb';
end;

// Returns the first connected device serial or '' if none
function GetConnectedDevice(): String;
var
  Output   : AnsiString;
  Lines    : TStringList;
  I        : Integer;
  Line     : String;
  ExitCode : Integer;
begin
  Result := '';
  ExitCode := ExecWithOutput(AdbPath, 'devices', ExtractFileDir(AdbPath), Output);

  Lines := TStringList.Create;
  try
    Lines.Text := String(Output);
    for I := 1 to Lines.Count - 1 do  // skip header line
    begin
      Line := Trim(Lines[I]);
      if (Length(Line) > 0) and (Pos('device', Line) > 0) and (Pos('offline', Line) = 0) then
      begin
        // Extract serial (first token)
        Result := Copy(Line, 1, Pos(#9, Line + #9) - 1);
        Result := Trim(Result);
        Break;
      end;
    end;
  finally
    Lines.Free;
  end;
end;

// Get device model name for display
function GetDeviceModel(const Serial: String): String;
var
  Output   : AnsiString;
  ExitCode : Integer;
begin
  ExitCode := ExecWithOutput(
    AdbPath,
    '-s ' + Serial + ' shell getprop ro.product.model',
    ExtractFileDir(AdbPath),
    Output
  );
  Result := Trim(String(Output));
  if Result = '' then Result := 'Unknown Device';
end;

// Returns true if the APK is already installed on the device
function IsApkInstalled(const Serial: String): Boolean;
var
  Output   : AnsiString;
  ExitCode : Integer;
begin
  ExitCode := ExecWithOutput(
    AdbPath,
    '-s ' + Serial + ' shell pm list packages {#PackageName}',
    ExtractFileDir(AdbPath),
    Output
  );
  Result := Pos('{#PackageName}', String(Output)) > 0;
end;

// Install the APK onto the device. Returns exit code (0 = success).
function InstallApk(const Serial: String): Integer;
var
  ApkPath  : String;
  Output   : AnsiString;
  ExitCode : Integer;
begin
  ApkPath := ExpandConstant('{app}\apk\{#ApkName}');
  ExitCode := ExecWithOutput(
    AdbPath,
    '-s ' + Serial + ' install -r -d "' + ApkPath + '"',
    ExtractFileDir(AdbPath),
    Output
  );
  Result := ExitCode;
end;

// ============================================================
// WIZARD PAGES
// ============================================================

// Called when wizard page changes — perform device check on prerequisite page
procedure RefreshDeviceStatus();
var
  Model : String;
begin
  DeviceId    := GetConnectedDevice();
  DeviceFound := DeviceId <> '';

  if DeviceFound then
  begin
    Model := GetDeviceModel(DeviceId);
    DeviceLabel.Caption := '✅  Device found: ' + Model + '  (' + DeviceId + ')';
    DeviceLabel.Font.Color := $00AA44;  // green
    StatusLabel.Caption := 'Ready to install. Click Next to continue.';
    StatusLabel.Font.Color := clWindowText;
  end
  else
  begin
    DeviceLabel.Caption := '❌  No device detected. Plug in your phone and enable USB Debugging.';
    DeviceLabel.Font.Color := $0000BB;  // red (BGR)
    StatusLabel.Caption := 'Waiting for device...';
    StatusLabel.Font.Color := $0000BB;
  end;
end;

// Create a custom page for the "Connect Device" step
procedure CreateDeviceCheckPage();
var
  Page       : TWizardPage;
  TitleLabel : TLabel;
  InstrLabel : TLabel;
begin
  Page := CreateCustomPage(
    wpWelcome,
    'Connect Your Android Device',
    'Plug in your phone and enable USB Debugging before continuing.'
  );

  TitleLabel := TLabel.Create(Page);
  TitleLabel.Parent := Page.Surface;
  TitleLabel.Caption := 'How to enable USB Debugging:';
  TitleLabel.Font.Style := [fsBold];
  TitleLabel.SetBounds(0, 0, Page.SurfaceWidth, 20);

  InstrLabel := TLabel.Create(Page);
  InstrLabel.Parent := Page.Surface;
  InstrLabel.Caption :=
    '1.  On your Android phone: go to Settings → About Phone'#13#10 +
    '2.  Tap "Build Number" 7 times to unlock Developer Options'#13#10 +
    '3.  Go to Settings → Developer Options'#13#10 +
    '4.  Enable "USB Debugging"'#13#10 +
    '5.  Connect your phone to this PC via USB cable'#13#10 +
    '6.  On your phone: tap "Allow" on the USB Debugging prompt';
  InstrLabel.SetBounds(0, 28, Page.SurfaceWidth, 100);

  DeviceLabel := TLabel.Create(Page);
  DeviceLabel.Parent := Page.Surface;
  DeviceLabel.Caption := 'Checking for connected device...';
  DeviceLabel.Font.Style := [fsBold];
  DeviceLabel.SetBounds(0, 148, Page.SurfaceWidth, 24);

  StatusLabel := TLabel.Create(Page);
  StatusLabel.Parent := Page.Surface;
  StatusLabel.Caption := '';
  StatusLabel.SetBounds(0, 172, Page.SurfaceWidth, 20);

  RefreshButton := TButton.Create(Page);
  RefreshButton.Parent := Page.Surface;
  RefreshButton.Caption := '🔄  Refresh Device Status';
  RefreshButton.SetBounds(0, 200, 200, 30);
  RefreshButton.OnClick := @RefreshDeviceStatus;

  PageIDs[0] := Page.ID;
  InstallPage := Page;
  RefreshDeviceStatus();
end;

// Create a custom page showing post-install instructions
procedure CreatePostInstallPage();
var
  Page      : TWizardPage;
  InfoLabel : TLabel;
begin
  Page := CreateCustomPage(
    wpSelectDir,
    'Almost Done — Final Steps on Your Phone',
    'Complete these steps on your Android device to activate StrictFocus.'
  );

  InfoLabel := TLabel.Create(Page);
  InfoLabel.Parent := Page.Surface;
  InfoLabel.WordWrap := True;
  InfoLabel.Caption :=
    'After installation, open StrictFocus on your phone and complete these steps:'#13#10#13#10 +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'#13#10 +
    ''#13#10 +
    'STEP 1 — Grant Device Administrator'#13#10 +
    '  Tap "Grant" on the Device Admin prompt.'#13#10 +
    '  This prevents uninstallation during focus sessions.'#13#10 +
    ''#13#10 +
    'STEP 2 — Enable Accessibility Service'#13#10 +
    '  Tap "Grant →" next to Accessibility Service.'#13#10 +
    '  Find "StrictFocus Anti-Bypass Guard" and enable it.'#13#10 +
    '  This prevents bypassing the VPN via Settings.'#13#10 +
    ''#13#10 +
    'STEP 3 — Start Your First Session'#13#10 +
    '  Add whitelisted domains, set a timer, and tap Start!'#13#10 +
    ''#13#10 +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  InfoLabel.SetBounds(0, 0, Page.SurfaceWidth, 300);

  PageIDs[1] := Page.ID;
end;

// ============================================================
// INNO SETUP EVENT HANDLERS
// ============================================================

procedure InitializeWizard();
begin
  AdbPath     := ExpandConstant('{app}\adb\adb.exe');
  DeviceFound := False;
  DeviceId    := '';

  CreateDeviceCheckPage();
  CreatePostInstallPage();
end;

// Block "Next" on the device check page if no device is found
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;

  // Device check page
  if CurPageID = PageIDs[0] then
  begin
    RefreshDeviceStatus();
    if not DeviceFound then
    begin
      MsgBox(
        'No Android device detected.'#13#10#13#10 +
        'Please:'#13#10 +
        '  1. Connect your phone via USB'#13#10 +
        '  2. Enable USB Debugging (Settings → Developer Options)'#13#10 +
        '  3. Tap "Allow" on your phone''s USB Debugging prompt'#13#10 +
        '  4. Click "Refresh Device Status" below'#13#10#13#10 +
        'Then click Next again.',
        mbError,
        MB_OK
      );
      Result := False;
    end;
  end;
end;

// After files are installed, run ADB install
procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode   : Integer;
  ModelName  : String;
  ErrMsg     : String;
begin
  if CurStep = ssPostInstall then
  begin
    // Refresh ADB path now that files are installed
    AdbPath := ExpandConstant('{app}\adb\adb.exe');

    // Re-confirm device is still connected
    DeviceId := GetConnectedDevice();
    if DeviceId = '' then
    begin
      MsgBox(
        'Your device was disconnected during installation.'#13#10 +
        'Please reconnect your phone and run the installer again.',
        mbError,
        MB_OK
      );
      Exit;
    end;

    ModelName := GetDeviceModel(DeviceId);

    // Install the APK
    ExitCode := InstallApk(DeviceId);

    if ExitCode = 0 then
    begin
      MsgBox(
        '✅ StrictFocus successfully installed on:'#13#10 +
        '   ' + ModelName + '  (' + DeviceId + ')'#13#10#13#10 +
        'Open the app on your phone to complete setup.',
        mbInformation,
        MB_OK
      );
    end
    else
    begin
      ErrMsg :=
        '❌ APK installation failed (ADB exit code: ' + IntToStr(ExitCode) + ').'#13#10#13#10 +
        'Possible causes:'#13#10 +
        '  • The phone''s screen was locked during install'#13#10 +
        '  • "Install unknown apps" permission was denied'#13#10 +
        '  • USB connection was interrupted'#13#10#13#10 +
        'You can install manually:'#13#10 +
        '  1. Copy the APK from: ' + ExpandConstant('{app}\apk\{#ApkName}') + #13#10 +
        '  2. Transfer to your phone and open it to install';
      MsgBox(ErrMsg, mbError, MB_OK);
    end;
  end;
end;

// ============================================================
// UNINSTALL: Remove APK from device on uninstall
// ============================================================
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Output   : AnsiString;
  ExitCode : Integer;
  Confirm  : Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    AdbPath  := ExpandConstant('{app}\adb\adb.exe');
    DeviceId := GetConnectedDevice();

    if DeviceId <> '' then
    begin
      Confirm := MsgBox(
        'Do you want to also remove StrictFocus from your connected Android device?',
        mbConfirmation,
        MB_YESNO
      );
      if Confirm = IDYES then
      begin
        ExitCode := ExecWithOutput(
          AdbPath,
          '-s ' + DeviceId + ' uninstall {#PackageName}',
          ExtractFileDir(AdbPath),
          Output
        );
        if ExitCode = 0 then
          MsgBox('StrictFocus has been removed from your device.', mbInformation, MB_OK)
        else
          MsgBox(
            'Could not automatically remove the app from device.'#13#10 +
            'You can uninstall it manually from your phone''s Settings.',
            mbInformation,
            MB_OK
          );
      end;
    end;
  end;
end;
