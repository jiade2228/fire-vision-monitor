[Unit]
Description=Fire Vision - 火焰/烟雾视频识别监控平台
Documentation=file:///opt/fire-vision/README-QUICKSTART.txt
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fire-vision
Group=fire-vision
WorkingDirectory={{INSTALL_DIR}}
# 配置由安装包落在 /etc/fire-vision/fire-vision.env；环境变量优先级更高。
ExecStart={{INSTALL_DIR}}/program/node {{INSTALL_DIR}}/program/server/boot.mjs --port {{PORT}} --config /etc/fire-vision/fire-vision.env
Restart=always
RestartSec=5
# 多路 HLS + SSE + 录像并发会占用较多描述符，默认 1024 偏低
LimitNOFILE=4096
# 基础加固：禁止提权、只读系统目录，仅放行数据与日志
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths={{DATA_DIR}} {{INSTALL_DIR}}/logs

[Install]
WantedBy=multi-user.target
