/** 从粘贴的 curl 示例里识别 Base URL / API Key / model / prompt */
export function parseCurlExample(raw: string): {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  prompt?: string;
  error?: string;
} {
  const text = String(raw || '')
    .replace(/\\\r?\n/g, ' ')
    .trim();
  if (!text) return { error: '请先粘贴 curl' };
  if (!/\bcurl\b/i.test(text)) return { error: '未识别到 curl 命令' };

  let url = '';
  const urlFlag = text.match(
    /curl\s+(?:--location|-L)?\s*(?:-X\s+\w+\s+)?['"]?(https?:\/\/[^'"\s]+)['"]?/i,
  );
  if (urlFlag) url = urlFlag[1];
  if (!url) {
    const m = text.match(/https?:\/\/[^'"\s]+/i);
    if (m) url = m[0];
  }

  let apiKey = '';
  const bearer = text.match(/Authorization:\s*Bearer\s+([^'"\s]+)/i);
  if (bearer) apiKey = bearer[1];
  if (!apiKey) {
    const h = text.match(/-H\s+['"]Authorization:\s*Bearer\s+([^'"\s]+)['"]/i);
    if (h) apiKey = h[1];
  }
  if (!apiKey) {
    const h2 = text.match(/--header\s+['"]Authorization:\s*Bearer\s+([^'"\s]+)['"]/i);
    if (h2) apiKey = h2[1];
  }

  let jsonStr = '';
  const dataMatch =
    text.match(/(?:--data-raw|--data|-d)\s+'([\s\S]*?)'/) ||
    text.match(/(?:--data-raw|--data|-d)\s+"([\s\S]*?)"/) ||
    text.match(/(?:--data-raw|--data|-d)\s+(\{[\s\S]*\})/);
  if (dataMatch) jsonStr = dataMatch[1];

  let model = '';
  let prompt = '';
  if (jsonStr) {
    try {
      const cleaned = jsonStr
        .replace(/\$\{?[A-Z0-9_]+\}?/g, '""')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      const j = JSON.parse(cleaned);
      model = String(j.model || j?.input?.model || '').trim();
      prompt = String(j.prompt || '').trim();
      if (!prompt && Array.isArray(j?.input?.messages)) {
        const contents = j.input.messages.flatMap((m: any) =>
          Array.isArray(m?.content) ? m.content : [],
        );
        const textPart = contents.find((c: any) => c && typeof c.text === 'string');
        if (textPart) prompt = String(textPart.text).trim();
      }
    } catch {
      const mm = jsonStr.match(/"model"\s*:\s*"([^"]+)"/);
      if (mm) model = mm[1];
      const pp = jsonStr.match(/"prompt"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (pp) {
        try {
          prompt = JSON.parse('"' + pp[1] + '"');
        } catch {
          prompt = pp[1];
        }
      }
      const tp = jsonStr.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (!prompt && tp) {
        try {
          prompt = JSON.parse('"' + tp[1] + '"');
        } catch {
          prompt = tp[1];
        }
      }
    }
  }

  let baseUrl = url;
  if (baseUrl) {
    baseUrl = baseUrl.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(baseUrl)) {
      baseUrl = baseUrl.replace(/\/chat\/completions$/i, '');
    }
    if (/\/images\/generations$/i.test(baseUrl)) {
      baseUrl = baseUrl.replace(/\/images\/generations$/i, '');
    }
  }

  if (!baseUrl && !apiKey && !model) return { error: '未能从 curl 中识别出可用参数' };
  return {
    baseUrl: baseUrl || undefined,
    apiKey: apiKey || undefined,
    model: model || undefined,
    prompt: prompt || undefined,
  };
}
