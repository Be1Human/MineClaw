/**
 * FEAT-CROSS-26-001-004-002 · Permission policy (U34, P07).
 * Static dependency gate and runtime access verification for first-party domain
 * plugins: no adapter/storage/core-private imports, no undeclared permissions.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compilePermissions,
  checkStaticDependencyPolicy,
  FIRST_PARTY_STATIC_POLICY,
  verifyPermissionAccess,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/permission.js';
import { PluginContractError } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/errors.js';

test('P07 静态依赖门拒绝 GameAdapter/Mineflayer/核心私有导入', () => {
  for (const imports of [
    ['../adapter/GameAdapter.js'],
    ['../../bot/mineflayer/MineflayerGameAdapter.js'],
    ['../task/execution/gameBodyDriver.js'],
    ['../memory/registry.js'],
    ['../cognitive/llm/types.js'],
  ]) {
    assert.throws(
      () => checkStaticDependencyPolicy('mineclaw.test', 'plugins/builtin/test', imports, FIRST_PARTY_STATIC_POLICY),
      (error: unknown) => error instanceof PluginContractError && error.code === 'permission_denied',
      JSON.stringify(imports),
    );
  }
});

test('P07 干净依赖通过；plugin-sdk 与受限端口允许', () => {
  assert.doesNotThrow(() => checkStaticDependencyPolicy(
    'mineclaw.test', 'plugins/builtin/test',
    ['../plugin-sdk/index.js', '../../plugin-sdk/contracts/integration.js', 'node:fs'],
    FIRST_PARTY_STATIC_POLICY,
  ));
});

test('U34 运行时权限：未声明 Atomic/跨插件身份/系统权限拒绝；声明后放行', () => {
  const compiled = compilePermissions('mineclaw.ovens', 'domain', [
    'world.read:bounded-block-snapshot',
    'body.submit:mineclaw.minecraft-system.atomic.move-to',
    'fact.read:mineclaw.inventory.observation.owner-inventory',
  ]);

  verifyPermissionAccess(compiled, { permission: 'world.read:bounded-block-snapshot' });
  verifyPermissionAccess(compiled, { permission: 'body.submit:mineclaw.minecraft-system.atomic.move-to' });
  assert.throws(() => verifyPermissionAccess(compiled, { permission: 'body.submit:mineclaw.minecraft-system.atomic.dig' }),
    (error: unknown) => error instanceof PluginContractError && error.code === 'permission_denied');
  assert.throws(() => verifyPermissionAccess(compiled, { permission: 'system.adapter' }),
    (error: unknown) => error instanceof PluginContractError && error.code === 'permission_denied');
  assert.throws(() => verifyPermissionAccess(compiled, { permission: 'world.read:bounded-block-snapshot', pluginId: 'mineclaw.other' }),
    (error: unknown) => error instanceof PluginContractError && error.code === 'permission_denied');
});

test('U34 数据插件无运行时权限；system 权限仅预编译声明内可用', () => {
  const data = compilePermissions('mineclaw.facts', 'data', []);
  assert.throws(() => verifyPermissionAccess(data, { permission: 'world.read:bounded-block-snapshot' }),
    (error: unknown) => error instanceof PluginContractError && error.code === 'permission_denied');

  const system = compilePermissions('mineclaw.minecraft-system', 'system', ['system.adapter']);
  verifyPermissionAccess(system, { permission: 'system.adapter' });
});
