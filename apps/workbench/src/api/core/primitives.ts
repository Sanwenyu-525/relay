import { RelayContractError } from "./errors";
import type { DecimalRevision } from "../../types";
import type { ExecutorKind } from "../../types";
import type { InteractionMode } from "../../types";
import type { TaskStatus } from "../../types";

export function availability(record: Record<string, unknown>, key: string, name: string): "AVAILABLE" | "UNAVAILABLE" {
  const value = string(record, key, name);
  if (value !== "AVAILABLE" && value !== "UNAVAILABLE") throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  return value;
}

export function directList<T>(value: unknown, name: string, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new RelayContractError(`${name} 响应格式无效。`);
  return value.map(parse);
}

export function stringList(row: Record<string, unknown>, key: string, name: string): readonly string[] {
  return array(row, key, name).map((value) => {
    if (typeof value !== "string") throw new RelayContractError(`${name}.${key} 响应格式无效。`);
    return value;
  });
}

export function object(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RelayContractError(`${name} 响应格式无效。`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function array(record: Record<string, unknown>, key: string, name: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

export function string(record: Record<string, unknown>, key: string, name: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

export function boolean(record: Record<string, unknown>, key: string, name: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  return value;
}

/** 缺键与 null 都当作「未配置」；形状不对则显式失败，不当成空清单蒙混过去。 */
export function nullableStringArray(record: Record<string, unknown>, key: string, name: string): readonly string[] | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  for (const entry of value) {
    if (typeof entry !== "string") throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  }
  return value.length === 0 ? null : (value as readonly string[]);
}

export function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export function nullableString(record: Record<string, unknown>, key: string, name: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

export function decimal(record: Record<string, unknown>, key: string, name: string): DecimalRevision {
  const value = string(record, key, name);
  if (!/^\d+$/u.test(value)) {
    throw new RelayContractError(`${name}.${key} 必须是十进制字符串。`);
  }
  return value;
}

export function integer(record: Record<string, unknown>, key: string, name: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

export function nullableInteger(record: Record<string, unknown>, key: string, name: string): number | null {
  return record[key] === null ? null : integer(record, key, name);
}

/** Provider 可选上报字段：缺失与显式 null 同义，都表示"未上报"而非 0。 */
export function nullableOptionalInteger(record: Record<string, unknown>, key: string, name: string): number | null {
  if (record[key] === undefined || record[key] === null) return null;
  return integer(record, key, name);
}

export function stringArray(record: Record<string, unknown>, key: string, name: string): readonly string[] {
  return array(record, key, name).map((value) => {
    if (typeof value !== "string") {
      throw new RelayContractError(`${name}.${key} 响应格式无效。`);
    }
    return value;
  });
}

export function taskStatus(record: Record<string, unknown>, key: string, name: string): TaskStatus {
  const value = string(record, key, name);
  const values: readonly TaskStatus[] = ["INBOX", "READY", "IN_PROGRESS", "WAITING", "BLOCKED", "DONE", "CANCELLED"];
  if (!values.includes(value as TaskStatus)) {
    throw new RelayContractError(`${name}.${key} 包含未知任务状态。`);
  }
  return value as TaskStatus;
}

export function interactionMode(record: Record<string, unknown>, key: string, name: string): InteractionMode {
  const value = string(record, key, name);
  const values: readonly InteractionMode[] = ["ME", "AI_ASSIST", "DELEGATE_AI"];
  if (!values.includes(value as InteractionMode)) {
    throw new RelayContractError(`${name}.${key} 包含未知执行模式。`);
  }
  return value as InteractionMode;
}

export function executorKind(record: Record<string, unknown>, key: string, name: string): ExecutorKind {
  const value = string(record, key, name);
  if (value !== "HUMAN" && value !== "AI") {
    throw new RelayContractError(`${name}.${key} 包含未知执行者。`);
  }
  return value;
}
