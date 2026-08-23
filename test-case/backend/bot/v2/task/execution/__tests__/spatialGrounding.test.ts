import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SpatialGroundingLedger } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/spatialGrounding.js';

describe('BUG-CROSS-47 · resource action spatial grounding', () => {
  test('resource collection rejects invented coordinates before dispatch', () => {
    const ledger = new SpatialGroundingLedger();
    const result = ledger.validate('采集附近 stone 直到拿到圆石', 'invoke_behavior', {
      behavior: 'gather_block',
      params: { pos: { x: 40, y: -60, z: 40 }, blockName: 'stone' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'contract.ungrounded_position');
  });

  test('locate_block result authorizes the matching block position only', () => {
    const ledger = new SpatialGroundingLedger();
    ledger.record('locate_block', {
      ok: true,
      block: 'stone',
      blocks: [{ position: { x: 12, y: -60, z: 0 }, distance: 3 }],
    });
    assert.equal(ledger.size(), 1);
    assert.equal(ledger.validate('挖掘 stone 获得 cobblestone', 'invoke_behavior', {
      behavior: 'gather_block',
      params: { pos: { x: 12, y: -60, z: 0 }, blockName: 'stone' },
    }).ok, true);
    assert.equal(ledger.validate('挖掘 stone 获得 cobblestone', 'invoke_behavior', {
      behavior: 'gather_block',
      params: { pos: { x: 12, y: -60, z: 0 }, blockName: 'iron_ore' },
    }).ok, false);
  });

  test('non-resource goals and non-spatial actions are not overblocked', () => {
    const ledger = new SpatialGroundingLedger();
    assert.equal(ledger.validate('制作一把木镐', 'invoke_atomic', {
      atomic: 'craft', args: { itemName: 'wooden_pickaxe' },
    }).ok, true);
    assert.equal(ledger.validate('走到主人身边', 'invoke_atomic', {
      atomic: 'goto_position', args: { position: { x: 100, y: 64, z: 100 } },
    }).ok, true);
  });
});
