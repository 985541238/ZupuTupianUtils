import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

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

  /**
   * 弹出系统自带的选择窗口（服务就跑在用户这台电脑上）。
   * 窗口只显示图片文件，选中任意一张图片即取它所在的文件夹。非 Windows 或失败时返回 unsupported，前端退回网页内目录选择。
   */
  pickFolder(start?: string): Promise<{ path?: string; cancelled?: boolean; unsupported?: boolean }> {
    if (process.platform !== 'win32') return Promise.resolve({ unsupported: true });
    let init = '';
    try {
      const cand = start ? path.resolve(start) : this.defaultFolder();
      if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) init = cand;
    } catch {
      init = '';
    }
    const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'; $owner.Size = New-Object System.Drawing.Size(0,0)
$owner.Show(); $owner.Activate()
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '选择图片所在文件夹（选中其中任意一张图片即可）'
$d.Filter = '图片文件|*.jpg;*.jpeg;*.png;*.bmp;*.tif;*.tiff;*.webp'
$d.Multiselect = $false
if ($env:ZUPU_PICK_START) { $d.InitialDirectory = $env:ZUPU_PICK_START }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write([System.IO.Path]::GetDirectoryName($d.FileName)) }
$owner.Close()
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
        { env: { ...process.env, ZUPU_PICK_START: init }, timeout: 10 * 60 * 1000, windowsHide: false, encoding: 'utf8' },
        (err, stdout) => {
          if (err) return resolve({ unsupported: true });
          const out = String(stdout || '').trim();
          resolve(out ? { path: out } : { cancelled: true });
        },
      );
    });
  }

  uploadRoot() {
    return process.env.UPLOAD_ROOT || path.join(process.cwd(), '..', 'data', 'uploads');
  }

  createUploadSession(label?: string, files?: { path: string; size: number; lastModified?: number }[], sourceKey?: string, parentSessionId?: string) {
    const safe = String(label || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 40);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const id = `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
    const uploadRoot = path.resolve(this.uploadRoot());
    let base = uploadRoot;
    if (parentSessionId) {
      const parentRel = String(parentSessionId).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!parentRel || parentRel.split('/').some((part) => part === '..') || /^[A-Za-z]:/.test(parentRel)) throw new BadRequestException('父上传会话无效');
      base = path.resolve(uploadRoot, parentRel);
      const baseRel = path.relative(uploadRoot, base);
      if (!baseRel || baseRel.startsWith('..') || path.isAbsolute(baseRel) || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
        throw new BadRequestException('父上传会话不存在');
      }
    }
    const dir = path.join(base, parentSessionId ? (safe || id) : (safe ? `${id}_${safe}` : id));
    fs.mkdirSync(dir, { recursive: true });
    if (Array.isArray(files)) {
      fs.writeFileSync(path.join(dir, '.upload-manifest.json'), JSON.stringify({ version: 1, label: label || '', sourceKey: sourceKey || '', files }, null, 2), 'utf8');
    }
    return { id: path.relative(uploadRoot, dir).replace(/\\/g, '/'), dir };
  }

  private uploadTarget(id: string, name: string) {
    const uploadRoot = path.resolve(this.uploadRoot());
    const relId = String(id || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relId || relId.split('/').some((part) => part === '..') || /^[A-Za-z]:/.test(relId)) throw new BadRequestException('会话无效');
    const dir = path.resolve(uploadRoot, relId);
    const dirRel = path.relative(uploadRoot, dir);
    if (!dirRel || dirRel.startsWith('..') || path.isAbsolute(dirRel)) throw new BadRequestException('会话无效');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new BadRequestException('上传会话不存在，请重新选择文件夹');
    const rel = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.split('/').some((part) => part === '..') || /^[A-Za-z]:/.test(rel)) throw new BadRequestException('上传文件路径无效');
    const base = path.basename(rel);
    const ext = path.extname(base).toLowerCase();
    if (!base || !IMAGE_EXT.has(ext)) throw new BadRequestException('只接受图片文件（jpg/png/tif/bmp/webp）');
    const target = path.resolve(dir, rel);
    if (!target.toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)) throw new BadRequestException('上传文件路径无效');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return { target, part: `${target}.part` };
  }

  uploadStatus(id: string, name: string) {
    const { target, part } = this.uploadTarget(id, name);
    if (fs.existsSync(target)) {
      return { offset: fs.statSync(target).size, complete: true };
    }
    return { offset: fs.existsSync(part) ? fs.statSync(part).size : 0, complete: false };
  }

  /** 把请求体（原始二进制）按偏移写入上传会话，断线后保留 .part 文件。 */
  saveUpload(id: string, name: string, req: NodeJS.ReadableStream): Promise<{ ok: true; size: number }> {
    const { target, part } = this.uploadTarget(id, name);
    const h = (req as any).headers || {};
    const offsetHeader = Number(h['x-upload-offset'] ?? 0);
    const totalHeader = Number(h['x-upload-total'] ?? 0);
    const offset = Number.isFinite(offsetHeader) && offsetHeader >= 0 ? offsetHeader : 0;
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0;
    if (fs.existsSync(target)) {
      const size = fs.statSync(target).size;
      if (!total || size === total) return Promise.resolve({ ok: true, size });
      throw new BadRequestException('文件已存在但大小不一致，请重新上传');
    }
    const current = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (offset !== current) throw new BadRequestException(`上传偏移不匹配，服务器已接收 ${current} 字节`);
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(part, { flags: offset === 0 ? 'w' : 'r+', start: offset });
      let size = offset;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (total && size > total) ws.destroy(new Error('上传数据超过文件大小'));
      });
      req.pipe(ws);
      ws.on('finish', () => {
        if (total && size === total) {
          fs.renameSync(part, target);
        }
        resolve({ ok: true, size });
      });
      ws.on('error', (e) => reject(new BadRequestException('写入失败：' + e.message)));
      req.on('error', (e) => {
        ws.destroy();
        reject(new BadRequestException('上传中断：' + e.message));
      });
      req.on('aborted', () => {
        ws.destroy();
        reject(new BadRequestException('上传连接中断，已保留断点'));
      });
    });
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
      this.uploadRoot(),
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
