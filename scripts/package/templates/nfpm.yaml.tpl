# nfpm 配置（生成 deb / rpm）
# 由 scripts/package/installer.mjs 生成；打包命令：
#   nfpm package --config nfpm.yaml --packager deb --target out.deb
name: fire-vision
arch: {{APP_ARCH}}
platform: linux
version: {{APP_VERSION}}
section: net
priority: optional
maintainer: {{MAINTAINER}}
vendor: {{MAINTAINER}}
license: MIT
description: |
  火焰/烟雾视频识别监控平台。
  RTSP/ONVIF 接入、7×24 检测、告警抓拍与短视频、多渠道通知、
  多站点隔离、持续录像与回放、审计与趋势看板。
contents:
  # 程序（只读）
  - src: {{BUNDLE_DIR}}/program
    dst: /opt/fire-vision/program
  # 启动器与说明
  - src: {{BUNDLE_DIR}}/start.sh
    dst: /opt/fire-vision/start.sh
    file_info:
      mode: 0755
  - src: {{BUNDLE_DIR}}/README-QUICKSTART.txt
    dst: /opt/fire-vision/README-QUICKSTART.txt
  # 配置模板（实际配置由 postinstall 生成到 /etc/fire-vision）
  - src: {{BUNDLE_DIR}}/config/fire-vision.env.example
    dst: /opt/fire-vision/config/fire-vision.env.example
  # systemd 单元
  - src: {{PROJECT_DIR}}/fire-vision.service
    dst: /lib/systemd/system/fire-vision.service
    file_info:
      mode: 0644
scripts:
  postinstall: {{PROJECT_DIR}}/postinstall.sh
