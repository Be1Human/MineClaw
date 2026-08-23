/**
 * say 文本净化 · FEAT-WEBUI-09
 *
 * 所有「给主人的话」在出口（ctx.speak / say 原子）发出前过这里，确保
 * 思考(<think>)、系统提示词碎片、LLM 误把动作当文字吐的 JSON 不混进回答气泡。
 *
 * 纯函数、无副作用。放 infra 层 → atomic 与 decision 两侧都可引用，不破坏分层。
 */
export function sanitizeSpeech(text: string | null | undefined): string {
  if (!text) return '';
  let out = text;
  // 1) 剥成对 <think>…</think>（含跨行 · 大小写不敏感）
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 2) 剥只开不闭的 <think> 残段（思考模型偶发截断）
  out = out.replace(/<think>[\s\S]*$/i, '');
  // 3) 剥 LLM 误把动作当文字吐的 JSON 对象段（{"thought"|"action"|"tool"|"input":…}）
  out = out.replace(/\{\s*"(?:thought|action|tool|input)"[\s\S]*\}/g, '');
  // 4) 收敛多余空白
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}
