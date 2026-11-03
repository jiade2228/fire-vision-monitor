import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // hls.js 是动态 import 的懒加载 chunk（仅播放 HLS 时才下载），
  // 单文件 >500kB 属预期，静音警告即可。
  build: { chunkSizeWarningLimit: 700 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
      '/streams': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
