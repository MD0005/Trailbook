; Installer of the Windows app (Inno Setup 6); built by windows/build.py.
; Per user, no administrator rights: an update from inside the app installs without a prompt.
; The data (%LOCALAPPDATA%\Trailbook) is not part of the install: updates keep it; uninstalling
; asks whether to delete it too (default No, so a reinstall finds it again).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F1C2B3E-8D0A-4C55-9E2B-7A1D4F0C9B21}
AppName=Trailbook
AppVersion={#AppVersion}
AppVerName=Trailbook {#AppVersion}
AppPublisher=Trailbook
AppPublisherURL=https://github.com/MD0005/Trailbook
DefaultDirName={localappdata}\Programs\Trailbook
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName=Trailbook
PrivilegesRequired=lowest
OutputBaseFilename=Trailbook-Setup-{#AppVersion}
SetupIconFile=out\trailbook.ico
UninstallDisplayIcon={app}\Trailbook.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "pl"; MessagesFile: "compiler:Languages\Polish.isl"

[CustomMessages]
en.StartWithWindows=Start Trailbook when Windows starts (imports and downloads keep running)
pl.StartWithWindows=Uruchamiaj Trailbook razem z Windows (import i pobieranie działają dalej)
en.LaunchNow=Start Trailbook
pl.LaunchNow=Uruchom Trailbook
en.DeleteData=Also delete your Trailbook data (activities, files, settings) from this computer?%n%n%1%n%nThis cannot be undone. Choose No to keep it for a later install.
pl.DeleteData=Usunąć też dane Trailbook (aktywności, pliki, ustawienia) z tego komputera?%n%n%1%n%nTego nie da się cofnąć. Wybierz Nie, aby zachować je na później.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startup"; Description: "{cm:StartWithWindows}"; Flags: unchecked

[Files]
Source: "out\dist\Trailbook\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; files of the previous version that this one no longer has
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{group}\Trailbook"; Filename: "{app}\Trailbook.exe"
Name: "{group}\{cm:UninstallProgram,Trailbook}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Trailbook"; Filename: "{app}\Trailbook.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Trailbook"; ValueData: """{app}\Trailbook.exe"" --background"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\Trailbook.exe"; Description: "{cm:LaunchNow}"; Flags: nowait postinstall skipifsilent
; after an update from inside the app (silent): start again without a new browser tab
Filename: "{app}\Trailbook.exe"; Parameters: "--background"; Flags: nowait; Check: WizardSilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM Trailbook.exe"; Flags: runhidden; RunOnceId: "StopTrailbook"

[Code]
// After the program is removed (Trailbook.exe already stopped by [UninstallRun]): ask whether
// the data goes too. Not asked in a silent uninstall; the answer defaults to No.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  Data := ExpandConstant('{localappdata}\Trailbook');
  if UninstallSilent or not DirExists(Data) then Exit;
  if MsgBox(FmtMessage(CustomMessage('DeleteData'), [Data]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    DelTree(Data, True, True, True);
end;
