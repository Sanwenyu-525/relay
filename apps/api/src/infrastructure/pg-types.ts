import { types } from 'pg';

/**
 * bigint（INT8）在应用层用 bigint 无损承载；公开 JSON 由调用方转成十进制字符串。
 *
 * pg 默认把 INT8 解析为 string。设置成 BigInt 后，revision/epoch/acceptance_revision 不会先经过
 * number（> 2^53 会静默丢精度）。这是进程级设置，导入本模块即生效。
 */
types.setTypeParser(types.builtins.INT8, (value: string): bigint => BigInt(value));