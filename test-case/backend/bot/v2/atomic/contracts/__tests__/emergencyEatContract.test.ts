import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemAtomicContracts } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/atomicContracts.js';

test('emergency eat contract preserves a boolean recovery intent and rejects malformed input', () => {
  const contract = buildSystemAtomicContracts(['eat'])[0];
  assert.ok(contract?.prepare);

  const prepared = contract!.prepare!({ emergency: true });
  assert.ok('prepared' in prepared);
  if ('prepared' in prepared) assert.deepEqual(prepared.prepared, { emergency: true });

  const invalid = contract!.prepare!({ emergency: 'yes' });
  assert.ok('invalid' in invalid);
  if ('invalid' in invalid) assert.equal(invalid.invalid.code, 'contract.invalid_parameter');
});
