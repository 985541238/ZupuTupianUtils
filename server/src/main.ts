import * as fs from 'fs';
import * as path from 'path';

// load server/.env
(() => {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
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

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
