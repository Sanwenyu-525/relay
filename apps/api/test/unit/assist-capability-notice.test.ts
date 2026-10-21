import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSessionCapabilities } from '../../src/application/assist-capability-notice.js';

/**
 * 会话能力事实块（2026-10-20 第二轮）。
 *
 * 断言的重点不是排版，而是**原因必须指向真因**：没目录、档位只读、缺连接三者是三种
 * 不同的失败，模型不该把它们都说成「没有被赋予访问能力」，也不该转成「请补充任务
 * 目标或验收标准」——那正是用户反馈的错位。
 */

const READ_TOOLS = ['list_directory', 'find_paths', 'search_text', 'read_file'];

test('没有目录时说明缺的是目录，而不是笼统的「没有访问能力」', () => {
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: null, writeTier: null,
    tools: [], allowWrite: false });
  assert.match(text, /还没有选定工作目录/u);
  assert.match(text, /本轮可用工具：无/u);
  // 文件读取这一族确实不可用，必须如实列出来——它是最常见的那个缺口。
  assert.match(text, /本轮没有这些能力：读取文件/u);
});

test('有目录但档位只读时，写入口的缺口指向档位而不是连接', () => {
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: 'D:\\proj\\demo',
    writeTier: 'READ_ONLY', tools: [...READ_TOOLS, 'git_status'], allowWrite: false });
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
});

test('AUTO 档位有写工具时不报写入缺口', () => {
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: '/srv/app',
    writeTier: 'AUTO', tools: [...READ_TOOLS, 'apply_changeset', 'read_change_set'], allowWrite: true });
  assert.match(text, /目录写档位：普通修改自动执行/u);
  assert.doesNotMatch(text, /文件写入：本轮不开放/u);
  assert.doesNotMatch(text, /修改文件/u);
});

test('没有归入项目时不给任何连接清单，也不假装有工具', () => {
  const text = formatSessionCapabilities({ hasProject: false, workingRoot: null, writeTier: null,
    tools: [], allowWrite: false });
  assert.match(text, /还没有归入项目/u);
  assert.match(text, /本轮可用工具：无/u);
  assert.doesNotMatch(text, /本轮没有这些能力/u);
});

test('事实块固定声明「不是指令、也不构成授权」，并要求模型不转嫁到任务信息上', () => {
  const text = formatSessionCapabilities({ hasProject: true, workingRoot: '/srv/app',
    writeTier: 'ASK', tools: READ_TOOLS, allowWrite: false });
  assert.match(text, /不是指令，也不构成授权/u);
  assert.match(text, /不要把原因说成「没有被赋予访问能力」/u);
  assert.match(text, /请补充任务目标或验收标准/u);
});
