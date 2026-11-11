/**
 * 服务端识别的内置插件 mention（2026-11-01 COMPUTER-PLUGIN-E2E）。
 *
 * 输入器里的 `@电脑操控` 此前只是展示层芯片，服务端只看到一段普通文本。模型因此可以把
 * 一条明确的电脑操作请求读成普通讨论，或在正文里写「执行请求已交给后台」却什么都没发生。
 *
 * 这里只做**识别**，不产生授权，也不新建执行路径：识别结果作为一条服务端事实拼进本轮
 * system，让模型知道「用户这次明确选了哪个插件」；真正的候选校验、连接准入、Runtime 与
 * 审批仍走 `conversation-execution` / Gateway 原有入口。
 *
 * 标签集合必须与工作台 `apps/workbench/src/lib/pluginMentions.ts` 的展示集合保持一致：
 * 两处是同一份用户可见标签。工作台负责画芯片，这里负责让服务端读懂同一个标签。
 */

export type KnownPluginKey = 'computer' | 'browser' | 'github';

export const KNOWN_PLUGIN_MENTIONS: readonly {
  readonly key: KnownPluginKey;
  readonly label: string;
}[] = [
  { key: 'computer', label: '电脑操控' },
  { key: 'browser', label: '浏览器操控' },
  { key: 'github', label: 'GitHub' },
];

export interface KnownPluginMention {
  readonly key: KnownPluginKey;
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

const MENTION_PATTERN = /@(电脑操控|浏览器操控|GitHub)/gu;
/** 单词/路径字符：出现它们说明 `@` 或标签是更长 token 的一部分。不含 `@` 本身。 */
const TOKEN_CHAR = /[A-Za-z0-9_./\\-]/u;
const CJK_CHAR = /[\u4e00-\u9fff]/u;

export function findKnownPluginMentions(text: string): readonly KnownPluginMention[] {
  const matches: KnownPluginMention[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const label = match[1] as string;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = start === 0 ? '' : text[start - 1]!;
    const after = end >= text.length ? '' : text[end]!;
    const followsPrevious = matches.length > 0 && matches[matches.length - 1]!.end === start;
    if (!followsPrevious && before !== '' && TOKEN_CHAR.test(before)) continue;
    if (after !== '' && (TOKEN_CHAR.test(after) || CJK_CHAR.test(after))) continue;
    const entry = KNOWN_PLUGIN_MENTIONS.find((item) => item.label === label);
    if (entry !== undefined) matches.push({ ...entry, start, end });
  }
  return matches;
}

/**
 * 这条消息看起来是在**询问能力/可行性**，而不是下达执行命令。
 *
 * 真实 Provider 会把 `@电脑操控 能不能打开记事本？` 偶尔答成「这是命令式请求」，直接
 * 生成电脑操作候选。标签本身不区分提问与命令，而自动委托一旦发生就会开始在用户桌面
 * 输入。这里提供一个**只用于降级**的保守判定：句尾问号 + 能力/可行性措辞。命中时把
 * 机器候选降为澄清，不登记执行请求、不自动委托；用户回复「现在执行」后再走原链路。
 *
 * 它不会把任何候选升级为 PREPARE，也不绕过确定性校验；误判的代价只是多一次确认。
 */
export function isMachineCapabilityQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!/[？?]$/u.test(trimmed)) return false;
  return /(能不能|能否|可不可以|是否|支持|会不会|怎么|如何|能不能帮)/u.test(trimmed);
}

/**
 * 这条消息是否**明确要求操作电脑或浏览器**（2026-11-10）。
 *
 * 信封修复过去只看「工作区登记了机器插件」，于是插件工作区里的任何纯文本回复
 * （包括「你好」）都会多跑一次整份 system 的修复调用：实测 2026-11-10 一条问候
 * 因此多花 3,708 输入 token 和 6 秒。这个判定只回答「用户这句话是不是在要求动作」，
 * 不产生任何授权，也不改变候选校验——准入仍由原执行链决定。
 *
 * 判定刻意保守，宁可漏掉一次修复也不把普通聊天当命令：
 *   * 显式 `@电脑操控` / `@浏览器操控` 本身就是插件选择；
 *   * 能力询问与讨论措辞（怎么/如何/能不能/原理/介绍…）一律不算；
 *   * 其余要求「动作词 + 桌面/浏览器对象」同时出现，或动作词本身只可能发生在机器上
 *     （截图/点击/拖拽…）。「打开项目」「复制代码」这类文件/文字动作不算。
 */
export function detectMachineActionIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (findKnownPluginMentions(trimmed).some((mention) =>
    mention.key === 'computer' || mention.key === 'browser')) return true;
  if (isMachineCapabilityQuestion(trimmed)) return false;
  if (MACHINE_DISCUSSION_MARKERS.some((marker) => trimmed.includes(marker))) return false;
  if (!MACHINE_ACTION_VERBS.some((verb) => trimmed.includes(verb))) return false;
  return MACHINE_ACTION_OBJECTS.some((object) => trimmed.includes(object)) ||
    MACHINE_ONLY_ACTIONS.some((verb) => trimmed.includes(verb));
}

const MACHINE_DISCUSSION_MARKERS: readonly string[] = ['怎么', '如何', '能不能', '能否',
  '可不可以', '是否', '为什么', '什么是', '介绍', '讲解', '原理', '区别', '科普',
  '会不会', '讨论', '聊聊', '谈谈', '是什么'];

const MACHINE_ACTION_VERBS: readonly string[] = ['打开', '关闭', '关掉', '点击', '单击',
  '双击', '右击', '右键', '输入', '键入', '按下', '按住', '松开', '滚动', '拖拽',
  '拖动', '截图', '截屏', '录屏', '访问', '导航', '下载', '上传', '登录', '填写',
  '勾选', '最小化', '最大化', '启动'];

/** 只可能发生在桌面/浏览器上的动作词：命中即视为机器操作，不再要求对象词。 */
const MACHINE_ONLY_ACTIONS: readonly string[] = ['截图', '截屏', '录屏', '点击', '双击',
  '右击', '右键', '鼠标', '键盘', '滚动', '拖拽', '按住', '松开', '最小化', '最大化'];

const MACHINE_ACTION_OBJECTS: readonly string[] = ['浏览器', '网页', '页面', '网址',
  '链接', '标签页', '桌面', '窗口', '鼠标', '键盘', '应用', '程序', '记事本', '计算器',
  '资源管理器', '文件管理器', '按钮', '输入框', '菜单', '图标', '任务栏', '开始菜单',
  '系统设置', '软件', '播放器'];
