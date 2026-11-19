import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // 开发代理的后端地址：默认与 server/.env 的 PORT 保持一致（8081）。
  // 后端换了端口时不用改代码：设置环境变量 ZUPU_DEV_API_TARGET，
  // 或者写在 admin-web/.env.local（已被 gitignore，本地生效）。
  const fileEnv = loadEnv(mode, __dirname, '');
  const devApiTarget =
    process.env.ZUPU_DEV_API_TARGET || fileEnv.ZUPU_DEV_API_TARGET || 'http://localhost:8081';
  console.log(`[vite] /dev-api  ->  ${devApiTarget}`);

  return {
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
  };
});
