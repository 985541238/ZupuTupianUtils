import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  ScanText,
  Scissors,
  SkipForward,
  Sparkles,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api, pageImageUrl } from '../api/client';
import type { AiModel, Estimate, OcrResult, PageDetail, PageLite } from '../types';
import { Button, Field, Modal, PageStatusBadge, inputCls, money, usePolling, useUi } from './ui';
import { navigate } from '../router';

type Sel = { col: number; index: number } | null;

export const ReviewView: React.FC<{ taskId: number; pageId: number }> = ({ taskId, pageId }) => {
  const { toast, confirm } = useUi();
  const [page, setPage] = useState<PageDetail | null>(null);
  const [list, setList] = useState<PageLite[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [imgKind, setImgKind] = useState<'result' | 'source'>('result');
  /** 有 AI 候选时，正在看哪个版本 */
  const [version, setVersion] = useState<'current' | 'ai'>('ai');
  const [sel, setSel] = useState<Sel>(null);
  const [editCol, setEditCol] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [pageEditOpen, setPageEditOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [reocrOpen, setReocrOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);

  const loadList = useCallback(async () => {
    const l = await api.getPages(taskId);
    setList(l);
    return l;
  }, [taskId]);

  const loadPage = useCallback(async () => {
    const p = await api.getPage(pageId);
    if (p.taskId !== taskId) throw new Error('页面不属于这个任务');
    setPage(p);
    return p;
  }, [pageId, taskId]);

  useEffect(() => {
    setPage(null);
    setError('');
    setSel(null);
    setEditCol(null);
    setVersion('ai');
    setImgKind('result');
    loadPage().catch((e) => setError(e.message));
  }, [loadPage]);

  useEffect(() => {
    loadList().catch(() => {});
  }, [loadList]);

  const busyPage = !!page && (page.status === 'processing' || page.status === 'queued' || page.status === 'pending');
  usePolling(
    async () => {
      if (!busyPage) return;
      const before = page?.status;
      const p = await loadPage();
      if (before && p.status !== before && (p.status === 'review' || p.status === 'failed')) {
        if (p.hasCandidate) toast('AI 处理完成，请对比后选择保留哪个版本', 'success');
        else if (p.status === 'failed') toast('处理失败：' + (p.errorMessage || ''), 'error');
        else if (p.errorMessage) toast(p.errorMessage, 'warning');
        else toast('处理完成', 'success');
        void loadList();
      }
    },
    2000,
    [busyPage, loadPage, page?.status],
  );

  const comparing = !!page?.hasCandidate && !!page.candidate;
  const showingAi = comparing && version === 'ai';
  const ocr: OcrResult | null = page ? (showingAi ? page.candidate : page.ocr) : null;
  const editable = !!page && page.status === 'review' && !showingAi;

  const goto = (id: number | null | undefined) => {
    if (id) navigate(`/tasks/${taskId}/pages/${id}`);
  };

  const nextToReview = (afterId: number, l: PageLite[]) => {
    const idx = l.findIndex((p) => p.id === afterId);
    const after = l.slice(idx + 1).find((p) => p.status === 'review');
    return after || l.slice(0, Math.max(0, idx)).find((p) => p.status === 'review') || null;
  };

  const run = async (key: string, fn: () => Promise<PageDetail | void>, ok?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r) setPage(r);
      if (ok) toast(ok, 'success');
      void loadList();
      return true;
    } catch (e: any) {
      toast(e.message, 'error');
      return false;
    } finally {
      setBusy('');
    }
  };

  const approve = async () => {
    if (!page || page.status !== 'review') return;
    if (page.hasCandidate) return toast('请先选择保留哪个版本', 'warning');
    if (editCol != null) return toast('请先保存或取消正在编辑的列', 'warning');
    if (page.uncertainCount > 0) {
      const ok = await confirm({
        title: `还有 ${page.uncertainCount} 个疑似错字没处理`,
        message: '确定这些字都没问题，直接通过吗？推送时会附带这些字的标记。',
        okText: '直接通过',
      });
      if (!ok) return;
    }
    setBusy('approve');
    try {
      await api.approvePage(page.id);
      const l = await loadList();
      const next = nextToReview(page.id, l);
      if (next) {
        goto(next.id);
      } else {
        await loadPage();
        if (l.every((p) => p.status === 'approved')) setDoneOpen(true);
        else toast('已通过。没有其他待审核的页了', 'success');
      }
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  // 疑似错字列表（当前显示的版本）
  const uncertainList = ocr?.uncertain || [];
  const isUncertain = (col: number, index: number) => uncertainList.some((u) => u.col === col && u.index === index);
  const selInfo = sel && ocr ? uncertainList.find((u) => u.col === sel.col && u.index === sel.index) : null;
  const selChar = sel && ocr ? Array.from(ocr.columns[sel.col]?.text || '')[sel.index] : '';

  const jumpUncertain = (dir: 1 | -1) => {
    if (!uncertainList.length) return;
    const flat = uncertainList.map((u) => u.col * 100000 + u.index);
    const cur = sel ? sel.col * 100000 + sel.index : dir > 0 ? -1 : Infinity;
    let target = dir > 0 ? flat.find((v) => v > cur) : [...flat].reverse().find((v) => v < cur);
    if (target == null) target = dir > 0 ? flat[0] : flat[flat.length - 1];
    setSel({ col: Math.floor(target / 100000), index: target % 100000 });
    setEditCol(null);
  };

  // 键盘
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (aiOpen || reocrOpen || splitOpen || pageEditOpen || doneOpen) return;
      if (e.key === 'ArrowLeft') goto(page?.prevId);
      else if (e.key === 'ArrowRight') goto(page?.nextId);
      else if (e.key === 'Enter') void approve();
      else if (e.key === 'Tab') {
        e.preventDefault();
        jumpUncertain(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[13px] text-[#6E6E73]">
        {error}
        <Button onClick={() => navigate(`/tasks/${taskId}`)}>返回任务</Button>
      </div>
    );
  }
  if (!page) return <div className="flex-1 flex items-center justify-center text-xs text-[#86868B]">加载中…</div>;

  const imgSrc = showingAi
    ? pageImageUrl(page.id, 'candidate', page.updatedAt)
    : pageImageUrl(page.id, imgKind === 'source' || !page.hasResult ? 'source' : 'result', page.updatedAt);
  const boxesOn = (showingAi || (imgKind === 'result' && page.hasResult)) && !!ocr;
  const selBox = !boxesOn ? null : sel != null ? ocr!.columns[sel.col]?.box : editCol != null ? ocr!.columns[editCol]?.box : null;
  const nextReview = nextToReview(page.id, list);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 顶栏 */}
      <div className="h-12 px-4 border-b border-black/[0.06] bg-white flex items-center gap-3 shrink-0">
        <button onClick={() => navigate(`/tasks/${taskId}`)} className="flex items-center gap-1 text-xs font-semibold text-[#0071E3] cursor-pointer shrink-0">
          <ArrowLeft className="w-3.5 h-3.5" />
          {page.task.name}
        </button>
        <span className="w-px h-4 bg-black/[0.1]" />
        <div className="text-[13px] font-semibold tabular-nums shrink-0">
          第 {page.pageNo} / {page.total} 页{page.side === 'R' ? '（右页）' : page.side === 'L' ? '（左页）' : ''}
        </div>
        <PageStatusBadge status={page.status} />
        {page.edited && <span className="text-[11px] font-semibold text-[#0071E3]">已人工修改</span>}
        <span className="text-[11px] text-[#86868B] truncate hidden lg:block">{page.fileName}</span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="w-4 h-4" />} disabled={!page.prevId} onClick={() => goto(page.prevId)} title="上一页（←）">
            上一页
          </Button>
          <Button size="sm" variant="ghost" disabled={!page.nextId} onClick={() => goto(page.nextId)} title="下一页（→）">
            下一页
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button size="sm" icon={<SkipForward className="w-3.5 h-3.5" />} disabled={!nextReview} onClick={() => goto(nextReview?.id)} title="跳到下一个待审核的页">
            下一个待审
          </Button>
          <div className="relative">
            <Button size="sm" variant="ghost" onClick={() => setMenuOpen((v) => !v)} title="更多">
              <MoreHorizontal className="w-4 h-4" />
            </Button>
            {menuOpen && (
              <div className="absolute right-0 top-9 z-40 w-48 bg-white rounded-xl shadow-[0_10px_30px_rgba(0,0,0,0.15)] border border-black/[0.08] py-1 text-[13px]" onMouseLeave={() => setMenuOpen(false)}>
                <MenuItem
                  icon={<Scissors className="w-4 h-4" />}
                  disabled={!page.hasOrigin || busyPage}
                  onClick={() => {
                    setMenuOpen(false);
                    setSplitOpen(true);
                  }}
                >
                  拆页不对？调整拆页
                </MenuItem>
                <MenuItem
                  icon={<Pencil className="w-4 h-4" />}
                  disabled={!editable}
                  onClick={() => {
                    setMenuOpen(false);
                    setPageEditOpen(true);
                  }}
                >
                  整页编辑文字
                </MenuItem>
                <MenuItem
                  danger
                  icon={<Trash2 className="w-4 h-4" />}
                  disabled={busyPage}
                  onClick={async () => {
                    setMenuOpen(false);
                    const ok = await confirm({
                      title: '删除这一页？',
                      message: '适合空白页、封底等不需要的页。删除后不会再推送和导出，不能恢复。',
                      okText: '删除',
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await api.deletePage(page.id);
                      toast('已删除', 'success');
                      if (page.nextId) goto(page.nextId);
                      else if (page.prevId) goto(page.prevId);
                      else navigate(`/tasks/${taskId}`);
                    } catch (e: any) {
                      toast(e.message, 'error');
                    }
                  }}
                >
                  删除这一页
                </MenuItem>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* AI 结果待选择 */}
      {comparing && (
        <div className="px-4 py-2.5 bg-[#AF52DE]/[0.08] border-b border-[#AF52DE]/20 flex items-center gap-3 flex-wrap shrink-0">
          <Sparkles className="w-4 h-4 text-[#8944AB]" />
          <span className="text-[13px] font-semibold text-[#6B2E8C]">AI 处理完成（花费 {money(page.candidateCost, 3)}），对比后选择保留哪个版本</span>
          <div className="flex p-0.5 bg-white rounded-full border border-black/[0.08]">
            {(['current', 'ai'] as const).map((v) => (
              <button
                key={v}
                onClick={() => {
                  setVersion(v);
                  setSel(null);
                }}
                className={`px-3 h-7 rounded-full text-xs font-semibold cursor-pointer ${version === v ? 'bg-[#AF52DE] text-white' : 'text-[#6E6E73]'}`}
              >
                {v === 'current' ? `之前的版本（疑 ${page.ocr.uncertain.length}）` : `AI 处理后（疑 ${page.candidate!.uncertain.length}）`}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <Button size="sm" loading={busy === 'keepCur'} onClick={() => run('keepCur', () => api.chooseCandidate(page.id, 'current'), '已保留之前的版本')}>
              保留之前的
            </Button>
            <Button size="sm" variant="primary" loading={busy === 'keepAi'} onClick={() => run('keepAi', () => api.chooseCandidate(page.id, 'ai'), '已换成 AI 处理后的版本')}>
              保留 AI 版本
            </Button>
          </div>
        </div>
      )}

      {page.errorMessage && page.status !== 'failed' && !busyPage && (
        <div className="px-4 py-2 bg-[#FF9500]/10 text-xs text-[#9A4A00] border-b border-[#FF9500]/20 shrink-0 select-text">{page.errorMessage}</div>
      )}

      {/* 主体 */}
      <div className="flex-1 min-h-0 flex">
        <ImagePane
          key={page.id}
          src={imgSrc}
          kindToggle={
            showingAi ? null : (
              <div className="flex p-0.5 bg-[#E5E5EA] rounded-full">
                {(['result', 'source'] as const).map((k) => (
                  <button
                    key={k}
                    disabled={k === 'result' && !page.hasResult}
                    onClick={() => setImgKind(k)}
                    className={`px-3 h-7 rounded-full text-xs font-semibold cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                      imgKind === k && (k === 'source' || page.hasResult) ? 'bg-white shadow-[0_1px_3px_rgba(0,0,0,0.1)] text-[#1D1D1F]' : 'text-[#6E6E73]'
                    }`}
                  >
                    {k === 'result' ? `清理后${page.cleanUsed === 'ai' ? '（AI）' : ''}` : '原图'}
                  </button>
                ))}
              </div>
            )
          }
          box={selBox}
          charPos={sel && selBox ? { index: sel.index, total: Array.from(ocr!.columns[sel.col]?.text || '').length } : null}
          overlay={
            busyPage ? (
              <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] flex flex-col items-center justify-center gap-2 text-[13px] text-[#3A3A3C]">
                <Loader2 className="w-6 h-6 animate-spin text-[#0071E3]" />
                {page.status === 'pending'
                  ? page.task.status === 'paused'
                    ? '任务已暂停，继续处理后会处理这一页'
                    : '排队等待处理…'
                  : page.action === 'ai_clean'
                    ? 'AI 正在处理这一页，通常需要十几秒到一分钟…'
                    : page.action === 'reocr'
                      ? '正在重新识别…'
                      : '正在清理和识别…'}
              </div>
            ) : null
          }
        />

        {/* 文字 */}
        <div className="w-[46%] min-w-[380px] max-w-[720px] border-l border-black/[0.06] bg-white flex flex-col min-h-0">
          <div className="h-11 px-4 flex items-center gap-2 border-b border-black/[0.06] shrink-0">
            <ScanText className="w-4 h-4 text-[#0071E3]" />
            <span className="text-[13px] font-semibold">识别文字{showingAi ? '（AI 版本，选择后才能修改）' : ''}</span>
            {ocr && uncertainList.length > 0 && (
              <button onClick={() => jumpUncertain(1)} className="px-2 py-0.5 rounded-full bg-[#FFCC00]/30 text-[11px] font-semibold text-[#7A5D00] cursor-pointer" title="Tab 跳到下一个">
                疑似错字 {uncertainList.length} 处 · 按 Tab 逐个看
              </button>
            )}
            {ocr && !uncertainList.length && page.status === 'review' && <span className="text-[11px] text-[#248A3D] font-semibold">没有疑似错字</span>}
            <span className="ml-auto text-[11px] text-[#86868B] truncate">{page.ocrModelName}</span>
          </div>

          <div className="flex-1 min-h-0 overflow-auto px-3 py-4 selectable" dir="rtl">
            {ocr && ocr.columns.length > 0 ? (
              <VerticalText
                ocr={ocr}
                sel={sel}
                editingCol={editCol}
                isUncertain={isUncertain}
                onPick={(col, index) => {
                  setSel({ col, index });
                  setEditCol(null);
                }}
                onEditCol={(col) => {
                  if (!editable) return toast(page.status === 'approved' ? '已通过的页不能改，请先撤销通过' : '现在不能修改', 'warning');
                  setEditCol(col);
                  setEditText(ocr.columns[col].text);
                  setSel(null);
                }}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-[#86868B]" dir="ltr">
                {page.status === 'failed' ? '这一页处理失败，没有识别结果' : busyPage ? '处理完会显示在这里' : '没有识别出文字'}
              </div>
            )}
          </div>

          {/* 选中字 / 编辑列 */}
          <div className="border-t border-black/[0.06] px-4 py-3 shrink-0 min-h-[112px] bg-[#FAFAFB]">
            {editCol != null && ocr ? (
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="font-semibold">编辑第 {editCol + 1} 列（从右往左数）</span>
                  <span className="text-[#86868B]">保存后这一列的疑似错字标记会清除</span>
                </div>
                <textarea
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full h-16 px-3 py-2 text-[15px] leading-relaxed bg-white border border-black/[0.12] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-serif"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" onClick={() => setEditCol(null)}>
                    取消
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === 'saveCol'}
                    onClick={async () => {
                      const cols = ocr.columns.map((c, i) => (i === editCol ? editText : c.text));
                      if (await run('saveCol', () => api.saveText(page.id, cols), '已保存')) setEditCol(null);
                    }}
                  >
                    保存
                  </Button>
                </div>
              </div>
            ) : sel && ocr ? (
              <CharInspector
                key={`${sel.col}-${sel.index}-${page.updatedAt}`}
                col={sel.col}
                index={sel.index}
                char={selChar}
                info={selInfo || null}
                editable={editable}
                notEditableText={showingAi ? '这是 AI 版本，选择保留后才能修改' : page.status === 'approved' ? '已通过，如需修改请先撤销通过' : '现在不能修改'}
                busy={busy}
                onReplace={async (ch) => {
                  await run('resolve', () => api.resolveChar(page.id, { col: sel.col, index: sel.index, char: ch }));
                  jumpUncertain(1);
                }}
                onConfirm={async () => {
                  await run('resolve', () => api.resolveChar(page.id, { col: sel.col, index: sel.index }));
                  jumpUncertain(1);
                }}
                onEditCol={() => {
                  if (!editable) return;
                  setEditCol(sel.col);
                  setEditText(ocr.columns[sel.col].text);
                  setSel(null);
                }}
              />
            ) : (
              <div className="text-xs text-[#6E6E73] leading-relaxed">
                {page.status === 'review' && !showingAi ? (
                  <>
                    点任意一个字可以修改它，左图会框出它所在的那一列；<span className="bg-[#FFE58F] px-1 rounded">黄底</span>是 AI 标出的疑似错字。
                    <br />
                    双击一列可以整列修改。快捷键：Tab 下一个疑似错字 · ⏎ 通过 · ← → 翻页
                  </>
                ) : showingAi ? (
                  '正在看 AI 处理后的版本。选择「保留 AI 版本」后才能修改；切到「之前的版本」可以对比。'
                ) : page.status === 'approved' ? (
                  '这一页已通过。如需修改，请先点右下角「撤销通过」。'
                ) : page.status === 'failed' ? (
                  <span className="text-[#D70015] select-text">失败原因：{page.errorMessage}</span>
                ) : (
                  '处理完成后可以在这里校对文字。'
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底栏 */}
      <div className="h-14 px-4 border-t border-black/[0.06] bg-white flex items-center gap-3 shrink-0">
        <div className="text-[11px] text-[#86868B] tabular-nums">
          本页花费 {money(page.cost, 3)}
          {page.processingTimeMs ? ` · 用时 ${(page.processingTimeMs / 1000).toFixed(1)} 秒` : ''}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {page.status === 'failed' ? (
            <Button variant="primary" icon={<RotateCcw className="w-4 h-4" />} loading={busy === 'retry'} onClick={() => run('retry', () => api.retryPage(page.id), '已重新排队')}>
              重新处理本页
            </Button>
          ) : (
            <>
              <Button
                icon={<Sparkles className="w-4 h-4 text-[#AF52DE]" />}
                disabled={busyPage || comparing || (page.status !== 'review' && page.status !== 'approved')}
                title={comparing ? '请先选择保留哪个版本' : '用 AI 模型重新清理这一页的图片，再重新识别'}
                onClick={() => setAiOpen(true)}
              >
                AI 处理本页
              </Button>
              <Button
                icon={<ScanText className="w-4 h-4" />}
                disabled={busyPage || comparing || !page.hasResult || (page.status !== 'review' && page.status !== 'approved')}
                title="图片不变，只重新识别文字（可以换一个模型）"
                onClick={() => setReocrOpen(true)}
              >
                重新识别
              </Button>
              {page.status === 'approved' ? (
                <Button icon={<Undo2 className="w-4 h-4" />} loading={busy === 'unapprove'} onClick={() => run('unapprove', () => api.unapprovePage(page.id), '已撤销通过')}>
                  撤销通过
                </Button>
              ) : (
                <Button
                  variant="success"
                  icon={<Check className="w-4 h-4" />}
                  loading={busy === 'approve'}
                  disabled={page.status !== 'review' || comparing}
                  title={comparing ? '请先选择保留哪个版本' : '通过并跳到下一个待审核页（⏎）'}
                  onClick={() => void approve()}
                >
                  通过
                  <kbd className="ml-1 px-1 rounded bg-white/25 text-[10px] font-mono">⏎</kbd>
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <AiDialog open={aiOpen} page={page} onClose={() => setAiOpen(false)} onDone={(p) => { setPage(p); setVersion('ai'); void loadList(); }} />
      <ReocrDialog open={reocrOpen} page={page} onClose={() => setReocrOpen(false)} onDone={(p) => { setPage(p); void loadList(); }} />
      <SplitDialog open={splitOpen} page={page} onClose={() => setSplitOpen(false)} onDone={(p) => { void loadList(); if (p.id !== page.id) goto(p.id); else setPage(p); }} />
      <PageEditDialog open={pageEditOpen} page={page} onClose={() => setPageEditOpen(false)} onSaved={(p) => setPage(p)} />
      <Modal
        open={doneOpen}
        title="这本书全部审核通过了"
        onClose={() => setDoneOpen(false)}
        width={420}
        footer={
          <>
            <Button onClick={() => setDoneOpen(false)}>留在这一页</Button>
            <Button variant="success" onClick={() => navigate(`/tasks/${taskId}`)}>
              去推送 / 导出
            </Button>
          </>
        }
      >
        <div className="text-[13px] text-[#3A3A3C]">所有 {list.length} 页都已通过。下一步可以在任务页推送到第三方，或者导出。</div>
      </Modal>
    </div>
  );
};

const MenuItem: React.FC<{ icon: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }> = ({
  icon,
  onClick,
  disabled,
  danger,
  children,
}) => (
  <button
    disabled={disabled}
    onClick={onClick}
    className={`w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed hover:bg-black/[0.04] ${danger ? 'text-[#D70015]' : 'text-[#1D1D1F]'}`}
  >
    {icon}
    {children}
  </button>
);

// ---------------- 看图 ----------------

const ImagePane: React.FC<{
  src: string;
  kindToggle: React.ReactNode;
  box: [number, number, number, number] | null | undefined;
  charPos: { index: number; total: number } | null;
  overlay: React.ReactNode;
}> = ({ src, kindToggle, box, charPos, overlay }) => {
  const wrap = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [fitW, setFitW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  const computeFit = useCallback(() => {
    const el = wrap.current;
    if (!el || !nat) return;
    const w = el.clientWidth - 32;
    const h = el.clientHeight - 32;
    setFitW(Math.max(100, Math.min(w, (h * nat.w) / nat.h)));
  }, [nat]);

  useEffect(() => {
    computeFit();
    const ro = new ResizeObserver(computeFit);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [computeFit]);

  useEffect(() => setLoading(true), [src]);

  useEffect(() => {
    if (box && boxRef.current && zoom > 1) boxRef.current.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }, [box, zoom]);

  const width = fitW * zoom;
  const setZ = (z: number) => setZoom(Math.max(1, Math.min(6, Math.round(z * 100) / 100)));

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-[#EBEBEF]">
      <div className="h-11 px-3 flex items-center gap-2 border-b border-black/[0.06] bg-white/70 shrink-0">
        {kindToggle}
        <div className="ml-auto flex items-center gap-1">
          <button className="p-1.5 rounded-lg hover:bg-black/[0.06] cursor-pointer" onClick={() => setZ(zoom / 1.25)} title="缩小">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-[11px] tabular-nums w-10 text-center text-[#6E6E73]">{Math.round(zoom * 100)}%</span>
          <button className="p-1.5 rounded-lg hover:bg-black/[0.06] cursor-pointer" onClick={() => setZ(zoom * 1.25)} title="放大">
            <ZoomIn className="w-4 h-4" />
          </button>
          <button className="p-1.5 rounded-lg hover:bg-black/[0.06] cursor-pointer" onClick={() => setZoom(1)} title="适应窗口">
            <Maximize className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div
        ref={wrap}
        className={`relative flex-1 min-h-0 overflow-auto ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setZ(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
          }
        }}
        onMouseDown={(e) => {
          if (zoom <= 1 || !wrap.current) return;
          drag.current = { x: e.clientX, y: e.clientY, sl: wrap.current.scrollLeft, st: wrap.current.scrollTop };
        }}
        onMouseMove={(e) => {
          if (!drag.current || !wrap.current) return;
          wrap.current.scrollLeft = drag.current.sl - (e.clientX - drag.current.x);
          wrap.current.scrollTop = drag.current.st - (e.clientY - drag.current.y);
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onDoubleClick={() => setZ(zoom > 1 ? 1 : 2)}
      >
        <div className="min-w-full min-h-full flex items-center justify-center p-4">
          <div className="relative shadow-[0_8px_30px_rgba(0,0,0,0.12)] bg-white" style={{ width: width || undefined }}>
            <img
              src={src}
              alt=""
              draggable={false}
              className="block w-full h-auto select-none"
              onLoad={(e) => {
                const im = e.target as HTMLImageElement;
                setNat({ w: im.naturalWidth, h: im.naturalHeight });
                setLoading(false);
              }}
              onError={() => setLoading(false)}
            />
            {box && (
              <div
                ref={boxRef}
                className="absolute border-2 border-[#0071E3] bg-[#0071E3]/10 rounded-sm pointer-events-none transition-all"
                style={{ left: box[0] / 10 + '%', top: box[1] / 10 + '%', width: (box[2] - box[0]) / 10 + '%', height: (box[3] - box[1]) / 10 + '%' }}
              >
                {charPos && charPos.total > 0 && (
                  <div
                    className="absolute left-[-3px] right-[-3px] border-2 border-[#FF9500] bg-[#FF9500]/15 rounded-sm"
                    style={{ top: (charPos.index / charPos.total) * 100 + '%', height: 100 / charPos.total + '%' }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 className="w-5 h-5 animate-spin text-[#86868B]" />
          </div>
        )}
        {overlay}
      </div>
    </div>
  );
};

// ---------------- 竖排文字 ----------------

const VerticalText: React.FC<{
  ocr: OcrResult;
  sel: Sel;
  editingCol: number | null;
  isUncertain: (col: number, index: number) => boolean;
  onPick: (col: number, index: number) => void;
  onEditCol: (col: number) => void;
}> = ({ ocr, sel, editingCol, isUncertain, onPick, onEditCol }) => {
  const selRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [sel]);
  return (
    <div className="inline-flex flex-row gap-1 min-h-full" dir="rtl">
      {ocr.columns.map((c, col) => (
        <div
          key={col}
          dir="ltr"
          onDoubleClick={() => onEditCol(col)}
          title="双击整列修改"
          className={`group relative rounded-lg px-1 py-2 transition-colors ${
            editingCol === col ? 'bg-[#0071E3]/10 ring-2 ring-[#0071E3]/40' : sel?.col === col ? 'bg-[#0071E3]/[0.05]' : 'hover:bg-black/[0.03]'
          }`}
          style={{ writingMode: 'vertical-rl' }}
        >
          <span className="text-[10px] text-[#AEAEB2] mb-1 tabular-nums" style={{ writingMode: 'horizontal-tb' }}>
            {col + 1}
          </span>
          {Array.from(c.text).map((ch, i) => {
            const un = isUncertain(col, i);
            const on = sel?.col === col && sel?.index === i;
            return (
              <span
                key={i}
                ref={on ? selRef : undefined}
                onClick={() => onPick(col, i)}
                className={`inline-block cursor-pointer rounded-[3px] font-serif text-[21px] leading-[1.35] px-[1px] transition-all ${
                  on ? 'bg-[#0071E3] text-white' : un ? 'bg-[#FFE58F] text-[#5C4600] shadow-[inset_0_-2px_0_#F5A623]' : 'text-[#1D1D1F] hover:bg-black/[0.06]'
                } ${ch === '□' && !on ? 'text-[#D70015]' : ''}`}
              >
                {ch}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

const CharInspector: React.FC<{
  col: number;
  index: number;
  char: string;
  info: { candidates: string[]; reason: string } | null;
  editable: boolean;
  notEditableText: string;
  busy: string;
  onReplace: (ch: string) => void;
  onConfirm: () => void;
  onEditCol: () => void;
}> = ({ col, index, char, info, editable, notEditableText, busy, onReplace, onConfirm, onEditCol }) => {
  const [val, setVal] = useState('');
  const candidates = (info?.candidates || []).filter((c) => c !== char);
  return (
    <div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[#6E6E73]">
          第 {col + 1} 列第 {index + 1} 字
        </span>
        <span className="text-2xl font-serif leading-none">{char}</span>
        {info ? (
          <span className="px-1.5 py-0.5 rounded bg-[#FFE58F] text-[#5C4600] font-semibold">疑似错字{info.reason ? `：${info.reason}` : ''}</span>
        ) : (
          <span className="text-[#86868B]">（不是疑似错字）</span>
        )}
      </div>
      {editable ? (
        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          {candidates.length > 0 && (
            <>
              <span className="text-xs text-[#6E6E73]">可能是：</span>
              {candidates.map((c) => (
                <button
                  key={c}
                  onClick={() => onReplace(c)}
                  className="w-9 h-9 rounded-lg border border-black/[0.12] bg-white hover:border-[#0071E3] hover:bg-[#0071E3]/5 text-xl font-serif cursor-pointer"
                  title={`改成「${c}」`}
                >
                  {c}
                </button>
              ))}
            </>
          )}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (val.trim()) onReplace(val.trim());
            }}
          >
            <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="改成…" className={`${inputCls} !w-24 !h-9 font-serif text-base`} maxLength={4} autoFocus={!candidates.length} />
            <Button size="sm" type="submit" disabled={!val.trim()} loading={busy === 'resolve'}>
              改
            </Button>
          </form>
          {info && (
            <Button size="sm" variant="success" icon={<Check className="w-3.5 h-3.5" />} onClick={onConfirm} loading={busy === 'resolve'}>
              原字没错
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Pencil className="w-3.5 h-3.5" />} onClick={onEditCol}>
            整列修改
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-xs text-[#86868B]">{notEditableText}</div>
      )}
    </div>
  );
};

// ---------------- 对话框 ----------------

function useModels(open: boolean) {
  const [models, setModels] = useState<AiModel[]>([]);
  useEffect(() => {
    if (open) api.getModels().then(setModels).catch(() => {});
  }, [open]);
  return models;
}

const AiDialog: React.FC<{ open: boolean; page: PageDetail; onClose: () => void; onDone: (p: PageDetail) => void }> = ({ open, page, onClose, onDone }) => {
  const { toast } = useUi();
  const models = useModels(open);
  const cleanModels = models.filter((m) => m.purpose === 'clean' && m.enabled);
  const ocrModels = models.filter((m) => m.purpose === 'ocr' && m.enabled);
  const [cleanId, setCleanId] = useState<number | undefined>();
  const [ocrId, setOcrId] = useState<number | undefined>();
  const [est, setEst] = useState<Estimate | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!open || !models.length) return;
    setCleanId((v) => v ?? (page.task.cleanModelId && cleanModels.some((m) => m.id === page.task.cleanModelId) ? page.task.cleanModelId! : cleanModels.find((m) => m.isDefault)?.id ?? cleanModels[0]?.id));
    setOcrId((v) => v ?? (page.task.ocrModelId && ocrModels.some((m) => m.id === page.task.ocrModelId) ? page.task.ocrModelId! : ocrModels[0]?.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, models]);
  useEffect(() => {
    if (!open || !cleanId) return;
    api.pageEstimate(page.id, { action: 'ai_clean', cleanModelId: cleanId, ocrModelId: ocrId }).then(setEst).catch(() => setEst(null));
  }, [open, cleanId, ocrId, page.id]);
  const go = async () => {
    setSending(true);
    try {
      const p = await api.aiClean(page.id, { cleanModelId: cleanId, ocrModelId: ocrId });
      onDone(p);
      onClose();
      toast('已开始 AI 处理，完成后会让你对比两个版本', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <Modal
      open={open}
      title="AI 处理本页"
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" icon={<Sparkles className="w-4 h-4" />} loading={sending} disabled={!cleanId || !ocrId} onClick={go}>
            开始（约 {money(est?.total, 3)}）
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <div className="text-xs text-[#6E6E73] leading-relaxed">
          用 AI 模型把这一页的原图重新清理（去污渍、霉斑、褶皱），然后重新识别文字。完成后可以和现在的结果对比，<b>由你选择保留哪个</b>，现在的结果不会被直接覆盖。
        </div>
        {!cleanModels.length ? (
          <div className="text-xs text-[#C93400]">
            还没有可用的清理模型，
            <button className="underline font-semibold cursor-pointer" onClick={() => navigate('/settings')}>
              去配置
            </button>
          </div>
        ) : (
          <>
            <Field label="清理模型">
              <select className={inputCls} value={cleanId ?? ''} onChange={(e) => setCleanId(Number(e.target.value))}>
                {cleanModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}（{m.model}）
                  </option>
                ))}
              </select>
            </Field>
            <Field label="识别模型">
              <select className={inputCls} value={ocrId ?? ''} onChange={(e) => setOcrId(Number(e.target.value))}>
                {ocrModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}（{m.model}）
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        {est?.missing?.length ? <div className="text-[11px] text-[#C93400]">{est.missing.join('；')}，费用无法预估</div> : null}
        {page.edited && <div className="text-[11px] text-[#C93400]">这一页的文字你改过。如果选择保留 AI 版本，改动不会带过去。</div>}
      </div>
    </Modal>
  );
};

const ReocrDialog: React.FC<{ open: boolean; page: PageDetail; onClose: () => void; onDone: (p: PageDetail) => void }> = ({ open, page, onClose, onDone }) => {
  const { toast } = useUi();
  const models = useModels(open);
  const ocrModels = models.filter((m) => m.purpose === 'ocr' && m.enabled);
  const [ocrId, setOcrId] = useState<number | undefined>();
  const [est, setEst] = useState<Estimate | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (open && models.length) setOcrId((v) => v ?? (ocrModels.some((m) => m.id === page.task.ocrModelId) ? page.task.ocrModelId! : ocrModels[0]?.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, models]);
  useEffect(() => {
    if (open && ocrId) api.pageEstimate(page.id, { action: 'reocr', ocrModelId: ocrId }).then(setEst).catch(() => setEst(null));
  }, [open, ocrId, page.id]);
  const go = async () => {
    setSending(true);
    try {
      const p = await api.reocr(page.id, { ocrModelId: ocrId });
      onDone(p);
      onClose();
      toast('已开始重新识别', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <Modal
      open={open}
      title="重新识别"
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={sending} disabled={!ocrId} onClick={go}>
            重新识别（约 {money(est?.total, 3)}）
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <div className="text-xs text-[#6E6E73]">图片不变，用选择的模型重新识别文字。可以换一个识别效果更好的模型试试。</div>
        <Field label="识别模型">
          <select className={inputCls} value={ocrId ?? ''} onChange={(e) => setOcrId(Number(e.target.value))}>
            {ocrModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}（{m.model}）{m.enableThinking ? ' · 深度思考' : ''}
              </option>
            ))}
          </select>
        </Field>
        {(page.edited || page.status === 'approved') && (
          <div className="text-xs text-[#C93400] bg-[#FF9500]/10 rounded-lg px-3 py-2">
            {page.edited ? '这一页的文字你改过，重新识别会覆盖你的修改。' : ''}
            {page.status === 'approved' ? '这一页已通过，重新识别后需要重新审核。' : ''}
          </div>
        )}
      </div>
    </Modal>
  );
};

const SplitDialog: React.FC<{ open: boolean; page: PageDetail; onClose: () => void; onDone: (p: PageDetail) => void }> = ({ open, page, onClose, onDone }) => {
  const { toast } = useUi();
  const [ratio, setRatio] = useState(0.5);
  const [natW, setNatW] = useState(0);
  const [sending, setSending] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    if (open) setNatW(0);
  }, [open]);
  useEffect(() => {
    if (natW) setRatio(page.gutter ? Math.min(0.95, Math.max(0.05, page.gutter / natW)) : 0.5);
  }, [natW, page.gutter]);
  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setRatio(Math.min(0.9, Math.max(0.1, (clientX - r.left) / r.width)));
  };
  const go = async (mode: 'split' | 'merge') => {
    setSending(mode);
    try {
      const p = await api.resplit(page.id, { mode, ratio });
      toast(mode === 'merge' ? '已合成一页，正在重新处理' : '已重新拆页，两页都在重新处理', 'success');
      onDone(p);
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSending('');
    }
  };
  return (
    <Modal
      open={open}
      title="调整拆页"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          {page.side && (
            <Button loading={sending === 'merge'} onClick={() => go('merge')}>
              这是单页，不用拆
            </Button>
          )}
          <Button variant="primary" icon={<Scissors className="w-4 h-4" />} loading={sending === 'split'} onClick={() => go('split')}>
            {page.side ? '按这条线重新拆' : '按这条线拆成两页'}
          </Button>
        </>
      }
    >
      <div className="text-xs text-[#6E6E73] mb-3">拖动蓝线对准两页之间的中缝。右边的是前一页。调整后这张图拆出的两页都会重新清理和识别（会再产生一次费用），之前对这两页的修改不保留。</div>
      <div
        ref={box}
        className="relative select-none bg-[#F5F5F7] rounded-lg overflow-hidden cursor-ew-resize"
        onMouseDown={(e) => {
          dragging.current = true;
          move(e.clientX);
        }}
        onMouseMove={(e) => dragging.current && move(e.clientX)}
        onMouseUp={() => (dragging.current = false)}
        onMouseLeave={() => (dragging.current = false)}
      >
        <img src={pageImageUrl(page.id, 'origin', page.updatedAt)} alt="" draggable={false} className="block w-full h-auto max-h-[60vh] object-contain" onLoad={(e) => setNatW((e.target as HTMLImageElement).naturalWidth)} />
        <div className="absolute top-0 bottom-0 w-0.5 bg-[#0071E3] shadow-[0_0_0_1px_rgba(255,255,255,0.8)]" style={{ left: ratio * 100 + '%' }}>
          <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-1/2 w-6 h-10 rounded-full bg-[#0071E3] border-2 border-white flex items-center justify-center text-white text-[10px]">⇔</div>
        </div>
        <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/60 text-white text-[11px]">右页（在前）</div>
        <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-[11px]">左页</div>
      </div>
    </Modal>
  );
};

const PageEditDialog: React.FC<{ open: boolean; page: PageDetail; onClose: () => void; onSaved: (p: PageDetail) => void }> = ({ open, page, onClose, onSaved }) => {
  const { toast } = useUi();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setText(page.ocr.columns.map((c) => c.text).join('\n'));
  }, [open, page]);
  const lines = useMemo(() => text.split('\n'), [text]);
  const save = async () => {
    setSaving(true);
    try {
      const p = await api.saveText(page.id, lines);
      onSaved(p);
      toast('已保存', 'success');
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      title="整页编辑文字"
      onClose={onClose}
      width={640}
      footer={
        <>
          <div className="mr-auto self-center text-[11px] text-[#86868B]">共 {lines.filter((l) => l.trim()).length} 列</div>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="text-xs text-[#6E6E73] mb-2">一行就是原书的一列，从右往左第 1 列在最上面。改过的列，疑似错字标记会清除；空行会被删掉。</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full h-[50vh] px-3 py-2 text-[16px] leading-[1.9] bg-white border border-black/[0.12] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] font-serif"
      />
    </Modal>
  );
};
