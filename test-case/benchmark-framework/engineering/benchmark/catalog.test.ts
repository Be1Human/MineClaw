import test from 'node:test';
import assert from 'node:assert/strict';
import { allBenchmarkCases, caseById, casesForProfile } from '../../../../benchmark/engineering/catalog.js';

test('Benchmark Case ID 全局唯一', () => {
  const cases = allBenchmarkCases();
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
});

test('release 覆盖 17 Body、21 Experience、6 Reliability', () => {
  const cases = casesForProfile('release');
  assert.equal(cases.filter(item => item.layer === 'body').length, 17);
  assert.equal(cases.filter(item => item.layer === 'experience').length, 21);
  assert.equal(cases.filter(item => item.layer === 'reliability').length, 6);
  assert.equal(cases.length, 44);
});

test('full 在 release 基础上追加 15 个 Body matrix', () => {
  assert.equal(casesForProfile('full').length, 59);
  assert.equal(casesForProfile('full').filter(item => item.source === 'body-matrix').length, 15);
});

test('单 Case 路由区分 Body、Experience、Reliability', () => {
  assert.equal(caseById('NAV-01')?.source, 'body-full');
  assert.equal(caseById('T01')?.layer, 'experience');
  assert.equal(caseById('T27')?.layer, 'experience');
  assert.equal(caseById('T22')?.layer, 'reliability');
});
