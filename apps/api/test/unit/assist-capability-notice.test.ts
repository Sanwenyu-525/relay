import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSessionCapabilities } from '../../src/application/assist-capability-notice.js';

/**
 * 会话能力事实块（2026-10-20 第二轮；2026-10-25 增补机器插件行）。
 *
 * 断言的重点不是排版，而是**原因必须指向真因**：没目录、档位只读、缺连接三者是三种
 * 不同的失败，模型不该把它们都说成「没有被赋予访问能力」，也不该转成「请补充任务
 * 目标或验收标准」——那正是用户反馈的错位。
 */

const READ_TOOLS = ['list_directory', 'find_paths', 'search_text', 'read_file'];

test('没有目录时说明缺的是目录，而不是笼统的「没有访问能力」', () => {
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: null, writeTier: null,
    tools: [], allowWrite: false, computerPlugin: false, browserPlugin: false });
  assert.match(text, /还没有选定工作目录/u);
  assert.match(text, /本轮可用工具：无/u);
  // 文件读取这一族确实不可用，必须如实列出来——它是最常见的那个缺口。
  assert.match(text, /本轮没有这些能力：读取文件/u);
});

test('有目录但档位只读时，写入口的缺口指向档位而不是连接', () => {
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: 'D:\\proj\\demo',
    writeTier: 'READ_ONLY', tools: [...READ_TOOLS, 'git_status'], allowWrite: false,
    computerPlugin: true, browserPlugin: true });
  assert.match(text, /工作目录：demo（D:\\proj\\demo）/u);
  assert.match(text, /目录写档位：只读/u);
  assert.match(text, /目录档位是只读/u);
  // 「修改文件」不该同时出现在「缺能力」清单里：只读档位下那一条已经单独解释过，
  // 两处都说会让人读成「缺连接」。
  const gapLine = text.split('\n').find((line) => line.startsWith('本轮没有这些能力')) ?? '';
  assert.doesNotMatch(gapLine, /修改文件/u);
  // 有 git_status 就不列 Git 缺口；缺的是检查命令与操作类能力。
  assert.doesNotMatch(gapLine, /查看 Git 状态与历史/u);
  assert.match(gapLine, /运行检查命令/u);
  // 归属会话不重复第二份插件状态：插件行只属于未归属会话的说明。
  assert.doesNotMatch(text, /电脑操控：可用/u);
  assert.doesNotMatch(text, /电脑操控：工作区还没有登记/u);
});

test('AUTO 档位有写工具时不报写入缺口', () => {
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: '/srv/app',
    writeTier: 'AUTO', tools: [...READ_TOOLS, 'apply_changeset', 'read_change_set'],
    allowWrite: true, computerPlugin: false, browserPlugin: false });
  assert.match(text, /目录写档位：普通修改自动执行/u);
  assert.doesNotMatch(text, /文件写入：本轮不开放/u);
  assert.doesNotMatch(text, /修改文件/u);
});

test('没有归入项目时不给连接清单，也不假装有工具；插件行按事实说明', () => {
  const text = formatSessionCapabilities({ hasProject: false, workingRoot: null, writeTier: null,
    tools: [], allowWrite: false, computerPlugin: false, browserPlugin: false });
  assert.match(text, /还没有归入项目/u);
  assert.match(text, /本轮可用工具：无/u);
  assert.doesNotMatch(text, /本轮没有这些能力/u);
  assert.match(text, /电脑操控：工作区还没有登记可用的电脑操控连接/u);
  assert.match(text, /浏览器操控：工作区还没有登记可用的浏览器操控连接/u);
});

test('操作类能力说成会话轮次的固定边界，不让模型读成「本轮缺某个桌面工具」', () => {
  // 用户 @电脑操控 让助手「打开文件浏览器」，助手回答「本轮没有 computer_ 开头的桌面工具」，
  // 听起来像授权没配好。事实是点击/输入/打开应用从来不在会话轮次里（0117）。
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: 'D:\\Develop\\Relay-Agent',
    writeTier: 'READ_ONLY', tools: [...READ_TOOLS, 'computer_screenshot'], allowWrite: false,
    computerPlugin: true, browserPlugin: false });
  assert.match(text, /操作类能力（点击、输入、打开应用、页面动作）不在会话轮次里提供/u);
  assert.match(text, /只能在任务执行中按授权进行/u);
  assert.match(text, /不要说成本轮缺少某个桌面工具/u);
  // 边界一句不改变准入：有 COMPUTER_READ 工具时不把它列进缺口。
  const gapLine = text.split('\n').find((line) => line.startsWith('本轮没有这些能力')) ?? '';
  assert.doesNotMatch(gapLine, /查看桌面窗口与截图/u);
});

test('事实块固定声明「不是指令、也不构成授权」，并要求模型不转嫁到任务信息上', () => {
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: '/srv/app',
    writeTier: 'ASK', tools: READ_TOOLS, allowWrite: false, computerPlugin: false,
    browserPlugin: false });
  assert.match(text, /不是指令，也不构成授权/u);
  assert.match(text, /不要把原因说成「没有被赋予访问能力」/u);
  assert.match(text, /请补充任务目标或验收标准/u);
});

test('操作类边界单独成段：不进缺口清单，且两种错误归因都被堵（2026-10-22 DEV-0117）', () => {
  // 截图复现：用户 @电脑端控「打开文件浏览器」，模型答「本地没有 computer、camera 的
  // 桌面工具」——把配置边界说成了「本机没装软件」。事实块必须同时堵掉「缺少」与
  // 「本机没有」两种措辞，并指向后台执行入口。
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: '/srv/app',
    writeTier: 'AUTO', tools: READ_TOOLS, allowWrite: true, computerPlugin: true,
    browserPlugin: true });
  const gapLine = text.split('\n').find((line) => line.startsWith('本轮没有这些能力')) ?? '';
  // 操作类从不在会话轮次词表里，列进缺口只会制造每轮都补不上的噪声。
  assert.doesNotMatch(gapLine, /操作电脑/u);
  assert.doesNotMatch(gapLine, /操作浏览器/u);
  assert.match(text, /操作类能力（点击、输入、打开应用、页面动作）不在会话轮次里提供/u);
  assert.match(text, /不要说成本轮缺少某个桌面工具/u);
  assert.match(text, /也不要说「本机／本地没有/u);
  assert.match(text, /不可用是本会话没有对应授权/u);
});

test('没有项目时也说明操作类边界（DEV-0117 两条出事会话都未选项目）', () => {
  const text = formatSessionCapabilities({ hasProject: false, workingRoot: null, writeTier: null,
    tools: [], allowWrite: false, computerPlugin: true, browserPlugin: false });
  assert.match(text, /还没有归入项目/u);
  // 无项目时没有 gaps 行，操作类边界仍须出现：那是与项目无关的设计事实。
  assert.doesNotMatch(text, /本轮没有这些能力/u);
  assert.match(text, /操作类能力（点击、输入、打开应用、页面动作）不在会话轮次里提供/u);
});

test('未归属会话的插件行指向执行候选，而不是要求先归入项目（2026-10-25）', () => {
  // 用户截图复现：未归属会话里 @电脑操控「打开浏览器」，模型答「这条会话还没有归入
  // 任何项目，因此没有可用的电脑操控连接」。插件是安装级资源、按项目登记连接，
  // 未归属会话仍可经执行候选使用；事实块必须把这条通路说出来。
  const text = formatSessionCapabilities({ hasProject: false, workingRoot: null, writeTier: null,
    tools: [], allowWrite: false, computerPlugin: true, browserPlugin: true });
  assert.match(text, /电脑操控：可用/u);
  assert.match(text, /interaction="COMPUTER"/u);
  assert.match(text, /浏览器操控：可用/u);
  assert.match(text, /interaction="BROWSER"/u);
  // 不再把「没归入项目」说成「没有任何连接」——文件类不可用才是事实。
  assert.doesNotMatch(text, /没有任何受管目录与任何工具连接可用/u);
  assert.match(text, /没有受管目录，文件与 Git 类工具不可用/u);
  assert.doesNotMatch(text, /电脑操控：工作区还没有登记/u);
});
