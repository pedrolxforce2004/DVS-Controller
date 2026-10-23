!macro customInit
  DetailPrint "Preparando atualização dos serviços DVS..."
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop DVSControllerService'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { $$svc = Get-Service DVSControllerService -ErrorAction SilentlyContinue; if ($$svc) { $$svc.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(60)) }; exit 0 } catch { exit 1 }"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "O servico DVS nao parou com seguranca. Atualizacao cancelada antes de substituir arquivos."
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop DVSControllerPostgreSQL'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { $$svc = Get-Service DVSControllerPostgreSQL -ErrorAction SilentlyContinue; if ($$svc) { $$svc.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(60)) }; exit 0 } catch { exit 1 }"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "O PostgreSQL do DVS nao parou com seguranca. Atualizacao cancelada antes de substituir arquivos."
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "DVS Controller.exe"'
  Pop $0
!macroend

!macro customInstall
  DetailPrint "Configurando PostgreSQL e serviços DVS..."
  SetShellVarContext all
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("ELECTRON_RUN_AS_NODE", "1").r1'
  Delete "$TEMP\DVS-Controller-Setup.log"
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("DVS_INSTALL_LOG", "$TEMP\DVS-Controller-Setup.log").r1'
  nsExec::ExecToLog '"$INSTDIR\DVS Controller.exe" "$INSTDIR\resources\app.asar\installer\setup.js" install "$INSTDIR" "$APPDATA\DVS Controller" "$INSTDIR\resources\postgresql"'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t, i)i ("ELECTRON_RUN_AS_NODE", 0).r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, i)i ("DVS_INSTALL_LOG", 0).r1'
  ${If} $0 != 0
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP "Não foi possível configurar os serviços do DVS Controller (código $0). Log: $TEMP\DVS-Controller-Setup.log"
    ${EndIf}
    Abort
  ${EndIf}
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "DVS Controller Manager" '"$INSTDIR\DVS Controller.exe"'
  ${IfNot} ${Silent}
    ExecShell "open" "$INSTDIR\DVS Controller.exe"
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removendo serviços DVS..."
  SetShellVarContext all
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("ELECTRON_RUN_AS_NODE", "1").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("DVS_INSTALL_LOG", "$TEMP\DVS-Controller-Setup.log").r1'
  nsExec::ExecToLog '"$INSTDIR\DVS Controller.exe" "$INSTDIR\resources\app.asar\installer\setup.js" uninstall "$INSTDIR" "$APPDATA\DVS Controller" "$INSTDIR\resources\postgresql"'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t, i)i ("ELECTRON_RUN_AS_NODE", 0).r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, i)i ("DVS_INSTALL_LOG", 0).r1'
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "DVS Controller Manager"
!macroend
