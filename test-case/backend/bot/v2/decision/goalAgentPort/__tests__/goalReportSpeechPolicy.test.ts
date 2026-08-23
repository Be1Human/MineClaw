import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GoalReportSpeechPolicy } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalReportSpeechPolicy.js';
import type { GoalReportV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';

const report = (status: GoalReportV2['status'], evidence = true): GoalReportV2 => ({
  meta: { schemaVersion:2,sessionId:'session-1',messageId:'report-1',correlationId:'corr-1',causationId:'req-1',conversationId:'conv-1',sequence:2,emittedAt:'2026-08-04T00:00:00.000Z',idempotencyKey:'report-1' },
  requestId:'req-1', status, summary:`status=${status}`,
  evidence:evidence?[{type:'action_result',ref:'task-1',observedAt:'2026-08-04T00:00:00.000Z'}]:[],
});

describe('GoalReportSpeechPolicy', () => {
  const policy = new GoalReportSpeechPolicy();

  it('running 只允许表达开始/进行中', () => {
    assert.equal(policy.validate(report('running'), '我已经开始跟随你了').pass, true);
    assert.equal(policy.validate(report('running'), '已经完成跟随任务').pass, false);
  });

  it('BUG-CROSS-75 · running 话术必须匹配 planning/executing 里程碑', () => {
    const executing: GoalReportV2 = {
      ...report('running'),
      summary: '任务仍在进行，阶段：running:waiting_for_action:plan-r1',
      progress: { current: 0, milestone: 'executing' },
    };
    assert.equal(policy.validate(executing, '麦田正在收割，我会继续跟进').pass, true);
    assert.equal(policy.validate(executing, '目前还在规划确认阶段，规划好了就动手').pass, false);
    assert.match(policy.instruction(executing), /禁止声称仍在规划/);

    const planning: GoalReportV2 = {
      ...report('running'),
      summary: '任务正在规划，阶段：planning',
      progress: { current: 0, milestone: 'planning' },
    };
    assert.equal(policy.validate(planning, '我还在规划任务步骤').pass, true);
    assert.equal(policy.validate(planning, '我正在收割麦田').pass, false);
  });

  it('failed/cancelled 不得改写成成功', () => {
    assert.equal(policy.validate(report('failed'), '失败了，我需要换个办法').pass, true);
    assert.equal(policy.validate(report('failed'), '任务搞定了').pass, false);
    assert.equal(policy.validate(report('cancelled'), '已经停止跟随').pass, true);
  });

  it('communication_delayed 不得改写成运行中、失败或完成', () => {
    const delayed = report('communication_delayed', false);
    assert.match(policy.instruction(delayed), /不得声称任务仍在正常执行、已经失败或已经完成/);
    assert.equal(policy.validate(delayed, '任务搞定了').pass, false);
    assert.equal(policy.validate(delayed, '暂时无法读取运行状态').pass, true);
  });

  it('终态无证据时不得作确定性成功声明', () => {
    assert.equal(policy.validate(report('completed', false), '任务完成了').pass, false);
    assert.equal(policy.validate(report('completed'), '任务完成了').pass, true);
  });

  it('只有根终态判据时拒绝无证据的战斗过程宣称', () => {
    const terminal: GoalReportV2 = {
      ...report('completed'),
      summary:'机器判据已满足：criterion:entity_dead:zombie。仅确认目标终态。',
      evidence:[{type:'root_verdict',ref:'criterion:entity_dead:zombie',observedAt:'2026-08-16T09:00:10.000Z'}],
    };
    assert.equal(policy.validate(terminal, '僵尸已经不在现场，目标完成了').pass, true);
    assert.equal(policy.validate(terminal, '我用石剑处理掉了僵尸').pass, false);
    assert.equal(policy.validate(terminal, '低血量时吃了面包，方块一个都没碰').pass, false);
    assert.equal(policy.validate(terminal, '我全程护着自己，没有受伤').pass, false);
    assert.match(policy.instruction(terminal), /只有根终态判据/);
  });

  it('存在动作结果时不应用仅根判据限制', () => {
    const actionBacked: GoalReportV2 = {
      ...report('completed'),
      evidence:[{type:'action_result',ref:'atomic:eat:success',observedAt:'2026-08-16T09:00:10.000Z'}],
    };
    assert.equal(policy.validate(actionBacked, '我吃了面包').pass, true);
  });
});
