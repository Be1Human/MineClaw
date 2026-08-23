/**
 * NarrationHub + TemplateRenderer 单测 · FEAT-NARR-01 (S1)
 * Framework: node:test + node:assert/strict
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NarrationHub } from '../../../../../../apps/minecraft-companion/src/bot/v2/narration/narrationHub.js';
import { TemplateRenderer } from '../../../../../../apps/minecraft-companion/src/bot/v2/narration/templateRenderer.js';
import type { SpeechIntent } from '../../../../../../apps/minecraft-companion/src/bot/v2/narration/types.js';
import { NoticeLog } from '../../../../../../apps/minecraft-companion/src/bot/v2/narration/noticeLog.js';

function makeHub(opts?: {
  ownerActive?: boolean;
  now?: () => number;
  cfg?: { dedupeWindowMs?: number; ownerActiveSuppressBelow?: number };
}) {
  const notices: Array<{ source: string; detail: string; urgency: number; wake: boolean }> = [];
  const hub = new NarrationHub({
    submitNotice: notice => notices.push(notice),
    renderer: new TemplateRenderer(),
    isOwnerActive: () => opts?.ownerActive ?? false,
    now: opts?.now,
    cfg: opts?.cfg,
  });
  return { hub, said: notices };
}

const intent = (p: Partial<SpeechIntent>): SpeechIntent => ({
  source: 'test', topic: 'danger_flee', urgency: 50, ...p,
});

describe('TemplateRenderer', () => {
  test('已知 topic 出措辞', () => {
    const r = new TemplateRenderer();
    assert.match(r.render(intent({ topic: 'gather_done', data: { material: '橡木', have: 10 } })), /橡木.*10/);
  });
  test('未知 topic 返回空串、不抛', () => {
    const r = new TemplateRenderer();
    assert.equal(r.render(intent({ topic: '__nope__' })), '');
  });
  test('nav_timeout 只陈述超时，不推断目标过远', () => {
    const text = new TemplateRenderer().render(intent({ topic: 'nav_timeout' }));
    assert.match(text, /超时/);
    assert.doesNotMatch(text, /过远/);
  });
});

describe('NarrationHub', () => {
  test('单意图 → 渲染一次出口', () => {
    const { hub, said } = makeHub();
    hub.narrate(intent({ source: 'survival', topic: 'danger_flee', data: { mob: '苦力怕' } }));
    hub.flushTick();
    assert.equal(said.length, 1);
    assert.match(said[0].detail, /苦力怕/);
    assert.equal(said[0].source, 'survival');
  });

  test('空缓冲 flush → 不说、不抛', () => {
    const { hub, said } = makeHub();
    hub.flushTick();
    assert.equal(said.length, 0);
  });

  test('同 dedupeKey 同 tick → 合一（取最高 urgency）', () => {
    const { hub, said } = makeHub();
    hub.narrate(intent({ topic: 'danger_flee', urgency: 50, dedupeKey: 'danger' }));
    hub.narrate(intent({ topic: 'danger_fight', urgency: 90, dedupeKey: 'danger' }));
    hub.flushTick();
    assert.equal(said.length, 1);
    assert.equal(said[0].urgency, 90); // 高 urgency 胜出
  });

  test('多个不同话题同 tick → 仲裁，只说最高 urgency 一条', () => {
    const { hub, said } = makeHub();
    hub.narrate(intent({ topic: 'gather_progress', urgency: 40, dedupeKey: 'g' }));
    hub.narrate(intent({ topic: 'danger_flee', urgency: 90, dedupeKey: 'd' }));
    hub.flushTick();
    assert.equal(said.length, 1);
    assert.equal(said[0].urgency, 90);
  });

  test('时间窗去重：同 key 短窗内第二次不说，过窗后说', () => {
    let t = 1000;
    const { hub, said } = makeHub({ now: () => t, cfg: { dedupeWindowMs: 8000 } });
    hub.narrate(intent({ topic: 'nav_door', dedupeKey: 'door', urgency: 50 }));
    hub.flushTick();
    assert.equal(said.length, 1);
    t = 4000; // 仍在 8s 窗内
    hub.narrate(intent({ topic: 'nav_door', dedupeKey: 'door', urgency: 50 }));
    hub.flushTick();
    assert.equal(said.length, 1, '窗内复读被去重');
    t = 10000; // 超过 8s
    hub.narrate(intent({ topic: 'nav_door', dedupeKey: 'door', urgency: 50 }));
    hub.flushTick();
    assert.equal(said.length, 2, '过窗后可再说');
  });

  test('主人活跃 → 压制低优意图', () => {
    const { hub, said } = makeHub({ ownerActive: true, cfg: { ownerActiveSuppressBelow: 60 } });
    hub.narrate(intent({ source: 'idle', topic: 'idle_eat', urgency: 30 }));
    hub.flushTick();
    assert.equal(said.length, 0, '主人活跃时低优 IDLE 被压制');
  });

  test('主人活跃 → 高优危险不被压制', () => {
    const { hub, said } = makeHub({ ownerActive: true, cfg: { ownerActiveSuppressBelow: 60 } });
    hub.narrate(intent({ source: 'supervisor', topic: 'danger_flee', urgency: 90 }));
    hub.flushTick();
    assert.equal(said.length, 1, '高危照说');
  });

  test('主人活跃 → llm 来源不被压制', () => {
    const { hub, said } = makeHub({ ownerActive: true });
    hub.narrate(intent({ source: 'llm', topic: 'gather_done', urgency: 20, data: { material: '木', have: 3 } }));
    hub.flushTick();
    assert.equal(said.length, 1, 'llm 大脑说话不受退避影响');
  });

  test('未知 topic → 不发话', () => {
    const { hub, said } = makeHub();
    hub.narrate(intent({ topic: '__unknown__', urgency: 90 }));
    hub.flushTick();
    assert.equal(said.length, 0);
  });

  test('发出的通知进入 recentNotices（供注入大模型上下文）', () => {
    const { hub } = makeHub();
    hub.narrate(intent({ source: 'gather', topic: 'gather_done', data: { material: '橡木', have: 10 } }));
    hub.flushTick();
    assert.match(hub.recentNotices(), /橡木.*10/);
  });

  test('无通知时 recentNotices 为空串', () => {
    const { hub } = makeHub();
    assert.equal(hub.recentNotices(), '');
  });
});

describe('NoticeLog', () => {
  test('环形缓冲超上限丢旧', () => {
    const log = new NoticeLog(3);
    for (let i = 1; i <= 5; i++) log.record({ ts: i, source: 's', topic: 't', text: `n${i}` });
    assert.equal(log.size(), 3);
    assert.deepEqual(log.recent({ limit: 10 }).map((e) => e.text), ['n3', 'n4', 'n5']);
  });

  test('时间窗过滤', () => {
    const log = new NoticeLog();
    log.record({ ts: 1000, source: 's', topic: 't', text: 'old' });
    log.record({ ts: 9000, source: 's', topic: 't', text: 'new' });
    assert.deepEqual(log.recent({ now: 10000, windowMs: 5000 }).map((e) => e.text), ['new']);
  });
});
