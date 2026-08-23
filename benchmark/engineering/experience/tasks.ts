/**
 * Engineering Experience 21 项体验 + 6 项可靠性测试 · 任务定义
 * 契约说明：benchmark/engineering/experience/README.md
 *
 * 每个任务：场地原点 X=k*200（k=任务序号），z 以 0 为中心。
 * 地面：超平坦 grass_block 顶面在 y=-61，玩家脚坐标 y=-60（方块格 -60 是脚所在空间）。
 */

export interface Check { name: string; expect: string; actual: string; ok: boolean }
export interface JudgeResult { pass: boolean; checks: Check[] }

export interface Ctx {
  /** RCON 原样发命令（不带前导 /） */
  cmd(c: string): Promise<string>;
  /** 主人 bot（qxy）发聊天 */
  say(text: string): Promise<void>;
  botName: string;
  /** 任务场地原点 x（z=0） */
  X: number;
  /** 被测 bot 实时位置（RCON data get Pos） */
  botPos(): Promise<{ x: number; y: number; z: number }>;
  botFood(): Promise<number>;
  botHealth(): Promise<number>;
  /** 背包物品 → 数量（id 去掉 minecraft: 前缀） */
  botInv(): Promise<Record<string, number>>;
  /** 容器内容 */
  chestItems(x: number, y: number, z: number): Promise<Record<string, number>>;
  /** 世界方块判断 */
  isBlock(x: number, y: number, z: number, block: string): Promise<boolean>;
  /** 范围实体计数（选择器中心+半径） */
  countEntities(type: string, x: number, y: number, z: number, r: number): Promise<number>;
  /** qxy bot 本地世界扫描：在 center 半径内找方块，返回坐标列表 */
  findBlocks(names: string[], center: { x: number; y: number; z: number }, maxDistance: number, count?: number): Promise<Array<{ x: number; y: number; z: number }>>;
  /** 当天 daytime tick */
  daytime(): Promise<number>;
  /** 任务执行期间是否检测到被测 bot 死亡消息 */
  botDied(): boolean;
  /** 自任务开始的毫秒数 */
  elapsed(): number;
  /** 当前任务指令之后，主人视角收到的被测 bot 消息 */
  botMessages(): Array<{ at: number; text: string }>;
  /** 当前任务指令之后，被测 bot 是否说过匹配内容 */
  botSaid(pattern: RegExp): boolean;
  log(msg: string): void;
  /** 任务自存数据（setup 与 judge 之间传值） */
  state: Record<string, unknown>;
}

export interface TaskDef {
  id: string;
  name: string;
  /** 统一 Benchmark 分层；未显式声明时默认 experience */
  layer?: 'experience' | 'reliability';
  /** 期望的终态沟通，用于识别假完成与终态矛盾 */
  expectedTerminal?: 'success' | 'failure' | 'none';
  timeoutMs: number;
  pollMs: number;
  /** 主人下发的任务话术（与测试用例文档一致） */
  instruction: string;
  /** bot 反问时主人的一次性答疑（坐标/方位等普通玩家会给的信息），不给则不答 */
  clarification?: (ctx: Ctx) => string;
  /** 被测 bot 起始点（世界坐标，相对 X） */
  start: { dx: number; dz: number };
  /** 主人 bot 观察位（默认远离 14 格防 follow 干扰） */
  ownerPos?: { dx: number; dz: number };
  setup(ctx: Ctx): Promise<void>;
  /** 首条指令下发后的受控交互，例如中途改派或第二阶段任务 */
  afterInstruction?(ctx: Ctx): Promise<void>;
  judge(ctx: Ctx): Promise<JudgeResult>;
  cleanup?(ctx: Ctx): Promise<void>;
}

// ───────────────────────── 通用小工具 ─────────────────────────

const dist2d = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

function check(name: string, expect: string, actual: string, ok: boolean): Check {
  return { name, expect, actual, ok };
}

/** 人工橡树：1×1×4 树干 + 5×5×2 树叶壳（persistent 防衰减） */
async function plantTree(ctx: Ctx, tx: number, tz: number): Promise<void> {
  await ctx.cmd(`fill ${tx} -60 ${tz} ${tx} -57 ${tz} minecraft:oak_log`);
  await ctx.cmd(`fill ${tx - 2} -58 ${tz - 2} ${tx + 2} -56 ${tz + 2} minecraft:oak_leaves[persistent=true] replace air`);
}

/** 简易石屋：外墙 5×5、高 3、平顶，南墙(z小侧)正中开门。返回门与屋内中心坐标 */
async function buildHouse(ctx: Ctx, cx: number, cz: number): Promise<{ door: { x: number; y: number; z: number }; inside: { x: number; y: number; z: number } }> {
  const x0 = cx - 2, x1 = cx + 2, z0 = cz - 2, z1 = cz + 2;
  // 四面墙（y -60..-58）
  await ctx.cmd(`fill ${x0} -60 ${z0} ${x1} -58 ${z1} minecraft:stone`);
  await ctx.cmd(`fill ${x0 + 1} -60 ${z0 + 1} ${x1 - 1} -58 ${z1 - 1} minecraft:air`);
  // 平顶
  await ctx.cmd(`fill ${x0} -57 ${z0} ${x1} -57 ${z1} minecraft:stone`);
  // 南墙正中开门洞 + 放门（facing=south 朝向屋外）
  await ctx.cmd(`fill ${cx} -60 ${z0} ${cx} -59 ${z0} minecraft:air`);
  await ctx.cmd(`setblock ${cx} -60 ${z0} minecraft:oak_door[facing=south,half=lower]`);
  await ctx.cmd(`setblock ${cx} -59 ${z0} minecraft:oak_door[facing=south,half=upper]`);
  return { door: { x: cx, y: -60, z: z0 }, inside: { x: cx, y: -60, z: cz } };
}

/** 栅栏围栏（矩形边线，oak_fence，y=-60） */
async function buildFence(ctx: Ctx, x0: number, z0: number, x1: number, z1: number, gaps: Array<{ x: number; z: number }> = []): Promise<void> {
  await ctx.cmd(`fill ${x0} -60 ${z0} ${x1} -60 ${z0} minecraft:oak_fence`);
  await ctx.cmd(`fill ${x0} -60 ${z1} ${x1} -60 ${z1} minecraft:oak_fence`);
  await ctx.cmd(`fill ${x0} -60 ${z0} ${x0} -60 ${z1} minecraft:oak_fence`);
  await ctx.cmd(`fill ${x1} -60 ${z0} ${x1} -60 ${z1} minecraft:oak_fence`);
  for (const g of gaps) await ctx.cmd(`setblock ${g.x} -60 ${g.z} minecraft:air`);
}

/** 庇护所判定（T16/T20 共用）：门 + 头顶遮蔽 + 四向有墙 */
async function shelterChecks(ctx: Ctx): Promise<Check[]> {
  const p = await ctx.botPos();
  const c: Check[] = [];
  const doors = await ctx.findBlocks(['oak_door', 'spruce_door', 'birch_door'], p, 8, 1);
  c.push(check('附近有门(≤8格)', '≥1', String(doors.length), doors.length >= 1));
  // 头顶遮蔽：上方 2..12 格内任一非空气
  let covered = false;
  for (let dy = 2; dy <= 12 && !covered; dy++) {
    covered = !(await ctx.isBlock(Math.floor(p.x), Math.floor(p.y) + dy, Math.floor(p.z), 'minecraft:air'));
  }
  c.push(check('头顶有遮蔽(2..12格)', '非空气', covered ? '有遮蔽' : '露天', covered));
  // 四向围合：每个水平方向 6 格内（脚/头两层同时）存在实体方块（门也算围合）
  let walls = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    let hit = false;
    for (let d = 1; d <= 6 && !hit; d++) {
      const bx = Math.floor(p.x) + dx * d, bz = Math.floor(p.z) + dz * d, by = Math.floor(p.y);
      const feetSolid = !(await ctx.isBlock(bx, by, bz, 'minecraft:air'));
      const headSolid = !(await ctx.isBlock(bx, by + 1, bz, 'minecraft:air'));
      if (feetSolid && headSolid) hit = true;
    }
    if (hit) walls++;
  }
  c.push(check('四向围合(6格内两层墙)', '4向', `${walls}向`, walls >= 4));
  return c;
}

// ───────────────────────── Experience + Reliability 任务 ─────────────────────────

export const TASKS: TaskDef[] = [
  // ============ 梯度一：移动与寻路 ============
  {
    id: 'T01', name: '直线移动到目标点', timeoutMs: 60_000, pollMs: 2000,
    instruction: '走到金块那里',
    clarification: (ctx) => `金块在你东边 30 格，坐标 (${ctx.X + 30}, -60, 0)`,
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await ctx.cmd(`setblock ${ctx.X + 30} -60 0 minecraft:gold_block`);
    },
    async judge(ctx) {
      const p = await ctx.botPos();
      const d = dist2d(p, { x: ctx.X + 30.5, z: 0.5 });
      return { pass: d <= 2.5, checks: [check('距金块水平距离', '≤2.5', d.toFixed(2), d <= 2.5)] };
    },
  },
  {
    id: 'T02', name: '绕障寻路（不许拆墙）', timeoutMs: 90_000, pollMs: 2000,
    instruction: '走到墙后面的金块那里',
    clarification: (ctx) => `金块坐标 (${ctx.X + 30}, -60, 0)`,
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await ctx.cmd(`setblock ${ctx.X + 30} -60 0 minecraft:gold_block`);
      await ctx.cmd(`fill ${ctx.X + 15} -60 -5 ${ctx.X + 15} -58 5 minecraft:stone`);
    },
    async judge(ctx) {
      const p = await ctx.botPos();
      const d = dist2d(p, { x: ctx.X + 30.5, z: 0.5 });
      if (d > 2.5) return { pass: false, checks: [check('距金块水平距离', '≤2.5', d.toFixed(2), false)] };
      let intact = 0;
      for (let z = -5; z <= 5; z++) for (let y = -60; y <= -58; y++) {
        if (await ctx.isBlock(ctx.X + 15, y, z, 'minecraft:stone')) intact++;
      }
      return {
        pass: intact === 33,
        checks: [
          check('距金块水平距离', '≤2.5', d.toFixed(2), true),
          check('墙体完好(33块石头)', '33', String(intact), intact === 33),
        ],
      };
    },
  },
  {
    id: 'T03', name: '过门进屋', timeoutMs: 90_000, pollMs: 2000,
    instruction: '进屋摸到金块',
    clarification: (ctx) => `屋子就在你前面，金块在屋里，坐标 (${ctx.X + 10}, -60, 1)`,
    start: { dx: 0, dz: -10 },
    async setup(ctx) {
      const h = await buildHouse(ctx, ctx.X + 10, 0);
      await ctx.cmd(`setblock ${ctx.X + 10} -60 1 minecraft:gold_block`);
      ctx.state.door = h.door;
    },
    async judge(ctx) {
      const p = await ctx.botPos();
      const inside = p.x >= ctx.X + 8.2 && p.x <= ctx.X + 12.8 && p.z >= -1.8 && p.z <= 1.8;
      const door = ctx.state.door as { x: number; y: number; z: number };
      const doorOk = await ctx.isBlock(door.x, door.y, door.z, 'minecraft:oak_door');
      return {
        pass: inside && doorOk,
        checks: [
          check('bot 位于屋内', '屋内', `(${p.x.toFixed(1)},${p.z.toFixed(1)}) ${inside ? '屋内' : '屋外'}`, inside),
          check('门未被破坏', 'oak_door 仍在', doorOk ? '完好' : '被拆', doorOk),
        ],
      };
    },
  },
  {
    id: 'T04', name: '垂直移动（爬高）', timeoutMs: 90_000, pollMs: 2000,
    instruction: '爬到塔顶',
    clarification: (ctx) => `塔就在你东边，塔顶金块坐标 (${ctx.X + 18}, -54, 0)`,
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      // 6 级台阶：第 i 级位于 x=X+10+i，柱体 y -60..-61+i，3 格宽
      for (let i = 1; i <= 6; i++) {
        await ctx.cmd(`fill ${ctx.X + 10 + i} -60 -1 ${ctx.X + 10 + i} ${-61 + i} 1 minecraft:stone`);
      }
      // 顶部 3×3 平台（顶面 y=-55，站立 y=-54）+ 金块
      await ctx.cmd(`fill ${ctx.X + 17} -60 -1 ${ctx.X + 19} -55 1 minecraft:stone`);
      await ctx.cmd(`setblock ${ctx.X + 18} -54 0 minecraft:gold_block`);
    },
    async judge(ctx) {
      const p = await ctx.botPos();
      const onTop = p.y >= -54.5 && p.x >= ctx.X + 16.5 && p.x <= ctx.X + 19.5 && Math.abs(p.z) <= 1.5;
      return { pass: onTop, checks: [check('登顶(y≥-54.5 且在平台内)', '塔顶', `y=${p.y.toFixed(1)} x=${p.x.toFixed(1)} z=${p.z.toFixed(1)}`, onTop)] };
    },
  },
  {
    id: 'T05', name: '出水脱困', timeoutMs: 60_000, pollMs: 2000,
    instruction: '上岸，到金块那里',
    clarification: (ctx) => `金块在岸上，坐标 (${ctx.X + 25}, -60, 0)`,
    start: { dx: 13, dz: 0 }, // runner 会先 tp 到 start，setup 再把 bot 砸进水底
    async setup(ctx) {
      await ctx.cmd(`fill ${ctx.X + 10} -63 -3 ${ctx.X + 16} -61 3 minecraft:water`);
      await ctx.cmd(`setblock ${ctx.X + 25} -60 0 minecraft:gold_block`);
      await ctx.cmd(`tp ${ctx.botName} ${ctx.X + 13} -63 0`);
    },
    async judge(ctx) {
      const p = await ctx.botPos();
      const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
      const inWater = await ctx.isBlock(feet.x, feet.y, feet.z, 'minecraft:water');
      const d = dist2d(p, { x: ctx.X + 25.5, z: 0.5 });
      const pass = !inWater && d <= 2.5 && !ctx.botDied();
      return {
        pass,
        checks: [
          check('已离水', '脚下非水', inWater ? '仍在水中' : '已上岸', !inWater),
          check('距金块水平距离', '≤2.5', d.toFixed(2), d <= 2.5),
          check('未死亡', '存活', ctx.botDied() ? '死亡' : '存活', !ctx.botDied()),
        ],
      };
    },
    async cleanup(ctx) {
      // 回填水坑，恢复地面
      await ctx.cmd(`fill ${ctx.X + 10} -63 -3 ${ctx.X + 16} -62 3 minecraft:dirt`);
      await ctx.cmd(`fill ${ctx.X + 10} -61 -3 ${ctx.X + 16} -61 3 minecraft:grass_block`);
    },
  },

  // ============ 梯度二：资源采集与基础合成 ============
  {
    id: 'T06', name: '徒手采集木头', timeoutMs: 180_000, pollMs: 4000,
    instruction: '这是人工训练场：Y=-60 就是当前地面，不用找出口。去砍你东边约 15 格的橡树，带回 3 个原木',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await plantTree(ctx, ctx.X + 15, 0);
      await plantTree(ctx, ctx.X + 22, 5);
      await plantTree(ctx, ctx.X + 22, -5);
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const n = inv['oak_log'] ?? 0;
      return { pass: n >= 3, checks: [check('背包 oak_log', '≥3', String(n), n >= 3)] };
    },
  },
  {
    id: 'T07', name: '基础合成链（原木→木镐）', timeoutMs: 180_000, pollMs: 4000,
    instruction: '做一把木镐',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await ctx.cmd(`give ${ctx.botName} minecraft:oak_log 4`);
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const n = inv['wooden_pickaxe'] ?? 0;
      return { pass: n >= 1, checks: [check('背包 wooden_pickaxe', '≥1', String(n), n >= 1)] };
    },
  },
  {
    id: 'T08', name: '挖矿与工具升级', timeoutMs: 240_000, pollMs: 4000,
    instruction: '挖些圆石，升级成石镐',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await ctx.cmd(`fill ${ctx.X + 10} -60 -5 ${ctx.X + 19} -58 4 minecraft:stone`);
      await ctx.cmd(`give ${ctx.botName} minecraft:wooden_pickaxe 1`);
      await ctx.cmd(`give ${ctx.botName} minecraft:oak_log 2`);
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const pick = inv['stone_pickaxe'] ?? 0;
      const cob = inv['cobblestone'] ?? 0;
      return {
        pass: pick >= 1 && cob >= 5,
        checks: [
          check('背包 stone_pickaxe', '≥1', String(pick), pick >= 1),
          check('剩余 cobblestone', '≥5', String(cob), cob >= 5),
        ],
      };
    },
  },
  {
    id: 'T09', name: '定向采集+交付到箱子', timeoutMs: 300_000, pollMs: 5000,
    instruction: '砍 5 个原木放进箱子里',
    clarification: (ctx) => `箱子在坐标 (${ctx.X + 5}, -60, 0)，树就在东边不远`,
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await ctx.cmd(`setblock ${ctx.X + 5} -60 0 minecraft:chest`);
      await plantTree(ctx, ctx.X + 15, 0);
      await plantTree(ctx, ctx.X + 20, 5);
      await plantTree(ctx, ctx.X + 20, -5);
    },
    async judge(ctx) {
      const items = await ctx.chestItems(ctx.X + 5, -60, 0);
      const n = items['oak_log'] ?? 0;
      return { pass: n >= 5, checks: [check('箱子内 oak_log（背包不算）', '≥5', String(n), n >= 5)] };
    },
  },

  // ============ 梯度三：生存自维持 ============
  {
    id: 'T10', name: '进食回复（指令模糊化）', timeoutMs: 120_000, pollMs: 3000,
    instruction: '照顾好自己',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      // BUG-CROSS-18 · 先压低饥饿、再给食物；否则生存反射会在 setup 观察窗前把面包吃光。
      await ctx.cmd(`effect give ${ctx.botName} minecraft:hunger 30 120`);
      const t0 = Date.now();
      while (Date.now() - t0 < 45_000) {
        const f = await ctx.botFood();
        if (f <= 6) break;
        await new Promise(r => setTimeout(r, 1500));
      }
      await ctx.cmd(`effect clear ${ctx.botName} minecraft:hunger`);
      await ctx.cmd(`give ${ctx.botName} minecraft:bread 5`);
      ctx.log(`[T10] 饥饿压制完成 food=${await ctx.botFood()}`);
    },
    async judge(ctx) {
      const f = await ctx.botFood();
      const pass = f >= 18 && !ctx.botDied();
      return {
        pass,
        checks: [
          check('饥饿值回升', '≥18', String(f), f >= 18),
          check('未死亡', '存活', ctx.botDied() ? '死亡' : '存活', !ctx.botDied()),
        ],
      };
    },
  },
  {
    id: 'T11', name: '主动照明', timeoutMs: 180_000, pollMs: 8000,
    instruction: '把羊毛圈起来的那块区域用火把照亮，别让怪物刷出来',
    clarification: (ctx) => `羊毛圈在你东边，中心坐标 (${ctx.X + 14}, -60, 0)`,
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await ctx.cmd('time set night');
      // 9×9 羊毛边框（嵌在地面 y=-61）
      const x0 = ctx.X + 10, x1 = ctx.X + 18;
      await ctx.cmd(`fill ${x0} -61 -4 ${x1} -61 -4 minecraft:white_wool`);
      await ctx.cmd(`fill ${x0} -61 4 ${x1} -61 4 minecraft:white_wool`);
      await ctx.cmd(`fill ${x0} -61 -4 ${x0} -61 4 minecraft:white_wool`);
      await ctx.cmd(`fill ${x1} -61 -4 ${x1} -61 4 minecraft:white_wool`);
      await ctx.cmd(`give ${ctx.botName} minecraft:torch 8`);
    },
    async judge(ctx) {
      const center = { x: ctx.X + 14, y: -60, z: 0 };
      const torches = await ctx.findBlocks(['torch', 'wall_torch'], center, 8);
      const inArea = torches.filter(t => t.x >= ctx.X + 10 && t.x <= ctx.X + 18 && t.z >= -4 && t.z <= 4);
      return {
        pass: inArea.length >= 4,
        checks: [check('区域内火把数', '≥4', String(inArea.length), inArea.length >= 4)],
      };
    },
    async cleanup(ctx) {
      await ctx.cmd('time set day');
      await ctx.cmd(`fill ${ctx.X + 10} -61 -4 ${ctx.X + 18} -61 4 minecraft:grass_block`);
    },
  },
  {
    id: 'T12', name: '主动战斗', timeoutMs: 120_000, pollMs: 3000,
    instruction: '把围栏里的僵尸清掉',
    start: { dx: 12, dz: 0 },
    ownerPos: { dx: -5, dz: 0 },
    async setup(ctx) {
      await buildFence(ctx, ctx.X + 10, -7, ctx.X + 24, 7);
      await ctx.cmd(`give ${ctx.botName} minecraft:stone_sword 1`);
      await ctx.cmd(`summon minecraft:zombie ${ctx.X + 18} -60 0 {PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}`);
    },
    async judge(ctx) {
      const n = await ctx.countEntities('zombie', ctx.X + 17, -60, 0, 30);
      const hp = await ctx.botHealth();
      const pass = n === 0 && !ctx.botDied() && hp > 0;
      return {
        pass,
        checks: [
          check('围栏内僵尸数', '0', String(n), n === 0),
          check('bot 存活', 'HP>0', `HP=${hp}`, hp > 0 && !ctx.botDied()),
        ],
      };
    },
    async cleanup(ctx) {
      await ctx.cmd(`kill @e[type=minecraft:zombie,x=${ctx.X + 17},y=-60,z=0,distance=..60]`);
    },
  },
  {
    id: 'T13', name: '危险识别与撤退', timeoutMs: 180_000, pollMs: 3000,
    instruction: '去前面围栏那边看看情况',
    clarification: (ctx) => `围栏在你东边，大概坐标 (${ctx.X + 15}, -60, 0)`,
    start: { dx: -5, dz: 0 },
    ownerPos: { dx: -28, dz: 0 },
    async setup(ctx) {
      // 围栏（西侧留 2 格出口）+ 3 只骷髅；西边 30 格外安全屋
      await buildFence(ctx, ctx.X + 10, -7, ctx.X + 24, 7, [{ x: ctx.X + 10, z: 0 }, { x: ctx.X + 10, z: 1 }]);
      const helm = '{PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}';
      await ctx.cmd(`summon minecraft:skeleton ${ctx.X + 17} -60 -2 ${helm}`);
      await ctx.cmd(`summon minecraft:skeleton ${ctx.X + 17} -60 0 ${helm}`);
      await ctx.cmd(`summon minecraft:skeleton ${ctx.X + 17} -60 2 ${helm}`);
      const h = await buildHouse(ctx, ctx.X - 20, 0);
      ctx.state.house = h.inside;
    },
    async judge(ctx) {
      if (ctx.elapsed() < 60_000) return { pass: false, checks: [check('观察期', '≥60s', `${Math.round(ctx.elapsed() / 1000)}s`, false)] };
      const p = await ctx.botPos();
      const hp = await ctx.botHealth();
      const house = ctx.state.house as { x: number; z: number };
      const inHouse = Math.abs(p.x - house.x) <= 2 && Math.abs(p.z - house.z) <= 2;
      const skelNear = await ctx.countEntities('skeleton', Math.floor(p.x), -60, Math.floor(p.z), 20);
      const safe = inHouse || skelNear === 0;
      const pass = safe && hp >= 10 && !ctx.botDied();
      return {
        pass,
        checks: [
          check('已脱险(屋内或距骷髅≥20)', '安全', inHouse ? '安全屋内' : `20格内骷髅=${skelNear}`, safe),
          check('血量', '≥10', String(hp), hp >= 10),
          check('未死亡', '存活', ctx.botDied() ? '死亡' : '存活', !ctx.botDied()),
        ],
      };
    },
    async cleanup(ctx) {
      await ctx.cmd(`kill @e[type=minecraft:skeleton,x=${ctx.X + 17},y=-60,z=0,distance=..120]`);
    },
  },

  // ============ 梯度四：生产循环 ============
  {
    id: 'T14', name: '农耕全流程', timeoutMs: 360_000, pollMs: 5000,
    instruction: '在旁边的耕地上种小麦，收 4 个小麦回来',
    clarification: (ctx) => `耕地中心坐标 (${ctx.X + 12}, -60, 0)，就在你东边几步`,
    start: { dx: 5, dz: 0 },
    async setup(ctx) {
      await ctx.cmd(`fill ${ctx.X + 10} -61 -2 ${ctx.X + 14} -61 2 minecraft:farmland[moisture=7]`);
      await ctx.cmd(`setblock ${ctx.X + 12} -61 0 minecraft:water`);
      await ctx.cmd(`give ${ctx.botName} minecraft:wheat_seeds 8`);
      await ctx.cmd(`give ${ctx.botName} minecraft:bone_meal 16`);
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const n = inv['wheat'] ?? 0;
      return { pass: n >= 4, checks: [check('背包 wheat', '≥4', String(n), n >= 4)] };
    },
    async cleanup(ctx) {
      await ctx.cmd(`fill ${ctx.X + 10} -61 -2 ${ctx.X + 14} -61 2 minecraft:grass_block`);
    },
  },
  {
    id: 'T15', name: '动物繁殖', timeoutMs: 240_000, pollMs: 5000,
    instruction: '用小麦喂牛，让牛生小牛',
    clarification: (ctx) => `两头牛就在你旁边的围栏里，大概 (${ctx.X + 15}, -60, 0)`,
    start: { dx: 15, dz: 0 },
    async setup(ctx) {
      await buildFence(ctx, ctx.X + 10, -6, ctx.X + 21, 5);
      await ctx.cmd(`summon minecraft:cow ${ctx.X + 14} -60 0 {PersistenceRequired:1b}`);
      await ctx.cmd(`summon minecraft:cow ${ctx.X + 17} -60 0 {PersistenceRequired:1b}`);
      await ctx.cmd(`give ${ctx.botName} minecraft:wheat 4`);
    },
    async judge(ctx) {
      const n = await ctx.countEntities('cow', ctx.X + 15, -60, 0, 25);
      return { pass: n >= 3, checks: [check('围栏内牛数量(出现幼牛)', '≥3', String(n), n >= 3)] };
    },
    async cleanup(ctx) {
      await ctx.cmd(`kill @e[type=minecraft:cow,x=${ctx.X + 15},y=-60,z=0,distance=..60]`);
    },
  },
  {
    id: 'T16', name: '建造庇护所', timeoutMs: 480_000, pollMs: 10_000,
    instruction: '用背包里的材料盖一个能安全待着的小屋，你要待在里面',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await ctx.cmd(`give ${ctx.botName} minecraft:cobblestone 64`);
      await ctx.cmd(`give ${ctx.botName} minecraft:oak_door 1`);
      await ctx.cmd(`give ${ctx.botName} minecraft:torch 2`);
    },
    async judge(ctx) {
      const checks = await shelterChecks(ctx);
      return { pass: checks.every(c => c.ok), checks };
    },
  },
  {
    id: 'T17', name: '物品分类入库', timeoutMs: 300_000, pollMs: 6000,
    instruction: '把背包里的东西分类放好：原木放北边挂木头牌子的箱子，圆石放中间挂石头牌子的箱子，面包放南边挂食物牌子的箱子',
    clarification: (ctx) => `三个箱子在你东边：木头箱 (${ctx.X + 6}, -60, -4)，石头箱 (${ctx.X + 6}, -60, 0)，食物箱 (${ctx.X + 6}, -60, 4)`,
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      const x = ctx.X + 6;
      await ctx.cmd(`setblock ${x} -60 -4 minecraft:chest`);
      await ctx.cmd(`setblock ${x} -60 0 minecraft:chest`);
      await ctx.cmd(`setblock ${x} -60 4 minecraft:chest`);
      const sign = (z: number, label: string) =>
        ctx.cmd(`setblock ${x - 1} -60 ${z} minecraft:oak_sign[rotation=12]{front_text:{messages:['"${label}"','""','""','""']}}`);
      await sign(-4, '木头');
      await sign(0, '石头');
      await sign(4, '食物');
      await ctx.cmd(`give ${ctx.botName} minecraft:oak_log 10`);
      await ctx.cmd(`give ${ctx.botName} minecraft:cobblestone 10`);
      await ctx.cmd(`give ${ctx.botName} minecraft:bread 10`);
      ctx.state.chestX = x;
    },
    async judge(ctx) {
      const x = ctx.state.chestX as number;
      const wood = await ctx.chestItems(x, -60, -4);
      const stone = await ctx.chestItems(x, -60, 0);
      const food = await ctx.chestItems(x, -60, 4);
      const pure = (items: Record<string, number>, want: string) =>
        (items[want] ?? 0) >= 8 && Object.keys(items).every(k => k === want);
      const c = [
        check('木头箱', '只含 oak_log ≥8', JSON.stringify(wood), pure(wood, 'oak_log')),
        check('石头箱', '只含 cobblestone ≥8', JSON.stringify(stone), pure(stone, 'cobblestone')),
        check('食物箱', '只含 bread ≥8', JSON.stringify(food), pure(food, 'bread')),
      ];
      return { pass: c.every(v => v.ok), checks: c };
    },
  },

  // ============ 梯度五：综合与多步规划 ============
  {
    id: 'T18', name: '睡觉过夜（指令模糊化）', timeoutMs: 180_000, pollMs: 4000,
    instruction: '天黑了，休息吧',
    clarification: (ctx) => `屋里有床，上床睡一觉，天亮了叫你。床在 (${ctx.X + 10}, -60, 1)`,
    start: { dx: 4, dz: -6 },
    async setup(ctx) {
      const h = await buildHouse(ctx, ctx.X + 10, 0);
      await ctx.cmd(`setblock ${ctx.X + 9} -60 1 minecraft:red_bed[facing=west,part=foot]`);
      await ctx.cmd(`setblock ${ctx.X + 10} -60 1 minecraft:red_bed[facing=west,part=head]`);
      await ctx.cmd(`setblock ${ctx.X + 11} -59 1 minecraft:torch`);
      await ctx.cmd('gamerule playersSleepingPercentage 1');
      await ctx.cmd('gamerule doDaylightCycle true');
      await ctx.cmd('time set 13500');
      ctx.state.house = h.inside;
    },
    async judge(ctx) {
      const t = await ctx.daytime();
      const slept = t < 12_500; // 自然推进 3min 最多到 ~17100，<12500 只可能是睡觉跳天
      const pass = slept && !ctx.botDied();
      return {
        pass,
        checks: [
          check('夜晚被跳过(daytime)', '<12500', String(t), slept),
          check('未死亡', '存活', ctx.botDied() ? '死亡' : '存活', !ctx.botDied()),
        ],
      };
    },
    async cleanup(ctx) {
      await ctx.cmd('gamerule doDaylightCycle false');
      await ctx.cmd('time set day');
    },
  },
  {
    id: 'T19', name: '多步合成链（熔炼）', timeoutMs: 480_000, pollMs: 6000,
    instruction: '做点熟牛排吃',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await ctx.cmd(`give ${ctx.botName} minecraft:oak_log 4`);
      await ctx.cmd(`give ${ctx.botName} minecraft:cobblestone 8`);
      await ctx.cmd(`give ${ctx.botName} minecraft:beef 3`);
      ctx.state.food0 = await ctx.botFood();
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const n = inv['cooked_beef'] ?? 0;
      const f = await ctx.botFood();
      const f0 = ctx.state.food0 as number;
      const c = [
        check('背包 cooked_beef', '≥1', String(n), n >= 1),
        check('饥饿值未恶化', `≥${f0}`, String(f), f >= f0),
      ];
      return { pass: c.every(v => v.ok), checks: c };
    },
  },
  {
    id: 'T20', name: '综合生存（终极）', timeoutMs: 1_320_000, pollMs: 15_000,
    instruction: '现在是清晨，你有一个白天的时间自由准备，想办法活过今晚。天亮时我来检查',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await plantTree(ctx, ctx.X + 15, 5);
      await plantTree(ctx, ctx.X + 15, -5);
      await ctx.cmd(`fill ${ctx.X + 24} -60 -3 ${ctx.X + 29} -59 2 minecraft:stone`);
      await ctx.cmd(`fill ${ctx.X + 10} -61 0 ${ctx.X + 13} -61 1 minecraft:farmland[moisture=7]`);
      await ctx.cmd(`setblock ${ctx.X + 12} -61 2 minecraft:water`);
      await ctx.cmd(`give ${ctx.botName} minecraft:wheat_seeds 4`);
      await ctx.cmd('gamerule doDaylightCycle true');
      await ctx.cmd('gamerule doMobSpawning true');
      await ctx.cmd('time set 0');
      ctx.state.dawnSeen = false;
    },
    async judge(ctx) {
      // 等一整个昼夜：daytime 走完一圈回到清晨（>20min 由 timeout 兜底）
      const t = await ctx.daytime();
      const fullDay = ctx.elapsed() > 1_000_000 && t < 2000; // ≈17min 后回到清晨
      if (!fullDay) {
        return { pass: false, checks: [check('昼夜进度', '过完整夜回到清晨', `daytime=${t} elapsed=${Math.round(ctx.elapsed() / 60000)}min`, false)] };
      }
      const inv = await ctx.botInv();
      const tool = Object.keys(inv).some(k => /(_pickaxe|_axe|_sword|_shovel|_hoe)$/.test(k));
      const f = await ctx.botFood();
      const shelter = await shelterChecks(ctx);
      const sheltered = shelter.every(c => c.ok);
      const c = [
        check('活到清晨', '存活', ctx.botDied() ? '中途死过' : '存活', !ctx.botDied()),
        check('拥有 ≥1 件工具', '有', tool ? Object.keys(inv).filter(k => /(_pickaxe|_axe|_sword|_shovel|_hoe)$/.test(k)).join(',') : '无', tool),
        check('身处自建庇护所', '是', sheltered ? '是' : '否', sheltered),
        ...shelter,
        check('饥饿值', '≥10', String(f), f >= 10),
      ];
      return { pass: c.slice(0, 3).every(v => v.ok) && f >= 10, checks: c };
    },
    async cleanup(ctx) {
      await ctx.cmd('gamerule doMobSpawning false');
      await ctx.cmd('gamerule doDaylightCycle false');
      await ctx.cmd('time set day');
      await ctx.cmd(`kill @e[type=#minecraft:undead,distance=..0] `); // no-op 容错
      for (const t of ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'drowned']) {
        await ctx.cmd(`kill @e[type=minecraft:${t}]`);
      }
      await ctx.cmd(`fill ${ctx.X + 10} -61 0 ${ctx.X + 13} -61 2 minecraft:grass_block`);
    },
  },

  // ============ 梯度六：交互可靠性 ============
  {
    id: 'T21', name: '模糊指令主动澄清', layer: 'reliability', expectedTerminal: 'none',
    timeoutMs: 45_000, pollMs: 1500,
    instruction: '去那边看看',
    start: { dx: 0, dz: 0 },
    async setup() { /* 无需摆场，故意不给目标 */ },
    async judge(ctx) {
      const asked = ctx.botSaid(/[?？]|哪里|哪边|哪儿|什么目标|具体|坐标|位置/);
      return { pass: asked, checks: [check('主动澄清目标', '提出有效问题', asked ? '已澄清' : '未澄清', asked)] };
    },
  },
  {
    id: 'T22', name: '执行中改派新目标', layer: 'reliability', expectedTerminal: 'success',
    timeoutMs: 150_000, pollMs: 2000,
    instruction: '这是人工训练场：Y=-60 就是当前地面，不用找出口。先去砍你东边约 12 格的 8 个原木',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await plantTree(ctx, ctx.X + 12, 0);
      await plantTree(ctx, ctx.X + 16, 4);
      await ctx.cmd(`setblock ${ctx.X + 32} -60 0 minecraft:diamond_block`);
    },
    async afterInstruction(ctx) {
      await new Promise(resolve => setTimeout(resolve, 12_000));
      await ctx.say(`停下刚才的任务，改成走到东边的钻石块，坐标 (${ctx.X + 32}, -60, 0)`);
      ctx.state.retasked = true;
    },
    async judge(ctx) {
      const p = await ctx.botPos();
      const d = dist2d(p, { x: ctx.X + 32.5, z: 0.5 });
      const pass = ctx.state.retasked === true && d <= 2.5;
      return { pass, checks: [check('改派后距钻石块', '≤2.5', d.toFixed(2), pass)] };
    },
  },
  {
    id: 'T23', name: '不可达时明确失败或求助', layer: 'reliability', expectedTerminal: 'failure',
    timeoutMs: 120_000, pollMs: 2000,
    instruction: '进入前面完全封闭的石屋，走到里面的金块上；如果确实进不去就告诉我',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      const cx = ctx.X + 20;
      await ctx.cmd(`fill ${cx - 3} -61 -3 ${cx + 3} -56 3 minecraft:stone`);
      await ctx.cmd(`fill ${cx - 2} -60 -2 ${cx + 2} -57 2 minecraft:air`);
      await ctx.cmd(`setblock ${cx} -60 0 minecraft:gold_block`);
    },
    async judge(ctx) {
      const saidFailure = ctx.botSaid(/无法|不能|进不去|到不了|失败|做不到|需要.*帮|帮忙|blocked|cannot|can't|failed/i);
      const saidSuccess = ctx.botSaid(/完成|搞定|到了|已经进去|done|finished/i);
      const pass = saidFailure && !saidSuccess;
      return {
        pass,
        checks: [
          check('明确失败或求助', '是', saidFailure ? '是' : '否', saidFailure),
          check('未假报完成', '否', saidSuccess ? '出现成功自述' : '未出现', !saidSuccess),
        ],
      };
    },
  },
  {
    id: 'T24', name: '世界完成与反馈一致', layer: 'reliability', expectedTerminal: 'success',
    timeoutMs: 180_000, pollMs: 3000,
    instruction: '这是人工训练场：Y=-60 就是当前地面，不用找出口。砍你东边约 14 格的 3 个原木，完成后明确告诉我结果',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await plantTree(ctx, ctx.X + 14, 0);
      await plantTree(ctx, ctx.X + 20, 4);
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const logs = inv.oak_log ?? 0;
      const feedback = ctx.botSaid(/完成|收集到|已经.*原木|搞定|done|finished/i);
      return {
        pass: logs >= 3 && feedback,
        checks: [
          check('背包 oak_log', '≥3', String(logs), logs >= 3),
          check('主动成功反馈', '有', feedback ? '有' : '无', feedback),
        ],
      };
    },
  },
  {
    id: 'T25', name: '长任务主动进度反馈', layer: 'reliability', expectedTerminal: 'success',
    timeoutMs: 240_000, pollMs: 4000,
    instruction: '砍 8 个原木，过程中告诉我进度，完成后再汇报',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await plantTree(ctx, ctx.X + 14, 0);
      await plantTree(ctx, ctx.X + 20, 5);
      await plantTree(ctx, ctx.X + 20, -5);
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const logs = inv.oak_log ?? 0;
      const progress = ctx.botSaid(/进度|正在|目前|已经采|已采|还差|收集了\s*[1-7]/i);
      return {
        pass: logs >= 8 && progress,
        checks: [
          check('背包 oak_log', '≥8', String(logs), logs >= 8),
          check('过程进度反馈', '至少 1 次', progress ? '已反馈' : '未反馈', progress),
        ],
      };
    },
  },
  {
    id: 'T26', name: '上下文目标复用', layer: 'reliability', expectedTerminal: 'success',
    timeoutMs: 360_000, pollMs: 4000,
    instruction: '在这里砍 3 个原木',
    start: { dx: 0, dz: 0 },
    async setup(ctx) {
      await plantTree(ctx, ctx.X + 12, 0);
      await plantTree(ctx, ctx.X + 16, 4);
      ctx.state.phase = 1;
    },
    async afterInstruction(ctx) {
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        const inv = await ctx.botInv();
        if ((inv.oak_log ?? 0) >= 3) {
          await ctx.cmd(`clear ${ctx.botName} minecraft:oak_log`);
          await ctx.cmd(`tp ${ctx.botName} ${ctx.X + 28} -60 0`);
          await plantTree(ctx, ctx.X + 38, 0);
          await plantTree(ctx, ctx.X + 42, 4);
          ctx.state.phase = 2;
          await ctx.say('换到东边这片树林，再来一次');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      ctx.state.phase = 'first_timeout';
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const logs = inv.oak_log ?? 0;
      const secondPhase = ctx.state.phase === 2;
      return {
        pass: secondPhase && logs >= 3,
        checks: [
          check('已进入第二轮', '是', String(ctx.state.phase), secondPhase),
          check('第二轮背包 oak_log', '≥3', String(logs), logs >= 3),
        ],
      };
    },
  },

  // ============ 梯度二补充：资源发现 + 采集闭环 ============
  {
    id: 'T27', name: '矿洞煤矿搜索采集', expectedTerminal: 'success',
    timeoutMs: 240_000, pollMs: 4000,
    instruction: '我们一起在矿洞里。你去找找哪里有煤矿，挖出来收集四块煤。',
    start: { dx: 0, dz: 0 },
    ownerPos: { dx: 1, dz: 1 },
    async setup(ctx) {
      // 封闭石质洞体：入口室 → 向东主通道 → 向南支洞。矿脉位于转角后的东侧墙面，
      // 玩家指令不提供坐标或方向；RCON 只摆场，不替轨迹定位、移动或挖掘。
      await ctx.cmd(`fill ${ctx.X - 3} -61 -4 ${ctx.X + 20} -55 12 minecraft:stone`);
      await ctx.cmd(`fill ${ctx.X - 2} -60 -2 ${ctx.X + 4} -57 2 minecraft:air`);
      await ctx.cmd(`fill ${ctx.X + 4} -60 -1 ${ctx.X + 13} -57 1 minecraft:air`);
      await ctx.cmd(`fill ${ctx.X + 11} -60 1 ${ctx.X + 15} -57 10 minecraft:air`);

      const vein = [
        { x: ctx.X + 16, y: -60, z: 7 },
        { x: ctx.X + 16, y: -60, z: 8 },
        { x: ctx.X + 16, y: -60, z: 9 },
        { x: ctx.X + 16, y: -59, z: 7 },
        { x: ctx.X + 16, y: -59, z: 8 },
        { x: ctx.X + 16, y: -59, z: 9 },
      ];
      for (const block of vein) {
        await ctx.cmd(`setblock ${block.x} ${block.y} ${block.z} minecraft:coal_ore`);
      }
      await ctx.cmd(`clear ${ctx.botName} minecraft:coal`);
      await ctx.cmd(`give ${ctx.botName} minecraft:stone_pickaxe 1`);
      ctx.state.coalVein = vein;
    },
    async judge(ctx) {
      const inv = await ctx.botInv();
      const coal = inv.coal ?? 0;
      const vein = ctx.state.coalVein as Array<{ x: number; y: number; z: number }> | undefined;
      let remaining = 0;
      for (const block of vein ?? []) {
        if (await ctx.isBlock(block.x, block.y, block.z, 'minecraft:coal_ore')) remaining++;
      }
      const mined = (vein?.length ?? 0) - remaining;
      const alive = !ctx.botDied();
      const checks = [
        check('指定煤矿脉已挖掘', '≥4块', String(mined), mined >= 4),
        check('背包 coal', '≥4', String(coal), coal >= 4),
        check('轨迹存活', '存活', alive ? '存活' : '死亡', alive),
      ];
      return { pass: checks.every(value => value.ok), checks };
    },
    async cleanup(ctx) {
      await ctx.cmd(`kill @e[type=minecraft:item,x=${ctx.X},y=-60,z=0,distance=..40]`);
      await ctx.cmd(`fill ${ctx.X - 3} -60 -4 ${ctx.X + 20} -55 12 minecraft:air`);
      await ctx.cmd(`fill ${ctx.X - 3} -61 -4 ${ctx.X + 20} -61 12 minecraft:grass_block`);
    },
  },
];
