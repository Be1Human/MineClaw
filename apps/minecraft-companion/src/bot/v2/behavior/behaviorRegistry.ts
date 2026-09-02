/**
 * L4 Skill 注册表实现
 *
 * 轻量 Map 包装：register / get / list / clear。
 * 同 id 重复注册覆盖（方便热更新/测试替换）。
 */

import type { IBehavior, IBehaviorRegistry } from './types.js';
import { assertBehaviorDefinition } from './behaviorDefinition.js';

export class BehaviorRegistry implements IBehaviorRegistry {
  private readonly skills = new Map<string, IBehavior>();

  register(skill: IBehavior): void {
    assertBehaviorDefinition(skill);
    this.skills.set(skill.id, skill);
  }

  get(id: string): IBehavior | undefined {
    return this.skills.get(id);
  }

  list(): IBehavior[] {
    return Array.from(this.skills.values());
  }

  clear(): void {
    this.skills.clear();
  }
}
