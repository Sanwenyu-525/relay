/**
 * Computer 执行路由（V2 Phase 2）。
 *
 * 工具不自己决定调用哪个 Windows API：所有 Computer 动作先经这里判定
 * 「目标是什么 → 有没有可用的后台路径 → 是否需要独立工作区 → 是否必须接管用户桌面」，
 * 再由 Gateway 按其结论决定审批形态，由适配器按结论执行。
 *
 * 三条不可让步的规则（V2 §四/§24/§37）：
 *   1. **后台优先**：Browser/CDP → UI Automation → 独立工作区 → 用户桌面。
 *   2. **后台不可用绝不静默降级**：没有可用后台路径时，返回要求用户授权的明确结论
 *      （或直接拒绝），不把 SendInput 当作兜底。
 *   3. **前台是最后手段且必须显式授权**：`foreground` 只在调用方声明已获授权时执行。
 *
 * 本模块是**纯决策**：不调用运行时、不读写数据库、不抛异常（不可执行也是一种结论）。
 */

import {
  isForegroundInputAction,
  type ComputerEnvironment,
  type ComputerExecutionMode,
  type CoordinateSpace,
} from './protocol.js';

/** 动作 → 运行时方法的能力分类（与词表 capability 同源，V2 再按「是否需要桌面输入」细分）。 */
export interface RouterPlanInput {
  readonly actionType: string;
  /** 运行时探测结果；缺失表示尚未探测（按最保守的假设处理）。 */
  readonly environment: ComputerEnvironment | null;
  /**
   * 调用方是否已获得执行用户桌面输入的显式授权。
   *
   * 只由 Gateway 决定：prepare 阶段为 false（此时正在决定是否需要审批），
   * dispatch 阶段为 true（单动作 Review 已批准，或本次任务范围授权覆盖）。
   * **模型参数永远不能影响这个值。**
   */
  readonly foregroundAuthorized: boolean;
  /** 目标声明（V2 §12/§20）；缺省按用户桌面理解，但这会在结论里如实写出。 */
  readonly captureTarget?: string | undefined;
  readonly coordinateSpace?: CoordinateSpace | undefined;
}

export interface RouterPlan {
  readonly mode: ComputerExecutionMode;
  readonly provider: 'runtime_user_desktop' | 'runtime_window' | 'ui_automation'
    | 'browser_cdp' | 'agent_session';
  readonly coordinateSpace: CoordinateSpace;
  /** 需要用户确认（前台接管）时为 true；上游据此给出「接管电脑」提示。 */
  readonly requiresUserAuthorization: boolean;
  /** 不可执行时的类型化原因；给出后可执行字段无意义。 */
  readonly refusal?: {
    readonly code: string;
    readonly message: string;
    readonly requiresUserAction: boolean;
  } | undefined;
  /** 人类可读的决策说明，进入审批文案与工具结果，便于用户理解「为什么需要接管」。 */
  readonly explanation: string;
}

/** 后台路径的当前可用性（读自运行时探测；缺探测时一律视为不可用）。 */
function backgroundAvailability(environment: ComputerEnvironment | null): {
  readonly browserCdp: boolean;
  readonly uiAutomation: boolean;
} {
  const background = environment?.mode_availability?.background;
  return {
    browserCdp: background?.browser_cdp === 'available',
    uiAutomation: background?.ui_automation === 'available',
  };
}

function isolatedAvailability(environment: ComputerEnvironment | null): boolean {
  return environment?.mode_availability?.isolated?.status === 'available';
}

/**
 * 只读动作（截图 / 窗口枚举）的路由。
 *
 * 只读也分目标：Agent 工作区优先（不打扰用户），用户桌面需要显式声明。
 * 当前没有独立工作区，因此 `agent_session` 目标会明确拒绝而不是退回桌面截图。
 */
function planReadOnly(input: RouterPlanInput): RouterPlan {
  const target = input.captureTarget ?? 'user_desktop';
  if (target === 'agent_session') {
    if (!isolatedAvailability(input.environment)) {
      return {
        mode: 'isolated', provider: 'agent_session', coordinateSpace: 'agent_session',
        requiresUserAuthorization: false, explanation: '目标是 Agent 独立工作区',
        refusal: {
          code: 'ISOLATED_SESSION_UNAVAILABLE',
          message: '当前没有可用的独立工作区（Windows 子会话未建立）；' +
            '不退回截取用户桌面。',
          requiresUserAction: true,
        },
      };
    }
    return {
      mode: 'isolated', provider: 'agent_session', coordinateSpace: 'agent_session',
      requiresUserAuthorization: false, explanation: '在 Agent 独立工作区中读取',
    };
  }
  if (target === 'browser_page') {
    const { browserCdp } = backgroundAvailability(input.environment);
    if (!browserCdp) {
      return {
        mode: 'background', provider: 'browser_cdp', coordinateSpace: 'browser_viewport',
        requiresUserAuthorization: false, explanation: '目标是浏览器页面',
        refusal: {
          code: 'CAPTURE_TARGET_UNAVAILABLE',
          message: '浏览器页面读取需要浏览器适配器（尚未接入）。',
          requiresUserAction: false,
        },
      };
    }
    return {
      mode: 'background', provider: 'browser_cdp', coordinateSpace: 'browser_viewport',
      requiresUserAuthorization: false, explanation: '通过浏览器适配器读取页面',
    };
  }
  if (target === 'window') {
    return {
      mode: 'background', provider: 'runtime_window', coordinateSpace: 'window',
      requiresUserAuthorization: false,
      explanation: '读取指定窗口区域（受管窗口截图，不移动鼠标、不切换前台窗口）',
    };
  }
  return {
    mode: 'background', provider: 'runtime_user_desktop', coordinateSpace: 'user_desktop',
    requiresUserAuthorization: false,
    explanation: '读取用户桌面（只读，不产生输入）',
  };
}

/**
 * 输入动作的路由。
 *
 * 顺序（V2 §24）：Browser/CDP → UI Automation → 独立工作区 → 用户桌面（需授权）。
 * 前三级目前都不可用（无浏览器适配器、UIA provider 未实现、子会话未建立），
 * 因此结论是「需要用户显式授权才能接管桌面」——**这不是失败**，是 V2 的默认行为：
 * 停下来告诉用户需要接管，而不是偷偷抢桌面。
 */
function planInput(input: RouterPlanInput): RouterPlan {
  const { browserCdp, uiAutomation } = backgroundAvailability(input.environment);
  const space = input.coordinateSpace ?? 'user_desktop';
  if (uiAutomation) {
    // Phase 4 落地后走这里：按元素语义操作，不碰鼠标键盘。
    return {
      mode: 'background', provider: 'ui_automation', coordinateSpace: 'window',
      requiresUserAuthorization: false,
      explanation: '通过 Windows UI Automation 在后台操作目标元素',
    };
  }
  if (browserCdp && space === 'browser_viewport') {
    return {
      mode: 'background', provider: 'browser_cdp', coordinateSpace: 'browser_viewport',
      requiresUserAuthorization: false, explanation: '通过浏览器适配器操作页面',
    };
  }
  if (input.foregroundAuthorized) {
    return {
      mode: 'foreground', provider: 'runtime_user_desktop', coordinateSpace: space,
      requiresUserAuthorization: true,
      explanation: '已获授权：在用户当前桌面产生鼠标/键盘输入（接管期间用户无法正常使用电脑）',
    };
  }
  return {
    mode: 'foreground', provider: 'runtime_user_desktop', coordinateSpace: space,
    requiresUserAuthorization: true,
    explanation: '后台路径不可用（无浏览器适配器、UI Automation provider 未实现、' +
      '独立工作区未建立）；这一步需要在你的电脑上产生真实输入，必须先由你确认接管。',
    refusal: {
      code: 'FOREGROUND_REQUIRES_AUTHORIZATION',
      message: '这一步需要接管你的电脑（真实鼠标/键盘输入），需要你显式授权。',
      requiresUserAction: true,
    },
  };
}

/**
 * 一次 Computer 动作的执行计划。
 *
 * `refusal` 存在的含义取决于动作类别：只读/后台动作被拒绝时**不可执行**；
 * 输入动作带 `FOREGROUND_REQUIRES_AUTHORIZATION` 时表示「可执行，但必须先拿到授权」——
 * 上游据此创建审批（Allow once）或把它算进本次任务范围授权，而不是当成错误。
 */
export function planComputerAction(input: RouterPlanInput): RouterPlan {
  return isForegroundInputAction(input.actionType) ? planInput(input) : planReadOnly(input);
}

/** 「先拿到授权」这一类结论：动作本身可执行，缺的是用户确认。 */
export function isAuthorizationPending(plan: RouterPlan): boolean {
  return plan.refusal?.code === 'FOREGROUND_REQUIRES_AUTHORIZATION';
}

/** 真正不可执行的结论（后台路径缺失且无法通过授权解决）。 */
export function isBlocked(plan: RouterPlan): boolean {
  return plan.refusal !== undefined && !isAuthorizationPending(plan);
}
