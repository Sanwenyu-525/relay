import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { canonicalizeJson } from '../receipt/payload-hash.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalResourceIdentity } from './gateway-configuration.js';

/**
 * 检查入口信任摘要（Stage A）。
 *
 * 只回答一个问题：**这次检查实际要跑的材料，此刻在磁盘上是什么**。
 *
 * 它刻意只覆盖一个**有限、明确、可枚举**的集合：
 *   - 入口可执行程序（冻结清单里的 executable，根内或根外都算）；
 *   - 非 `--test` 形态下，第一个路径参数（`node <script>` / `python <script>`
 *     形态里真正被执行的脚本，**包括选项结束标记 `--` 之后那个**）；
 *   - `node --test` 形态下（`--test` 出现在第一个位置参数之前），全部路径脚本参数
 *    （测试运行器会逐个执行每一个显式入口，漏算任何一个都会让旧摘要沿用新代码）；
 *   - **等号开关值引用的文件**（`--env-file=.env`，以及 `--env-file=--` 这种值为 `--`
 *     的形态——它是一个确定的文件名，见下），它们是这次检查真实读取的材料；
 *   - 受管根**顶层**直接决定检查行为的构建/测试配置（package.json / tsconfig / vitest / jest 等）。
 *
 * 它不做的事，和它做的事同样重要：
 *   - 不放宽连接允许的可执行入口清单，也不放宽用户授予的动作权限（那是
 *     `evaluateExecutableAdmission` 与 `evaluateScopeGrant` 的职责）；
 *   - 不遍历整个仓库、node_modules 或动态依赖；
 *   - 不把**被检查的源文件**当材料。工作集本来就是要被读取、修改、再检查的对象，
 *     把它算进材料会让「检查失败 → 修正 → 再跑同一检查」这条主链直接不可用。
 *
 * 因此非 `--test` 形态下第二个及之后的位置参数（`node check.mjs src/feature.mjs` 里的
 * `src/feature.mjs`）是这次检查的**输入**而不是程序，不进材料。检查程序自己 import
 * 的兄弟模块同理不进材料；这一范围限制已在架构文档中写明，不用「静默少算材料」去维持 AUTO。
 *
 * 参数身份分五类，判定只按**位置**与**形状**，不看文件名偏好：
 *   1. **执行器选项**：横线开头的选项名（`--test` / `--env-file`），本身不携带执行内容；
 *   2. **选项的值**：等号右侧的字面量，或分离形态下跟在取值型开关之后的那个参数；
 *      身份由 `classifyOptionValue` 单独判定，**绝不**再递归回选项解析；
 *   3. **选项终止符**：顶层参数序列、入口之前的 `--`（由 `classifyArgs` 判定）；
 *   4. **执行入口**：非 `--test` 形态第一个路径参数（含终止符之后的第一个）；
 *   5. **脚本 argv**：入口之后的全部参数，包括入口之后再次出现的 `--`。注意实测有一处
 *      例外（入口之后、带等号的取值型开关 Node 仍会校验其值存在，见下文值位置一节），
 *      所以这里对它们仍按「被校验的文件」处理，不当成完全没有影响。
 * 同一个字面量在不同位置身份不同，互不套用。
 *
 * `--`（选项结束标记）的语义按真实 CLI 行为推理，Node 24.21.0 实测为准：
 *   - 标记本身不携带执行内容，不进材料。它只是「后面不再是开关」的分界。
 *   - 标记**之后**的参数一律不再套用开关分类：以横线开头的参数是文件名而不是开关
 *     （`node -- --entry.mjs src/value.txt` 实际执行 `--entry.mjs`；去掉终止符时同一参数
 *     是 bad option）。按开关跳过它就等于漏算真正被执行的入口——冻结之后换入口仍会 AUTO。
 *   - 标记之后**第一个**路径参数是非 `--test` 形态下的执行入口，必须进材料；再往后的
 *     路径参数是这次检查的输入（`node -- check.mjs --flag` 的入口仍是 check.mjs）。
 *   - `--test` 形态下（`--test` 在终止符之前）标记之后的路径参数仍全是测试入口：
 *     `node --test -- a.test.mjs b.test.mjs` 会逐个执行，漏算任何一个都会沿用旧代码。
 *   - 标记之后无法证明是单一文件引用的值（裸词、通配符、shell 元字符、stdin `-`、
 *     空参数，以及 `--` 自身再次出现）一律明确判为不支持，不猜。`node -- --test a.mjs`
 *     实测是把 `--test` 当模块名去找，所以不能因为它长得像开关就放行。同理
 *     `node -- -- check.mjs` 实测报 `Cannot find module '--'`：终止符之后的 `--` 走的是
 *     **模块解析**而不是相对路径打开，因此那里仍按裸词拒绝，不按「确定的文件名」放行。
 *   - 标记顺带解决「分离式开关值与主脚本无法区分」的歧义：终止符之后的第一个路径参数
 *     身份明确，所以开关的候选只算终止符**之前**的文件参数；两侧各有一个候选入口
 *     （`node --env-file .env -- check.mjs` 实测执行 check.mjs）仍无法证明，一律拒绝。
 *   - 标记之后一个路径参数都没有（`node --`）时没有任何可枚举的入口，明确拒绝。
 *   - 标记**不能**出现在一个取值型开关后面。固定 Node 24.21.0 实测
 *     `node --env-file -- check.mjs` 直接报 `--env-file requires an argument`（exit 9），
 *     一个脚本都不执行。也就是说分离形态下 `--` **不是**该选项的值；这种参数序列的实际
 *     执行范围无法证明，必须明确拒绝，不能把 `--` 当终止符放行出一份没有依据的授权。
 *
 * 值位置的 `--` 则是**确定的文件名**，必须进材料。实测依据（固定 Node 24.21.0，受管根里
 * 放一个名为 `--` 的文件）：`node --env-file=-- check.mjs` 真实打开那个文件并把内容注入
 * 进程环境（把文件内容从 A 改成 B，脚本读到的环境变量随之变化，exit 0）。同一形态下
 * 根内没有该文件时报 `--: not found`、它是目录时报 `--: invalid format`，两种情况
 * 都不执行任何脚本——所以读不到时必须按材料读不到拒绝，不能静默算出一份漏算材料的摘要。
 *
 * 值位置的前后位置语义并不完全一样，这里按实测记住，不假定相同：
 *   - 入口**之前**（`node --env-file=-- check.mjs`）：文件被读取**并注入**环境，材料必需；
 *   - 入口**之后**（`node check.mjs --env-file=--`）：Node 仍会校验该文件存在（缺文件报
 *     `--: not found`，exit 9），但**不再把内容注入**环境（实测 `process.env` 未变，参数原样
 *     进 argv）。所以这里按「被校验的文件」处理：读不到就拒绝，与既有的
 *     `--env-file=.env` 入口之后形态同一约定；把内容也算进摘要是偏保守方向，不构成缺口。
 *   - 入口之后**再跟一个显式 `--`**（`node check.mjs -- --env-file=--`）：完全是 argv，
 *     exit 0，连存在性都不校验。
 *
 * 有限支持说明（未知形态不默认安全，一律明确拒绝 AUTO）：
 *   - 先识别开关名再处理值，等号（`--import=./x`）与分离（`--import ./x`）同一规则；
 *     动态开关的值不占主脚本位置，而是直接判为不支持（见下）。
 *   - 等号开关值确定属于开关（BE-02 一般形态）：`node --env-file=.env check.mjs` 里
 *     `.env` 是开关引用的材料，不占主脚本位置，`check.mjs` 仍是第一个位置脚本；
 *     否则主脚本会被挤成第二个位置参数而漏算，改了被执行脚本摘要却不变。
 *   - 等号右侧是**值**，不再当选项解析。把它递归回选项解析（上一版就是这么写的）会让
 *     `--env-file=--` 的值 `--` 走「横线开头且无等号」的分支变成 FLAG，而 FLAG 不进材料：
 *     环境文件内容变化 → 真实 Node 输出变化 → 摘要不变 → 旧授权继续自动放行。
 *     动态预加载开关（`--import` / `--require` / `--loader`）在值分类**之前**按开关身份
 *     拒绝，所以 `--import=--`、`--require=--` 这类「值为 `--`」的形态仍然明确不支持
 *     （实测它们按**包名/模块名**解析 `--`，报 `MODULE_NOT_FOUND`），不会被新规则放行。
 *   - 分离式开关的值与主脚本无法区分（`node --env-file .env check.mjs` 实测执行
 *     `check.mjs`）：同一开关之后还有两个以上文件参数时无法证明哪一个是被执行脚本，
 *     一律明确判为不支持（进入 ASK/DENY），不猜；`--test`（不取值）与 `--` 之后的
 *     文件参数身份明确，不受此限。
 *   - 解释器内联求值 / 动态加载（`-e` / `-c` / `--eval`、`--import` / `--require` /
 *     `--loader` / `--experimental-loader`、`-r` / `-m` 等现有集合，含等号、分离、
 *     短参数紧凑写法 `-r./x`）无法在有限模型内证明范围，一律明确判为不支持自动信任
 *    （进入 ASK/DENY），而不是当成「没有额外材料」放行；终止符之后不再套用这套开关
 *     语义，这些写法在终止符之后只是字面文件名（读不到即拒绝）。
 *   - `node --test` 无显式入口（默认发现）、目录展开、通配符、无扩展名裸词、空参数、
 *     stdin（`-`）等无法枚举确切文件集合的形态，一律明确拒绝，不静默放行。
 *   - 不凭扩展名猜输入：路径参数是否进材料只看位置与形态，不看扩展名；读不到
 *     （不存在、是目录、不可读）返回类型化原因，不落无依据授权。
 *
 * 已知范围限制（本版不扩大，扩大会变成推测性框架）：取值型开关只有本模块**建模为开关
 * 引用材料**的那一个有限名单（见 VALUE_OPTION_FLAGS）。名字不在名单里的未知开关若在
 * 分离形态下取值并紧跟 `--`，仍可能被当成终止符；Node 的完整选项表不在本模块职责内，
 * 未建模的选项由上面的「两个以上文件参数即歧义」与「终止符之后无入口即拒绝」兜住。
 *
 * 解释器内联求值（`-e` / `-c` / `--eval`）、shell 组合（`&&`、`|`、`;`、反引号、`$()`）与
 * 通配符无法在有限模型内证明范围，一律明确判为不支持自动信任（进入 ASK/DENY），
 * 而不是当成「没有额外材料」放行。
 */

export const CHECK_TRUST_REASON = {
  /** 材料在磁盘上不存在、不是普通文件或读不出来。 */
  MATERIAL_UNREADABLE: 'CHECK_TRUST_MATERIAL_UNREADABLE',
  /** 参数含解释器内联求值、shell 组合或通配符，无法证明执行范围。 */
  DYNAMIC_EXECUTION_UNSUPPORTED: 'CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED',
} as const;

export interface CheckTrustMaterial {
  /** 规范绝对路径（Windows 下小写、反斜杠），与 `canonicalResourceIdentity` 同口径。 */
  readonly path: string;
  /** 位于受管根内时的根内相对路径；根外材料为 null，不伪造根内身份。 */
  readonly rootRelativePath: string | null;
  readonly sha256: string;
  readonly role: 'EXECUTABLE' | 'REFERENCED_SCRIPT' | 'BUILD_CONFIG';
}

export interface CheckTrustBasis {
  readonly version: 'check-trust-v1';
  readonly materials: readonly CheckTrustMaterial[];
  readonly digest: string;
}

export type ComputeCheckTrustBasisResult =
  | { readonly ok: true; readonly basis: CheckTrustBasis }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

const TRUST_BASIS_VERSION = 'check-trust-v1';

/**
 * 直接决定检查行为的构建/测试配置：只在受管根**顶层**按名单取，不递归、不遍历仓库。
 * 名单之外的文件（源码、夹具、数据）都不是材料。
 */
const TRUST_BUILD_CONFIG_FILES: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.mts',
  'vitest.config.cts',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'jest.config.ts',
  'jest.config.js',
  'jest.config.mjs',
  'jest.config.cjs',
];

/**
 * 解释器内联求值 / 动态加载开关：无法在有限模型内证明范围，明确不支持自动信任。
 * 覆盖 node / python / shell 的常见形态。等号、分离、短参数紧凑写法同一规则，
 * 具体见 classifyArg（先识别开关名再处理值）。
 */
const DYNAMIC_FLAGS = new Set([
  '-c', '-e', '-p', '-i', '-m', '-r',
  '--eval', '--print', '--input-type', '--interactive', '--module', '--require',
  '--import', '--loader', '--experimental-loader',
]);

/** 测试运行器形态：`--test` 出现在第一个位置参数之前时，全部位置脚本都是入口。 */
const TEST_FLAG = '--test';

/**
 * 两字符纯横线字面量。它在不同参数位置上有两种**互不相同**的身份，两条都以固定
 * Node 24.21.0 实测为准，不能互相套用：
 *   - 顶层参数序列、入口之前：选项结束标记（`node -- --entry.mjs src/value.txt`）。
 *   - 等号开关值位置（`node --env-file=-- check.mjs`）：一个确定的文件名。实测 Node 真实
 *     打开受管根里名为 `--` 的文件并把内容注入进程环境，所以它必须进信任材料。
 * 因此「值等于 `--`」不得被提升为终止符，也不得因为看起来像开关而被丢出文件集合。
 */
const DASH_LITERAL = '--';

/**
 * 选项结束标记：本身不携带执行内容，它只是「后面不再是开关」的分界。
 * 它只在顶层参数序列、且入口之前才有这个含义，因此由 classifyArgs 处理，不走 classifyArg。
 */
const OPTION_TERMINATOR = DASH_LITERAL;

/**
 * 取值型开关的有限名单：只有本模块**建模为「开关引用一份材料」**的那些开关才在这里。
 *
 * 用途只有一个：区分「`--` 是终止符」与「`--` 是一个还没给出值的开关的位置」。实测
 * `node --env-file -- check.mjs` 报 `--env-file requires an argument`（exit 9），一个脚本
 * 都不执行，所以紧跟取值型开关的 `--` 无法证明执行范围，必须明确拒绝。
 *
 * 这不是 Node 的完整选项表，也不应该是：未知选项取值时紧跟 `--` 的情形由既有的
 * 「两个以上文件参数即歧义」与「终止符之后无入口即拒绝」兜住，不靠在这里猜选项语义。
 */
const VALUE_OPTION_FLAGS = new Set(['--env-file']);

/** shell 元字符：出现即说明参数不是单一文件引用。 */
const SHELL_METACHARACTERS = /[&|;`$><\n\r]/;
/** 通配符 / 花括号展开：出现即说明参数指向一组未知文件。 */
const GLOB_CHARACTERS = /[*?{}]/;

interface ResolvedMaterial {
  readonly identity: string;
  readonly sha256: string;
}

async function readRegularFile(path: string): Promise<ResolvedMaterial | null> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return null;
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(real);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  let bytes: Buffer;
  try {
    bytes = await readFile(real);
  } catch {
    return null;
  }
  return { identity: canonicalResourceIdentity(real), sha256: sha256(bytes) };
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rootRelative(rootIdentity: string, materialIdentity: string): string | null {
  const part = relative(rootIdentity, materialIdentity);
  if (part === '' || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) return null;
  return part;
}

type ArgClassification =
  | { readonly kind: 'FLAG' }
  | { readonly kind: 'FLAG_VALUE'; readonly value: string }
  | { readonly kind: 'PATH'; readonly value: string }
  | { readonly kind: 'TERMINATOR' }
  | { readonly kind: 'TERMINATED_PATH'; readonly value: string }
  | { readonly kind: 'DYNAMIC'; readonly detail: string };

/**
 * 判定「位置参数 / 终止符之后参数」的形状：能证明是单一文件引用的返回 PATH，
 * 其余一律明确判为不支持。这一层**不认**终止符，也不认纯横线字面量是文件名——
 * 终止符之后的 `--` 走模块解析（实测 `Cannot find module '--'`），必须继续按裸词拒绝。
 * 等号开关值由 `classifyOptionValue` 单独判定，两条规则不共用结论。
 */
function classifyValue(value: string): ArgClassification {
  // 空值无法证明是哪一个文件：独立空参数与 `--flag=` 空值同一规则，一律不支持。
  if (value === '') return { kind: 'DYNAMIC', detail: '空参数无法证明执行范围' };
  if (SHELL_METACHARACTERS.test(value)) {
    return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(value)} 含 shell 元字符` };
  }
  if (GLOB_CHARACTERS.test(value)) {
    return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(value)} 含通配符` };
  }
  // stdin 不是单一文件引用，无法证明范围。
  if (value === '-') return { kind: 'DYNAMIC', detail: '标准输入无法证明执行范围' };
  // 裸词（既不是开关，也不含扩展名或路径分隔符）无法证明是哪一个文件。
  if (!/[.\\/]/.test(value)) {
    return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(value)} 不是单一文件引用` };
  }
  return { kind: 'PATH', value };
}

/**
 * 判定等号开关值的身份（`--env-file=--` 里 `=` 右侧那一段）。
 *
 * 值位置**没有**选项语义，也**没有**终止符语义：它只是某个选项要读的一个字面量。因此
 * 这一层只判「这个字面量能不能证明是一个确定的文件」，判不出就明确拒绝：
 *   - 属于既有的不可证明形状（空、shell 元字符、通配符、stdin、无形状裸词）→ 不支持；
 *   - 纯横线字面量 `--` → 确定的文件名（实测依据见 DASH_LITERAL）。
 *
 * 关键约束：**不递归回 `classifyArg`**。把值再当选项解析一次，会让 `--env-file=--` 的值
 * `--` 命中「横线开头、无等号」的分支变成 FLAG，而 FLAG 不进材料——环境文件内容变了而摘要
 * 不变，旧授权因此继续自动放行。
 *
 * 同一个字面量在**入口位置**语义不同，不共用这条结论：实测 `node -- -- check.mjs` 报
 * `Cannot find module '--'`（走模块解析而不是相对路径打开），所以终止符之后那里仍按
 * `classifyValue` 的裸词规则明确拒绝。
 */
function classifyOptionValue(value: string): ArgClassification {
  if (value === DASH_LITERAL) return { kind: 'PATH', value };
  return classifyValue(value);
}

/**
 * 分类一个还没遇到终止符的参数。开关、开关值、路径参数与无法证明范围的形态在这里分流；
 * `--` 只在顶层参数序列里有终止符含义，因此由 classifyArgs 处理，不走这里。
 */
function classifyArg(raw: string): ArgClassification {
  if (raw === '') return { kind: 'DYNAMIC', detail: '空参数无法证明执行范围' };
  if (SHELL_METACHARACTERS.test(raw)) {
    return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(raw)} 含 shell 元字符` };
  }
  if (GLOB_CHARACTERS.test(raw)) {
    return { kind: 'DYNAMIC', detail: `参数 ${JSON.stringify(raw)} 含通配符` };
  }
  // stdin 不是单一文件引用，无法证明范围。
  if (raw === '-') return { kind: 'DYNAMIC', detail: '标准输入无法证明执行范围' };
  if (raw.startsWith('-')) {
    // 先识别开关名再处理值：等号与分离形式同一规则，动态开关的值不占主脚本位置。
    const separator = raw.indexOf('=');
    if (separator > 0) {
      const name = raw.slice(0, separator).toLowerCase();
      const value = raw.slice(separator + 1);
      // 动态加载开关在值分类**之前**按开关身份拒绝：无论值是什么形状，`--import=--`
      // 与 `--import=./x` 都无法在有限模型内证明执行范围（实测前者按包名解析报
      // MODULE_NOT_FOUND），必须同一规则明确拒绝，不因「值看起来可读」而放行。
      if (DYNAMIC_FLAGS.has(name)) {
        return { kind: 'DYNAMIC', detail: `开关 ${raw.slice(0, separator)} 属于解释器内联求值或动态加载` };
      }
      // `--test` 不接受值：带值的写法无法证明范围，不默认安全。
      if (name === TEST_FLAG) {
        return { kind: 'DYNAMIC', detail: '开关 --test 不接受值，无法证明执行范围' };
      }
      // 等号值确定属于开关（BE-02 一般形态）：不占主脚本位置，否则
      // `node --env-file=.env check.mjs` 会把主脚本挤到第二个位置参数而漏算。
      // 像文件的等号值作为开关引用的材料参与摘要；非文件值与动态值沿用同一分类。
      const inner = classifyOptionValue(value);
      if (inner.kind === 'PATH') return { kind: 'FLAG_VALUE', value: inner.value };
      if (inner.kind === 'DYNAMIC') return inner;
      // classifyOptionValue 只会返回 PATH 或 DYNAMIC；真走到这里说明出现了没有结论的形状，
      // 明确拒绝而不是当成「这个开关没有引用材料」静默放行。
      return { kind: 'DYNAMIC',
        detail: `开关 ${raw.slice(0, separator)} 的值 ${JSON.stringify(value)} 无法证明是哪一个文件` };
    }
    if (DYNAMIC_FLAGS.has(raw.toLowerCase())) {
      return { kind: 'DYNAMIC', detail: `开关 ${raw} 属于解释器内联求值或动态加载` };
    }
    // 短参数紧凑写法（`-r./preload.mjs`、`-e...`）：第二字符是动态开关即按动态处理，
    // 否则等号形式早已绕过检查（BE-02 同类缺口）。
    if (!raw.startsWith('--') && raw.length > 2 &&
      DYNAMIC_FLAGS.has(raw.slice(0, 2).toLowerCase())) {
      return { kind: 'DYNAMIC', detail: `开关 ${raw.slice(0, 2)} 属于解释器内联求值或动态加载` };
    }
    return { kind: 'FLAG' };
  }
  return classifyValue(raw);
}

/**
 * 逐个分类参数，并把选项结束标记之后的参数与开关分开。
 *
 * `--` 之后的参数**不再套用开关语义**：以横线开头的参数是被执行的入口名而不是开关
 * （Node 24 实测 `node -- --entry.mjs src/value.txt` 执行 `--entry.mjs`，而去掉终止符时
 * 同一参数是 bad option）。终止符本身不携带执行内容，只标记「后面不再是开关」。
 *
 * 终止符只在**入口脚本之前**才有这个含义：解释器的选项解析在第一个位置参数处就停止，
 * 入口之后的参数全部是传给脚本的 argv，`--` 本身只是其中一个普通参数。Node 24 实测
 * `node check.mjs -- --verbose` 正常执行 check.mjs，并把 `["--","--verbose"]` 原样传下去。
 * 因此入口之后的 `--` 按普通开关参数处理，不切换后续参数的解释方式——否则会把一份
 * 完全可证明的检查命令判成「无法证明执行范围」，平白退回人工确认。
 *
 * 终止符之后仍然要求是能证明的单一文件引用：裸词、通配符、shell 元字符、stdin、
 * 空参数都判为不支持；终止符**之前**再次出现 `--`（`node -- -- check.mjs`）同样无法
 * 证明——实测 Node 报 `Cannot find module '--'`，走的是模块解析而不是相对路径打开，
 * 所以按 classifyValue 的裸词规则拒绝，不猜它只是被透传给脚本。
 *
 * 紧跟取值型开关的 `--` 不是终止符：实测 `node --env-file -- check.mjs` 报
 * `--env-file requires an argument`（exit 9），一个脚本都不执行，实际执行范围无法证明。
 * 这种形态明确拒绝，不把 `--` 当终止符放行出一份没有依据的授权。
 */
function classifyArgs(args: readonly string[]): ArgClassification[] {
  const classified: ArgClassification[] = [];
  let optionsEnded = false;
  let seenPositional = false;
  // 前一个参数若是取值型开关，这里记下它的名字：其后的 `--` 既不是它的值也不是终止符。
  let awaitingValueOf: string | null = null;
  for (const arg of args) {
    // 入口出现之前才认终止符；之后它只是脚本的一个参数（见上）。
    if (!optionsEnded && !seenPositional && arg === OPTION_TERMINATOR) {
      if (awaitingValueOf !== null) {
        classified.push({ kind: 'DYNAMIC', detail:
          `开关 ${awaitingValueOf} 之后出现选项结束标记：实测分离形态下 -- 不是该选项的值，执行范围无法证明` });
        awaitingValueOf = null;
        continue;
      }
      optionsEnded = true;
      classified.push({ kind: 'TERMINATOR' });
      continue;
    }
    if (optionsEnded) {
      const after = classifyValue(arg);
      classified.push(after.kind === 'PATH'
        ? { kind: 'TERMINATED_PATH', value: after.value } : after);
      continue;
    }
    const classifiedArg = classifyArg(arg);
    if (classifiedArg.kind === 'PATH') seenPositional = true;
    // 只有「等号之外的取值型开关」还在等它的值；等号值已经带在同一个参数里。
    awaitingValueOf = classifiedArg.kind === 'FLAG' &&
      VALUE_OPTION_FLAGS.has(arg.toLowerCase()) ? arg : null;
    classified.push(classifiedArg);
  }
  return classified;
}

export async function computeCheckTrustBasis(input: {
  readonly canonicalRoot: string;
  readonly executable: string;
  readonly args: readonly string[];
}): Promise<ComputeCheckTrustBasisResult> {
  const rootIdentity = canonicalResourceIdentity(
    (await realpathOrNull(input.canonicalRoot)) ?? input.canonicalRoot);

  const materials: CheckTrustMaterial[] = [];
  const seen = new Set<string>();

  const push = (identity: string, digest: string, role: CheckTrustMaterial['role']) => {
    if (seen.has(identity)) return;
    seen.add(identity);
    materials.push({ path: identity, rootRelativePath: rootRelative(rootIdentity, identity),
      sha256: digest, role });
  };

  const executable = await readRegularFile(input.executable);
  if (executable === null) {
    return unreadable(input.executable);
  }
  push(executable.identity, executable.sha256, 'EXECUTABLE');

  // 非 `--test` 形态下，只有第一个路径参数是「被执行的程序」——包括选项结束标记
  // `--` 之后那个（`node -- --entry.mjs src/value.txt` 实测执行 `--entry.mjs`）；
  // 第二个及之后的位置参数是这次检查的输入（工作集），不进材料，改它不失效。
  // `--test` 形态下（`--test` 出现在第一个位置参数之前），测试运行器会逐个执行
  // 每一个显式入口，因此全部路径脚本都进材料（含终止符之后的）；无显式入口
  // （默认发现）、目录展开、通配符等无法枚举的形态明确拒绝，不静默放行。不凭扩展名猜输入。
  // 等号开关值（`--env-file=.env`、`--env-file=--`）确定属于开关：作为开关引用的材料
  // 进摘要，但不占主脚本位置——它们是真实被执行器读取的文件，内容变了就必须让摘要变化。
  // 分离式开关的值与主脚本无法区分（`node --env-file .env check.mjs` 实测执行
  // `check.mjs`），同一开关之后还有两个以上文件参数时明确拒绝，不猜；紧跟 `--` 时按
  // 实测直接拒绝（Node 报 requires an argument，一个脚本都不执行）。终止符之后的第一个
  // 路径参数身份明确，所以分离式候选只算终止符**之前**的文件参数。
  const classifications = classifyArgs(input.args);
  for (const classified of classifications) {
    if (classified.kind === 'DYNAMIC') {
      return { ok: false, reason: CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
        detail: classified.detail };
    }
  }
  const terminatorIndex = classifications.findIndex((item) => item.kind === 'TERMINATOR');
  // 分离式开关值的候选范围：终止符之前的文件参数。终止符之后的路径参数不是候选，
  // 它就是那次检查真正被执行的入口（或这次检查的输入）。
  const candidateBoundary = terminatorIndex === -1 ? input.args.length : terminatorIndex;
  let positional = 0;
  let testMode = false;
  let seenPositional = false;
  for (let index = 0; index < input.args.length; index += 1) {
    const arg = input.args[index]!;
    const classified = classifications[index]!;
    // 终止符本身不携带执行内容，只切换后续参数的解释方式。
    if (classified.kind === 'TERMINATOR') continue;
    if (classified.kind === 'FLAG') {
      // `--test` 出现在第一个位置参数之前才是测试运行器形态；
      // 跟在脚本之后的是脚本自己的参数，不改变形态（保留工作集链）。
      if (!seenPositional && arg.toLowerCase() === TEST_FLAG) { testMode = true; continue; }
      if (!seenPositional && index < candidateBoundary) {
        const candidates = classifications.slice(index + 1, candidateBoundary)
          .filter((later) => later.kind === 'PATH');
        const afterTerminator = classifications.slice(candidateBoundary)
          .some((later) => later.kind === 'TERMINATED_PATH');
        // 终止符之前有候选、终止符之后又有路径参数时两侧各有一个可能的入口
        // （`node --env-file .env -- check.mjs` 实测执行 check.mjs），同样无法证明。
        if (candidates.length >= 2 || (candidates.length === 1 && afterTerminator)) {
          return { ok: false, reason: CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
            detail: `开关 ${arg} 之后的文件参数无法证明哪一个是主脚本（分离式开关值歧义）` };
        }
      }
      continue;
    }
    if (classified.kind === 'FLAG_VALUE') {
      const resolved = isAbsolute(classified.value)
        ? classified.value : join(rootIdentity, classified.value);
      const material = await readRegularFile(resolved);
      if (material === null) return unreadable(classified.value);
      push(material.identity, material.sha256, 'REFERENCED_SCRIPT');
      continue;
    }
    if (classified.kind !== 'PATH' && classified.kind !== 'TERMINATED_PATH') continue;
    seenPositional = true;
    positional += 1;
    if (!testMode && positional > 1) continue;
    const resolved = isAbsolute(classified.value)
      ? classified.value : join(rootIdentity, classified.value);
    const material = await readRegularFile(resolved);
    if (material === null) return unreadable(classified.value);
    push(material.identity, material.sha256, 'REFERENCED_SCRIPT');
  }
  // `node --test` 无显式入口即默认发现：无法枚举本次实际执行的文件集合，不默认安全。
  if (testMode && positional === 0) {
    return { ok: false, reason: CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      detail: 'node --test 未给出显式测试入口，默认发现无法枚举执行范围' };
  }
  // 终止符之后一个路径参数都没有（`node --`）时，没有任何可枚举的执行入口：
  // 解释器会退到交互式或默认发现形态，不默认安全。
  if (positional === 0 && terminatorIndex !== -1) {
    return { ok: false, reason: CHECK_TRUST_REASON.DYNAMIC_EXECUTION_UNSUPPORTED,
      detail: '选项结束标记之后没有任何可枚举的执行入口' };
  }

  for (const name of TRUST_BUILD_CONFIG_FILES) {
    const material = await readRegularFile(join(rootIdentity, name));
    if (material !== null) push(material.identity, material.sha256, 'BUILD_CONFIG');
  }

  materials.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const digest = sha256(canonicalizeJson({
    version: TRUST_BASIS_VERSION,
    materials: materials.map((material) => ({ path: material.path,
      rootRelativePath: material.rootRelativePath, sha256: material.sha256, role: material.role })),
  } as unknown as JsonObject));

  return { ok: true, basis: { version: TRUST_BASIS_VERSION, materials, digest } };
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function unreadable(path: string): ComputeCheckTrustBasisResult {
  return { ok: false, reason: CHECK_TRUST_REASON.MATERIAL_UNREADABLE,
    detail: `检查材料 ${path} 不存在、不是普通文件或无法读取。` };
}

const ROLES: readonly CheckTrustMaterial['role'][] = ['EXECUTABLE', 'REFERENCED_SCRIPT', 'BUILD_CONFIG'];

/**
 * 从持久化 JSON 还原信任摘要。形状不合法就返回 undefined——调用方据此把这次检查当作
 * 缺信任依据处理，而不是猜一个「看起来一样」的摘要。
 */
export function parseCheckTrustBasis(value: unknown): CheckTrustBasis | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== TRUST_BASIS_VERSION) return undefined;
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) return undefined;
  if (!Array.isArray(record.materials) || record.materials.length === 0) return undefined;
  const materials: CheckTrustMaterial[] = [];
  for (const entry of record.materials) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const material = entry as Record<string, unknown>;
    if (typeof material.path !== 'string' || material.path === '') return undefined;
    if (material.rootRelativePath !== null && typeof material.rootRelativePath !== 'string') {
      return undefined;
    }
    if (typeof material.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(material.sha256)) return undefined;
    if (typeof material.role !== 'string' || !ROLES.includes(material.role as CheckTrustMaterial['role'])) {
      return undefined;
    }
    materials.push({ path: material.path, rootRelativePath: material.rootRelativePath as string | null,
      sha256: material.sha256, role: material.role as CheckTrustMaterial['role'] });
  }
  return { version: TRUST_BASIS_VERSION, materials, digest: record.digest };
}
