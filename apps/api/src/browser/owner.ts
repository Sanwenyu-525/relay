/**
 * 浏览器任务的所属身份（F26）。
 *
 * 与 Gateway 的 origin 词表一一对应：`RUN` → Run（Task/Run 工具循环，可写），
 * `SESSION` → 会话只读轮次（人设助手 / 普通 Agent 主流程，只读）。
 * 它是 `0107` 表里的 `owner_kind` 值，也是 `browserOwnerFor` 的返回类型。
 */

export type BrowserSessionOwnerKind = 'RUN' | 'SESSION';

/** 浏览器逻辑动作 → 一句中文动作说明（进 UI 与审批文案）。 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  BROWSER_LIST_PAGES: '读取页面列表',
  BROWSER_READ_PAGE: '读取页面内容',
  BROWSER_SCREENSHOT: '截取页面画面',
  BROWSER_WAIT_FOR: '等待页面内容',
  BROWSER_NEW_PAGE: '新建标签页',
  BROWSER_NAVIGATE: '导航到新地址',
  BROWSER_CLICK: '点击页面元素',
  BROWSER_FILL: '填写表单字段',
  BROWSER_PRESS_KEY: '按下按键',
  BROWSER_CLOSE_PAGE: '关闭标签页',
  BROWSER_SUBMIT_FORM: '提交表单',
  BROWSER_UPLOAD_FILE: '上传文件',
};

export function describeBrowserAction(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType;
}
