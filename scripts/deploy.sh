#!/usr/bin/env bash
#
# 火情视频识别监控平台 —— 一键部署 / 升级脚本（Linux / macOS）。
#
# 与 scripts/deploy.ps1 保持相同的步骤与退出码：
#   0 成功；1 前置检查失败；2 备份失败；3 依赖/构建/测试失败；4 重启失败；5 健康检查失败
#
# 用法：
#   ./scripts/deploy.sh                     # 完整部署（备份+安装+构建+测试+重启+健康检查）
#   ./scripts/deploy.sh --dry-run           # 只做前置检查
#   ./scripts/deploy.sh --no-restart        # 只准备，不重启
#   ./scripts/deploy.sh --skip-install      # 离线环境（node_modules 已就绪）
#   ./scripts/deploy.sh --data-dir /var/fire/data --port 4173
#
# 注意：Linux 上推荐用 systemd 管理进程；本脚本检测到 systemd 单元时会
# 用 systemctl restart，否则直接后台拉起（日志落 data/server.out.log）。
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR=""
PORT=4173
SKIP_BACKUP=0
SKIP_INSTALL=0
SKIP_BUILD=0
SKIP_TESTS=0
NO_RESTART=0
DRY_RUN=0
SERVICE_NAME="${SERVICE_NAME:-fire-monitor}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DATA_DIR" ]]; then
  DATA_DIR="$ROOT/data"
elif [[ "$DATA_DIR" != /* ]]; then
  DATA_DIR="$ROOT/$DATA_DIR"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/deploy-$STAMP.log"
DB_FILE="$DATA_DIR/app.db"
BACKUP_DIR="$DATA_DIR/backups"
INSTANCE_LOCK="$DATA_DIR/instance.lock"
BACKUP_PATH=""
STEP=0

log() {
  local level="$1"; shift
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') [$level] $*"
  case "$level" in
    ERROR) printf '\033[31m%s\033[0m\n' "$line" ;;
    WARN)  printf '\033[33m%s\033[0m\n' "$line" ;;
    OK)    printf '\033[32m%s\033[0m\n' "$line" ;;
    *)     printf '%s\n' "$line" ;;
  esac
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
}

step() {
  STEP=$((STEP + 1))
  printf '\n\033[36m===== 步骤 %d：%s =====\033[0m\n' "$STEP" "$1"
  log INFO "步骤 $STEP 开始：$1"
}

fail() {
  local code="$1"; shift
  local message="$1"; shift
  log ERROR "$message"
  for hint in "$@"; do log WARN "  -> $hint"; done
  printf '\n\033[31m部署失败（退出码 %s）。日志：%s\033[0m\n' "$code" "$LOG_FILE" >&2
  exit "$code"
}

run() {
  log INFO "执行：$*"
  if ! "$@" >>"$LOG_FILE" 2>&1; then
    return 1
  fi
  return 0
}

printf '\033[36m火情视频识别监控平台 · 一键部署（Linux）\033[0m\n'
printf '仓库目录 : %s\n数据目录 : %s\n服务端口 : %s\n模式     : %s\n' \
  "$ROOT" "$DATA_DIR" "$PORT" "$([[ $DRY_RUN -eq 1 ]] && echo '预演（只检查）' || echo '正式执行')"
log INFO "部署开始 root=$ROOT dataDir=$DATA_DIR port=$PORT dryRun=$DRY_RUN"

# ---------- 1. 前置检查 ----------
step "前置检查"

for required in package.json server/boot.mjs server/index.mjs vite.config.ts; do
  [[ -e "$ROOT/$required" ]] || fail 1 "仓库结构不完整，缺少 $required" "请在项目根目录运行" "确认代码已完整拉取"
done
log OK "仓库结构检查通过"

command -v node >/dev/null 2>&1 || fail 1 "未找到 node，请先安装 Node.js 22 LTS" "https://nodejs.org/"
NODE_VERSION="$(node -v | sed 's/^v//')"
node -e 'const v=process.versions.node.split(".").map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)' \
  || fail 1 "Node 版本过低：$NODE_VERSION，需要 >= 22.5.0（node:sqlite）" "升级到 Node 22 LTS"
log OK "Node $NODE_VERSION"

command -v npm >/dev/null 2>&1 || fail 1 "未找到 npm"
log OK "npm $(npm -v)"

if command -v ffmpeg >/dev/null 2>&1; then log OK "FFmpeg 可用"; else log WARN "未找到 FFmpeg：RTSP 转码/录像/抓拍不可用"; fi
if command -v ffprobe >/dev/null 2>&1; then log OK "ffprobe 可用"; else log WARN "未找到 ffprobe：测流与段时长校准不可用"; fi

mkdir -p "$DATA_DIR" || fail 1 "无法创建数据目录：$DATA_DIR" "检查目录权限"
probe="$DATA_DIR/.deploy-probe-$STAMP"
( : > "$probe" ) 2>/dev/null || fail 1 "数据目录不可写：$DATA_DIR" "检查目录权限/挂载状态"
rm -f "$probe"
log OK "数据目录可写：$DATA_DIR"

FREE_MB="$(df -Pm "$DATA_DIR" | awk 'NR==2 {print $4}')"
if [[ -n "$FREE_MB" && "$FREE_MB" -lt 500 ]]; then
  fail 1 "磁盘剩余空间不足：${FREE_MB}MB（至少 500MB）" "清理磁盘或更换 --data-dir"
fi
log OK "磁盘剩余 ${FREE_MB:-未知} MB"

if [[ $DRY_RUN -eq 1 ]]; then
  printf '\n'; log OK "预演完成：前置检查全部通过。去掉 --dry-run 即可正式执行。"; exit 0
fi

# ---------- 2. 数据库备份 ----------
step "数据库备份"
if [[ $SKIP_BACKUP -eq 1 ]]; then
  log WARN "已指定 --skip-backup，跳过备份"
elif [[ ! -f "$DB_FILE" ]]; then
  log WARN "未找到 app.db（首次部署？），跳过备份"
else
  mkdir -p "$BACKUP_DIR"
  BACKUP_PATH="$BACKUP_DIR/deploy-$STAMP.db"
  # 统一走 scripts/db-backup.mjs：内部用 VACUUM INTO（含 WAL 数据）并校验 integrity。
  BACKUP_SCRIPT="$ROOT/scripts/db-backup.mjs"
  [[ -f "$BACKUP_SCRIPT" ]] || fail 2 "缺少备份脚本 scripts/db-backup.mjs" "确认代码完整"
  BACKUP_OUT="$(node "$BACKUP_SCRIPT" --data-dir "$DATA_DIR" --out "$BACKUP_PATH" 2>&1)" \
    || fail 2 "数据库备份失败：$BACKUP_OUT" "确认无进程长期占用数据库" "检查磁盘空间"
  [[ "$BACKUP_OUT" == *'"ok":true'* ]] || fail 2 "备份完整性校验未通过：$BACKUP_OUT" "停止部署，先排查数据库健康"
  log OK "备份完成：$BACKUP_PATH"
  log INFO "备份内容：$BACKUP_OUT"
fi

# ---------- 3. 依赖 ----------
step "安装依赖"
if [[ $SKIP_INSTALL -eq 1 ]]; then
  [[ -d "$ROOT/node_modules" ]] || fail 3 "node_modules 不存在，不能跳过依赖安装"
  log WARN "已指定 --skip-install，跳过依赖安装"
elif [[ -f "$ROOT/package-lock.json" ]]; then
  run npm ci --no-audit --no-fund || fail 3 "npm ci 失败" "检查网络或 npm 镜像" "删除 node_modules 后重试"
  log OK "依赖安装完成（npm ci）"
else
  log WARN "未找到 package-lock.json，退回 npm install"
  run npm install --no-audit --no-fund || fail 3 "npm install 失败" "检查网络或 npm 镜像"
  log OK "依赖安装完成（npm install）"
fi

# ---------- 4. 构建 ----------
step "构建前端"
if [[ $SKIP_BUILD -eq 1 ]]; then
  log WARN "已指定 --skip-build，跳过构建"
else
  run npm run build || fail 3 "构建失败" "本地运行 npm run build 查看报错" "确认 Node >= 22.5"
  log OK "构建完成"
fi

# ---------- 5. 测试 ----------
step "运行测试"
if [[ $SKIP_TESTS -eq 1 ]]; then
  log WARN "已指定 --skip-tests，跳过测试"
else
  run npm test || fail 3 "测试未通过" "查看上方失败用例" "确认环境依赖（ffprobe 等）"
  log OK "测试通过"
fi

# ---------- 6. 重启 ----------
if [[ $NO_RESTART -eq 1 ]]; then
  step "跳过重启"
  log WARN "已指定 --no-restart：代码与产物已就绪，请择机重启"
  printf '\n完成（未重启）。\n'
  exit 0
fi

step "重启服务"
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
  log INFO "检测到 systemd 单元 ${SERVICE_NAME}.service，执行 restart"
  systemctl restart "$SERVICE_NAME" || fail 4 "systemctl restart $SERVICE_NAME 失败" "journalctl -u $SERVICE_NAME -n 50 查看原因"
  log OK "服务已重启（systemd）"
else
  log INFO "未检测到 systemd 单元，使用后台进程方式重启"
  if [[ -f "$INSTANCE_LOCK" ]]; then
    OLD_PID="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid||"")}catch{console.log("")}' "$INSTANCE_LOCK")"
    if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      log INFO "停止实例 PID $OLD_PID"
      kill "$OLD_PID" 2>/dev/null || true
      for _ in $(seq 1 30); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 1; done
      kill -9 "$OLD_PID" 2>/dev/null || true
      log OK "旧实例已停止"
    fi
    rm -f "$INSTANCE_LOCK"
  fi
  # setsid 让进程脱离当前会话；输出重定向便于排查
  setsid node "$ROOT/server/boot.mjs" --port "$PORT" \
    >>"$DATA_DIR/server.out.log" 2>>"$DATA_DIR/server.err.log" < /dev/null &
  log OK "服务已后台启动"
fi

# ---------- 7. 健康校验 ----------
step "健康校验"
HEALTH_URL="http://127.0.0.1:$PORT/healthz"
HEALTHY=0
BODY=""
for _ in $(seq 1 45); do
  BODY="$(curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null || true)"
  if [[ "$BODY" == *'"ok":true'* ]]; then HEALTHY=1; break; fi
  sleep 2
done
if [[ $HEALTHY -ne 1 ]]; then
  [[ -f "$DATA_DIR/server.err.log" ]] && log ERROR "stderr 末尾：$(tail -n 8 "$DATA_DIR/server.err.log" | tr '\n' ' ')"
  fail 5 "健康检查未通过：90 秒内 /healthz 未返回 ok=true" "查看 $DATA_DIR/server.out.log" "查看 $DATA_DIR/server.err.log"
fi
log OK "健康检查通过：$BODY"
[[ "$BODY" == *'"database":true'* ]] || log WARN "数据库状态异常"
[[ "$BODY" == *'"diskOk":true'* ]] || log WARN "磁盘空间不足"

printf '\n\033[32m===== 部署完成 =====\033[0m\n'
printf '服务地址 : http://127.0.0.1:%s\n数据目录 : %s\n' "$PORT" "$DATA_DIR"
[[ -n "$BACKUP_PATH" ]] && printf '本次备份 : %s\n' "$BACKUP_PATH"
printf '部署日志 : %s\n\n' "$LOG_FILE"
printf '\033[33m回滚方法（如需）：\033[0m\n'
printf '  1) 停止服务（systemctl stop %s 或结束 node 进程）\n' "$SERVICE_NAME"
printf '  2) 代码回滚：git checkout <上一个 tag>\n'
printf '  3) 数据回滚：用上面的备份覆盖 app.db（同时删除 app.db-wal / app.db-shm）\n'
log OK "部署成功"
exit 0
