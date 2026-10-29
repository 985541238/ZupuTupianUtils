/**
 * 平台目录：与《OCR / 大模型图片理解 报价对比》表中的厂商一一对应。
 * 字段、地址参考各家官方文档；secret=true 的字段加密入库，接口只回显掩码。
 *
 * imageEdit：该平台能否做「图生图」（图片处理）。
 *   - siliconflow 硅基流动：POST {base}/images/generations，image 为单个 Base64 Data URL 字符串
 *   - ark      火山方舟 Seedream：POST {base}/images/generations，image 支持 base64 data URI
 *   - aliyun   阿里云百炼：POST {origin}/api/v1/services/aigc/multimodal-generation/generation，image 支持 base64
 *   - baidu    百度千帆：POST {base}/images/edits（OpenAI 风格）
 *   - tencent  腾讯混元生图 3.0（TokenHub 同步接口）：POST {base}/images/generations，images 为数组
 *   - zhipu / deepseek：官方无图生图接口，仅供后续文字识别使用
 */
export type PlatformCode = 'siliconflow' | 'ark' | 'aliyun' | 'baidu' | 'tencent' | 'zhipu' | 'deepseek';

export interface PlatformField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  /** 通用 = 大模型调用；ocr = 传统 OCR 接口（后续接入文字识别时使用） */
  scope: 'general' | 'ocr';
  /** 去哪里获取：直达链接 + 一句话说明（给不熟悉控制台的用户） */
  link?: string;
  howTo?: string;
}

export interface PlatformDef {
  code: PlatformCode;
  name: string;
  /** 聚合平台：默认展示、推荐使用；其余直连平台在界面上默认收起 */
  featured?: boolean;
  /** 一句话介绍（界面展示） */
  intro?: string;
  /** 平台计价币种，默认人民币；美元平台按「通用设置」里的汇率折算成人民币记账 */
  currency?: 'CNY' | 'USD';
  /** 默认服务地址（大模型调用） */
  defaultBaseUrl: string;
  docsUrl: string;
  consoleUrl: string;
  /** 服务地址说明（多数人保持默认即可） */
  baseUrlHelp: string;
  /** 开通 / 管理模型的控制台页面 */
  modelsUrl: string;
  fields: PlatformField[];
  /** 引导配置用：去哪拿 Key、怎么充值、怎么开通模型（普通用户能照做的步骤） */
  guide: {
    keyUrl: string;
    billingUrl: string;
    steps: string[];
    modelTip?: string;
  };
  imageEdit: {
    supported: boolean;
    /** 不支持时的原因，展示给用户 */
    reason?: string;
    /** 推荐的图生图模型代码（可改） */
    suggestedModels?: string[];
    /** 推荐模型的参考单价（平台币种/张），新建模型时预填 */
    referencePrices?: Record<string, number>;
    /** 官方是否明确支持 base64 传图；不确定的平台可切到「公网链接」方式 */
    base64Documented?: boolean;
  };
}

export const PLATFORMS: PlatformDef[] = [
  {
    // 硅基流动 SiliconFlow：一个 Key 调用通义千问、GLM、DeepSeek 等模型，人民币计价。
    // 文档 https://docs.siliconflow.cn/docs/api/images-generations-post
    // 出图：POST {base}/images/generations，JSON；image 为单个字符串（Base64 Data URL 或公网链接，不能是数组）
    //       Qwen/Qwen-Image-Edit(-2509) 不需要 image_size（按原图比例出图），其他模型必填 image_size
    //       返回 images[0].url，链接 1 小时内有效，需立即下载；请求头 X-Enable-Watermark: 0 关闭显式「AI 生成」水印
    // 模型列表：GET {base}/models?sub_type=image-to-image
    // 看图识别：POST {base}/chat/completions（OpenAI 兼容，image_url 支持 Base64）
    code: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    featured: true,
    currency: 'CNY',
    intro: '一个 Key 即可调用通义千问图片编辑、GLM、DeepSeek 等模型，按人民币计费，图片处理和文字识别都能用',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    docsUrl: 'https://docs.siliconflow.cn/docs/api/images-generations-post',
    consoleUrl: 'https://cloud.siliconflow.cn/',
    baseUrlHelp: '保持默认即可（https://api.siliconflow.cn/v1）。',
    modelsUrl: 'https://www.siliconflow.cn/pricing',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        secret: true,
        placeholder: 'sk-...',
        scope: 'general',
        link: 'https://cloud.siliconflow.cn/account/ak',
        howTo: '硅基流动控制台 →「账户管理 → API 密钥」→「新建 API 密钥」→ 复制（sk- 开头）',
      },
    ],
    guide: {
      keyUrl: 'https://cloud.siliconflow.cn/account/ak',
      billingUrl: 'https://cloud.siliconflow.cn/',
      steps: [
        '注册 / 登录硅基流动（手机号即可）',
        '完成实名认证（平台要求实名后才能调用模型；认证后可领代金券）',
        '打开「账户管理 → API 密钥」页面（点下面的按钮直达），点「新建 API 密钥」并复制',
        '在「账户管理 → 余额充值」确认有余额或代金券，否则会提示余额不足',
      ],
      modelTip: '推荐 Qwen/Qwen-Image-Edit-2509（通义千问图片编辑），约 ¥0.3/张；价格以硅基流动价格页为准',
    },
    imageEdit: {
      supported: true,
      suggestedModels: ['Qwen/Qwen-Image-Edit-2509', 'Qwen/Qwen-Image-Edit'],
      // 参考单价（元/张，取自 siliconflow.cn/pricing 2026-10；以平台实际为准，用户可改）
      referencePrices: {
        'Qwen/Qwen-Image-Edit-2509': 0.3,
        'Qwen/Qwen-Image-Edit': 0.3,
        'Kwai-Kolors/Kolors': 0,
      },
      base64Documented: true,
    },
  },
  {
    code: 'ark',
    name: '火山方舟',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    docsUrl: 'https://ark.volcengine.com/region:cn-beijing/docs/seedream-5-0-pro',
    consoleUrl: 'https://ark.volcengine.com/region:cn-beijing/overview',
    baseUrlHelp: '保持默认即可（北京地域）。只有使用其他地域时才需要改。',
    modelsUrl: 'https://ark.volcengine.com/region:cn-beijing/overview',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, placeholder: '方舟控制台 → API Key 管理', scope: 'general', link: 'https://ark.volcengine.com/region:cn-beijing/apikey', howTo: '火山方舟控制台 →「API Key 管理」→「创建 API Key」→ 复制' },
    ],
    guide: {
      keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apikey',
      billingUrl: 'https://console.volcengine.com/finance/',
      steps: [
        '用火山引擎账号登录（没有就先注册并完成实名认证）',
        '打开「火山方舟」控制台的「API Key 管理」页（点下面的按钮直达）',
        '点「创建 API Key」，创建后点复制',
        '确认账户有余额（费用中心充值），否则会提示欠费',
      ],
      modelTip: '首次使用需在方舟控制台左侧「开通管理」里开通 Seedream 5.0 图片生成模型',
    },
    imageEdit: {
      supported: true,
      suggestedModels: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'],
      base64Documented: true,
    },
  },
  {
    code: 'aliyun',
    name: '阿里云百炼',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-image-edit-api',
    consoleUrl: 'https://bailian.console.aliyun.com/cn-beijing/home',
    baseUrlHelp: '一般保持默认（官方说明旧域名仍可正常使用）。如需使用业务空间专属地址，填 https://<业务空间ID>.cn-beijing.maas.aliyuncs.com，业务空间 ID 在百炼控制台「业务空间管理」里查看。',
    modelsUrl: 'https://bailian.console.aliyun.com/?tab=model#/model-market',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        secret: true,
        placeholder: 'sk-...',
        scope: 'general', link: 'https://bailian.console.aliyun.com/?tab=model#/api-key', howTo: '百炼控制台 → 右上角头像或左侧「API-KEY」→「创建 API-KEY」→ 复制' },
      { key: 'accessKeyId', label: 'AccessKey ID', placeholder: 'LTAI...', help: '「全文识别高精版」OCR 使用，可后填', scope: 'ocr', link: 'https://ram.console.aliyun.com/manage/ak', howTo: '阿里云「AccessKey 管理」→ 创建 AccessKey（建议用 RAM 子账号）→ 复制 ID' },
      { key: 'accessKeySecret', label: 'AccessKey Secret', secret: true, scope: 'ocr', link: 'https://ram.console.aliyun.com/manage/ak', howTo: '与 AccessKey ID 一起生成，只在创建时显示一次，请当场复制保存' },
    ],
    guide: {
      keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
      billingUrl: 'https://billing-cost.console.aliyun.com/',
      steps: [
        '用阿里云账号登录（需完成实名认证）',
        '打开「阿里云百炼」控制台，首次进入按提示开通服务',
        '进入「API-KEY」页面，点「创建 API-KEY」，创建后复制',
        '确认账户有余额或免费额度，否则会提示欠费',
      ],
      modelTip: '百炼开通后即可使用千问图像 qwen-image-2.0 系列（新用户通常有免费额度）',
    },
    imageEdit: {
      supported: true,
      suggestedModels: ['qwen-image-2.0-pro', 'qwen-image-2.0'],
      base64Documented: true,
    },
  },
  {
    code: 'baidu',
    name: '百度智能云',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan-docs/s/bm8wv3h6f',
    consoleUrl: 'https://console.bce.baidu.com/qianfan',
    baseUrlHelp: '保持默认即可。',
    modelsUrl: 'https://console.bce.baidu.com/qianfan/modelcenter/model/buildIn/list',
    fields: [
      { key: 'apiKey', label: '千帆 API Key', secret: true, placeholder: 'bce-v3/...', scope: 'general', link: 'https://console.bce.baidu.com/qianfan/ais/console/apiKey', howTo: '千帆控制台 →「API Key」→「创建 API Key」→ 复制（以 bce-v3/ 开头）' },
      { key: 'ocrApiKey', label: '文字识别 API Key', placeholder: '文字识别应用的 API Key', help: '「通用文字识别（高精度含位置版）」使用，可后填', scope: 'ocr', link: 'https://console.bce.baidu.com/ai/#/ai/ocr/app/list', howTo: '文字识别控制台 →「应用列表」→ 创建应用 → 复制 API Key' },
      { key: 'ocrSecretKey', label: '文字识别 Secret Key', secret: true, scope: 'ocr', link: 'https://console.bce.baidu.com/ai/#/ai/ocr/app/list', howTo: '同一个应用里的 Secret Key，点「显示」后复制' },
    ],
    guide: {
      keyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/apiKey',
      billingUrl: 'https://console.bce.baidu.com/billing/',
      steps: [
        '用百度智能云账号登录（需完成实名认证）',
        '打开「千帆」控制台，首次进入按提示开通服务',
        '在千帆「API Key」页面点「创建 API Key」，创建后复制（以 bce-v3/ 开头）',
        '确认账户有余额，否则会提示欠费',
      ],
      modelTip: '需在千帆控制台确认 qwen-image-edit 等图像编辑模型可用',
    },
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
    consoleUrl: 'https://console.cloud.tencent.com/tokenhub/',
    baseUrlHelp: '保持默认即可（混元生图 3.0 同步接口）。',
    modelsUrl: 'https://console.cloud.tencent.com/tokenhub/',
    fields: [
      { key: 'apiKey', label: 'TokenHub API Key', secret: true, help: '混元生图 3.0 同步接口使用 MaaS（TokenHub）的 API Key', scope: 'general', link: 'https://console.cloud.tencent.com/tokenhub/apikey', howTo: 'TokenHub 控制台 →「API Key 管理」→ 选地域 →「创建 API Key」→ 复制' },
      { key: 'secretId', label: 'SecretId', placeholder: 'AKID...', help: '「通用文字识别（高精度版）」使用，可后填', scope: 'ocr', link: 'https://console.cloud.tencent.com/cam/capi', howTo: '腾讯云「API 密钥管理」→「新建密钥」→ 复制 SecretId' },
      { key: 'secretKey', label: 'SecretKey', secret: true, scope: 'ocr', link: 'https://console.cloud.tencent.com/cam/capi', howTo: '与 SecretId 一起生成，点「显示」后复制' },
      { key: 'region', label: '地域', placeholder: 'ap-guangzhou', scope: 'ocr', link: 'https://cloud.tencent.com/document/product/866', howTo: '文字识别服务所在地域，一般填 ap-guangzhou（广州）即可' },
    ],
    guide: {
      keyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey',
      billingUrl: 'https://console.cloud.tencent.com/expense/overview',
      steps: [
        '用腾讯云账号登录（需完成实名认证）',
        '打开「大模型服务平台 TokenHub」控制台的「API Key 管理」页（点下面的按钮直达）',
        '页面上方选地域，点「创建 API Key」，填名称后确定并复制',
        '确认账户有余额，否则会提示欠费',
      ],
      modelTip: '需在 TokenHub 中开通「混元生图 3.0」（hy-image-v3.0）',
    },
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
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/quick-start',
    consoleUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    baseUrlHelp: '保持默认即可。',
    modelsUrl: 'https://docs.bigmodel.cn',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true, scope: 'general', link: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', howTo: '智谱开放平台 →「API Keys」→ 添加新的 API Key → 复制' }],
    guide: {
      keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
      billingUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
      steps: ['登录智谱开放平台', '进入「API Keys」页面创建并复制 Key'],
    },
    imageEdit: { supported: false, reason: '官方图像接口只有文生图，不能传入原图做图片处理；可用于后续文字识别' },
  },
  {
    code: 'deepseek',
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
    consoleUrl: 'https://platform.deepseek.com',
    baseUrlHelp: '保持默认即可。',
    modelsUrl: 'https://platform.deepseek.com/usage',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true, placeholder: 'sk-...', scope: 'general', link: 'https://platform.deepseek.com/api_keys', howTo: 'DeepSeek 开放平台 →「API keys」→ 创建 → 复制' }],
    guide: {
      keyUrl: 'https://platform.deepseek.com/api_keys',
      billingUrl: 'https://platform.deepseek.com/top_up',
      steps: ['登录 DeepSeek 开放平台', '进入「API Keys」页面创建并复制 Key'],
    },
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
  if (b.includes('siliconflow')) return 'siliconflow';
  if (b.includes('volces.com')) return 'ark';
  if (b.includes('aliyuncs.com')) return 'aliyun';
  if (b.includes('baidubce.com')) return 'baidu';
  if (b.includes('tencentmaas.com') || b.includes('tencent')) return 'tencent';
  if (b.includes('bigmodel.cn')) return 'zhipu';
  if (b.includes('deepseek.com')) return 'deepseek';
  return null;
}
