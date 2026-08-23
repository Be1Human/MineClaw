/**
 * 火山引擎 Ark API Provider
 *
 * 注：目前 Ark 也兼容 OpenAI Chat Completions 协议，所以实现上直接复用 OpenAI 兼容流程。
 * 之所以保留独立 provider，是为了：
 *   1. 通过 matches() 显式声明优先级（Ark 域名优先匹配）
 *   2. 未来 Ark 协议如果偏离 OpenAI（如增加 reasoning_content），可在此覆盖
 */
import { OpenAICompatibleProvider } from './openaiCompatibleProvider.js';

export class ArkProvider extends OpenAICompatibleProvider {
  override readonly name = 'volcengine_ark';

  override matches(baseUrl: string): boolean {
    return baseUrl.includes('volces.com') || baseUrl.includes('volcengine');
  }
}
