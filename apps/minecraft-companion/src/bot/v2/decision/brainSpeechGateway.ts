import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import { sanitizeSpeech } from '../infra/sanitizeSpeech.js';

export type BrainSpeechMode = 'say' | 'ask_master';

type ActiveTurn = {
  turnId: string;
  epoch: number;
};

/**
 * The only character-speech commit point. A caller must hold the currently
 * active MainBrain turn; stale and out-of-turn requests are rejected.
 */
export class BrainSpeechGateway {
  private epoch = 0;
  private decisionSeq = 0;
  private active: ActiveTurn | null = null;

  constructor(
    private readonly bus: EventBusV2,
    private readonly game: GameAdapter,
    private readonly isEmbodied: () => boolean,
  ) {}

  beginTurn(turnId: string): number {
    this.active = { turnId, epoch: this.epoch };
    return this.epoch;
  }

  endTurn(turnId: string): void {
    if (this.active?.turnId === turnId) this.active = null;
  }

  invalidate(reason: string): number {
    this.epoch += 1;
    this.active = null;
    this.bus.publish('brain.speech_epoch_changed', 'info', { epoch: this.epoch, reason });
    return this.epoch;
  }

  commit(text: string, mode: BrainSpeechMode = 'say'): boolean {
    const active = this.active;
    const clean = sanitizeSpeech(text);
    if (!active || active.epoch !== this.epoch || !clean) {
      this.bus.publish('brain.speech_rejected', 'recoverable', {
        reason: !active ? 'no_active_brain_turn' : active.epoch !== this.epoch ? 'stale_turn' : 'empty_text',
        turnId: active?.turnId ?? null,
        epoch: this.epoch,
      });
      return false;
    }

    const decisionId = `speech-${++this.decisionSeq}-${Date.now()}`;
    if (this.isEmbodied()) this.game.chat(clean);
    this.bus.publish('speech.committed', 'info', {
      text: clean,
      mode,
      turnId: active.turnId,
      decisionId,
      epoch: active.epoch,
    });
    return true;
  }
}
