import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoalCapabilityRouter } from '../../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/goalCapabilityRouter.js';

function request(requestText: string, requestKind: 'task' | 'query' | 'cancel' = 'task') {
  return { requestText, originalText: requestText, requestKind };
}

describe('GoalCapabilityRouter', () => {
  it('跟随表达统一路由到 persistent_behavior', () => {
    const router = new GoalCapabilityRouter();
    for (const text of ['跟我来', '跟着我走', '跟随主人', 'follow me']) {
      const match = router.resolve(request(text));
      assert.equal(match.definition.id, 'follow_owner', text);
      assert.equal(match.definition.mode, 'persistent_behavior');
      assert.match(match.definition.successContract, /distance evidence/);
    }
  });

  it('物品与一般目标仍进入 planned_goal', () => {
    const router = new GoalCapabilityRouter();
    for (const text of ['给我一把石镐', '做一把石斧', '探索附近洞穴', '过来下']) {
      assert.equal(router.resolve(request(text)).definition.id, 'planned_goal', text);
    }
  });

  it('认知搜索和精确读取复用同一能力目录', () => {
    const router = new GoalCapabilityRouter();
    assert.equal(router.search({ query: '跟随', limit: 3 })[0]?.id, 'follow_owner');
    assert.equal(router.get('planned_goal')?.mode, 'planned_goal');
    assert.equal(router.get('missing'), null);
  });

  it('cancel 不经过 Planner；实时事实查询不再进入任务路由', () => {
    const router = new GoalCapabilityRouter();
    assert.equal(router.resolve(request('别跟了', 'cancel')).definition.mode, 'cancel');
    // FEAT-CROSS-28: knowledge_query 走独立合同，不再成为任务/查询能力路由输入。
    assert.equal(router.resolve(request('背包里有什么', 'cancel')).definition.mode, 'cancel');
  });

  it('注册新持续行为无需修改路由框架', () => {
    const router = new GoalCapabilityRouter();
    router.register({
      id:'patrol_area',aliases:['巡逻这里'],mode:'persistent_behavior',
      successContract:'active patrol handle',handler:'behavior.patrol',
    });
    assert.equal(router.resolve(request('请巡逻这里')).definition.id, 'patrol_area');
  });
});
