import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response } from 'express';
import archiver from 'archiver';
import * as fs from 'fs';
import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import { buildPayload } from './payload';
import { pageText, readOcr } from './ocr-utils';
import { statusText } from './tasks.service';

export type ExportFormat = 'json' | 'txt' | 'xlsx';

@Injectable()
export class ExportService {
  constructor(@InjectRepository(TaskImage) private readonly pages: Repository<TaskImage>) {}

  async export(task: Task, opts: { format: ExportFormat; scope: 'all' | 'approved'; images: boolean }, res: Response) {
    const all = await this.pages.find({ where: { taskId: task.id }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const pageNos = new Map<number, number>(all.map((p: TaskImage, i: number) => [Number(p.id), i + 1] as [number, number]));
    const rows = all.filter((p) => (opts.scope === 'approved' ? p.status === 'approved' : !!p.ocrJson || p.status === 'failed'));
    if (!rows.length) {
      throw new BadRequestException(opts.scope === 'approved' ? '还没有已通过的页' : '还没有处理完的页');
    }
    const imgName = (p: TaskImage) => `images/${String(pageNos.get(Number(p.id))).padStart(4, '0')}.png`;
    const base = `${task.name}${opts.scope === 'approved' ? '-已通过' : ''}`;

    let fileName: string;
    let data: Buffer;
    if (opts.format === 'json') {
      const payload = buildPayload(task, rows, pageNos, (p) => (opts.images && p.resultPath ? imgName(p) : null));
      fileName = `${base}.json`;
      data = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    } else if (opts.format === 'txt') {
      const parts = rows.map((p) => {
        const no = pageNos.get(Number(p.id));
        const side = p.side === 'R' ? '（右页）' : p.side === 'L' ? '（左页）' : '';
        return `【第 ${no} 页】${p.fileName}${side}\n${pageText(readOcr(p.ocrJson))}`;
      });
      fileName = `${base}.txt`;
      data = Buffer.from('﻿' + `${task.name}（${task.surname}氏）\n\n` + parts.join('\n\n') + '\n', 'utf8');
    } else if (opts.format === 'xlsx') {
      const header = ['页码', '文件名', '左右', '状态', '识别文字', '疑似错字数', '人工改过'];
      const table = rows.map((p) => [
        String(pageNos.get(Number(p.id))),
        p.fileName,
        p.side === 'R' ? '右' : p.side === 'L' ? '左' : '',
        statusText(p.status),
        pageText(readOcr(p.ocrJson)),
        String(p.uncertainCount || 0),
        p.edited ? '是' : '否',
      ]);
      fileName = `${base}.xlsx`;
      data = await buildXlsx([header, ...table], [8, 24, 6, 8, 80, 10, 8]);
    } else {
      throw new BadRequestException('不支持的导出格式');
    }

    if (!opts.images) {
      setDownload(res, fileName, contentType(opts.format));
      res.end(data);
      return;
    }
    // 附带图片：打成 zip
    setDownload(res, `${base}.zip`, 'application/zip');
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', (err) => res.destroy(err));
    zip.pipe(res);
    zip.append(data, { name: fileName });
    for (const p of rows) {
      if (p.resultPath && fs.existsSync(p.resultPath)) zip.file(p.resultPath, { name: imgName(p) });
    }
    await zip.finalize();
  }
}

function contentType(f: ExportFormat) {
  if (f === 'json') return 'application/json; charset=utf-8';
  if (f === 'txt') return 'text/plain; charset=utf-8';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

function setDownload(res: Response, name: string, type: string) {
  res.setHeader('Content-Type', type);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(name).replace(/%/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
}

// ---------- 最小 xlsx 生成（不引入第三方库） ----------

function xmlEscape(s: string) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(i: number) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export async function buildXlsx(rows: string[][], widths: number[]): Promise<Buffer> {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const style = ri === 0 ? ' s="1"' : ci === 4 ? ' s="2"' : '';
          return `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="识别结果" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="宋体"/></font><font><b/><sz val="11"/><name val="宋体"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  return new Promise<Buffer>((resolve, reject) => {
    const zip = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    zip.on('data', (c: Buffer) => chunks.push(c));
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    zip.on('error', reject);
    for (const [name, content] of Object.entries(files)) zip.append(content, { name });
    void zip.finalize();
  });
}

