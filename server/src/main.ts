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
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  if (!process.env.JWT_SECRET) {
    console.warn('[安全提示] 没有设置 JWT_SECRET，正在使用默认密钥。正式部署前请在 server/.env 里设置一个随机长字符串。');
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '5mb' });
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const outputRoot = process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output');
  fs.mkdirSync(outputRoot, { recursive: true });

  const port = Number(process.env.PORT || 8080);
  await app.listen(port);
  console.log(`Zupu scan server http://localhost:${port}`);
}
bootstrap();
