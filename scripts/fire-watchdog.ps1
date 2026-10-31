# 火情监控生产守护：健康检查失败即重启实例（登录时由启动文件夹调用）
$root = "D:\87304\Documents\workbuddy\fire\火情视频识别监控项目-93014924"
while ($true) {
  $healthy = $false
  try {
    $r = Invoke-WebRequest -UseBasicParsing -NoProxy "http://127.0.0.1:4173/healthz" -TimeoutSec 5
    $healthy = ($r.StatusCode -eq 200)
  } catch {
    $healthy = $false
  }
  if (-not $healthy) {
    Start-Process -FilePath "node" -ArgumentList "`"$root\server\index.mjs`" --port 4173" -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 12
  } else {
    Start-Sleep -Seconds 30
  }
}