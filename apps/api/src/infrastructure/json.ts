/**
 * jsonb 列与命令摘要使用的 JSON 值类型。
 * 公开 JSON 中的 bigint（revision/epoch/acceptance_revision）必须是十进制字符串，不能是有损 number。
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}