import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayApiClient } from "../api/relayClient";

/**
 * 「待你处理」的工作区上下文。
 * 三种工作区的待办来源不同，不能一套内容套所有入口：
 * - PROJECT：项目有目标、有归属本项目的 Review；
 * - FOLDER：普通目录没有项目任务/评审，只剩该目录下未读的讨论；
 * - GLOBAL：全局（无项目、无目录），看全部待判断与未归属任务。
 */
export type PendingContext =
  | { readonly scope: "PROJECT"; readonly projectId: string }
  | { readonly scope: "FOLDER"; readonly resourceId: string }
  | { readonly scope: "GLOBAL" };

export interface PendingWorkItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

export interface PendingWorkState {
  readonly items: readonly PendingWorkItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** 只用到这四个读接口；单独收窄成接口，纯函数可直接单测，不必构造整个 RelayApiClient。 */
export interface PendingWorkClient {
  getProjectGoals(projectId: string): Promise<readonly { readonly title: string }[]>;
  getReviews(): Promise<readonly { readonly status: string; readonly projectId: string | null }[]>;
  getAssistSessions(): Promise<readonly {
    readonly id: string; readonly workingResourceId: string | null; readonly unreadAt: string | null;
  }[]>;
  getInboxTasksPage(): Promise<{ readonly items: readonly unknown[]; readonly nextCursor: string | null }>;
}

/**
 * 「待你处理」的入口清单。只读汇总：只给计数/标题与跳转，不在欢迎页做审批或完成动作。
 * 各工作区取各自的真实来源，空结果返回空数组由组件整条隐藏。
 */
export async function readPendingWork(client: PendingWorkClient, scope: PendingContext["scope"],
  projectId: string | null, resourceId: string | null): Promise<readonly PendingWorkItem[]> {
  if (scope === "PROJECT" && projectId !== null) {
    const [goals, reviews] = await Promise.all([client.getProjectGoals(projectId), client.getReviews()]);
    const collected: PendingWorkItem[] = [];
    if (goals.length > 0) {
      const first = goals[0]!;
      collected.push({
        key: "goal",
        label: goals.length > 1 ? `目标：${first.title} 等 ${goals.length} 个` : `目标：${first.title}`,
        href: `/projects/${encodeURIComponent(projectId)}`
      });
    }
    const open = reviews.filter((review) => review.status === "OPEN" && review.projectId === projectId).length;
    if (open > 0) {
      collected.push({
        key: "reviews",
        label: `${open} 项待判断`,
        href: `/reviews?project_id=${encodeURIComponent(projectId)}`
      });
    }
    return collected;
  }

  if (scope === "FOLDER" && resourceId !== null) {
    const sessions = await client.getAssistSessions();
    const unread = sessions
      .filter((session) => session.workingResourceId === resourceId && session.unreadAt !== null)
      .sort((left, right) => (right.unreadAt ?? "").localeCompare(left.unreadAt ?? ""));
    if (unread.length === 0) return [];
    return [{
      key: "unread",
      label: `${unread.length} 条未读讨论`,
      href: `/agent?session=${encodeURIComponent(unread[0]!.id)}`
    }];
  }

  const [reviews, inbox] = await Promise.all([client.getReviews(), client.getInboxTasksPage()]);
  const collected: PendingWorkItem[] = [];
  const open = reviews.filter((review) => review.status === "OPEN").length;
  if (open > 0) collected.push({ key: "reviews", label: `${open} 项待判断`, href: "/reviews" });
  if (inbox.items.length > 0) {
    collected.push({
      key: "inbox",
      label: `${inbox.items.length}${inbox.nextCursor !== null ? "+" : ""} 个未归属任务`,
      href: "/tasks?inbox=true"
    });
  }
  return collected;
}

/**
 * 按工作区读取「待你处理」的入口。任一来源失败时整条静默（二级信息，不占用欢迎页的错误位）；
 * 空结果由组件整条隐藏。
 */
export function usePendingWork(client: RelayApiClient, context: PendingContext): PendingWorkState {
  const scope = context.scope;
  const projectId = context.scope === "PROJECT" ? context.projectId : null;
  const resourceId = context.scope === "FOLDER" ? context.resourceId : null;
  const [items, setItems] = useState<readonly PendingWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);

  const read = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    try {
      const next = await readPendingWork(client, scope, projectId, resourceId);
      if (current !== version.current) return;
      setItems(next);
      setError(null);
    } catch (caught) {
      if (current !== version.current) return;
      // 二级信息失败不噪音化欢迎页：清空并记下原因，界面整条不出现。
      setItems([]);
      setError(caught instanceof Error ? caught.message : "待你处理读不到。");
    } finally {
      if (current === version.current) setLoading(false);
    }
  }, [client, scope, projectId, resourceId]);

  useEffect(() => {
    void read();
    return () => { version.current++; };
  }, [read]);

  return { items, loading, error, refresh: () => { void read(); } };
}
