# 推送到 GitHub 完整步骤

> 中文 · [English](#english)
> 适用版本：v1.1.3

本文假设项目就在当前目录，且**已经在本地 git 仓库中**（本项目已有提交历史与 tag）。
如果你的目录还没有 `.git`（例如从压缩包解压），请从 §1 开始；否则直接跳到 §2。

---

## 0. 推送前检查（强烈建议）

```bash
git status                 # 应无未提交改动
git log --oneline -5       # 确认提交历史
git tag -l                 # 确认版本 tag（v1.1.0 / v1.1.1 / v1.1.2 / v1.1.3）
```

**确认敏感内容不会被推送**（`.gitignore` 已覆盖，仍建议核对）：

```bash
git ls-files | grep -E "^data/|\.env$|\.key$|\.secret$" || echo "无敏感文件"
```

必须留在本地、**不要**入库的内容：

| 路径 | 原因 |
|---|---|
| `data/` | 含 SQLite 库、`credentials.key`、`session.secret`、录像与抓拍 |
| `.env` / `.env.*` | 环境变量与密钥 |
| `node_modules/`、`dist/` | 依赖与构建产物（CI 会重建） |
| `test-videos/` | 测试素材体积大，且有独立版权 |

> ⚠️ 如果曾经误提交过 `data/` 或密钥，仅删除文件不够——历史里仍可检出。
> 需要重写历史（`git filter-repo`）并**更换所有密钥**（`credentials.key` 泄露意味着库内凭据可解密）。

---

## 1. 本地仓库初始化（仅当还没有 `.git`）

```bash
cd <项目目录>
git init -b main
git add -A
git commit -m "初始化：火焰/烟雾视频识别监控平台"
```

配置提交身份（只需一次）：

```bash
git config user.name  "你的名字"
git config user.email "you@example.com"
```

---

## 2. 在 GitHub 创建空仓库

1. 打开 https://github.com/new
2. Repository name：如 `fire-vision-monitor`
3. 可见性：私有（推荐，含业务配置）或公开
4. **不要**勾选 "Add a README file / .gitignore / license"（本地已有，勾选会造成首次推送冲突）
5. 创建后记下地址，例如：
   - HTTPS：`https://github.com/<账号>/fire-vision-monitor.git`
   - SSH：`git@github.com:<账号>/fire-vision-monitor.git`

---

## 3. 关联远程仓库

```bash
# 若之前配过其它远程，先查看并移除
git remote -v
git remote remove origin 2>/dev/null || true

# 添加远程（二选一）
git remote add origin https://github.com/<账号>/fire-vision-monitor.git
# 或
git remote add origin git@github.com:<账号>/fire-vision-monitor.git

git remote -v            # 确认已关联
```

### 认证方式（HTTPS 用 PAT）

GitHub 已不支持账号密码推送。用 **Personal Access Token**：

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token
2. 勾选 `repo` 权限，生成后复制（只显示一次）
3. 推送时用户名填 GitHub 账号，**密码粘贴 token**

或改用 SSH（推荐长期使用）：

```bash
ssh-keygen -t ed25519 -C "you@example.com"     # 一路回车
cat ~/.ssh/id_ed25519.pub                      # 复制内容
# GitHub → Settings → SSH and GPG keys → New SSH key → 粘贴
ssh -T git@github.com                          # 出现 "Hi <账号>!" 即成功
```

> Windows 上 `~/.ssh` 是 `C:\Users\<用户名>\.ssh`。

---

## 4. 推送代码与 tag

```bash
# 首次推送（-u 建立追踪关系，以后直接 git push）
git push -u origin main

# 推送全部版本 tag（重要：不推 tag，Release 与回滚点都不存在）
git push origin --tags
```

验证：

```bash
git ls-remote --tags origin     # 应能看到 v1.1.0 … v1.1.3
```

---

## 5. 推送后确认 CI

仓库内置 `.github/workflows/ci.yml`，push 后自动执行：安装 FFmpeg → `npm test` → `npm run build` → `npm run e2e`。

1. 打开仓库 **Actions** 标签
2. 确认最近一次 workflow 为绿色
3. 若失败：点进 job 看具体步骤；常见原因是 Node 版本或缺少 Chrome（CI 已内置 `CHROME_PATH`）

> CI 使用 Ubuntu 与系统 FFmpeg，与现场 Windows 环境不同，属于**额外的跨平台验证**。

---

## 6. 后续日常提交

```bash
git add -A
git commit -m "修复：<简要说明>"
git push
```

发布新版本：

```bash
# 同步 package.json 版本号后
git tag -a v1.1.4 -m "v1.1.4：<变更摘要>"
git push origin main --tags
# 可在 GitHub Releases 页面基于 tag 生成发布说明
```

---

## 7. 常见问题

| 现象 | 原因与处理 |
|---|---|
| `remote: Support for password authentication was removed` | 用了账号密码；改用 PAT 或 SSH（§3） |
| `failed to push some refs ... non-fast-forward` | 远程已有提交（可能创建仓库时勾了 README）。`git pull --rebase origin main` 后再推 |
| `fatal: remote origin already exists` | `git remote remove origin` 后重新添加 |
| 推送体积过大 | 检查是否误提交 `data/`、`dist/`、`node_modules/`、`test-videos/`；`git ls-files \| grep -E "^(data\|dist\|node_modules\|test-videos)/"` |
| CI 里 E2E 跳过 | 未找到 Chrome；CI 已设置 `CHROME_PATH=/usr/bin/google-chrome`，本地运行需自行安装 |
| 想撤销某次推送 | `git revert <commit>` 后正常推送（**不要** `push --force` 到已共享的分支） |

---

## 8. 可选：仓库信息完善

- **About**：填描述与 topics（`fire-detection`, `rtsp`, `onvif`, `hls`, `ffmpeg`, `video-surveillance`）
- **LICENSE**：仓库已含 MIT
- **Branch protection**（公开仓库建议）：要求 CI 通过后再合并
- **Secrets**：如需部署流水线，在 Settings → Secrets 配置，切勿写入代码

---

## English

### 1. Pre-flight

```bash
git status                 # should be clean
git tag -l                 # v1.1.0 … v1.1.3
git ls-files | grep -E "^data/|\.env$|\.key$|\.secret$" || echo "no sensitive files"
```

Never commit: `data/` (SQLite DB, `credentials.key`, `session.secret`, media), `.env*`, `node_modules/`, `dist/`, `test-videos/`.
If secrets were ever committed, deleting the files is not enough — rewrite history and **rotate the keys**.

### 2. Initialize (only if there is no `.git`)

```bash
git init -b main
git add -A
git commit -m "Initial commit: fire & smoke video monitoring platform"
git config user.name "Your Name"
git config user.email "you@example.com"
```

### 3. Create an empty GitHub repository

Go to https://github.com/new, choose a name and visibility, and **do not** initialize it with a README/.gitignore/license (it would conflict with your first push).

### 4. Add the remote and authenticate

```bash
git remote add origin https://github.com/<account>/fire-vision-monitor.git
# or: git remote add origin git@github.com:<account>/fire-vision-monitor.git
git remote -v
```

Password auth is not supported. Use a **Personal Access Token** (`repo` scope) as the password, or SSH:

```bash
ssh-keygen -t ed25519 -C "you@example.com"
cat ~/.ssh/id_ed25519.pub          # add it at GitHub → Settings → SSH and GPG keys
ssh -T git@github.com              # expect: Hi <account>!
```

### 5. Push code and tags

```bash
git push -u origin main
git push origin --tags             # tags are your release and rollback points
git ls-remote --tags origin        # verify
```

### 6. Verify CI

Open the **Actions** tab. `.github/workflows/ci.yml` installs FFmpeg, then runs `npm test`, `npm run build` and `npm run e2e` on Ubuntu. Wait for a green run; on failure open the job log (the most common cause is a missing browser or a Node version mismatch).

### 7. Day-to-day

```bash
git add -A
git commit -m "fix: <summary>"
git push
```

Release a new version:

```bash
git tag -a v1.1.4 -m "v1.1.4: <summary>"
git push origin main --tags
```

### 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "Support for password authentication was removed" | Use a PAT or SSH |
| "non-fast-forward" | `git pull --rebase origin main`, then push |
| "remote origin already exists" | `git remote remove origin` and re-add |
| Push is huge | Something like `data/`, `dist/`, `test-videos/` was committed; check `git ls-files` |
| E2E skipped in CI | Chrome not found; CI sets `CHROME_PATH=/usr/bin/google-chrome` |
