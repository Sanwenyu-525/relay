/** Run 等待原因的人类可读说法（docs/frontend/workbench-design.md §18.8）。
 *
 *  内部枚举不直接进界面：`REPEATED_FAILURE` 这类词对用户没有意义，读起来像故障代号。
 *  未登记的值原样透出而不是猜——枚举扩展时宁可显示原值，也不要显示一个错误的解释。
 */
export function waitReasonText(reason: string): string {
  switch (reason) {
    case "REPEATED_FAILURE": return "反复失败已停下，需要你决定";
    case "HUMAN_TOOL": return "有一个动作在等你批准";
    case "AWAITING_HUMAN_EVIDENCE": return "等你提供证据";
    default: return reason;
  }
}
