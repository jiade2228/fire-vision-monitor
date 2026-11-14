# 安卓调试版（WebView 壳）

本目录是 Capacitor 生成的安卓工程，**只用于构建调试版 APK**。正式签名不在此仓库内，需要正式分发的使用者请自行生成 keystore 并配置 release 签名。

## 包信息

| 项 | 值 |
|---|---|
| 应用 ID | `com.flamevision.monitor` |
| versionName | `1.2.9` |
| versionCode | `10209`（`major*10000 + minor*100 + patch`） |
| minSdk | 24（Android 7.0） |
| compileSdk / targetSdk | 35 |

## 运行方式

壳页面在 `mobile-shell/index.html`，只负责服务器地址：

1. 首次启动填写服务器地址（支持 `http://` 与 `https://`，默认端口 4173）；
2. 点击「连接」后请求 `<地址>/healthz` 探活，成功后写入 localStorage 键 `fv.server.base`；
3. 探活通过即导航到该地址，之后就是现有 Web 界面；
4. 冷启动会读取已存地址自动连接，连接中可点「修改地址」回到表单。

设计原因：现有前端的所有请求都是相对路径同源请求（`/api/...`、`/streams/...`），服务端也没有 CORS 头。若让内置页面跨源直连远程服务器，Cookie 会话与 SSE 会被浏览器拦截。因此壳页面只做地址配置，真正界面统一从服务器源加载，行为与桌面浏览器一致，**服务端无需任何改动**。

## 构建

本地（需 JDK 21 + Android SDK）：

```bash
npm ci
npx cap copy android
cd android && ./gradlew assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（调试签名，Gradle 自动生成，不入库）。

CI：`.github/workflows/android-debug.yml`（push 到 main 且命中相关路径，或手动 `workflow_dispatch`），APK 以 artifact `flamevision-debug-apk` 上传，保留 14 天。该工作流不创建 Release。

## 明文 HTTP 与自签 HTTPS

配置文件：`android/app/src/main/res/xml/network_security_config.xml`，已通过 `AndroidManifest.xml` 的 `android:networkSecurityConfig` 引用。

- **明文 http**：`base-config cleartextTrafficPermitted="true"`，局域网直连即可。正式版如需强制 https，改为 `false`。
- **自签 https**：Android 7.0 起应用默认不信任用户安装的 CA，因此配置里显式加了 `<certificates src="user" />`。设备侧步骤：
  1. 把服务器自签证书（`.crt` / `.pem`）传到手机；
  2. 设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书，导入该文件；
  3. 在壳页面填写 `https://<服务器>:<端口>`。
- **替换为只信任指定 CA**：把 `<certificates src="user" />` 改成 `<certificates src="@raw/my_ca" />`，证书放到 `android/app/src/main/res/raw/my_ca.pem`（raw 下资源名需小写，不含扩展名引用）。

## 不入库的内容

`*.apk`、`*.aab`、`*.jks`、`*.keystore`、`android/.gradle/`、`android/app/build/`、`android/local.properties`、`android/app/src/main/assets/public/` 均由 `.gitignore` 排除。
