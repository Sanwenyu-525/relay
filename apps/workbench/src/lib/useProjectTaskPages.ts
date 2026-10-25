import { useCallback, useEffect, useRef, useState } from "react";
import { RelayApiError, type RelayApiClient } from "../api/relayClient";
import type { RelayTaskSummary } from "../api/dtos/tasks";

export interface ProjectTaskPages {
  readonly items: readonly RelayTaskSummary[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly scopeLost: boolean;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

interface State {
  readonly client: RelayApiClient | null;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly scopeKey: string | number;
  readonly pageSize: number | undefined;
  readonly items: readonly RelayTaskSummary[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly scopeLost: boolean;
}

const EMPTY: State = { client: null, projectId: "", enabled: false, scopeKey: "", pageSize: undefined,
  items: [], nextCursor: null, loading: false, loadingMore: false, error: null,
  scopeLost: false };

function scopeLost(error: unknown): error is RelayApiError {
  return error instanceof RelayApiError && [401, 403, 404].includes(error.problem.status);
}

function describe(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message : "读取项目任务失败。";
}

/** 按用户请求逐页读取项目任务；权限失效时清空事实，暂态失败保留原页与游标。 */
export function useProjectTaskPages(client: RelayApiClient | null, projectId: string,
  enabled = true, scopeKey: string | number = "", pageSize?: number): ProjectTaskPages {
  const [state, setState] = useState<State>(EMPTY);
  const stateRef = useRef(state);
  const generation = useRef(0);
  const activeRequest = useRef<number | null>(null);
  const retryCursor = useRef<string | null>(null);
  stateRef.current = state;

  const readPage = useCallback(async (cursor: string | null, requestGeneration: number) => {
    if (client === null || projectId === "" || activeRequest.current === requestGeneration) return;
    activeRequest.current = requestGeneration;
    retryCursor.current = cursor;
    setState((current) => ({ ...current, loading: cursor === null,
      loadingMore: cursor !== null, error: null, scopeLost: false }));
    try {
      const page = await client.getProjectTasksPage(projectId, cursor, pageSize);
      if (generation.current !== requestGeneration) return;
      setState((current) => {
        const byId = new Map((cursor === null ? [] : current.items).map((item) => [item.id, item]));
        for (const item of page.items) byId.set(item.id, item);
        return { ...current, items: [...byId.values()], nextCursor: page.nextCursor,
          loading: false, loadingMore: false, error: null, scopeLost: false };
      });
      retryCursor.current = page.nextCursor;
    } catch (caught) {
      if (generation.current !== requestGeneration) return;
      if (scopeLost(caught)) {
        retryCursor.current = null;
        setState({ ...EMPTY, client, projectId, enabled: true, scopeKey, pageSize,
          error: describe(caught), scopeLost: true });
      } else {
        setState((current) => ({ ...current, loading: false, loadingMore: false,
          error: describe(caught), scopeLost: false }));
      }
    } finally {
      if (activeRequest.current === requestGeneration) activeRequest.current = null;
    }
  }, [client, projectId, pageSize]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    retryCursor.current = null;
    if (!enabled || client === null || projectId === "") {
      setState({ ...EMPTY, client, projectId, enabled, scopeKey, pageSize });
    } else {
      setState({ ...EMPTY, client, projectId, enabled, scopeKey, pageSize, loading: true });
      void readPage(null, requestGeneration);
    }
    return () => {
      if (generation.current === requestGeneration) generation.current++;
    };
  }, [client, projectId, enabled, scopeKey, pageSize, readPage]);

  const loadMore = useCallback(() => {
    const cursor = stateRef.current.nextCursor;
    if (stateRef.current.client !== client || stateRef.current.projectId !== projectId ||
      stateRef.current.enabled !== enabled || !Object.is(stateRef.current.scopeKey, scopeKey) ||
      stateRef.current.pageSize !== pageSize ||
      !enabled || cursor === null || stateRef.current.loading || stateRef.current.loadingMore) return;
    void readPage(cursor, generation.current);
  }, [client, projectId, enabled, scopeKey, pageSize, readPage]);

  const retry = useCallback(() => {
    if (stateRef.current.client !== client || stateRef.current.projectId !== projectId ||
      stateRef.current.enabled !== enabled || !Object.is(stateRef.current.scopeKey, scopeKey) ||
      stateRef.current.pageSize !== pageSize ||
      !enabled || stateRef.current.error === null || stateRef.current.loading || stateRef.current.loadingMore) return;
    void readPage(retryCursor.current, generation.current);
  }, [client, projectId, enabled, scopeKey, pageSize, readPage]);

  const sameScope = state.client === client && state.projectId === projectId &&
    state.enabled === enabled && Object.is(state.scopeKey, scopeKey) && state.pageSize === pageSize;
  const visible = sameScope ? state : { ...EMPTY,
    loading: enabled && client !== null && projectId !== "" };
  return { ...visible, loadMore, retry };
}
