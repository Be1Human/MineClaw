import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const v2Root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../../apps/minecraft-companion/src/bot/v2');

test('production contains one MainBrain and one GoalAgent, with no legacy agent control plane', () => {
  const removed = [
    'decision/agents/criticAgent.ts',
    'decision/agents/reflectionAgent.ts',
    'decision/agents/crystallizeAgent.ts',
    'decision/ruleLoop.ts',
    'decision/goalAgentPort/goalAgentQueryService.ts',
    'task/goalRunner/goalAgent.ts',
    'task/goalRunner/goalAgentLlm.ts',
    'task/goalRunner/goalQueue.ts',
    'task/planOrchestrator.ts',
    'task/planner/productionPlannerGateway.ts',
    'task/planner/plannerAgent.ts',
    'task/planner/plannerGraphRuntime.ts',
    'task/planner/goalRunFacade.ts',
    'task/execution/goalExecutionCoordinator.ts',
    'task/goalAgent/goalAgentLoop.ts',
    'task/goalAgent/nodeContracts.ts',
    'task/goalAgent/goalAgentHarness.ts',
    'task/goalAgent/goalAgentCognition.ts',
    'task/goalAgent/goalAgentCognitiveRuntime.ts',
    'task/goalAgent/nodes/interpretNode.ts',
    'task/goalAgent/nodes/plannerNode.ts',
    'task/goalAgent/nodes/actorNode.ts',
    'task/goalAgent/nodes/executeNode.ts',
    'task/goalAgent/nodes/criticNode.ts',
    'task/goalAgent/nodes/recoveryNode.ts',
    'task/goalAgent/nodes/reflectionNode.ts',
  ];
  for (const path of removed) {
    assert.equal(existsSync(join(v2Root, path)), false, `${path} must stay physically deleted`);
  }

  const runtime = readFileSync(join(v2Root, 'v2Runtime.ts'), 'utf8');
  assert.equal(matches(runtime, /new LLMClient\(/g), 1, 'one provider-facing client is shared');
  assert.match(runtime, /new GoalAgent\([\s\S]*?modelClient:\s*llmClient/);
  assert.match(runtime, /const brainDeps\s*=\s*\{[\s\S]*?llm:\s*llmClient[\s\S]*?\};[\s\S]*?new MainBrain\(\s*brainDeps/);
  assert.doesNotMatch(runtime, /GoalQueue|GoalAgentLlm|ProductionPlannerGateway|CriticAgent|ReflectionAgent/);

  const goalAgentRoot = join(v2Root, 'task/goalAgent');
  const goalAgentSource = sourceFiles(goalAgentRoot).map(path => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(goalAgentSource, /GoalAgentNodeResult|ROUTE_TARGETS|ALLOWED_ROUTES|state\.context\.messages|next\.context\.messages/);
  const facade = readFileSync(join(goalAgentRoot, 'goalAgent.ts'), 'utf8');
  assert.match(facade, /new GoalAgentRoundLoop/);
  assert.doesNotMatch(facade, /InterpretNode|PlannerNode|ActorNode|ExecuteNode|CriticNode|RecoveryNode|ReflectionNode/);
});

test('only MainBrain loop and the unified GoalAgent model runtime call the LLM in business code', () => {
  const callers = sourceFiles(v2Root)
    .filter(path => !path.includes(`${join('__tests__', '')}`))
    .filter(path => readFileSync(path, 'utf8').includes('.callWithTools('))
    .map(path => relative(v2Root, path).replaceAll('\\', '/'))
    .filter(path => !path.startsWith('cognitive/llm/'))
    .sort();

  assert.deepEqual(callers, [
    'decision/llmLoop.ts',
    'task/goalAgent/goalAgentModelRuntime.ts',
  ]);
});

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) files.push(path);
  }
  return files;
}

function matches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}
