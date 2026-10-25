; Relay Agent 安装器钩子（Tauri NSIS，由 bundle.windows.nsis.installerHooks 引入）。
; 纪律：安装/卸载只动程序文件、快捷方式与注册表卸载项；不产生任何业务事实，
; 不碰数据库与用户数据目录（除非用户在卸载页显式勾选「删除应用数据」）。
; 静默模式（/S）不弹任何窗口：失败用 SetErrorLevel + Abort。

!macro NSIS_HOOK_PREINSTALL
  ; 1) 系统版本：Relay Agent 依赖 WebView2 与现代文件 API，要求 Windows 10 及以上。
  ;    CurrentMajorVersionNumber 在 Win10+ 才存在；旧系统读到 0，按不支持处理。
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentMajorVersionNumber"
  ${If} $0 < 10
    ${If} ${Silent}
      SetErrorLevel 2
    ${Else}
      MessageBox MB_ICONSTOP "Relay Agent 需要 Windows 10 或更高版本。当前系统版本不受支持，安装已取消。"
    ${EndIf}
    Abort
  ${EndIf}
  ; 2) 架构：只发布 x64 包；32 位系统明确拒绝而不是装到一半失败。
  ${IfNot} ${RunningX64}
    ${If} ${Silent}
      SetErrorLevel 3
    ${Else}
      MessageBox MB_ICONSTOP "Relay Agent 仅支持 64 位 Windows。当前系统架构不受支持，安装已取消。"
    ${EndIf}
    Abort
  ${EndIf}
  ; 3) 已有安装（原地升级）：先走随包维护会话停掉受管进程并取得停止证明，再覆盖文件。
  ;    hold-desktop-stop 只做进程停止与单实例守卫持有，不读数据库、不调用模型。
  ;    本钩子在模板的 CheckIfAppIsRunning（按 EXE 名结束进程）之前执行，因此正常路径
  ;    不会走到按名强杀；维护会话失败即中止，绝不带着运行中的进程覆盖程序文件。
  ${If} ${FileExists} "$INSTDIR\relay-desktop.exe"
  ${AndIf} ${FileExists} "$INSTDIR\api\dist\src\cli\maintenance.js"
    nsExec::ExecToStack 'cmd /c ""$INSTDIR\node.exe" "$INSTDIR\api\dist\src\cli\maintenance.js" hold-desktop-stop --package-root "$INSTDIR" --data-root "$APPDATA\dev.relay.agent\data" < nul"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      ${If} ${Silent}
        SetErrorLevel 4
      ${Else}
        MessageBox MB_ICONSTOP "无法停止正在运行的 Relay Agent（维护会话退出码 $0）。$\r$\n请先关闭应用后重新运行安装程序。$\r$\n$\r$\n$1"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 数据删除的显式选择由模板卸载页的「删除应用数据」复选框承担（默认不勾＝保留，
  ; 静默卸载不执行该页＝保留，更新模式 $UpdateMode=1 也不会删）。这里只加一道安全网：
  ; 若数据目录本身是重解析点（junction/符号链接），清掉勾选状态，避免模板的
  ; RmDir /r 穿透链接删到别处。
  ; 卸载不结束任何进程：模板的 CheckIfAppIsRunning 只按本应用 EXE 名处理，
  ; 不做 taskkill 全量清理，避免误杀其他会话或用户的 PostgreSQL。
  ${If} $DeleteAppDataCheckboxState = 1
    System::Call 'kernel32::GetFileAttributes(t "$APPDATA\dev.relay.agent")i .r2'
    ${If} $2 != -1
      IntOp $3 $2 & 0x400
      ${If} $3 != 0
        StrCpy $DeleteAppDataCheckboxState 0
        ${IfNot} ${Silent}
          MessageBox MB_ICONEXCLAMATION "检测到数据目录是链接或无法确认类型，已取消「删除应用数据」以保护您的文件。$\r$\n路径：$APPDATA\dev.relay.agent"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载后不写任何业务数据。
!macroend
