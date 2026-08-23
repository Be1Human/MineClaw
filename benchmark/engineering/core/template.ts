/**
 * 评测体系 · 场景模板展开器（FEAT-CROSS-03）
 *
 * 定位：场景作者写"一份模板 + 参数轴"，展开器在【注册期】生成 N 个 ScenarioFactory。
 * runner / report 仍只认 ScenarioFactory，对模板无感知（OCP）。
 *
 *   ScenarioTemplate{ axes:{dist:[8,16,32],count:[1,4]}, pinned:[...] }
 *      └─ expand() ─→ [pinned 实例(原ID,full/quick) ... , 矩阵实例(prefix-M01,matrix) ...]
 *
 * 约定：
 *   - 带矩阵的模板，axes 必须覆盖 P 的全部键（否则矩阵实例参数不完整）；
 *   - 纯钉名模板（每个 pinned 各自带完整 params）用 `axes: {}`，不生成矩阵实例。
 */

import type { Category, ScenarioFactory, ScenarioSpec, Suite } from './types.js';

/** build 返回的场景主体（id/suite/category/repeat 由展开器注入） */
export type ScenarioBody = Omit<ScenarioSpec, 'id' | 'suite' | 'category' | 'repeat'>;

/** 模板：一组参数 P → 一个场景实例 */
export interface ScenarioTemplate<P extends object> {
  /** 实例 ID 前缀，如 'GATHER' */
  idPrefix: string;
  /** 类目（报告分组用） */
  category: Category;
  /** 参数轴（笛卡尔积 → 矩阵实例）· 纯钉名模板用 {} */
  axes: Partial<{ [K in keyof P]: readonly P[K][] }>;
  /** 显式钉名实例：原 13 个 ID 走这里，保证基线兼容（ID/suite 固定） */
  pinned?: Array<{ id: string; suite: Suite; params: P }>;
  /** 每实例重复次数（full 套件用 · 缺省 5） */
  repeat?: number;
  /** 由参数组合构建场景主体 */
  build(params: P): ScenarioBody;
}

/** 笛卡尔积：{a:[1,2], b:['x','y']} → [{a:1,b:'x'},...]（仅对提供的轴键展开） */
export function cartesian<P extends object>(axes: Partial<{ [K in keyof P]: readonly P[K][] }>): P[] {
  const keys = Object.keys(axes) as Array<keyof P>;
  let combos: Array<Partial<P>> = [{}];
  for (const key of keys) {
    const values = (axes[key] ?? []) as readonly P[keyof P][];
    const next: Array<Partial<P>> = [];
    for (const combo of combos) {
      for (const v of values) {
        next.push({ ...combo, [key]: v } as Partial<P>);
      }
    }
    combos = next;
  }
  return combos as P[];
}

/**
 * 展开模板为场景工厂数组：
 *   - pinned 实例：保留原 ID + suite（基线兼容）
 *   - 矩阵实例：ID = `${prefix}-M01..`，suite = 'matrix'，title 追加参数后缀
 */
export function expand<P extends object>(t: ScenarioTemplate<P>): ScenarioFactory[] {
  const factories: ScenarioFactory[] = [];
  const repeat = t.repeat ?? 5;

  for (const pin of t.pinned ?? []) {
    factories.push(() => ({
      ...t.build(pin.params), id: pin.id, suite: pin.suite, category: t.category, repeat,
    }));
  }

  // 无参数轴 → 不生成矩阵实例
  if (Object.keys(t.axes).length === 0) return factories;

  const combos = cartesian<P>(t.axes);
  combos.forEach((params, i) => {
    const id = `${t.idPrefix}-M${String(i + 1).padStart(2, '0')}`;
    const suffix = Object.entries(params as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join(',');
    factories.push(() => {
      const base = t.build(params);
      return { ...base, id, suite: 'matrix' as Suite, category: t.category, repeat, title: `${base.title} [${suffix}]` };
    });
  });

  return factories;
}
