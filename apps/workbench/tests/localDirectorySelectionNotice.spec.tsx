import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import FolderScope from '../src/components/FolderScope';
import { mountReact } from './mountApp';

describe('本地目录读取授权告知', () => {
  it('首次选择前说明默认只读，不再声称选择目录不会开启任何权限', async () => {
    const mounted = await mountReact(createElement(FolderScope, {
      state: { directory: null, recents: [], busy: false },
      onOpen: vi.fn(), onNewConversation: vi.fn(),
    }));
    try {
      await act(async () => {});
      const text = document.querySelector('[data-testid="folder-scope"]')?.textContent ?? '';
      expect(text).toContain('默认只读');
      expect(text).toContain('可读取本目录文件');
      expect(text).toContain('已配置目录恢复原档位');
      expect(text).toContain('不会自动读取整棵树');
      expect(text).toContain('外发内容');
      expect(text).not.toContain('开启任何权限');
    } finally { mounted.unmount(); }
  });
});
