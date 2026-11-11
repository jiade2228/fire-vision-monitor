# 火情监控生产守护：健康检查失败才重启，并避免重复拉起实例
# 关键约束：服务必须单实例运行（data/instance.lock + SQLite WAL）。
# 原实现每 12 秒无条件下发 Start-Process，慢启动时会叠加出多个实例，
# 相互竞争数据库锁并触发误导性的「损坏」备份。
$root = "D:\87304\Documents\workbuddy\fire\火情视频识别监控项目-93014924"
$lockFile = Join-Path $root "data\instance.lock"
$healthUrl = "http://127.0.0.1:4173/healthz"
$minBackoff = 15
$maxBackoff = 120
$startGraceSeconds = 45
$logFile = Join-Path $root "data\watchdog.log"

function Write-WatchdogLog([string]$message) {
  try {
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch {
    # Logging must never break the watchdog loop.
  }
}

# 健康探测：必须绕开系统/环境代理，且不依赖特定 PowerShell 版本的参数。
#
# 缺陷背景：本脚本原先用 `Invoke-WebRequest -UseBasicParsing -NoProxy $healthUrl`。
# `-NoProxy` 是 PowerShell 6+ 才引入的参数，本脚本由 `powershell.exe`（5.1）启动，
# 参数绑定直接抛错并被 catch 吞掉 → 健康实例被恒定判为 unhealthy →
# 5 分钟后走「stuck, stopping」分支把好端端的实例强杀（watchdog.log 里出现过
# "instance 25468 stuck for 390s, stopping"）。同时机器上设置了
# HTTP_PROXY=127.0.0.1:9047 且 NO_PROXY 为空，走代理的探测同样不可靠。
#
# 现改为：显式构造 WebRequest 并置 Proxy = $null（直连），不依赖版本特有参数。
function Test-Health {
  param([string]$Url)
  try {
    $request = [System.Net.WebRequest]::Create($Url)
    $request.Method = 'GET'
    $request.Timeout = 5000
    # 直连本机，绕开 HTTP_PROXY / 系统代理。
    $request.Proxy = $null
    $response = $request.GetResponse()
    try {
      return ([int]$response.StatusCode -eq 200)
    } finally {
      $response.Close()
    }
  } catch {
    return $false
  }
}

# 只认「确实在跑本项目 server/index.mjs」的进程，避免 pid 复用误判。
function Get-RunningInstance {
  try {
    if (-not (Test-Path $lockFile)) { return $null }
    $lock = Get-Content -Path $lockFile -Raw | ConvertFrom-Json
    $processId = [int]$lock.pid
    if ($processId -le 0) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
    if ($null -eq $proc) { return $null }
    if ($proc.Name -notmatch '^node(\.exe)?$') { return $null }
    if ($proc.CommandLine -notmatch 'server[\\/](index|boot)\.mjs') { return $null }
    return $proc
  } catch {
    return $null
  }
}

$backoff = $minBackoff
$unhealthySince = $null
# 连续启动失败计数：服务若「启动即崩」（如数据库损坏、配置错误、端口冲突），
# 原实现只 foreach 45s 重拉一次，形成无限重启循环且日志里看不出根因。
# 达到阈值后进入长退避（10 分钟）并写醒目的 FATAL 行 + 标记文件，等待人工介入；
# 一旦恢复健康则清零并删除标记。
$startFailures = 0
$maxStartFailures = 5
$fatalBackoff = 600
$failureMarker = Join-Path $root "data\startup-failed.marker"
$stdoutLog = Join-Path $root "data\server.out.log"
$stderrLog = Join-Path $root "data\server.err.log"
Write-WatchdogLog "watchdog started (pid=$PID)"

while ($true) {
  $healthy = Test-Health -Url $healthUrl

  if ($healthy) {
    if ($null -ne $unhealthySince) {
      Write-WatchdogLog "healthy again, backoff reset"
    }
    if ($startFailures -gt 0) {
      Write-WatchdogLog ("recovered after {0} consecutive start failure(s)" -f $startFailures)
      Remove-Item -Path $failureMarker -Force -ErrorAction SilentlyContinue
    }
    $startFailures = 0
    $backoff = $minBackoff
    $unhealthySince = $null
    Start-Sleep -Seconds 30
    continue
  }

  if ($null -eq $unhealthySince) { $unhealthySince = Get-Date }

  $running = Get-RunningInstance
  if ($null -ne $running) {
    # 已有实例：可能仍在启动或暂时繁忙。给它时间，不重复拉起。
    $elapsed = ((Get-Date) - $unhealthySince).TotalSeconds
    if ($elapsed -lt 300) {
      Write-WatchdogLog ("unhealthy but instance {0} is alive; wait {1}s" -f $running.ProcessId, $backoff)
      Start-Sleep -Seconds $backoff
      $backoff = [Math]::Min($backoff * 2, $maxBackoff)
      continue
    }
    # 5 分钟仍不健康：判定卡死，显式终止后再由下一轮拉起。
    Write-WatchdogLog ("instance {0} stuck for {1:N0}s, stopping" -f $running.ProcessId, $elapsed)
    try {
      Stop-Process -Id $running.ProcessId -Force -ErrorAction Stop
      Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
    } catch {
      Write-WatchdogLog ("stop failed: {0}" -f $_.Exception.Message)
    }
    $unhealthySince = $null
    $backoff = $minBackoff
    Start-Sleep -Seconds 5
    continue
  }

  # 无实例：拉起一个，然后给足启动窗口，避免紧接着又拉第二个。
  if ($startFailures -ge $maxStartFailures) {
    if (-not (Test-Path $failureMarker)) {
      Write-WatchdogLog ("FATAL: {0} consecutive start failures; entering {1}s backoff. 请查看 {2} 并修复后删除 {3} 以恢复正常重启。" -f $startFailures, $fatalBackoff, $stderrLog, $failureMarker)
      try {
        Set-Content -Path $failureMarker -Value ("watchdog gave up at {0}; consecutive failures={1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $startFailures) -Encoding UTF8
      } catch {
        # 标记文件写不了也不影响长退避逻辑。
      }
    }
    Start-Sleep -Seconds $fatalBackoff
    # 长退避后仍尝试一次，保留「人工修好后自动恢复」的可能性。
    $startFailures = $maxStartFailures - 1
    continue
  }

  Write-WatchdogLog "no live instance, starting service"
  $startedAt = Get-Date
  try {
    # 把 stdout/stderr 落盘：启动即崩时，watchdog.log 只有 "starting service"，
    # 真正的错误（如 startup_failed: file is not a database）在子进程输出里。
    Start-Process -FilePath "node" -ArgumentList "`"$root\server\boot.mjs`" --port 4173" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  } catch {
    Write-WatchdogLog ("start failed: {0}" -f $_.Exception.Message)
  }
  Start-Sleep -Seconds $startGraceSeconds
  # 启动窗口结束后仍未健康且无存活实例 → 记一次启动失败。
  if (-not (Test-Health -Url $healthUrl) -and $null -eq (Get-RunningInstance)) {
    $startFailures += 1
    Write-WatchdogLog ("start attempt failed ({0}/{1}); see {2}" -f $startFailures, $maxStartFailures, $stderrLog)
  }
}