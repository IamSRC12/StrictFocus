; ============================================================
; StrictFocus Windows Installer  v1.0.0
; Built with Inno Setup 6.x
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
WelcomeLabel2=This wizard installs StrictFocus on your Android device.%n%nBefore continuing, make sure your phone is:%n%n  [1] Connected via USB cable%n  [2] USB Debugging is enabled%n  [3] Screen is unlocked%n%nClick Next to begin.
FinishedHeadingLabel=StrictFocus is Installed!
FinishedLabel=StrictFocus has been installed on your Android device.%n%nCOMPLETE THESE STEPS ON YOUR PHONE:%n%n  1. Open the StrictFocus app%n  2. Tap [Grant] for Device Administrator%n  3. Tap [Grant ->] for Accessibility Service%n  4. Start your first focus session!

[Files]
; --- ADB Binaries (bundled, no Android Studio needed) ---
Source: "adb\adb.exe";             DestDir: "{app}\adb"; Flags: ignoreversion
Source: "adb\AdbWinApi.dll";       DestDir: "{app}\adb"; Flags: ignoreversion
Source: "adb\AdbWinUsbApi.dll";    DestDir: "{app}\adb"; Flags: ignoreversion

; --- StrictFocus APK ---
Source: "apk\{#ApkName}";          DestDir: "{app}\apk"; Flags: ignoreversion

; --- App icon ---
Source: "assets\icon.ico";         DestDir: "{app}\assets"; Flags: ignoreversion

[Icons]
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Code]

// ============================================================
// GLOBAL VARIABLES
// ============================================================
var
  AdbBin          : String;
  ConnectedDevice : String;
  DeviceOK        : Boolean;

  PageDevice      : TWizardPage;
  PageGuide       : TWizardPage;

  LblStatus       : TLabel;
  LblModel        : TLabel;
  BtnScan         : TButton;

// ============================================================
// UTILITY: Execute a command, return stdout as String
// ============================================================
function RunCmd(Exe, Args, WorkDir: String): String;
var
  TmpFile  : String;
  ExitCode : Integer;
  Output   : AnsiString;
begin
  TmpFile := ExpandConstant('{tmp}\sf_output.txt');
  Exec(
    ExpandConstant('{cmd}'),
    '/C ""' + Exe + '" ' + Args + ' >"' + TmpFile + '" 2>&1"',
    WorkDir,
    SW_HIDE,
    ewWaitUntilTerminated,
    ExitCode
  );
  Output := '';
  if FileExists(TmpFile) then
    LoadStringFromFile(TmpFile, Output);
  Result := String(Output);
end;

// ============================================================
// ADB FUNCTIONS
// ============================================================

// Returns the serial of the first connected device, or empty string
function FindDevice: String;
var
  RawOutput : String;
  Lines     : TStringList;
  I         : Integer;
  Line      : String;
  Serial    : String;
begin
  Result := '';
  RawOutput := RunCmd(AdbBin, 'devices', ExtractFileDir(AdbBin));
  Lines := TStringList.Create;
  try
    Lines.Text := RawOutput;
    for I := 1 to Lines.Count - 1 do
    begin
      Line := Trim(Lines[I]);
      if (Length(Line) > 0) and
         (Pos(#9 + 'device', Line) > 0) and
         (Pos('offline', Line) = 0) then
      begin
        // Serial is everything before the tab
        Serial := Copy(Line, 1, Pos(#9, Line + #9) - 1);
        Result := Trim(Serial);
        Break;
      end;
    end;
  finally
    Lines.Free;
  end;
end;

// Returns the model name of the given device serial
function DeviceModel(Serial: String): String;
var
  Raw : String;
begin
  Raw := RunCmd(AdbBin,
                '-s ' + Serial + ' shell getprop ro.product.model',
                ExtractFileDir(AdbBin));
  Result := Trim(Raw);
  if Result = '' then Result := 'Android Device';
end;

// Returns Android version string
function AndroidVer(Serial: String): String;
var
  Raw : String;
begin
  Raw := RunCmd(AdbBin,
                '-s ' + Serial + ' shell getprop ro.build.version.release',
                ExtractFileDir(AdbBin));
  Result := Trim(Raw);
end;

// Installs the APK; returns ADB exit code
function DoInstallApk(Serial: String): Integer;
var
  ApkPath  : String;
  TmpFile  : String;
  ExitCode : Integer;
  Output   : AnsiString;
begin
  ApkPath := ExpandConstant('{app}\apk\{#ApkName}');
  TmpFile := ExpandConstant('{tmp}\sf_install.txt');
  Exec(
    ExpandConstant('{cmd}'),
    '/C ""' + AdbBin + '" -s ' + Serial +
      ' install -r -d "' + ApkPath + '" >"' + TmpFile + '" 2>&1"',
    ExtractFileDir(AdbBin),
    SW_HIDE,
    ewWaitUntilTerminated,
    ExitCode
  );
  Result := ExitCode;
end;

// Launches the app on device
procedure LaunchApp(Serial: String);
begin
  RunCmd(AdbBin,
         '-s ' + Serial +
         ' shell monkey -p {#PackageName} -c android.intent.category.LAUNCHER 1',
         ExtractFileDir(AdbBin));
end;

// ============================================================
// DEVICE PAGE LOGIC
// ============================================================

procedure ScanDevice(Sender: TObject);
var
  Model   : String;
  Android : String;
begin
  BtnScan.Enabled := False;
  LblStatus.Caption := 'Scanning...';
  LblModel.Caption  := '';

  ConnectedDevice := FindDevice();
  DeviceOK := ConnectedDevice <> '';

  if DeviceOK then
  begin
    Model   := DeviceModel(ConnectedDevice);
    Android := AndroidVer(ConnectedDevice);
    LblStatus.Caption    := '[ OK ]  Device found!';
    LblStatus.Font.Color := $0033AA33;
    LblModel.Caption     := Model + '   (Android ' + Android + ')   [' + ConnectedDevice + ']';
    LblModel.Font.Color  := $0033AA33;
    WizardForm.NextButton.Enabled := True;
  end
  else
  begin
    LblStatus.Caption    := '[ X ]  No device detected.';
    LblStatus.Font.Color := $000033BB;
    LblModel.Caption     := 'Connect your phone via USB and enable USB Debugging, then click Refresh.';
    WizardForm.NextButton.Enabled := False;
  end;

  BtnScan.Enabled := True;
end;

// Creates the "Connect Your Android Device" wizard page
procedure BuildDevicePage;
var
  Instr : TLabel;
  Sep   : TLabel;
begin
  PageDevice := CreateCustomPage(
    wpWelcome,
    'Connect Your Android Device',
    'Plug in your phone and enable USB Debugging.'
  );

  // Instructions
  Instr := TLabel.Create(PageDevice);
  Instr.Parent   := PageDevice.Surface;
  Instr.WordWrap := True;
  Instr.Caption  :=
    'HOW TO ENABLE USB DEBUGGING ON YOUR PHONE:' + #13#10 +
    '' + #13#10 +
    '   Step 1 : Settings -> About Phone' + #13#10 +
    '            Tap "Build Number" 7 times to unlock Developer Options' + #13#10 +
    '' + #13#10 +
    '   Step 2 : Settings -> Developer Options' + #13#10 +
    '            Turn on "USB Debugging"' + #13#10 +
    '' + #13#10 +
    '   Step 3 : Connect phone via USB cable' + #13#10 +
    '            Tap "ALLOW" on the USB Debugging prompt on your phone';
  Instr.SetBounds(0, 0, PageDevice.SurfaceWidth, 136);

  // Separator
  Sep := TLabel.Create(PageDevice);
  Sep.Parent    := PageDevice.Surface;
  Sep.Caption   := '-------------------------------------------------------------------';
  Sep.Font.Color := clGrayText;
  Sep.SetBounds(0, 142, PageDevice.SurfaceWidth, 16);

  // Status label
  LblStatus := TLabel.Create(PageDevice);
  LblStatus.Parent     := PageDevice.Surface;
  LblStatus.Caption    := 'Click "Refresh" to detect your phone.';
  LblStatus.Font.Style := [fsBold];
  LblStatus.SetBounds(0, 164, PageDevice.SurfaceWidth, 22);

  // Model label
  LblModel := TLabel.Create(PageDevice);
  LblModel.Parent    := PageDevice.Surface;
  LblModel.Caption   := '';
  LblModel.WordWrap  := True;
  LblModel.SetBounds(0, 190, PageDevice.SurfaceWidth, 36);

  // Refresh button
  BtnScan := TButton.Create(PageDevice);
  BtnScan.Parent   := PageDevice.Surface;
  BtnScan.Caption  := '  Refresh Device Status  ';
  BtnScan.SetBounds(0, 236, 200, 28);
  BtnScan.OnClick  := @ScanDevice;
end;

// Creates the "Final steps on your phone" post-install guide page
procedure BuildGuidePage;
var
  Lbl : TLabel;
begin
  PageGuide := CreateCustomPage(
    PageDevice.ID,
    'Almost Done - Final Setup On Your Phone',
    'Complete these steps on your Android device.'
  );

  Lbl := TLabel.Create(PageGuide);
  Lbl.Parent   := PageGuide.Surface;
  Lbl.WordWrap := True;
  Lbl.Caption  :=
    'Open the StrictFocus app on your phone and complete:' + #13#10 +
    '' + #13#10 +
    '==========================================' + #13#10 +
    '' + #13#10 +
    'STEP 1 - Grant Device Administrator' + #13#10 +
    '  Tap "Grant" on the Device Admin prompt.' + #13#10 +
    '  This prevents the app being uninstalled during sessions.' + #13#10 +
    '' + #13#10 +
    'STEP 2 - Enable Accessibility Service' + #13#10 +
    '  Tap "Grant ->" next to Accessibility Service.' + #13#10 +
    '  Enable "StrictFocus Anti-Bypass Guard" in the list.' + #13#10 +
    '  This blocks navigation to VPN/Settings during sessions.' + #13#10 +
    '' + #13#10 +
    'STEP 3 - Start Your First Focus Session!' + #13#10 +
    '  Add whitelisted domains, set your timer, tap Start.' + #13#10 +
    '' + #13#10 +
    '==========================================';
  Lbl.SetBounds(0, 0, PageGuide.SurfaceWidth, 310);
end;

// ============================================================
// INNO SETUP EVENT HANDLERS
// ============================================================

procedure InitializeWizard;
begin
  AdbBin          := ExpandConstant('{app}\adb\adb.exe');
  ConnectedDevice := '';
  DeviceOK        := False;

  BuildDevicePage;
  BuildGuidePage;

  // Disable Next until device is confirmed
  WizardForm.NextButton.Enabled := False;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PageDevice.ID then
    WizardForm.NextButton.Enabled := DeviceOK
  else
    WizardForm.NextButton.Enabled := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PageDevice.ID then
  begin
    if not DeviceOK then
    begin
      MsgBox(
        'No Android device detected.' + #13#10 + #13#10 +
        'Please:' + #13#10 +
        '  1.  Connect your phone via USB' + #13#10 +
        '  2.  Enable USB Debugging in Developer Options' + #13#10 +
        '  3.  Tap ALLOW on the phone' + #13#10 +
        '  4.  Click "Refresh Device Status"' + #13#10 +
        '  5.  Then click Next',
        mbError, MB_OK
      );
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ApkPath   : String;
  ApkSize   : Int64;
  ExitCode  : Integer;
  Model     : String;
begin
  if CurStep = ssPostInstall then
  begin
    // ADB is now in final location
    AdbBin := ExpandConstant('{app}\adb\adb.exe');

    // Check if APK is real (> 10 KB) or a placeholder
    ApkPath := ExpandConstant('{app}\apk\{#ApkName}');
    ApkSize := 0;
    if FileExists(ApkPath) then
      ApkSize := GetFileSize(ApkPath);

    if ApkSize < 10000 then
    begin
      MsgBox(
        'INFO: This installer was built without the final APK.' + #13#10 + #13#10 +
        'The APK placeholder has been installed. To install the real app,' + #13#10 +
        'build the APK from Android Studio and run:' + #13#10 + #13#10 +
        '"' + AdbBin + '" install -r "C:\path\to\StrictFocus.apk"' + #13#10 + #13#10 +
        'ADB tools are ready at: ' + ExpandConstant('{app}\adb\'),
        mbInformation, MB_OK
      );
      Exit;
    end;

    // Re-verify device is still connected
    ConnectedDevice := FindDevice();
    if ConnectedDevice = '' then
    begin
      MsgBox(
        'Device disconnected during installation.' + #13#10 +
        'Please reconnect and run the installer again.',
        mbError, MB_OK
      );
      Exit;
    end;

    Model    := DeviceModel(ConnectedDevice);
    ExitCode := DoInstallApk(ConnectedDevice);

    if ExitCode = 0 then
    begin
      LaunchApp(ConnectedDevice);
      MsgBox(
        'StrictFocus installed successfully!' + #13#10 + #13#10 +
        'Device: ' + Model + '  [' + ConnectedDevice + ']' + #13#10 + #13#10 +
        'The app has been launched on your phone.' + #13#10 +
        'Complete the setup steps shown on the next screen.',
        mbInformation, MB_OK
      );
    end
    else
    begin
      MsgBox(
        'APK installation failed (ADB exit code: ' + IntToStr(ExitCode) + ')' + #13#10 + #13#10 +
        'Common fixes:' + #13#10 +
        '  - Unlock your phone screen' + #13#10 +
        '  - Allow "Install unknown apps" in phone Settings' + #13#10 +
        '  - Try a different USB cable' + #13#10 + #13#10 +
        'Manual install command:' + #13#10 +
        '"' + AdbBin + '" install -r "' + ApkPath + '"',
        mbError, MB_OK
      );
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ExitCode : Integer;
  TmpFile  : String;
  Output   : AnsiString;
  Serial   : String;
begin
  if CurUninstallStep = usUninstall then
  begin
    AdbBin := ExpandConstant('{app}\adb\adb.exe');
    Serial := FindDevice();
    if (Serial <> '') and
       (MsgBox('Also remove StrictFocus from your connected Android device?',
               mbConfirmation, MB_YESNO) = IDYES) then
    begin
      TmpFile := ExpandConstant('{tmp}\sf_uninstall.txt');
      Exec(
        ExpandConstant('{cmd}'),
        '/C ""' + AdbBin + '" -s ' + Serial +
          ' uninstall {#PackageName} >"' + TmpFile + '" 2>&1"',
        ExtractFileDir(AdbBin),
        SW_HIDE,
        ewWaitUntilTerminated,
        ExitCode
      );
      if ExitCode = 0 then
        MsgBox('StrictFocus removed from device.', mbInformation, MB_OK)
      else
        MsgBox('Automatic removal failed. Uninstall manually from phone Settings.',
               mbInformation, MB_OK);
    end;
  end;
end;
