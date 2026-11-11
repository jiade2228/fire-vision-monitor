<#
.SYNOPSIS
  火情视频识别监控平台 —— 一键部署 / 升级脚本（Windows）。

.DESCRIPTION
  按固定顺序执行：前置检查 → 数据库备份 → 安装依赖 → 构建 → 测试 → 重启服务 → 健康校验。
  设计目标：
    1. 可重复执行：每一步都是幂等的，重复跑不会破坏数据或产生重复实例。
    2. 失败可回滚：部署前自动 VACUUM INTO 备份，失败时打印精确回滚步骤。
    3. 错误可诊断：每一步失败都有中文原因与下一步动作，日志落盘 data/deploy-*.log。

.PARAMETER DataDir
  数据目录（默认 <仓库>/data）。须与生产实例一致，否则备份/重启会错位。

.PARAMETER Port
  服务端口（默认 4173）。

.PARAMETER SkipBackup
  跳过数据库备份（仅在确认有外部备份时使用）。

.PARAMETER SkipTests
  跳过 npm test（仅限紧急修复；常规升级不建议）。

.PARAMETER SkipInstall
  跳过依赖安装（离线/内网环境，或确认 node_modules 已就绪时使用）。

.PARAMETER SkipBuild
  跳过前端构建（仅在后端热修且 dist 已是最新时使用）。

.PARAMETER NoRestart
  只做检查/备份/构建，不重启服务（用于预演或维护窗口前准备）。

.PARAMETER DryRun
  只做前置检查并打印将要执行的步骤，不做任何写操作。

.PARAMETER Yes
  跳过交互确认。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -NoRestart -SkipTests

.NOTES
  退出码：0 成功；1 前置检查失败；2 备份失败；3 依赖/构建失败；4 重启失败；5 健康检查失败。
#>
[CmdletBinding()]
param(
  [string]$DataDir = "",
  [int]$Port = 4173,
  [switch]$SkipBackup,
  [switch]$SkipTests,
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$NoRestart,
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

# 控制台按 UTF-8 输出：否则子进程（node/npm）的中文路径与 vite 输出会变成乱码，
# 日志失去可诊断性。写入失败也不影响部署流程。
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # 某些受限宿主不允许改编码，忽略即可。
}

# ---------- 基础路径 ----------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $root "data"
} elseif (-not [System.IO.Path]::IsPathRooted($DataDir)) {
  $DataDir = Join-Path $root $DataDir
}
$DataDir = [System.IO.Path]::GetFullPath($DataDir)

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logDir = Join-Path $DataDir "logs"
$logFile = Join-Path $logDir ("deploy-" + $stamp + ".log")
$instanceLock = Join-Path $DataDir "instance.lock"
$dbFile = Join-Path $DataDir "app.db"
$backupDir = Join-Path $DataDir "backups"

$script:stepNo = 0
$script:backupPath = $null

function Write-Log {
  param([string]$Level, [string]$Message)
  $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
  switch ($Level) {
    'ERROR' { Write-Host $line -ForegroundColor Red }
    'WARN'  { Write-Host $line -ForegroundColor Yellow }
    'OK'    { Write-Host $line -ForegroundColor Green }
    default { Write-Host $line }
  }
  try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch {
    # 日志写入失败不能中断部署
  }
}

function Write-Step {
  param([string]$Title)
  $script:stepNo += 1
  Write-Host ""
  Write-Host ("===== 步骤 {0}：{1} =====" -f $script:stepNo, $Title) -ForegroundColor Cyan
  Write-Log 'INFO' ("步骤 {0} 开始：{1}" -f $script:stepNo, $Title)
}

function Fail {
  param([int]$Code, [string]$Message, [string[]]$Hints = @())
  Write-Log 'ERROR' $Message
  foreach ($hint in $Hints) { Write-Log 'WARN' ("  -> " + $hint) }
  Write-Host ""
  Write-Host ("部署失败（退出码 {0}）。日志：{1}" -f $Code, $logFile) -ForegroundColor Red
  exit $Code
}

function Invoke-Cmd {
  param([string]$Title, [string]$File, [string[]]$Arguments)
  $display = "$File " + ($Arguments -join ' ')
  Write-Log 'INFO' ("执行：" + $display)
  $output = & $File @Arguments 2>&1
  $code = $LASTEXITCODE
  if ($output) {
    $tail = ($output | Select-Object -Last 12) -join [Environment]::NewLine
    Write-Host $tail
    try { Add-Content -Path $logFile -Value $tail -Encoding UTF8 } catch {}
  }
  if ($code -ne 0) { return @{ ok = $false; code = $code } }
  return @{ ok = $true; code = 0 }
}

# ---------- 0. 摘要 ----------
Write-Host "火情视频识别监控平台 · 一键部署" -ForegroundColor Cyan
Write-Host ("仓库目录 : " + $root)
Write-Host ("数据目录 : " + $DataDir)
Write-Host ("服务端口 : " + $Port)
Write-Host ("模式     : " + $(if ($DryRun) { "预演（只检查，不写入）" } else { "正式执行" }))
Write-Log 'INFO' ("部署开始 root=$root dataDir=$DataDir port=$Port dryRun=$DryRun")

# ---------- 1. 前置检查 ----------
Write-Step "前置检查"
if ($DryRun) { Write-Log 'INFO' "预演模式：以下仅检查，不执行写操作" }

# 1.1 目录与关键文件
foreach ($required in @("package.json", "server\boot.mjs", "server\index.mjs", "vite.config.ts")) {
  $full = Join-Path $root $required
  if (-not (Test-Path $full)) {
    Fail 1 ("仓库结构不完整，缺少 " + $required) @("请在项目根目录运行本脚本", "确认已完整拉取代码（git status）")
  }
}
Write-Log 'OK' "仓库结构检查通过"

# 1.2 Node 版本（node:sqlite 需要 >= 22.5）
$nodeVersion = (& node -v) 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersion)) {
  Fail 1 "未找到 node，请先安装 Node.js 22 LTS" @("下载：https://nodejs.org/")
}
$nodeVersion = $nodeVersion.Trim()
$versionCheck = & node -e "const v=process.versions.node.split('.').map(Number); process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)"
if ($LASTEXITCODE -ne 0) {
  Fail 1 ("Node 版本过低：" + $nodeVersion + "，需要 >= 22.5.0（node:sqlite）") @("升级到 Node 22 LTS", "多版本环境：nvm use 22")
}
Write-Log 'OK' ("Node " + $nodeVersion)

# 1.3 npm
$npmVersion = (& npm -v) 2>$null
if ($LASTEXITCODE -ne 0) { Fail 1 "未找到 npm（应随 Node 一起安装）" }
Write-Log 'OK' ("npm " + $npmVersion.Trim())

# 1.4 FFmpeg（缺失不阻断：可先部署，之后补装；但明确告知影响）
$ffmpegPath = if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { "ffmpeg" }
$ffmpegOk = $true
try { & $ffmpegPath -version 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $ffmpegOk = $false } } catch { $ffmpegOk = $false }
$ffprobePath = if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { "ffprobe" }
$ffprobeOk = $true
try { & $ffprobePath -version 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $ffprobeOk = $false } } catch { $ffprobeOk = $false }
if ($ffmpegOk) { Write-Log 'OK' "FFmpeg 可用" } else { Write-Log 'WARN' "未找到 FFmpeg：RTSP 转码/录像/抓拍将不可用（HLS/http 点位仍可播放）" }
if ($ffprobeOk) { Write-Log 'OK' "ffprobe 可用" } else { Write-Log 'WARN' "未找到 ffprobe：一键测流与段时长校准不可用" }

# 1.5 数据目录可写
try {
  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
  $probe = Join-Path $DataDir (".deploy-probe-" + $stamp)
  Set-Content -Path $probe -Value "ok" -Encoding ASCII
  Remove-Item -Path $probe -Force
  Write-Log 'OK' ("数据目录可写：" + $DataDir)
} catch {
  Fail 1 ("数据目录不可写：" + $DataDir) @("检查目录权限（Windows 可用管理员运行一次）", "或改用 -DataDir 指定可写目录")
}

# 1.6 磁盘余量（构建 + 备份需要空间）
try {
  $drive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($DataDir))
  $freeMb = [math]::Round($drive.AvailableFreeSpace / 1MB, 0)
  if ($freeMb -lt 500) {
    Fail 1 ("磁盘剩余空间不足：{0} MB（需要至少 500 MB）" -f $freeMb) @("清理磁盘或调整 -DataDir")
  }
  Write-Log 'OK' ("磁盘剩余 {0} MB" -f $freeMb)
} catch {
  Write-Log 'WARN' "无法读取磁盘余量，跳过该检查"
}

# 1.7 端口占用判定
$ourInstancePid = $null
if (Test-Path $instanceLock) {
  try {
    $lock = Get-Content -Path $instanceLock -Raw | ConvertFrom-Json
    if ($lock.pid) { $ourInstancePid = [int]$lock.pid }
  } catch {
    Write-Log 'WARN' "instance.lock 无法解析，将视为无运行实例"
  }
}
$portBusy = $false
try {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
  if ($conn) { $portBusy = $true }
} catch {
  # Get-NetTCPConnection 在旧系统/权限不足时不可用，降级为 TcpClient 探测
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect("127.0.0.1", $Port)
    $portBusy = $client.Connected
    $client.Close()
  } catch { $portBusy = $false }
}
if ($portBusy) {
  if ($ourInstancePid) {
    Write-Log 'OK' ("端口 {0} 由本项目实例占用（PID {1}），稍后将平滑重启" -f $Port, $ourInstancePid)
  } else {
    Fail 1 ("端口 {0} 已被其它程序占用" -f $Port) @("用 netstat -ano | findstr :$Port 查看占用进程", "或使用 -Port 指定其它端口")
  }
} else {
  Write-Log 'OK' ("端口 {0} 空闲" -f $Port)
}

if ($DryRun) {
  Write-Host ""
  Write-Log 'OK' "预演完成：前置检查全部通过。去掉 -DryRun 即可正式执行。"
  exit 0
}

# ---------- 2. 数据库备份 ----------
Write-Step "数据库备份"
if ($SkipBackup) {
  Write-Log 'WARN' "已指定 -SkipBackup，跳过数据库备份（请确认存在外部备份）"
} elseif (-not (Test-Path $dbFile)) {
  Write-Log 'WARN' "未找到 app.db（首次部署？），跳过备份"
} else {
  if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
  $backupPath = Join-Path $backupDir ("deploy-" + $stamp + ".db")
  # 统一走 scripts/db-backup.mjs：内部用 VACUUM INTO（含 WAL 数据）并校验 integrity。
  # 早期版本把 JS 内联在 here-string 里，引号会被脚本宿主二次解释，已改为独立脚本。
  $backupScript = Join-Path $root "scripts\db-backup.mjs"
  if (-not (Test-Path $backupScript)) {
    Fail 2 "缺少备份脚本 scripts\db-backup.mjs" @("确认代码完整（git status）")
  }
  $result = & node $backupScript --data-dir $DataDir --out $backupPath 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Fail 2 ("数据库备份失败：" + (($result | Select-Object -Last 1) -join ' ')) @("确认没有其它进程长期占用数据库", "检查磁盘空间")
  }
  $info = ($result | Select-Object -Last 1)
  if ($info -notmatch '"ok":true') {
    Fail 2 ("备份完整性校验未通过：" + $info) @("停止部署，先排查数据库健康状态")
  }
  $script:backupPath = $backupPath
  Write-Log 'OK' ("备份完成：" + $backupPath)
  Write-Log 'INFO' ("备份内容：" + $info)
}

# ---------- 3. 安装依赖 ----------
Write-Step "安装依赖"
if ($SkipInstall) {
  Write-Log 'WARN' "已指定 -SkipInstall，跳过依赖安装（请确认 node_modules 完整）"
  if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Fail 3 "node_modules 不存在，不能跳过依赖安装" @("去掉 -SkipInstall 重新执行")
  }
} else {
$lockFile = Join-Path $root "package-lock.json"
if (Test-Path $lockFile) {
  $r = Invoke-Cmd "npm ci" "npm" @("ci", "--no-audit", "--no-fund")
} else {
  Write-Log 'WARN' "未找到 package-lock.json，退回 npm install（依赖版本可能漂移）"
  $r = Invoke-Cmd "npm install" "npm" @("install", "--no-audit", "--no-fund")
}
if (-not $r.ok) {
  Fail 3 ("依赖安装失败（npm 退出码 " + $r.code + "）") @("检查网络或 npm 镜像：npm config set registry https://registry.npmmirror.com", "删除 node_modules 后重试")
}
Write-Log 'OK' "依赖安装完成"
}

# ---------- 4. 构建 ----------
Write-Step "构建前端"
if ($SkipBuild) {
  Write-Log 'WARN' "已指定 -SkipBuild，跳过构建（请确认 dist 与当前代码一致）"
} else {
  $r = Invoke-Cmd "npm run build" "npm" @("run", "build")
  if (-not $r.ok) {
    Fail 3 ("构建失败（退出码 " + $r.code + "）") @("先本地运行 npm run build 查看具体报错", "确认 Node 版本 >= 22.5")
  }
  Write-Log 'OK' "构建完成"
}

# ---------- 5. 测试 ----------
Write-Step "运行测试"
if ($SkipTests) {
  Write-Log 'WARN' "已指定 -SkipTests，跳过测试（不建议用于常规升级）"
} else {
  $r = Invoke-Cmd "npm test" "npm" @("test")
  if (-not $r.ok) {
    Fail 3 ("测试未通过（退出码 " + $r.code + "）") @("查看上方失败用例", "确认不是环境问题（如缺少 ffprobe）")
  }
  Write-Log 'OK' "测试通过"
}

# ---------- 6. 重启服务 ----------
if ($NoRestart) {
  Write-Step "跳过重启"
  Write-Log 'WARN' "已指定 -NoRestart：代码与构建产物已就绪，请择机重启服务使其生效。"
  Write-Host ""
  Write-Host "完成（未重启）。重启命令：" -ForegroundColor Green
  Write-Host ("  node server\boot.mjs --port " + $Port + "   # 或等待守护自动拉起")
  exit 0
}

Write-Step "重启服务"
if ($ourInstancePid) {
  $proc = Get-Process -Id $ourInstancePid -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Log 'INFO' ("停止实例 PID " + $ourInstancePid)
    try {
      Stop-Process -Id $ourInstancePid -Force -ErrorAction Stop
    } catch {
      Fail 4 ("停止旧实例失败：" + $_.Exception.Message) @("以管理员身份重试", "手动结束 node 进程后重跑本脚本")
    }
    # 等待进程真正退出并释放端口
    $waited = 0
    while ($waited -lt 30) {
      if (-not (Get-Process -Id $ourInstancePid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Seconds 1
      $waited += 1
    }
    Write-Log 'OK' "旧实例已停止"
  } else {
    Write-Log 'WARN' "instance.lock 指向的进程已不存在，继续启动新实例"
    Remove-Item -Path $instanceLock -Force -ErrorAction SilentlyContinue
  }
}

# 启动新实例（优先让守护拉起；守护不可用时直接启动）
$watchdog = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'fire-watchdog\.ps1' }
$startedPid = $null
if ($watchdog) {
  Write-Log 'INFO' ("检测到守护进程（PID " + $watchdog.ProcessId + "），等待其自动拉起（最多 90 秒）")
} else {
  Write-Log 'INFO' "未检测到守护进程，直接启动服务"
  $stdoutLog = Join-Path $DataDir "server.out.log"
  $stderrLog = Join-Path $DataDir "server.err.log"
  $proc = Start-Process -FilePath "node" -ArgumentList ("`"server\boot.mjs`" --port " + $Port) -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  $startedPid = $proc.Id
  Write-Log 'OK' ("服务已启动 PID " + $startedPid)
}

# ---------- 7. 健康校验 ----------
Write-Step "健康校验"
$healthUrl = "http://127.0.0.1:" + $Port + "/healthz"
$deadline = (Get-Date).AddSeconds(90)
$healthy = $false
$lastBody = ""
while ((Get-Date) -lt $deadline) {
  try {
    $request = [System.Net.WebRequest]::Create($healthUrl)
    $request.Method = 'GET'
    $request.Timeout = 3000
    $request.Proxy = $null   # 绕开系统代理，避免内网代理导致误判
    $response = $request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $lastBody = $reader.ReadToEnd()
      $reader.Close()
    } finally {
      $response.Close()
    }
    if ($lastBody -match '"ok":true') { $healthy = $true; break }
  } catch {
    # 启动中，继续等待
  }
  Start-Sleep -Seconds 2
}

if (-not $healthy) {
  $errLog = Join-Path $DataDir "server.err.log"
  $hints = @("查看服务日志：" + (Join-Path $DataDir "server.out.log"), "查看错误日志：" + $errLog)
  if (Test-Path $errLog) {
    $tail = (Get-Content $errLog -Tail 8) -join [Environment]::NewLine
    if ($tail) { Write-Log 'ERROR' ("stderr 末尾：`n" + $tail) }
  }
  Fail 5 ("健康检查未通过：90 秒内 /healthz 未返回 ok=true") $hints
}
Write-Log 'OK' ("健康检查通过：" + $lastBody)

# 校验关键子系统状态
try {
  $payload = $lastBody | ConvertFrom-Json
  $issues = @()
  if ($payload.database -ne $true) { $issues += "数据库不可用" }
  if ($payload.ffmpeg -ne $true) { $issues += "FFmpeg 不可用（转码/录像受影响）" }
  if ($payload.diskOk -ne $true) { $issues += "磁盘空间不足" }
  if ($issues.Count -gt 0) {
    Write-Log 'WARN' ("健康检查有告警：" + ($issues -join "；"))
  } else {
    Write-Log 'OK' "数据库 / FFmpeg / 磁盘 均正常"
  }
} catch {
  Write-Log 'WARN' "健康响应解析失败，已跳过子系统校验"
}

# ---------- 8. 汇总 ----------
Write-Host ""
Write-Host "===== 部署完成 =====" -ForegroundColor Green
Write-Host ("服务地址 : http://127.0.0.1:" + $Port)
Write-Host ("数据目录 : " + $DataDir)
if ($script:backupPath) { Write-Host ("本次备份 : " + $script:backupPath) }
Write-Host ("部署日志 : " + $logFile)
Write-Host ""
Write-Host "回滚方法（如需）：" -ForegroundColor Yellow
Write-Host "  1) 停止服务：结束 node 进程（或让守护重启）"
Write-Host "  2) 代码回滚：git checkout <上一个 tag>"
if ($script:backupPath) {
  Write-Host ("  3) 数据回滚：备份 " + $script:backupPath + " 覆盖 " + $dbFile + "（同时删除 app.db-wal / app.db-shm）")
} else {
  Write-Host "  3) 数据回滚：使用 data\backups 下最近的备份"
}
Write-Log 'OK' "部署成功"
exit 0
