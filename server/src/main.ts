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

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const outputRoot = process.env.OUTPUT_ROOT || path.join(process.cwd(), '..', 'data', 'output');
  fs.mkdirSync(outputRoot, { recursive: true });

  const port = Number(process.env.PORT || 8080);
  await app.listen(port);
  console.log(`Zupu scan server http://localhost:${port}`);
}
bootstrap();
