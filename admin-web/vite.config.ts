import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// 开发代理的后端地址：默认与 server/.env 的 PORT 保持一致（8081）。
// 如果后端换了端口，可用环境变量 ZUPU_DEV_API_TARGET 覆盖。
const devApiTarget = process.env.ZUPU_DEV_API_TARGET || 'http://localhost:8081';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  server: {
    port: 8888,
    host: true,
    strictPort: true,
    proxy: {
      '/dev-api': {
        target: devApiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/dev-api/, ''),
      },
    },
  },
});
