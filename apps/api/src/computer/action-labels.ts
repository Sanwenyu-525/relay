/**
 * Computer 动作 → 状态条「当前操作」文案（纯函数）。
 *
 * 文案只描述这一次动作本身做什么，不猜测目标应用：参数里没有可靠的
 * 应用名（窗口标题只有 get_windows 返回，动作参数不含），因此不虚构
 * 「正在操作 Chrome」这类应用前缀；有窗口信息后可在此追加。
 */

import type { JsonObject } from '../infrastructure/json.js';

export function describeComputerAction(actionType: string, params: JsonObject): string {
  switch (actionType) {
    case 'COMPUTER_SCREENSHOT':
      return '正在截取屏幕画面';
    case 'COMPUTER_GET_WINDOWS':
      return '正在查看窗口列表';
    case 'COMPUTER_ACTIVATE_WINDOW':
      return '正在切换窗口';
    case 'COMPUTER_CLICK':
      return `正在点击 (${integer(params.x)}, ${integer(params.y)})`;
    case 'COMPUTER_DOUBLE_CLICK':
      return `正在双击 (${integer(params.x)}, ${integer(params.y)})`;
    case 'COMPUTER_SCROLL':
      return '正在滚动页面';
    case 'COMPUTER_DRAG':
      return '正在拖拽';
    case 'COMPUTER_TYPE': {
      const text = typeof params.text === 'string' ? params.text : '';
      return text.length > 0 ? `正在输入内容（${text.length} 字符）` : '正在输入内容';
    }
    case 'COMPUTER_KEYPRESS': {
      const key = typeof params.key === 'string' ? params.key : '';
      return key === '' ? '正在按键' : `正在按键 ${key}`;
    }
    case 'COMPUTER_HOTKEY': {
      const keys = Array.isArray(params.keys)
        ? params.keys.filter((key): key is string => typeof key === 'string') : [];
      return keys.length > 0 ? `正在按组合键 ${keys.join('+')}` : '正在按组合键';
    }
    default:
      return 'Relay 正在操作电脑';
  }
}

function integer(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) ? String(value) : '…';
}
