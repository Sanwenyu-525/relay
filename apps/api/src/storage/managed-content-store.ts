import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * 受管内容存储（docs/database/physical-design-postgresql.md 第 7 节、
 * contracts/04-recovery-and-commit.md 第 6 节）。
 *
 * 写入顺序固定为：同文件系统暂存 → 完整写入并计算 hash/size → 按平台能力刷盘 →
 * 发布到新的不可变版本目录（禁止覆盖）→ 由调用方登记数据库版本行。
 * 数据库只保存受管相对路径；路径全部由服务端按内部 ID 生成，绝不接受调用方传入的
 * 绝对路径或相对拼接，也不把用户内容写进仓库源码目录。
 *
 * 失败可以留下未引用的暂存/发布内容（孤儿），但不能让数据库出现指向未发布文件的版本；
 * V1 默认保留孤儿并提供核对报告，不自动清理。
 */

export const ARTIFACTS_DIRECTORY = 'artifacts';
export const STAGING_DIRECTORY = 'staging';
export const CONTENT_FILE_NAME = 'content.md';

/** 首个切片的内容上限：256 KiB（docs/api/http-command-contract.md 第 3 节）。 */
export const MAX_MARKDOWN_BYTES = 256 * 1024;

export const SUPPORTED_MEDIA_TYPES: readonly string[] = ['text/markdown'];

const STORAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** 存储路径不合法（绝对路径、盘符、上级目录、非法 ID）：一律拒绝，不尝试“修正”。 */
export class UnsafeStorageRefError extends Error {
  override readonly name = 'UnsafeStorageRefError';
}

/** 目标版本目录已被占用：不可变版本禁止覆盖。 */
export class StorageConflictError extends Error {
  override readonly name = 'StorageConflictError';
}

/** 本地写入/刷盘失败：调用方按 STORAGE_UNAVAILABLE 处理，不伪造已保存。 */
export class StorageUnavailableError extends Error {
  override readonly name = 'StorageUnavailableError';
}

export type ContentReadStatus = 'OK' | 'MISSING' | 'TAMPERED' | 'UNREADABLE';

export type ContentReadResult =
  | { readonly status: 'OK'; readonly content: Buffer }
  | { readonly status: Exclude<ContentReadStatus, 'OK'> };

export interface PublishedContent {
  /** 受管相对路径，形如 artifacts/<artifact-id>/<version-id>/content.md。 */
  readonly storageRef: string;
  readonly contentHash: Buffer;
  readonly size: bigint;
}

/** 内部 ID 必须是 UUID：宿主路径由这些 ID 生成，任何其他形态都说明调用方在拼路径。 */
export function requireStorageId(value: string, label: string): string {
  if (!STORAGE_ID_PATTERN.test(value)) {
    throw new UnsafeStorageRefError(`${label} must be a UUID when building a storage path`);
  }

  return value.toLowerCase();
}

export function managedContentRef(artifactId: string, versionId: string): string {
  const artifact = requireStorageId(artifactId, 'artifact id');
  const version = requireStorageId(versionId, 'version id');

  return `${ARTIFACTS_DIRECTORY}/${artifact}/${version}/${CONTENT_FILE_NAME}`;
}

/**
 * 把受管相对路径解析成 data_root 内的绝对路径。
 *
 * 拒绝：空值、绝对路径、以分隔符起始、盘符或冒号、NUL、任何 ""/./.. 片段，
 * 以及解析后逃出 data_root 的结果（防住符号链接式与拼接式的路径遍历）。
 */
export function resolveStoredContentPath(dataRoot: string, storageRef: string): string {
  if (typeof storageRef !== 'string' || storageRef === '') {
    throw new UnsafeStorageRefError('storage_ref must be a non-empty managed relative path');
  }

  if (storageRef.includes('\0') || storageRef.includes(':')) {
    throw new UnsafeStorageRefError('storage_ref must not contain NUL or a drive/stream separator');
  }

  if (isAbsolute(storageRef) || storageRef.startsWith('/') || storageRef.startsWith('\\')) {
    throw new UnsafeStorageRefError('storage_ref must not be an absolute path');
  }

  const segments = storageRef.split(/[\\/]/u);

  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new UnsafeStorageRefError(
      'storage_ref must not contain empty, current-directory or parent-directory segments',
    );
  }

  const root = resolve(dataRoot);
  const resolved = resolve(root, storageRef);
  const relativePath = relative(root, resolved);

  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new UnsafeStorageRefError('storage_ref must resolve inside the managed data root');
  }

  return resolved;
}

export function contentHashOf(content: Buffer): Buffer {
  return createHash('sha256').update(content).digest();
}

/** 受管内容存储：发布不可变版本、按存储引用读取并核对内容摘要。 */
export class ManagedContentStore {
  readonly dataRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = resolve(dataRoot);
  }

  /**
   * 发布一个新版本内容并返回它的受管相对路径与摘要。目标目录已存在时拒绝覆盖。
   * 返回值只说明内容已完整落盘；数据库版本行由调用方在同一事务中登记。
   */
  async publish(input: {
    readonly artifactId: string;
    readonly versionId: string;
    readonly content: Buffer;
  }): Promise<PublishedContent> {
    const storageRef = managedContentRef(input.artifactId, input.versionId);
    const targetPath = resolveStoredContentPath(this.dataRoot, storageRef);
    const stagingPath = join(this.dataRoot, STAGING_DIRECTORY, `${input.versionId}.part`);

    try {
      await mkdir(dirname(stagingPath), { recursive: true });
      await writeAndFlush(stagingPath, input.content);
      await mkdir(dirname(targetPath), { recursive: true });

      if (await pathExists(targetPath)) {
        throw new StorageConflictError(`immutable content already exists: ${storageRef}`);
      }

      await rename(stagingPath, targetPath);
      await flushExisting(targetPath);
    } catch (error) {
      if (error instanceof StorageConflictError || error instanceof UnsafeStorageRefError) {
        throw error;
      }

      throw new StorageUnavailableError(
        `could not publish managed content ${storageRef}: ${describeError(error)}`,
      );
    }

    return {
      storageRef,
      contentHash: contentHashOf(input.content),
      size: BigInt(input.content.byteLength),
    };
  }

  /**
   * 读取某个版本的受管内容，并与数据库保存的摘要/大小核对。
   * 缺失、被替换或被篡改都返回明确的读取状态，由调用方拒绝依赖该证据的操作，
   * 不伪造内容，也不重写旧 hash。
   */
  async readWithHashCheck(
    storageRef: string,
    expected: { readonly contentHash: Buffer; readonly size: bigint },
  ): Promise<ContentReadResult> {
    let content: Buffer;

    try {
      const path = resolveStoredContentPath(this.dataRoot, storageRef);
      content = await readFile(path);
    } catch (error) {
      if (error instanceof UnsafeStorageRefError) {
        return { status: 'UNREADABLE' };
      }

      return { status: isMissingFileError(error) ? 'MISSING' : 'UNREADABLE' };
    }

    const actualHash = contentHashOf(content);

    if (!actualHash.equals(Buffer.from(expected.contentHash)) || BigInt(content.byteLength) !== expected.size) {
      return { status: 'TAMPERED' };
    }

    return { status: 'OK', content };
  }
}

async function writeAndFlush(path: string, content: Buffer): Promise<void> {
  const handle = await open(path, 'wx');

  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 发布后再次刷盘（目录项已由 rename 建立）；失败作为存储错误处理，不报告成功。 */
async function flushExisting(path: string): Promise<void> {
  const handle = await open(path, 'r+');

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;

  return code === 'ENOENT' || code === 'ENOTDIR';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}