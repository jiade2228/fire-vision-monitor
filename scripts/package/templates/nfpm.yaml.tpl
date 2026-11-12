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
  # 程序（只读）：必须用 type: tree 递归打包整棵目录（node、server/、dist/、
  # node_modules/、可选 ffmpeg）。
  # 早期写成 type: dir + 单独一条 program/node，结果只创建了空目录，
  # 安装包里仅剩 node 与 3 个文本文件（v1.2.6 P0：deb 12 条目 / rpm 7 条目）。
  # tree 只能指定一个 mode，取 0755 以保证 program/node 可执行；
  # 静态资源因此也带执行位，不影响运行。
  - src: {{BUNDLE_DIR}}/program
    dst: /opt/fire-vision/program
    type: tree
    file_info:
      mode: 0755
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
