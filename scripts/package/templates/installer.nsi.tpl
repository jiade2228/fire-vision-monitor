; Fire Vision 安装脚本（NSIS 3.x / Unicode）
; 由 scripts/package/installer.mjs 生成，请勿手工修改生成结果。
;
; 设计说明：
;   - 复用便携包产物（program/ config/ data/ logs/ start.cmd），安装器只做
;     「放置 + 写配置 + 快捷方式 + 卸载信息」，避免两套布局漂移。
;   - 数据目录放在 %LOCALAPPDATA%\FireVision，而不是 Program Files ——
;     后者对普通用户不可写，数据库会直接写失败。
;   - 开机自启用「启动文件夹快捷方式」（当前用户），不需要管理员权限、
;     不依赖 WinSW 等外部二进制；系统级服务请见 docs 说明。

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APP_NAME "Fire Vision"
!define APP_VERSION "{{APP_VERSION}}"
!define APP_PUBLISHER "{{APP_PUBLISHER}}"
!define APP_ARCH "{{APP_ARCH}}"
!define DEFAULT_PORT "{{DEFAULT_PORT}}"
!define DATA_DIR "$LOCALAPPDATA\FireVision"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FireVision"

Name "${APP_NAME} ${APP_VERSION}"

; 版本信息资源：安装包右键「属性 → 详细信息」可见，也便于资产盘点与签名校验。
; VIProductVersion 必须是四段数字（x.x.x.x）。
VIProductVersion "{{APP_VERSION_4}}"
VIAddVersionKey /LANG=2052 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT License"
BrandingText "${APP_NAME} ${APP_VERSION} (${APP_ARCH})"
OutFile "{{OUTFILE}}"
InstallDir "$PROGRAMFILES64\FireVision"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "本向导将安装 ${APP_NAME} ${APP_VERSION}。$\r$\n$\r$\n安装完成后，程序文件位于安装目录，运行数据保存在：$\r$\n${DATA_DIR}$\r$\n$\r$\n卸载时默认保留运行数据，便于重装后继续使用。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\start.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\README-QUICKSTART.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看快速开始说明"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

;--------------------------------------------------------------
; 安装
;--------------------------------------------------------------
Section "核心程序（必需）" SEC_CORE
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; 安装路径过长会导致 Windows MAX_PATH 问题（录像文件还会再拼约 60 字符）
  StrLen $0 "$INSTDIR"
  ${If} $0 > 120
    MessageBox MB_OK|MB_ICONEXCLAMATION "安装路径过长（$0 字符），可能导致录像写入失败。$\r$\n建议改到更短的路径，例如 D:\FireVision。"
  ${EndIf}

  ; 复制便携包全部内容（program/ config/ data/ logs/ start.cmd 等）
  File /r "{{BUNDLE_DIR}}\*.*"

  ; 写运行配置：数据目录指向用户可写位置
  CreateDirectory "$INSTDIR\config"
  FileOpen $0 "$INSTDIR\config\fire-vision.env" w
  FileWrite $0 "# 由安装程序生成；修改后重启服务生效。$\r$\n"
  FileWrite $0 "# 数据目录（数据库、凭据密钥、录像、备份）$\r$\n"
  FileWrite $0 "DATA_DIR=${DATA_DIR}$\r$\n"
  FileWrite $0 "PORT=${DEFAULT_PORT}$\r$\n"
  FileClose $0

  ; 数据目录与日志目录
  CreateDirectory "${DATA_DIR}"
  CreateDirectory "$INSTDIR\logs"

  ; 开始菜单
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\start.cmd" "" "$INSTDIR\program\node.exe" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"

  ; 卸载信息
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\program\node.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  DetailPrint "安装完成。数据目录：${DATA_DIR}"
SectionEnd

Section "开机自动启动（当前用户）" SEC_AUTOSTART
  CreateShortCut "$SMSTARTUP\${APP_NAME}.lnk" "$INSTDIR\start.cmd" "" "$INSTDIR\program\node.exe" 0
  DetailPrint "已添加到启动文件夹：$SMSTARTUP"
SectionEnd

Section "桌面快捷方式" SEC_DESKTOP
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\start.cmd" "" "$INSTDIR\program\node.exe" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "程序文件、运行配置与卸载程序。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_AUTOSTART} "登录 Windows 后自动启动监控服务（当前用户，无需管理员）。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "在桌面创建启动快捷方式。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

;--------------------------------------------------------------
; 卸载
;--------------------------------------------------------------
Section "Uninstall"
  Delete "$SMSTARTUP\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  RMDir /r "$INSTDIR\program"
  RMDir /r "$INSTDIR\config"
  ; logs 保留还是删除：日志对排障有价值，但属于运行产物，默认删除；
  ; 数据目录（数据库/录像）**不在安装目录内**，因此不会被误删。
  RMDir /r "$INSTDIR\logs"
  Delete "$INSTDIR\start.cmd"
  Delete "$INSTDIR\README-QUICKSTART.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "${UNINST_KEY}"

  ; 明确告知数据仍在，避免用户以为"卸载即清空"
  MessageBox MB_OK|MB_ICONINFORMATION "程序已卸载。$\r$\n$\r$\n运行数据仍保留在：$\r$\n${DATA_DIR}$\r$\n$\r$\n如需彻底清除，请手动删除该目录（其中 credentials.key 与 app.db 必须成对处理）。"
SectionEnd
