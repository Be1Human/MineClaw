import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  migrateWorldPreviewModes,
  normalizeWorldPreviewMode,
  projectWorldPreview,
} from '../../../../apps/minecraft-companion/web/src/lib/worldPreviewPresentation.js';

test('世界预览模式只接受雷达、简略和真实三态', () => {
  assert.equal(normalizeWorldPreviewMode('radar'), 'radar');
  assert.equal(normalizeWorldPreviewMode('simple'), 'simple');
  assert.equal(normalizeWorldPreviewMode('authentic'), 'authentic');
  assert.equal(normalizeWorldPreviewMode('unknown'), 'radar');
});

test('已有三态存储保留合法值，新 Profile 默认雷达且过滤非法值', () => {
  const result = migrateWorldPreviewModes({
    storedModes: { alpha: 'authentic', invalid: 'fake' },
    profileIds: ['alpha', 'beta'],
    legacyShow3D: '1',
    legacyWorldModes: { beta: 'simple' },
  });

  assert.deepEqual(result.modes, { alpha: 'authentic', beta: 'radar' });
  assert.equal(result.changed, true);
});

test('尚无三态存储时把旧 show3D/worldMode 一次性迁入全部 Profile', () => {
  const result = migrateWorldPreviewModes({
    storedModes: {},
    profileIds: ['alpha', 'beta'],
    legacyShow3D: '1',
    legacyWorldModes: { alpha: 'authentic', beta: 'simple' },
  });

  assert.deepEqual(result.modes, { alpha: 'authentic', beta: 'simple' });
});

test('默认迁移保持低负载雷达而不自动启用 WebGL', () => {
  const result = migrateWorldPreviewModes({
    storedModes: {},
    profileIds: ['alpha'],
    legacyShow3D: null,
    legacyWorldModes: { alpha: 'authentic' },
  });

  assert.deepEqual(result.modes, { alpha: 'radar' });
});

test('离线真实模式可见但不会挂载场景', () => {
  const state = projectWorldPreview({
    mode: 'authentic',
    hasProfile: true,
    hubConnected: true,
    brainReady: true,
  });

  assert.equal(state.modeLabel, '真实世界');
  assert.equal(state.stage, 'world-disconnected');
  assert.equal(state.shouldMountScene, false);
  assert.equal(state.actionLabel, '连接 Minecraft 世界');
  assert.match(state.message, /无需启动 Minecraft 客户端/);
});

test('连接失败直接展示 Runtime lastError 并允许重试', () => {
  const state = projectWorldPreview({
    mode: 'simple',
    hasProfile: true,
    hubConnected: true,
    brainReady: true,
    lastError: '服务器 127.0.0.1:25565 无法连接',
  });

  assert.equal(state.stage, 'error');
  assert.equal(state.tone, 'error');
  assert.equal(state.actionLabel, '重试连接');
  assert.match(state.message, /25565/);
});

test('连接成功但首帧未到时等待真实数据', () => {
  const state = projectWorldPreview({
    mode: 'authentic',
    hasProfile: true,
    hubConnected: true,
    inGame: true,
    connectionStatus: 'connected',
  });

  assert.equal(state.stage, 'waiting-world-state');
  assert.equal(state.shouldMountScene, false);
  assert.match(state.message, /收到真实世界数据后/);
});

test('只有在线简略或真实模式挂载场景', () => {
  const common = {
    hasProfile: true,
    hubConnected: true,
    inGame: true,
    connectionStatus: 'connected',
    hasWorldState: true,
  };

  assert.equal(projectWorldPreview({ ...common, mode: 'radar' }).shouldMountScene, false);
  assert.equal(projectWorldPreview({ ...common, mode: 'simple' }).shouldMountScene, true);
  assert.equal(projectWorldPreview({ ...common, mode: 'authentic' }).shouldMountScene, true);
});

test('连接与断开过程禁用重复动作并给出明确文案', () => {
  const connecting = projectWorldPreview({
    mode: 'simple', hasProfile: true, hubConnected: true, pendingAction: 'connect',
  });
  const disconnecting = projectWorldPreview({
    mode: 'simple', hasProfile: true, hubConnected: true, inGame: true,
    connectionStatus: 'connected', hasWorldState: true, pendingAction: 'disconnect',
  });

  assert.equal(connecting.canAct, false);
  assert.equal(connecting.actionLabel, '正在连接…');
  assert.equal(disconnecting.canAct, false);
  assert.equal(disconnecting.actionLabel, '正在断开…');
});
