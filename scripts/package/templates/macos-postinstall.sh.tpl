#!/bin/sh
# Fire Vision macOS 安装后脚本（pkg postinstall，以 root 运行）。
#
# 职责：修正权限、准备日志目录、注册 LaunchDaemon 并启动。
# 注意：本脚本在未签名的 pkg 上同样会执行；Gatekeeper 拦截发生在更早阶段，
#       正式分发必须对 pkg 签名并公证（见 docs/DISTRIBUTION-PLAN.md P3）。
set -e

INSTALL_DIR="{{INSTALL_DIR}}"
DATA_DIR="{{DATA_DIR}}"
LABEL="{{LABEL}}"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
PORT="{{PORT}}"

# 1) 目录与权限：程序只读，数据与日志可写
mkdir -p "$DATA_DIR" "$INSTALL_DIR/logs"
chown -R root:wheel "$INSTALL_DIR/program" 2>/dev/null || true
chmod -R a+rX "$INSTALL_DIR/program" 2>/dev/null || true
chown -R root:wheel "$DATA_DIR" "$INSTALL_DIR/logs" 2>/dev/null || true

# 2) 首次安装生成配置（升级不覆盖）
CONFIG="$INSTALL_DIR/config/fire-vision.env"
if [ ! -f "$CONFIG" ]; then
  mkdir -p "$INSTALL_DIR/config"
  cat > "$CONFIG" <<'EOF'
# Fire Vision 运行配置（修改后需重启 launchd 任务）
DATA_DIR={{DATA_DIR}}
PORT={{PORT}}
SERVER_DETECTION=1
RECORDING=0
EOF
  chmod 644 "$CONFIG"
fi

# 3) LaunchDaemon：开机启动、异常退出重启、提升文件描述符上限
#    launchd 的 PATH 不含 Homebrew，因此显式给出；FFmpeg 已随包提供。
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/program/node</string>
    <string>${INSTALL_DIR}/program/server/boot.mjs</string>
    <string>--port</string>
    <string>${PORT}</string>
    <string>--config</string>
    <string>${INSTALL_DIR}/config/fire-vision.env</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>4096</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/logs/server.out.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/logs/server.err.log</string>
</dict>
</plist>
EOF

chmod 644 "$PLIST"
chown root:wheel "$PLIST"

# 4) 加载（先卸载旧任务，保证升级后使用新 plist）
launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl bootstrap system "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
launchctl kickstart -k "system/${LABEL}" 2>/dev/null || true

echo "Fire Vision 已安装到 ${INSTALL_DIR}"
echo "数据目录：${DATA_DIR}"
echo "访问地址：http://127.0.0.1:${PORT}"
exit 0
