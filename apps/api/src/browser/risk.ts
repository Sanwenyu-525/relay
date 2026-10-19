/**
 * 点击风险分类（F26，M3）。
 *
 * 它回答一个问题：**这一步点击会不会把"本任务的网页交互"变成"对外部世界的提交"？**
 * 用于在范围授权覆盖 `BROWSER_ACTION`（普通点击可以 AUTO）的情况下，把提交类点击
 * 升级为单动作审批。
 *
 * 必须写清楚的边界：**这是启发式，不是安全边界。**
 *   * 它依赖 a11y 快照里的 `role`/`name`/`inForm`，而这三者都可能被页面构造得难以辨认
 *     （自绘按钮、图标按钮、非中英语言文字）。漏判并不意味着动作必然被执行——
 *   * 真正结构性的护栏只有两条：`BROWSER_COMMIT` 的两个工具（提交表单、上传文件）
 *     永远不进范围授权，必须逐次批准；以及策略按站点收窄。
 *   * 因此这里的实现策略是**宁可多问**：拿不准时按 HIGH 处理，代价是一次多余的人工确认，
 *     而不是一次漏放行。
 */

import type { BrowserElement } from './provider.js';

/** 命中即视为"有外部影响"的动词（中英双语，大小写不敏感）。 */
const RISKY_VERBS: readonly string[] = [
  'submit', 'send', 'publish', 'post', 'buy', 'purchase', 'pay', 'delete', 'remove',
  'confirm', 'place order', 'checkout', 'transfer', 'withdraw', 'unsubscribe',
  '提交', '发送', '发布', '发表', '购买', '支付', '付款', '下单', '删除', '移除',
  '确认', '转账', '提现', '退订', '注销', '签约',
];

export type BrowserClickRisk = 'LOW' | 'HIGH';

export interface BrowserClickRiskVerdict {
  readonly risk: BrowserClickRisk;
  /** 人类可读的原因：进入审批文案，让用户看到"为什么这一步要确认"。 */
  readonly reason: string;
}

const LOW: BrowserClickRiskVerdict = { risk: 'LOW', reason: '' };

/**
 * 分类一次点击。
 *
 * `elements` 是**动作前**刚读到的快照元素；uid 不在其中时按 LOW 处理——那一步点击
 * 会在派发时以 `BROWSER_ELEMENT_NOT_FOUND` 失败，为一次注定失败的点击要审批没有意义。
 */
export function classifyClick(elements: readonly BrowserElement[], uid: string):
BrowserClickRiskVerdict {
  const element = elements.find((candidate) => candidate.uid === uid);
  if (element === undefined) {
    return { risk: 'LOW', reason: '目标元素不在当前快照里（这一步会因元素不存在而失败）。' };
  }
  const name = element.name.trim();
  const lower = name.toLowerCase();
  const verb = RISKY_VERBS.find((candidate) =>
    lower.includes(candidate.toLowerCase()));
  if (verb !== undefined) {
    return { risk: 'HIGH', reason: `点击目标「${name || element.role || uid}」${
      verb === name ? '是' : '包含'}提交/发送/支付/删除类操作（命中「${verb}」）。` };
  }
  if (isSubmitControl(element)) {
    return { risk: 'HIGH',
      reason: `点击目标「${name || element.role || uid}」是表单提交控件（在 form 内且可提交）。` };
  }
  return LOW;
}

/** 提交控件：角色是可提交控件，且位于表单内。 */
function isSubmitControl(element: BrowserElement): boolean {
  if (!element.inForm) return false;
  return element.role === 'button' || element.role === 'submit' || element.role === 'input';
}
