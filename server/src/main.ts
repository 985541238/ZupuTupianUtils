import * as fs from 'fs';
import * as path from 'path';

// 加载环境变量。优先级：系统环境变量 > server/.env > server/.env.production（仅线上）> 代码默认值
// 本地开发（npm run start:dev）不带 --prod，走本地默认库；
// 打包部署用 start:prod / deploy/windows/start.cmd（带 --prod），自动使用线上这套 .env.production
(() => {
  const isProd = process.argv.includes('--prod') || process.env.APP_ENV === 'prod';
  const files = ['.env'];
  if (isProd) files.push('.env.production');
  for (const f of files) {
    const envPath = path.join(__dirname, '..', f);
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
})();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as express from 'express';
import sharp from 'sharp';

async function bootstrap() {
  // 控制 sharp(libvips) 内存：缓存只留一点，线程数不随核数放大
  sharp.cache({ memory: 64, files: 0, items: 50 });
  sharp.concurrency(Math.min(2, require('os').cpus().length));
  // 关闭 Nest 默认 body-parser（100KB 限制），改为自定义上限；上传走 octet-stream 流式不受影响
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.enableCors({ origin: true, credentials: true });
  // 单进程部署：同端口提供管理端静态页，并兼容前端的 /dev-api 前缀（无需 Nginx）
  const adminDist = process.env.ADMIN_DIST || path.join(__dirname, '..', '..', 'admin-web', 'dist');
  if (fs.existsSync(path.join(adminDist, 'index.html'))) {
    app.use((req: any, _res: any, next: any) => {
      if (req.url === '/dev-api' || req.url.startsWith('/dev-api/') || req.url.startsWith('/dev-api?')) {
        req.url = req.url.slice('/dev-api'.length) || '/';
      }
      next();
    });
    app.use(express.static(adminDist, { index: 'index.html', maxAge: '1h' }));
    app.use((req: any, res: any, next: any) => {
      const accepts = String(req.headers.accept || '');
      if (req.method === 'GET' && accepts.includes('text/html') && !path.extname(req.path)) {
        return res.sendFile(path.join(adminDist, 'index.html'));
      }
      next();
    });
    console.log(`管理端静态页：${adminDist}`);
  }
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const outputRoot = process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output');
  fs.mkdirSync(outputRoot, { recursive: true });

  const port = Number(process.env.PORT || 8080);
  await app.listen(port);
  console.log(`Zupu scan server http://localhost:${port}`);
}
bootstrap();
