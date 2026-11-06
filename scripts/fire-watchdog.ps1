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
    if ($proc.CommandLine -notmatch 'server[\\/]index\.mjs') { return $null }
    return $proc
  } catch {
    return $null
  }
}

$backoff = $minBackoff
$unhealthySince = $null
Write-WatchdogLog "watchdog started (pid=$PID)"

while ($true) {
  $healthy = $false
  try {
    $r = Invoke-WebRequest -UseBasicParsing -NoProxy $healthUrl -TimeoutSec 5
    $healthy = ($r.StatusCode -eq 200)
  } catch {
    $healthy = $false
  }

  if ($healthy) {
    if ($null -ne $unhealthySince) {
      Write-WatchdogLog "healthy again, backoff reset"
    }
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
  Write-WatchdogLog "no live instance, starting service"
  try {
    Start-Process -FilePath "node" -ArgumentList "`"$root\server\index.mjs`" --port 4173" -WorkingDirectory $root -WindowStyle Hidden
  } catch {
    Write-WatchdogLog ("start failed: {0}" -f $_.Exception.Message)
  }
  Start-Sleep -Seconds $startGraceSeconds
}