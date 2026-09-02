import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { jsonSnapshot } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/jsonSnapshot.js';
import { freezeGoalContractV2, goalContractV2Hash } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalContractV2.js';
import type { GoalContractV2 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/goalContractV2.js';

const root = fileURLToPath(new URL('../../../../../../../apps/minecraft-companion/src/bot/v2/', import.meta.url));
const contracts = resolve(root, 'task/contracts');
const dataModules = ['bodyOperation', 'operationReceipt', 'goalProgress', 'goalPlanOperation', 'failureEnvelope'].map(name => join(contracts, name + '.ts'));

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Include type-only, inline import types, re-exports and literal dynamic imports. */
function dependencies(file: ts.SourceFile): string[] {
  const result = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.add(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.add(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...result];
}

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : entry.name.endsWith('.ts') ? [child] : [];
  });
}

function localImport(file: string, specifier: string): string {
  assert.ok(specifier.startsWith('.'), 'neutral DTO must not depend on a service/package: ' + specifier);
  return resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
}

test('A01: shared data contracts and their transitive imports are implementation-independent and acyclic', () => {
  // Neutral contract roots: task/contracts (DTOs) and plugin-sdk (contract surface).
  const contractRoots = [contracts, join(root, 'plugin-sdk')];
  const complete = new Set<string>(), active: string[] = [];
  const walk = (path: string): void => {
    assert.ok(!active.includes(path), 'data dependency cycle: ' + [...active, path].map(value => relative(root, value)).join(' -> '));
    if (complete.has(path)) return;
    assert.ok(contractRoots.some(contractRoot => !relative(contractRoot, path).startsWith('..')),
      'data contract reaches implementation: ' + relative(root, path));
    active.push(path);
    for (const dependency of dependencies(source(path))) walk(localImport(path, dependency));
    active.pop(); complete.add(path);
  };
  for (const path of dataModules) walk(path);
  assert.ok(complete.has(join(contracts, 'goalDraft.ts')));
  assert.ok(complete.has(join(contracts, 'worldFact.ts')));
  assert.deepEqual(dependencies(source(join(root, 'infra/jsonSnapshot.ts'))), []);
  for (const module of ['task/execution/ports/controlledExecution.ts', 'task/execution/ports/bodyExecution.ts', 'task/goalAgent/ports/goalPlanPort.ts']) {
    const port = source(join(root, module));
    for (const dependency of dependencies(port)) {
      assert.doesNotMatch(dependency, /(?:controlledExecutionContext|goalProgressGuard|goalPlanAuthority|goalAgentRoundLoop)\.js$/);
    }
    for (const statement of port.statements) if (ts.isImportDeclaration(statement)) {
      assert.equal(statement.importClause?.isTypeOnly, true, module + ': port must not load an implementation');
    }
  }
});

test('A01: dependency scanner detects inline/type-only/re-export forms as well as runtime imports', () => {
  const fixture = ts.createSourceFile('fixture.ts', `
    import type { A } from './a.js';
    export type { B } from './b.js';
    type C = import('./c.js').C;
    const d = import('./d.js');
    const e = require('./e.js');
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(dependencies(fixture).sort(), ['./a.js', './b.js', './c.js', './d.js', './e.js']);
});

test('A01/A04: all consumers import shared contracts directly; replaced export aliases cannot return', () => {
  const owner = new Map([
    ['jsonSnapshot', 'infra/jsonSnapshot.ts'],
    ...['ExecutionOwner', 'OperationIdentity', 'OperationIntent', 'OperationCommand', 'StopAcknowledgement', 'OperationSnapshot'].map(name => [name, 'task/contracts/bodyOperation.ts'] as const),
    ['OperationEffect', 'task/contracts/operationReceipt.ts'],
    ['OperationReceipt', 'task/contracts/operationReceipt.ts'],
    ['ControlledExecutionContext', 'task/execution/ports/controlledExecution.ts'],
    ['GoalProgressState', 'task/contracts/goalProgress.ts'],
    ['CapabilityOperationSemantics', 'task/goalAgent/ports/goalPlanPort.ts'],
    ...['FailureEnvelope', 'FailureOrigin', 'FailureStage', 'FailureCategory'].map(name => [name, 'task/contracts/failureEnvelope.ts'] as const),
  ]);
  for (const path of files(root)) {
    for (const statement of source(path).statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause;
      if (!bindings || !ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)) continue;
      for (const binding of bindings.elements) {
        const name = binding.propertyName?.text ?? binding.name.text;
        const module = owner.get(name);
        if (!module) continue;
        assert.ok(ts.isImportDeclaration(statement), 'replaced alias re-exported by ' + relative(root, path) + ': ' + name);
        assert.equal(localImport(path, statement.moduleSpecifier.text), resolve(root, module), relative(root, path) + ': ' + name);
      }
    }
  }
});

test('A04: production contracts cannot advertise an unused optional controlled context or receipt', () => {
  for (const module of ['atomic/atomics.ts', 'behavior/types.ts', 'task/strategy/strategyExecutor.ts', 'task/goalRunner/actionPresentation.ts',
    'task/goalAgent/ports/executionPort.ts', 'task/goalAgent/goalAgentState.ts', 'task/execution/bodyActionService.ts']) {
    const visit = (node: ts.Node): void => {
      if ((ts.isPropertySignature(node) || ts.isParameter(node)) && node.questionToken && ts.isIdentifier(node.name)) {
        assert.ok(!['controlled', 'receipt'].includes(node.name.text), module + ': unused optional execution promise');
      }
      ts.forEachChild(node, visit);
    };
    visit(source(join(root, module)));
  }
  const publicWaitTest = readFileSync(new URL('../../goalAgent/__tests__/goalProgressGuard.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(publicWaitTest, /\bas any\)\.(?:loop|pump|wakeups)\b/);
});

test('S01: all production body writes use required sessions; removed execution paths cannot return',()=>{
  const botRoot=dirname(root);
  for(const removed of ['motor/motorService.ts','motor/types.ts','task/goalRunner/atomExec.ts','strategy/smartNavStrategy.ts']) {
    assert.equal(existsSync(join(root,removed)),false,removed+' must be removed, not retained as a fallback');
  }
  const writeMethods=new Set(['setControlState','clearControlStates','lookAt','look','attack','dig','equip','toss',
    'activateItem','deactivateItem','interactBlock','placeBlock','consume','sleep','wake','mount','dismount',
    'depositToChest','withdrawFromChest','craft','smelt']);
  for(const module of ['adapter/GameAdapter.ts','adapter/NavigationAdapter.ts']) {
    for(const statement of source(join(botRoot,module)).statements) if(ts.isInterfaceDeclaration(statement)) {
      for(const member of statement.members) if(member.name && ts.isIdentifier(member.name)) {
        assert.equal(writeMethods.has(member.name.text),false,module+' exposes an unbound device write');
        assert.equal(['goto','follow','stop','startFollow','stopFollow'].includes(member.name.text),false,module+' exposes an unbound navigation write');
      }
    }
  }
  for(const path of files(botRoot)) {
    const visit=(node:ts.Node):void=>{
      if(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method=node.expression.name.text,receiver=node.expression.expression.getText();
        if(writeMethods.has(method) && /(?:^|\.)(?:game|view)$/.test(receiver)) {
          assert.fail(relative(botRoot,path)+': physical write through a read-only game view');
        }
        if(/\.pathfinder$/.test(receiver) && ['goto','setGoal','setMovements','stop'].includes(method)) {
          assert.fail(relative(botRoot,path)+': uncontrolled pathfinder executor');
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(source(path));
  }
  for(const directory of ['atomic','behavior','navigation']) for(const path of files(join(root,directory))) {
    assert.doesNotMatch(readFileSync(path,'utf8'),/\bset(?:Timeout|Interval)\s*\(/,relative(root,path)+': waiting must use the operation lifetime');
  }
});

const goldenInput = {
  "schema": "mineclaw.goal/v2",
  "goalId": "goal-golden",
  "profileId": "test-profile",
  "goalText": "种一格",
  "requestRef": "request-golden",
  "successCriteria": [
    {
      "type": "predicate",
      "predicate": "test.crop",
      "predicateVersion": "1",
      "args": {
        "z": 2,
        "x": 1
      }
    }
  ],
  "scope": {
    "dimension": "overworld",
    "targetRefs": [
      "plot"
    ],
    "bindings": [
      {
        "id": "plot",
        "version": "1",
        "kind": "region",
        "summary": "test plot",
        "dimension": "overworld",
        "mutationAllowed": true,
        "required": true,
        "requiredPredicates": [
          {
            "id": "test.crop",
            "version": "1",
            "args": {
              "x": 1,
              "z": 2
            }
          }
        ],
        "evidenceRefs": [
          "world:plot"
        ]
      }
    ]
  },
  "createdAt": "2026-08-31T00:00:00.000Z"
} satisfies Omit<GoalContractV2, 'contentHash'>;
const goldenCanonical = "{\"createdAt\":\"2026-08-31T00:00:00.000Z\",\"goalId\":\"goal-golden\",\"goalText\":\"种一格\",\"profileId\":\"test-profile\",\"requestRef\":\"request-golden\",\"schema\":\"mineclaw.goal/v2\",\"scope\":{\"bindings\":[{\"dimension\":\"overworld\",\"evidenceRefs\":[\"world:plot\"],\"id\":\"plot\",\"kind\":\"region\",\"mutationAllowed\":true,\"required\":true,\"requiredPredicates\":[{\"args\":{\"x\":1,\"z\":2},\"id\":\"test.crop\",\"version\":\"1\"}],\"summary\":\"test plot\",\"version\":\"1\"}],\"dimension\":\"overworld\",\"targetRefs\":[\"plot\"]},\"successCriteria\":[{\"args\":{\"x\":1,\"z\":2},\"predicate\":\"test.crop\",\"predicateVersion\":\"1\",\"type\":\"predicate\"}]}";

test('A02: canonical JSON, goal hash and fixed-key signature input match the pre-refactor golden bytes', () => {
  const canonical = JSON.stringify(jsonSnapshot(goldenInput));
  assert.equal(canonical, goldenCanonical);
  assert.equal(createHash('sha256').update(canonical).digest('hex'), 'af448d0bc299d46f7b127683a140d8d0040e5a5213f1cfdff5d0ea28d490a369');
  assert.equal(createHmac('sha256', 'fixed-test-key').update(canonical).digest('hex'), '8c4960041bca7d18d38ef54b7184e735ddf6470c0299871a155bd6923aaba045');
  const goal = freezeGoalContractV2(goldenInput);
  assert.equal(goal.contentHash, 'af448d0bc299d46f7b127683a140d8d0040e5a5213f1cfdff5d0ea28d490a369');
  assert.equal(goalContractV2Hash(JSON.parse(JSON.stringify(goal))), goal.contentHash);
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
  assert.equal(goalContractV2Hash(reverseKeys(goldenInput) as typeof goldenInput), goal.contentHash);
});

test('A02: JSON snapshots retain detached/deep-frozen data and exact invalid-data error semantics', () => {
  const input = { z: [{ count: 1 }], a: null };
  const snapshot = jsonSnapshot(input);
  input.z[0].count = 2;
  assert.equal(snapshot.z[0].count, 1);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.z) && Object.isFrozen(snapshot.z[0]));
  for (const input of [undefined, NaN, Infinity, () => 1, { missing: undefined }]) {
    assert.throws(() => jsonSnapshot(input), { message: 'capability metadata must be finite JSON' });
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => jsonSnapshot(cycle), { message: 'cyclic capability metadata' });
  assert.throws(() => jsonSnapshot(new Date()), { message: 'capability metadata must use plain JSON objects' });
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => jsonSnapshot(JSON.parse('{"' + key + '":1}')), { message: 'unsafe capability metadata key: ' + key });
  }
});
