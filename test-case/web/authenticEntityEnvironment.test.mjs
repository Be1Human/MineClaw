import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AuthenticEntityRenderer } from '../../apps/minecraft-companion/web/src/lib/authentic/AuthenticEntityRenderer.js';
import { AuthenticEnvironmentRenderer } from '../../apps/minecraft-companion/web/src/lib/authentic/AuthenticEnvironmentRenderer.js';

const config = {
  maxAuthenticEntities: 3,
  entityInterpolationMs: 120,
  weatherParticleCount: 12,
  weatherRadius: 16,
  weatherFallSpeed: 18,
  fogDensity: { overworld: 0.004, theNether: 0.018, theEnd: 0.009 },
  rainFogMultiplier: 1.45,
};

function entity(id, overrides = {}) {
  return {
    id, type: 'mob', name: `mob-${id}`, position: { x: id, y: 64, z: id }, velocity: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, width: 0.6, height: 1.8, equipment: [], ...overrides,
  };
}

test('FEAT-WEBUI-27-004 | 玩家/生物/掉落物实体受上限控制、插值更新且 reset 可清空', () => {
  const group = new THREE.Group();
  const diagnostics = [];
  const renderer = new AuthenticEntityRenderer({ group, config, onDiagnostic: entry => diagnostics.push(entry) });
  const source = new Map([
    [1, entity(1, { type: 'player', name: 'Bot', username: 'Bot', isSelf: true })],
    [2, entity(2, { type: 'player', name: 'Alex', username: 'Alex', position: { x: 8, y: 64, z: 8 }, equipment: ['diamond_sword', null, 'iron_boots', null, 'iron_chestplate', 'iron_helmet'] })],
    [3, entity(3, { type: 'mob', name: 'creeper' })],
    [4, entity(4, { type: 'object', name: 'item', itemName: 'diamond' })],
    [5, entity(5, { type: 'mob', name: 'modded_beast' })],
  ]);
  renderer.sync(source, { chunkX: 0, chunkZ: 0 });
  assert.equal(renderer.entries.size, 3);
  assert.equal(renderer.entries.has(1), false, 'Bot 自身由共享皮肤标记渲染，真实实体层不应重复');
  assert.equal(renderer.entries.get(2).kind, 'player');
  assert.equal(renderer.entries.get(4).kind, 'item');
  assert.ok(renderer.entries.get(2).root.getObjectByName('equipment'));
  assert.equal(diagnostics[0]?.type, 'entity-placeholder');

  const before = renderer.entries.get(2).root.position.x;
  source.set(2, entity(2, { type: 'player', name: 'Alex', username: 'Alex', position: { x: 10, y: 64, z: 8 } }));
  renderer.sync(source, { chunkX: 0, chunkZ: 0 });
  renderer.tick(0.06);
  assert.ok(renderer.entries.get(2).root.position.x > before && renderer.entries.get(2).root.position.x < 10);

  renderer.sync(new Map(), { chunkX: 0, chunkZ: 0 });
  assert.equal(renderer.entries.size, 0);
  assert.equal(group.children.length, 0);
  assert.equal(renderer.geometries.size, 0);
  assert.equal(renderer.materials.size, 0);
  renderer.dispose();
});

test('FEAT-WEBUI-27-004 | 维度、昼夜、雨雾进入后生效，退出真实模式完整恢复场景', () => {
  const scene = new THREE.Scene();
  const originalBackground = new THREE.Color(0x102030);
  const originalFog = new THREE.Fog(0x102030, 1, 100);
  const light = new THREE.AmbientLight(0xffffff, 2);
  scene.background = originalBackground;
  scene.fog = originalFog;
  scene.add(light);
  const renderer = new AuthenticEnvironmentRenderer({ scene, config });

  renderer.activate({ dimension: 'minecraft:the_nether', timeOfDay: 18000, isRaining: true }, { chunkX: 2, chunkZ: -1 });
  assert.equal(scene.fog?.isFogExp2, true);
  assert.equal(scene.fog.density, config.fogDensity.theNether * config.rainFogMultiplier);
  assert.ok(light.intensity < 2);
  const rain = scene.getObjectByName('authenticWeather');
  assert.equal(rain?.isPoints, true);
  assert.equal(rain.geometry.attributes.position.count, config.weatherParticleCount);
  assert.deepEqual(rain.position.toArray(), [40, 0, -8]);
  const before = rain.geometry.attributes.position.array[1];
  renderer.tick(0.01);
  assert.notEqual(rain.geometry.attributes.position.array[1], before);

  renderer.deactivate();
  assert.equal(scene.background, originalBackground);
  assert.equal(scene.fog, originalFog);
  assert.equal(light.intensity, 2);
  assert.equal(scene.getObjectByName('authenticWeather'), undefined);
});
