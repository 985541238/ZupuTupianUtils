import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { AlertCircle, ExternalLink } from 'lucide-react';
import { AiModalShell, WizardPlatform } from './AiSetupWizard';

export type AiProblem = {
  taskId?: string;
  taskName?: string;
  /** 服务端给的说明；「\n详情：」后面是平台原始信息 */
  message: string;
  /** 类型:平台，如 arrears:ark */
  errorCode?: string | null;
  /** 已处理好的页数，>0 时允许先去审核这些页 */
  readyPages?: number;
};

/** 升级前产生的错误没有 errorCode：按文字推断类型（平台不明时留空） */
export function inferErrorCode(msg?: string | null): string | null {
  const m = String(msg || '').toLowerCase();
  if (!m) return null;
  const plat = /volces|火山|ark/.test(m) ? 'ark' : /dashscope|aliyun|阿里/.test(m) ? 'aliyun' : '';
  if (/overdue|arrear|欠费|余额不足|insufficient/.test(m)) return 'arrears:' + plat;
  if (/api key|401|403|拒绝访问|unauthori/.test(m)) return 'auth:' + plat;
  if (/404|model.*not|不存在|未开通/.test(m)) return 'model:' + plat;
  if (/429|限流|rate.?limit/.test(m)) return 'quota:' + plat;
  if (/模型|大模型|图片处理模型/.test(m)) return 'config:' + plat;
  return null;
}

const TITLES: Record<string, string> = {
  arrears: '模型平台账户余额不足',
  auth: 'API Key 不可用',
  model: '模型不可用',
  quota: '调用太频繁，被平台限流',
  param: '模型不接受这张图片',
  noimage: '模型没有返回图片',
  config: '大模型配置有问题',
};

/**
 * 大模型处理出错时弹出：用一句话说清原因，并给出能直接点的处理办法
 * （去充值 / 重新填 Key / 换模型 / 继续处理），技术细节默认收起。
 */
export const AiProblemDialog: React.FC<{
  problem: AiProblem | null;
  onClose: () => void;
  onOpenSetup: (platform: string | null, step: 1 | 2 | 3) => void;
  onRetry?: (taskId: string) => void;
  onReviewAnyway?: (taskId: string) => void;
}> = ({ problem, onClose, onOpenSetup, onRetry, onReviewAnyway }) => {
  const [platforms, setPlatforms] = useState<WizardPlatform[]>([]);
  useEffect(() => {
    if (!problem) return;
    api
      .getSettings()
      .then((d) => setPlatforms(d.platforms || []))
      .catch(() => setPlatforms([]));
  }, [problem]);
  if (!problem) return null;

  const [kind, code] = String(problem.errorCode || 'config:').split(':');
  const p = platforms.find((x) => x.code === code) || null;
  const [main, detail] = String(problem.message || '').split('\n详情：');
  const text = main.replace(/^已暂停处理：/, '');
  const btn = 'px-4 py-2 text-xs font-semibold rounded-xl cursor-pointer inline-flex items-center gap-1.5 whitespace-nowrap';
  const primary = `${btn} bg-[#0071E3] text-white`;
  const plain = `${btn} border border-black/[0.08] bg-white hover:bg-[#F5F5F7] text-[#1D1D1F]`;
  const taskId = problem.taskId;

  const actions: React.ReactNode[] = [];
  if (kind === 'arrears') {
    if (p) {
      actions.push(
        <a key="pay" href={p.guide.billingUrl} target="_blank" rel="noreferrer" className={plain}>
          去{p.name}充值 <ExternalLink className="w-3 h-3" />
        </a>,
      );
    }
    actions.push(
      <button key="switch" type="button" className={plain} onClick={() => onOpenSetup(null, 1)}>
        换一个平台
      </button>,
    );
    if (taskId && onRetry) {
      actions.push(
        <button key="retry" type="button" className={primary} onClick={() => onRetry(taskId)}>
          我已充值，继续处理
        </button>,
      );
    }
  } else if (kind === 'auth') {
    actions.push(
      <button key="key" type="button" className={primary} onClick={() => onOpenSetup(code || null, 2)}>
        重新填写 Key
      </button>,
    );
  } else if (kind === 'model' || kind === 'param' || kind === 'noimage') {
    if (kind === 'model' && p) {
      actions.push(
        <a key="open" href={p.modelsUrl || p.consoleUrl} target="_blank" rel="noreferrer" className={plain}>
          去控制台开通模型 <ExternalLink className="w-3 h-3" />
        </a>,
      );
    }
    actions.push(
      <button key="model" type="button" className={primary} onClick={() => onOpenSetup(code || null, 3)}>
        换一个推荐模型
      </button>,
    );
  } else if (kind === 'quota') {
    if (taskId && onRetry) {
      actions.push(
        <button key="retry" type="button" className={primary} onClick={() => onRetry(taskId)}>
          继续处理
        </button>,
      );
    }
  } else {
    actions.push(
      <button key="setup" type="button" className={primary} onClick={() => onOpenSetup(code || null, 1)}>
        打开引导配置
      </button>,
    );
  }

  return (
    <AiModalShell
      title={TITLES[kind] || TITLES.config}
      subtitle={problem.taskName ? `任务「${problem.taskName}」已暂停，处理好原因后可继续，已处理好的页不会重复处理。` : undefined}
      onClose={onClose}
      z="z-[96]"
      footer={
        <>
          <button type="button" onClick={onClose} className="px-3.5 py-2 text-xs text-[#86868B] cursor-pointer mr-auto whitespace-nowrap">
            关闭
          </button>
          {taskId && onReviewAnyway && (problem.readyPages || 0) > 0 ? (
            <button type="button" className={plain} onClick={() => onReviewAnyway(taskId)}>
              先审核已处理的 {problem.readyPages} 页
            </button>
          ) : null}
          {actions}
        </>
      }
    >
      <div className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-[#FFF8EC] border border-[#FF9500]/20">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#C93400]" />
        <p className="text-xs text-[#1D1D1F] leading-relaxed">{text}</p>
      </div>
      {detail ? (
        <details className="text-[11px] text-[#86868B]">
          <summary className="cursor-pointer select-none">技术详情（联系平台客服时可提供）</summary>
          <div className="mt-1.5 p-2.5 rounded-xl bg-[#F5F5F7] font-mono break-all">{detail}</div>
        </details>
      ) : null}
    </AiModalShell>
  );
};
