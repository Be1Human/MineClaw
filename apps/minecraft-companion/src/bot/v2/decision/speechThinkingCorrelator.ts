/**
 * SpeechThinkingCorrelator · FEAT-WEBUI-09
 *
 * 单一职责：把「本轮思考(l7.thought)」绑到大脑已提交的回答(speech.committed)上，
 * 让 UI 聊天面板能把一句干净回答和它背后的思考过程对应起来。
 *
 * 喂入 v2 总线事件（经 runtime.onEvent），只有命中 speech.committed 才回调 UI。
 */

export interface ChatMeta {
  /** 本轮 turn 标识（同一轮多次 say 共享） */
  turnId?: string;
  /** 本轮截至当前累积的思考（多行 join），无则 undefined */
  thinking?: string;
}

export class SpeechThinkingCorrelator {
  private turnSeq = 0;
  private currentTurnId = '';
  private thoughts: string[] = [];

  constructor(private readonly emit: (text: string, meta: ChatMeta) => void) {}

  /** runtime 把每个 v2 总线事件喂进来 */
  observe(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case 'l7.turn_started':
      case 'l7.idle_turn_started':
        this.turnSeq += 1;
        this.currentTurnId = `turn-${this.turnSeq}`;
        this.thoughts = [];
        break;

      case 'l7.turn_finished':
      case 'l7.idle_turn_finished':
        // turn 收尾后清空，turn 外的旁白/反射 say 不带残留思考
        this.thoughts = [];
        this.currentTurnId = '';
        break;

      case 'l7.thought': {
        const t = typeof payload.thought === 'string' ? payload.thought.trim() : '';
        if (t) this.thoughts.push(t);
        break;
      }

      case 'speech.committed': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        this.emit(text, {
          turnId: typeof payload.turnId === 'string' ? payload.turnId : this.currentTurnId || undefined,
          thinking: this.thoughts.length > 0 ? this.thoughts.join('\n') : undefined,
        });
        break;
      }
    }
  }
}
