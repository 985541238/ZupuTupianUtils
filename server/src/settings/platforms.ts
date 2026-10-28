/**
 * 平台目录：与《OCR / 大模型图片理解 报价对比》表中的厂商一一对应。
 * 字段、地址参考各家官方文档；secret=true 的字段加密入库，接口只回显掩码。
 *
 * imageEdit：该平台能否做「图生图」（图片处理）。
 *   - ark      火山方舟 Seedream：POST {base}/images/generations，image 支持 base64 data URI
 *   - aliyun   阿里云百炼：POST {origin}/api/v1/services/aigc/multimodal-generation/generation，image 支持 base64
 *   - baidu    百度千帆：POST {base}/images/edits（OpenAI 风格）
 *   - tencent  腾讯混元生图 3.0（TokenHub 同步接口）：POST {base}/images/generations，images 为数组
 *   - zhipu / deepseek：官方无图生图接口，仅供后续文字识别使用
 */
export type PlatformCode = 'ark' | 'aliyun' | 'baidu' | 'tencent' | 'zhipu' | 'deepseek';

export interface PlatformField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  /** 通用 = 大模型调用；ocr = 传统 OCR 接口（后续接入文字识别时使用） */
  scope: 'general' | 'ocr';
}

export interface PlatformDef {
  code: PlatformCode;
  name: string;
  /** 默认服务地址（大模型调用） */
  defaultBaseUrl: string;
  docsUrl: string;
  consoleUrl: string;
  fields: PlatformField[];
  imageEdit: {
    supported: boolean;
    /** 不支持时的原因，展示给用户 */
    reason?: string;
    /** 推荐的图生图模型代码（可改） */
    suggestedModels?: string[];
    /** 官方是否明确支持 base64 传图；不确定的平台可切到「公网链接」方式 */
    base64Documented?: boolean;
  };
}

export const PLATFORMS: PlatformDef[] = [
  {
    code: 'ark',
    name: '火山方舟',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    docsUrl: 'https://www.volcengine.com/docs/82379/1541523',
    consoleUrl: 'https://console.volcengine.com/ark',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, placeholder: '方舟控制台 → API Key 管理', scope: 'general' },
    ],
    imageEdit: {
      supported: true,
      suggestedModels: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-4-5-251128'],
      base64Documented: true,
    },
  },
  {
    code: 'aliyun',
    name: '阿里云百炼',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-image-edit-api',
    consoleUrl: 'https://bailian.console.aliyun.com',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        secret: true,
        placeholder: 'sk-...',
        help: '百炼控制台 → API-KEY。服务地址也可填业务空间地址 https://<空间>.cn-beijing.maas.aliyuncs.com',
        scope: 'general',
      },
      { key: 'accessKeyId', label: 'AccessKey ID', placeholder: 'LTAI...', help: '「全文识别高精版」OCR 使用，可后填', scope: 'ocr' },
      { key: 'accessKeySecret', label: 'AccessKey Secret', secret: true, scope: 'ocr' },
    ],
    imageEdit: {
      supported: true,
      suggestedModels: ['qwen-image-2.0-pro', 'qwen-image-edit-plus', 'qwen-image-edit'],
      base64Documented: true,
    },
  },
  {
    code: 'baidu',
    name: '百度智能云',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan-docs/s/bm8wv3h6f',
    consoleUrl: 'https://console.bce.baidu.com/qianfan',
    fields: [
      { key: 'apiKey', label: '千帆 API Key', secret: true, placeholder: 'bce-v3/...', help: '千帆控制台 → API Key', scope: 'general' },
      { key: 'ocrApiKey', label: '文字识别 API Key', placeholder: '文字识别应用的 API Key', help: '「通用文字识别（高精度含位置版）」使用，可后填', scope: 'ocr' },
      { key: 'ocrSecretKey', label: '文字识别 Secret Key', secret: true, scope: 'ocr' },
    ],
    imageEdit: {
      supported: true,
      suggestedModels: ['qwen-image-edit'],
      base64Documented: false,
    },
  },
  {
    code: 'tencent',
    name: '腾讯云',
    defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
    docsUrl: 'https://cloud.tencent.com/document/product/1668/129429',
    consoleUrl: 'https://console.cloud.tencent.com/hunyuan',
    fields: [
      { key: 'apiKey', label: 'TokenHub API Key', secret: true, help: '混元生图 3.0 同步接口使用 MaaS（TokenHub）的 API Key', scope: 'general' },
      { key: 'secretId', label: 'SecretId', placeholder: 'AKID...', help: '「通用文字识别（高精度版）」使用，可后填', scope: 'ocr' },
      { key: 'secretKey', label: 'SecretKey', secret: true, scope: 'ocr' },
      { key: 'region', label: '地域', placeholder: 'ap-guangzhou', scope: 'ocr' },
    ],
    imageEdit: {
      supported: true,
      suggestedModels: ['hy-image-v3.0'],
      base64Documented: false,
    },
  },
  {
    code: 'zhipu',
    name: '智谱 AI',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docsUrl: 'https://docs.bigmodel.cn',
    consoleUrl: 'https://open.bigmodel.cn',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true, scope: 'general' }],
    imageEdit: { supported: false, reason: '官方图像接口只有文生图，不能传入原图做图片处理；可用于后续文字识别' },
  },
  {
    code: 'deepseek',
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
    consoleUrl: 'https://platform.deepseek.com',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true, placeholder: 'sk-...', scope: 'general' }],
    imageEdit: { supported: false, reason: '没有出图接口；可用于后续文字识别' },
  },
];

export function getPlatformDef(code?: string | null): PlatformDef | null {
  return PLATFORMS.find((p) => p.code === code) || null;
}

/** 老数据没有 platform 字段时，按地址推断 */
export function guessPlatform(baseUrl?: string | null): PlatformCode | null {
  const b = (baseUrl || '').toLowerCase();
  if (!b) return null;
  if (b.includes('volces.com')) return 'ark';
  if (b.includes('aliyuncs.com')) return 'aliyun';
  if (b.includes('baidubce.com')) return 'baidu';
  if (b.includes('tencentmaas.com') || b.includes('tencent')) return 'tencent';
  if (b.includes('bigmodel.cn')) return 'zhipu';
  if (b.includes('deepseek.com')) return 'deepseek';
  return null;
}
