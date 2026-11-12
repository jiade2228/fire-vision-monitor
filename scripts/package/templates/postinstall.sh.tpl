#!/bin/sh
# Fire Vision 安装后脚本（deb/rpm postinstall）。
#
# 职责：创建运行用户、准备数据与配置目录、生成配置模板、注册并启动服务。
# 幂等：重复安装不会覆盖已有配置，也不会因用户已存在而失败。
set -e

INSTALL_DIR="{{INSTALL_DIR}}"
DATA_DIR="{{DATA_DIR}}"
SERVICE_NAME="{{SERVICE_NAME}}"
CONFIG_DIR="/etc/fire-vision"
CONFIG_FILE="$CONFIG_DIR/fire-vision.env"

# 1) 运行用户（系统账户，无登录 shell）
if ! id -u fire-vision >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin fire-vision 2>/dev/null \
    || adduser --system --no-create-home --disabled-login fire-vision 2>/dev/null \
    || true
fi

# 2) 目录与权限
mkdir -p "$DATA_DIR" "$INSTALL_DIR/logs" "$CONFIG_DIR"
chown -R fire-vision:fire-vision "$DATA_DIR" "$INSTALL_DIR/logs" 2>/dev/null || true
# 程序目录保持只读（服务不需要写）
chown -R root:root "$INSTALL_DIR/program" 2>/dev/null || true
chmod -R a+rX "$INSTALL_DIR/program" 2>/dev/null || true

# 3) 配置模板：仅在不存在时创建，升级不覆盖现场修改
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" <<'EOF'
# Fire Vision 运行配置（修改后需 restart 服务）
# 数据目录：数据库、凭据密钥、录像、备份
DATA_DIR={{DATA_DIR}}
PORT={{PORT}}
# 服务端 7x24 检测（0 关闭）
SERVER_DETECTION=1
# 持续录像总闸（1 开启）
RECORDING=0
EOF
  chmod 640 "$CONFIG_FILE"
  chown root:fire-vision "$CONFIG_FILE" 2>/dev/null || true
fi

# 4) systemd
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME" || true
fi

echo "Fire Vision 已安装。"
echo "  程序目录：$INSTALL_DIR"
echo "  数据目录：$DATA_DIR"
echo "  配置文件：$CONFIG_FILE"
echo "  访问地址：http://<服务器IP>:{{PORT}}"
echo "首次访问需创建管理员账号。"
exit 0
