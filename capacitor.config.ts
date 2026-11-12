import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 安卓调试版壳工程配置。
 *
 * 设计与约束：
 * - webDir 指向 mobile-shell（首启页），不打包 dist：壳页只负责填写服务器地址；
 *   连上之后 WebView 直接导航到服务器源，Cookie 会话、SSE、HLS 全部同源，
 *   行为与桌面浏览器一致，服务端无需任何改动（也不需要 CORS）。
 * - androidScheme 用 http：壳页源为 http://localhost，避免 https→http 的混合内容限制；
 *   目标地址若是 https 仍可正常导航。
 * - allowNavigation 放行任意主机，否则 Capacitor 会把外部地址交给系统浏览器打开。
 */
const config: CapacitorConfig = {
  appId: 'com.flamevision.monitor',
  appName: 'FlameVision',
  webDir: 'mobile-shell',
  server: {
    androidScheme: 'http',
    allowNavigation: ['*'],
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
