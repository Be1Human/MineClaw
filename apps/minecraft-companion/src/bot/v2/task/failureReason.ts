/**
 * 🧩 L6 · FailureReason（FEAT-L6-04 · 任务闭环契约 · 回边①）
 *
 * 把"任务为什么失败"从自由中文文本升级为结构化 { code, detail }。
 * code 给程序看（触发器退避 / LLM 换策略 / 终态分类统计），detail 给人看。
 *
 * 设计要点：
 *   - fail(taskId, reason) 兼容旧签名 —— 传 string 自动包装成 {code:'unknown', detail}。
 *   - code 是封闭枚举：新增失败类型 = 加一个 code（OCP），不改判定逻辑。
 */

export type FailureCode =
  | 'no_resource_found'   // 探索尽头也没找到目标资源
  | 'no_tool'             // 缺必备工具
  | 'stall_no_progress'   // 看门狗：长时间无进展
  | 'nav_timeout'         // 寻路超时
  | 'unreachable'         // 目标不可达（拉黑耗尽）
  | 'died'                // bot 死亡
  | 'preempted'           // 被高优任务抢占且未恢复
  | 'false_success'       // 后置验证门 3 连拒（并入 FEAT-L6-03）
  | 'precondition_failed' // preflight 拒绝（含环境门 no_hostiles_nearby / safe_daytime）
  | 'start_failed'        // 启动失败
  | 'need_owner'          // GoalAgent 求解到上限，转求助主人（BUG-CROSS-02 · 主链路终态，此前一律被硬编码成 unknown）
  | 'cancelled'           // 目标被取消（BUG-CROSS-02）
  | 'unknown';            // 旧字符串过渡期兜底

export interface FailureReason {
  code: FailureCode;
  detail?: string;
}

/** 把旧式 string reason 或结构化 reason 统一成 FailureReason */
export function toFailureReason(reason: FailureReason | string): FailureReason {
  if (typeof reason === 'string') return { code: 'unknown', detail: reason };
  return reason;
}

/** 终态日志 / 事件摘要用的一行式渲染：`code` 或 `code · detail` */
export function formatFailureReason(reason: FailureReason): string {
  return reason.detail ? `${reason.code} · ${reason.detail}` : reason.code;
}
