import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasDisownedInternalExecution,
  hasUserFacingIdentityLeak,
  normalizeInternalExecutionNarrative,
  sanitizeUserVisibleThinking,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/identitySemantics.js';
import { goalAgentTools } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/tools/defs/goalAgentTools.js';
import { skillTools } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/tools/defs/skillTools.js';

describe('CROSS-001 · 单一伙伴身份语义', () => {
  it('识别自有任务被写成外部执行者', () => {
    assert.equal(hasDisownedInternalExecution('系统还在跑合成铁镐的任务，不是我在操作。'), true);
    assert.equal(hasDisownedInternalExecution('另外系统还在合成熔炉。'), true);
    assert.equal(hasDisownedInternalExecution('我这就自己做木棍，不干等系统了。'), true);
    assert.equal(hasDisownedInternalExecution('Minecraft 服务器正常，但另外系统还在合成熔炉。'), true);
    assert.equal(hasDisownedInternalExecution('后台程序正在替我挖石头。'), true);
    assert.equal(hasDisownedInternalExecution('GoalAgent 自己拆解执行中。'), true);
  });

  it('允许真实外部系统故障', () => {
    assert.equal(hasDisownedInternalExecution('Minecraft 服务器断线了，我暂时进不去。'), false);
    assert.equal(hasDisownedInternalExecution('操作系统权限不足，没法读取这个目录。'), false);
    assert.equal(hasDisownedInternalExecution('操作系统正在安装更新。'), false);
    assert.equal(hasDisownedInternalExecution('游戏系统正在保存世界。'), false);
    assert.equal(hasDisownedInternalExecution('系统权限不足，没法读取这个目录。'), false);
    assert.equal(hasDisownedInternalExecution('网络请求失败了。'), false);
  });

  it('第一人称回答也不能泄漏内部任务标识', () => {
    assert.equal(hasUserFacingIdentityLeak('我还在合成铁镐（task-420 running）。'), true);
    assert.equal(hasUserFacingIdentityLeak('我还在合成铁镐，马上到最后一步。'), false);
    assert.equal(hasUserFacingIdentityLeak('Minecraft 服务器当前 running，但连接有点慢。'), false);
  });

  it('内部执行叙事投影为第一人称并移除调试标识', () => {
    const normalized = normalizeInternalExecutionNarrative(
      '系统还在跑合成铁镐的任务（task-420 running），GoalAgent 自己拆解执行中，不是我在手动操作。',
    );
    assert.match(normalized, /我还在跑合成铁镐/);
    assert.match(normalized, /这是我在执行/);
    assert.doesNotMatch(normalized, /系统|GoalAgent|task-420|running|不是我/);

    const parallelNormalized = normalizeInternalExecutionNarrative('另外系统还在合成熔炉，操作系统正在安装更新。');
    assert.equal(parallelNormalized, '另外我还在合成熔炉，操作系统正在安装更新。');
    assert.equal(normalizeInternalExecutionNarrative('我这就自己做木棍，不干等系统了。'), '我这就自己做木棍，我不再干等了。');
  });

  it('可见思考不暴露内部 Agent、task ID 和运行枚举', () => {
    const visible = sanitizeUserVisibleThinking(
      '任务系统确实在跑着（task-372 running）\nSubAgent 正在重新规划采集路线',
    );
    assert.match(visible, /我确实在跑着/);
    assert.match(visible, /我正在重新规划采集路线/);
    assert.doesNotMatch(visible, /系统|SubAgent|task-372|running/);
  });

  it('模型可见工具把 skill 与目标循环描述为自己的内部能力', () => {
    const submit = goalAgentTools.find(tool => tool.name === 'submit_goal_request');
    const invoke = skillTools.find(tool => tool.name === 'invoke_skill');
    assert.match(submit?.description ?? '', /你的内部执行循环/);
    assert.match(submit?.description ?? '', /仍然是你在做/);
    assert.doesNotMatch(submit?.description ?? '', /派给任务系统|goalAgent 自己/);
    assert.match(invoke?.description ?? '', /你的一个内部 skill/);
    assert.match(invoke?.description ?? '', /仍然是你在做/);
  });
});
