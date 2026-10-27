import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp']);

@Injectable()
export class FilesService {
  defaultFolder() {
    return (
      process.env.DEFAULT_SOURCE_FOLDER ||
      path.join(process.env.PROJECT_ROOT || process.cwd(), '待处理的图片')
    );
  }

  projectRoot() {
    return process.env.PROJECT_ROOT || path.resolve(process.cwd(), '..');
  }

  browse(target?: string) {
    let dir = target ? path.resolve(target) : this.defaultFolder();
    if (!fs.existsSync(dir)) {
      // fallback to project root if default missing
      dir = this.projectRoot();
    }
    if (!fs.existsSync(dir)) throw new BadRequestException('路径不存在');
    const st = fs.statSync(dir);
    if (!st.isDirectory()) throw new BadRequestException('不是文件夹');

    const entries = fs.readdirSync(dir).map((name) => {
      const full = path.join(dir, name);
      let isDir = false;
      let size = 0;
      try {
        const s = fs.statSync(full);
        isDir = s.isDirectory();
        size = s.isFile() ? s.size : 0;
      } catch {
        return null;
      }
      const ext = path.extname(name).toLowerCase();
      return {
        name,
        path: full,
        isDirectory: isDir,
        isImage: !isDir && IMAGE_EXT.has(ext),
        size,
      };
    }).filter(Boolean) as any[];

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });

    const parent = path.dirname(dir);
    return {
      current: dir,
      parent: parent !== dir ? parent : null,
      defaultFolder: this.defaultFolder(),
      roots: this.listRoots(),
      entries,
      imageCount: entries.filter((e) => e.isImage).length,
    };
  }

  listRoots() {
    if (process.platform === 'win32') {
      const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      const roots = [];
      for (const L of letters) {
        const p = L + ':\\';
        try {
          if (fs.existsSync(p)) roots.push(p);
        } catch {}
      }
      return roots;
    }
    return [os.homedir(), '/'];
  }

  assertReadable(absPath: string) {
    const resolved = path.resolve(absPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new BadRequestException('文件不存在');
    }
    // allow project root + output root
    const allowed = [
      this.projectRoot(),
      process.env.OUTPUT_ROOT || path.join(this.projectRoot(), 'data', 'output'),
      this.defaultFolder(),
    ].map((p) => path.resolve(p).toLowerCase());
    const low = resolved.toLowerCase();
    const ok = allowed.some((a) => low.startsWith(a));
    // also allow any path under same drive that was selected as source — for local tool we open more broadly under PROJECT_ROOT parent
    const projectParent = path.resolve(this.projectRoot(), '..').toLowerCase();
    if (!ok && !low.startsWith(projectParent) && !low.startsWith('d:\\xiangmu')) {
      // still allow D:\xiangmu for this local tool
      if (!low.startsWith('d:' + path.sep.toLowerCase())) {
        throw new BadRequestException('不允许访问该路径');
      }
    }
    return resolved;
  }
}
