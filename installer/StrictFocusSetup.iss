; ============================================================
; StrictFocus Windows Installer  v1.0.0
; Built with Inno Setup 6.x  –  https://jrsoftware.org/isinfo.php
; ============================================================

#define AppName      "StrictFocus"
#define AppVersion   "1.0.0"
#define AppPublisher "StrictFocus"
#define AppURL       "https://github.com/strictfocus/app"
#define ApkName      "StrictFocus.apk"
#define PackageName  "com.strictfocus.app"

[Setup]
AppId={{8F2A1D3E-47BC-4E9F-B2C1-A5D8F0E6C934}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
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
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\assets\icon.ico
ShowLanguageDialog=no
WizardSmallImageFile=assets\wizard_small.bmp
WizardImageFile=assets\wizard_banner.bmp
MinVersion=10.0.10240

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel1=Welcome to StrictFocus Setup
WelcomeLabel2=This wizard will install StrictFocus on your Android device.%n%nMake sure your phone is:%n%n  • Connected via USB cable%n  • USB Debugging is enabled%n  • Screen is unlocked%n%nClick Next to continue.
FinishedHeadingLabel=StrictFocus is Installed!
FinishedLabel=StrictFocus has been installed on your Android device.%n%nCOMPLETE THESE STEPS ON YOUR PHONE:%n%n  1. Open StrictFocus app%n  2. Tap [Grant] for Device Administrator%n  3. Tap [Grant] for Accessibility Service%n  4. Start your first focus session!

[Files]
; ADB Binaries (bundled)
Source: "adb\adb.exe";             DestDir: "{app}\adb"; Flags: ignoreversion
Source: "adb\AdbWinApi.dll";       DestDir: "{app}\adb"; Flags: ignoreversion
Source: "adb\AdbWinUsbApi.dll";    DestDir: "{app}\adb"; Flags: ignoreversion

; StrictFocus APK
Source: "apk\{#ApkName}";          DestDir: "{app}\apk"; Flags: ignoreversion

; Assets
Source: "assets\icon.ico";         DestDir: "{app}\assets"; Flags: ignoreversion

[Icons]
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Code]
// ============================================================
// GLOBALS
// ============================================================
var
  AdbPath         : String;
  DeviceSerial    : String;
  DeviceFound     : Boolean;
  ApkIsReal       : Boolean;

  // Custom page handles
  PageDeviceCheck : TWizardPage;
  PagePostInstall : TWizardPage;

  // Widgets on PageDeviceCheck
  LblDeviceStatus : TLabel;
  LblDeviceModel  : TLabel;
  BtnRefresh      : TButton;
  LblApkWarning   : TLabel;

// ============================================================
// UTILITY: Run command and capture stdout to string
// ============================================================
function CaptureExec(const Exe, Args, Dir: String; var Out: AnsiString): Integer;
var
  Tmp  : String;
  Code : Integer;
begin
  Tmp := ExpandConstant('{tmp}\sf_cmd_out.txt');
  Exec(
    ExpandConstant('{cmd}'),
    '/C ""' + Exe + '" ' + Args + ' >"' + Tmp + '" 2>&1"',
    Dir, SW_HIDE, ewWaitUntilTerminated, Code
  );
  Out := '';
  if FileExists(Tmp) then LoadStringFromFile(Tmp, Out);
  Result := Code;
end;

// ============================================================
// ADB HELPERS
// ============================================================
function GetFirstDevice: String;
var
  Out   : AnsiString;
  Lines : TStringList;
  I     : Integer;
  Line  : String;
begin
  Result := '';
  CaptureExec(AdbPath, 'devices', ExtractFileDir(AdbPath), Out);
  Lines := TStringList.Create;
  try
    Lines.Text := String(Out);
    for I := 1 to Lines.Count - 1 do
    begin
      Line := Trim(Lines[I]);
      if (Pos(#9 + 'device', Line) > 0) and (Pos('offline', Line) = 0) then
      begin
        Result := Copy(Line, 1, Pos(#9, Line) - 1);
        Break;
      end;
    end;
  finally
    Lines.Free;
  end;
end;

function GetDeviceModel(const Serial: String): String;
var
  Out  : AnsiString;
  Code : Integer;
begin
  Code := CaptureExec(AdbPath, '-s ' + Serial + ' shell getprop ro.product.model',
                       ExtractFileDir(AdbPath), Out);
  Result := Trim(String(Out));
  if Result = '' then Result := 'Unknown Device';
end;

function GetAndroidVersion(const Serial: String): String;
var Out: AnsiString;
begin
  CaptureExec(AdbPath, '-s ' + Serial + ' shell getprop ro.build.version.release',
              ExtractFileDir(AdbPath), Out);
  Result := Trim(String(Out));
end;

function InstallApk(const Serial: String): Integer;
var Out : AnsiString;
begin
  Result := CaptureExec(
    AdbPath,
    '-s ' + Serial + ' install -r -d "' + ExpandConstant('{app}\apk\{#ApkName}') + '"',
    ExtractFileDir(AdbPath),
    Out
  );
end;

function LaunchApp(const Serial: String): Integer;
var Out : AnsiString;
begin
  Result := CaptureExec(
    AdbPath,
    '-s ' + Serial + ' shell monkey -p {#PackageName} -c android.intent.category.LAUNCHER 1',
    ExtractFileDir(AdbPath),
    Out
  );
end;

// ============================================================
// DEVICE CHECK PAGE LOGIC
// ============================================================
procedure DoRefreshDevice(Sender: TObject);
var
  Model, Android : String;
begin
  LblDeviceStatus.Caption := 'Scanning for devices...';
  LblDeviceModel.Caption  := '';
  BtnRefresh.Enabled      := False;
  DeviceSerial := GetFirstDevice();
  DeviceFound  := DeviceSerial <> '';

  if DeviceFound then
  begin
    Model   := GetDeviceModel(DeviceSerial);
    Android := GetAndroidVersion(DeviceSerial);
    LblDeviceStatus.Caption := '✅  Device detected!';
    LblDeviceStatus.Font.Color := $0040AA40;
    LblDeviceModel.Caption  := Model + '  (Android ' + Android + ')  –  ' + DeviceSerial;
    LblDeviceModel.Font.Color := $0040AA40;
    WizardForm.NextButton.Enabled := True;
  end
  else
  begin
    LblDeviceStatus.Caption    := '❌  No device found. Connect your phone and enable USB Debugging.';
    LblDeviceStatus.Font.Color := $000055CC;
    LblDeviceModel.Caption     := '';
    WizardForm.NextButton.Enabled := False;
  end;
  BtnRefresh.Enabled := True;
end;

procedure CreateDeviceCheckPage;
var
  Lbl : TLabel;
begin
  PageDeviceCheck := CreateCustomPage(wpWelcome,
    'Connect Your Android Device',
    'Plug in your phone before continuing.'
  );

  // How-to instructions label
  Lbl := TLabel.Create(PageDeviceCheck);
  Lbl.Parent  := PageDeviceCheck.Surface;
  Lbl.Caption :=
    'HOW TO ENABLE USB DEBUGGING:'#13#10 +
    ''#13#10 +
    '  1.  Settings → About Phone → tap "Build Number" 7 times'#13#10 +
    '  2.  Settings → Developer Options → enable "USB Debugging"'#13#10 +
    '  3.  Connect your phone via USB cable'#13#10 +
    '  4.  On your phone: tap "ALLOW" on the USB Debugging prompt';
  Lbl.SetBounds(0, 0, PageDeviceCheck.SurfaceWidth, 110);
  Lbl.WordWrap := True;

  // Separator line
  Lbl := TLabel.Create(PageDeviceCheck);
  Lbl.Parent  := PageDeviceCheck.Surface;
  Lbl.Caption := '──────────────────────────────────────────────';
  Lbl.SetBounds(0, 118, PageDeviceCheck.SurfaceWidth, 16);
  Lbl.Font.Color := clGrayText;

  // Device status
  LblDeviceStatus := TLabel.Create(PageDeviceCheck);
  LblDeviceStatus.Parent   := PageDeviceCheck.Surface;
  LblDeviceStatus.Caption  := 'Click "Refresh" to scan for your device...';
  LblDeviceStatus.Font.Style := [fsBold];
  LblDeviceStatus.SetBounds(0, 142, PageDeviceCheck.SurfaceWidth, 22);

  LblDeviceModel := TLabel.Create(PageDeviceCheck);
  LblDeviceModel.Parent  := PageDeviceCheck.Surface;
  LblDeviceModel.Caption := '';
  LblDeviceModel.SetBounds(0, 166, PageDeviceCheck.SurfaceWidth, 20);

  // Refresh button
  BtnRefresh := TButton.Create(PageDeviceCheck);
  BtnRefresh.Parent   := PageDeviceCheck.Surface;
  BtnRefresh.Caption  := '🔄  Refresh Device Status';
  BtnRefresh.SetBounds(0, 196, 210, 30);
  BtnRefresh.OnClick  := @DoRefreshDevice;

  // APK warning (shown if APK is a placeholder)
  LblApkWarning := TLabel.Create(PageDeviceCheck);
  LblApkWarning.Parent    := PageDeviceCheck.Surface;
  LblApkWarning.WordWrap  := True;
  LblApkWarning.Caption   := '';
  LblApkWarning.Font.Color := $000055CC;
  LblApkWarning.SetBounds(0, 240, PageDeviceCheck.SurfaceWidth, 50);

  // Start with Next disabled until device is found
  WizardForm.NextButton.Enabled := False;
end;

// Post-install instructions page
procedure CreatePostInstallPage;
var Lbl : TLabel;
begin
  PagePostInstall := CreateCustomPage(
    PageDeviceCheck.ID,
    'Final Steps on Your Phone',
    'Complete these steps to fully activate StrictFocus.'
  );

  Lbl := TLabel.Create(PagePostInstall);
  Lbl.Parent   := PagePostInstall.Surface;
  Lbl.WordWrap := True;
  Lbl.Caption  :=
    'Open StrictFocus on your Android phone and:'#13#10#13#10 +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'#13#10 +
    ''#13#10 +
    'STEP 1 — Grant Device Administrator'#13#10 +
    '  Tap "Grant" when prompted.'#13#10 +
    '  Prevents the app from being uninstalled during sessions.'#13#10 +
    ''#13#10 +
    'STEP 2 — Enable Accessibility Service'#13#10 +
    '  Tap "Grant →" next to Accessibility Service in the app.'#13#10 +
    '  Find "StrictFocus Anti-Bypass Guard" and toggle it ON.'#13#10 +
    '  This blocks the Settings/VPN bypass.'#13#10 +
    ''#13#10 +
    'STEP 3 — Start Focusing!'#13#10 +
    '  Add whitelisted domains → set timer → tap Start!'#13#10 +
    ''#13#10 +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  Lbl.SetBounds(0, 0, PagePostInstall.SurfaceWidth, 330);
end;

// ============================================================
// INNO SETUP EVENTS
// ============================================================
procedure InitializeWizard;
begin
  AdbPath  := ExpandConstant('{app}\adb\adb.exe');
  ApkIsReal := False;
  DeviceFound := False;
  DeviceSerial := '';

  CreateDeviceCheckPage;
  CreatePostInstallPage;
end;

// Re-enable Next button between pages where we disabled it
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PageDeviceCheck.ID then
  begin
    // Next is only enabled once a device is found
    WizardForm.NextButton.Enabled := DeviceFound;
  end
  else
    WizardForm.NextButton.Enabled := True;
end;

// Block Next on device page if no device
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PageDeviceCheck.ID then
  begin
    if not DeviceFound then
    begin
      MsgBox(
        'No Android device detected.'#13#10#13#10 +
        'Please:'#13#10 +
        '  1. Connect phone via USB'#13#10 +
        '  2. Enable USB Debugging (Settings → Developer Options)'#13#10 +
        '  3. Tap "Allow" on your phone'#13#10 +
        '  4. Click Refresh Device Status'#13#10 +
        '  5. Then click Next',
        mbError, MB_OK
      );
      Result := False;
    end;
  end;
end;

// After files are installed, run ADB install
procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode  : Integer;
  ApkPath   : String;
  FileSize  : Int64;
begin
  if CurStep = ssPostInstall then
  begin
    // Now ADB is at its final path
    AdbPath := ExpandConstant('{app}\adb\adb.exe');

    // Check if APK is a real file (> 1 KB) or placeholder
    ApkPath  := ExpandConstant('{app}\apk\{#ApkName}');
    FileSize := 0;
    if FileExists(ApkPath) then
    begin
      // GetFileSize in Pascal Script
      var F : File;
      AssignFile(F, ApkPath);
      Reset(F, 1);
      FileSize := FileSize(F);
      CloseFile(F);
    end;

    if FileSize < 1000 then
    begin
      // APK is a placeholder — installer was built before APK was ready
      MsgBox(
        '⚠️  The StrictFocus APK is not included in this installer build.'#13#10#13#10 +
        'To install the app on your phone:'#13#10#13#10 +
        '  1. Build the APK from Android Studio'#13#10 +
        '  2. Run the following command:'#13#10 +
        '     ' + AdbPath + ' install app-debug.apk'#13#10#13#10 +
        'ADB has been installed to:'#13#10 +
        '  ' + ExpandConstant('{app}\adb\'),
        mbInformation, MB_OK
      );
      Exit;
    end;

    // Re-verify device is still connected
    DeviceSerial := GetFirstDevice();
    if DeviceSerial = '' then
    begin
      MsgBox(
        'Your device was disconnected during installation.'#13#10 +
        'Reconnect your phone and run the installer again.',
        mbError, MB_OK
      );
      Exit;
    end;

    // Install APK
    ExitCode := InstallApk(DeviceSerial);

    if ExitCode = 0 then
    begin
      // Launch app after install
      LaunchApp(DeviceSerial);
      MsgBox(
        '✅ StrictFocus installed successfully on:'#13#10 +
        '   ' + GetDeviceModel(DeviceSerial) + '  (' + DeviceSerial + ')'#13#10#13#10 +
        'The app has been launched on your phone.'#13#10 +
        'Complete the setup steps shown on the next screen.',
        mbInformation, MB_OK
      );
    end
    else
    begin
      MsgBox(
        '❌ APK installation failed (code: ' + IntToStr(ExitCode) + ')'#13#10#13#10 +
        'Try manually:'#13#10 +
        '  ' + AdbPath + ' install -r "' + ApkPath + '"'#13#10#13#10 +
        'Common fixes:'#13#10 +
        '  • Unlock your phone screen before running'#13#10 +
        '  • Allow "Install unknown apps" in your phone settings'#13#10 +
        '  • Try a different USB cable',
        mbError, MB_OK
      );
    end;
  end;
end;

// Offer to uninstall from device on uninstall
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Out  : AnsiString;
  Code : Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    AdbPath  := ExpandConstant('{app}\adb\adb.exe');
    DeviceSerial := GetFirstDevice();
    if (DeviceSerial <> '') and
       (MsgBox('Remove StrictFocus from your connected Android device too?',
               mbConfirmation, MB_YESNO) = IDYES) then
    begin
      Code := CaptureExec(
        AdbPath,
        '-s ' + DeviceSerial + ' uninstall {#PackageName}',
        ExtractFileDir(AdbPath), Out
      );
      if Code = 0 then
        MsgBox('StrictFocus removed from device.', mbInformation, MB_OK)
      else
        MsgBox('Could not remove automatically. Uninstall manually from phone Settings.',
               mbInformation, MB_OK);
    end;
  end;
end;
