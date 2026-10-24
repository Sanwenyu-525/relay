import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import FolderScope from '../src/components/FolderScope';
import { mountReact } from './mountApp';

describe('本地目录读取授权告知', () => {
  // 2026-10-23 用户截图指令删除底部权限脚注，2026-10-24 再收就绪宣告：
  // 浮层不再常驻任何授权状态预告，未选目录时只如实提供入口（无原生选择器的宿主给手动路径）。
  it('首次选择前不再常驻权限脚注，只提供入口，不预告授权状态', async () => {
    const mounted = await mountReact(createElement(FolderScope, {
      state: { directory: null, recents: [], busy: false },
      onOpen: vi.fn(), onNewConversation: vi.fn(),
    }));
    try {
      await act(async () => {});
      const text = document.querySelector('[data-testid="folder-scope"]')?.textContent ?? '';
      expect(text).not.toContain('默认只读');
      expect(text).not.toContain('可读取本目录文件');
      expect(text).not.toContain('已配置目录恢复原档位');
      expect(text).not.toContain('不会自动读取整棵树');
      // 原始不变量保留：任何一处都不声称「选择目录不会开启任何权限」这类失真承诺。
      expect(text).not.toContain('开启任何权限');
      // 入口仍在：jsdom 无原生选择器，手动绝对路径是这颗禁用键的替代。
      expect(document.querySelector('[data-testid="folder-manual-root"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="folder-open-manual"]')).not.toBeNull();
    } finally { mounted.unmount(); }
  });
});
