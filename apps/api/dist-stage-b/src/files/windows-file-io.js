import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
export class WindowsFileIoError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'WindowsFileIoError';
    }
}
const MAX_HELPER_OUTPUT_BYTES = 3 * 1024 * 1024;
const ID = /^[0-9a-f]{16}:[0-9a-f]{32}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
function validChain(value) {
    return Array.isArray(value) && value.every((part) => typeof part === 'object' && part !== null &&
        typeof part.path === 'string' && ID.test(part.id));
}
function contentSha(change) {
    return typeof change?.content === 'string'
        ? createHash('sha256').update(change.content).digest('hex') : null;
}
/** The Worker calls the packaged fixed helper. Windows file writes never fall back to path APIs. */
async function invokeWindowsFileIo(request, signal) {
    if (process.platform !== 'win32')
        throw new Error('Windows file I/O helper requires Windows');
    const executable = process.env.RELAY_FILE_IO_HELPER ??
        join(dirname(process.execPath), 'relay-file-io-helper.exe');
    if (signal?.aborted)
        throw new Error('Windows file I/O helper aborted before start');
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks = [];
        let size = 0;
        let stderr = '';
        let settled = false;
        const finish = (error, reply) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (error)
                reject(error);
            else
                resolve(reply);
        };
        const abort = () => { child.kill(); finish(new Error('Windows file I/O helper aborted')); };
        const timer = setTimeout(() => {
            child.kill();
            finish(new Error('Windows file I/O helper timed out'));
        }, 30_000);
        signal?.addEventListener('abort', abort, { once: true });
        child.on('error', (error) => finish(error));
        child.stdout.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_HELPER_OUTPUT_BYTES) {
                child.kill();
                finish(new Error('Windows file I/O helper output exceeded limit'));
            }
            else
                chunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < 4096)
                stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
        });
        child.on('close', (code) => {
            if (settled)
                return;
            if (code !== 0)
                return finish(new Error(`Windows file I/O helper exited ${code}: ${stderr}`));
            try {
                const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (reply.version !== 'relay-file-io-v1')
                    throw new Error('Windows file I/O helper protocol mismatch');
                if (!reply.ok)
                    throw new WindowsFileIoError(reply.error?.code ?? 'FAILED', reply.error?.message ?? 'Windows file I/O helper failed');
                finish(undefined, reply);
            }
            catch (error) {
                finish(error);
            }
        });
        child.stdin.on('error', (error) => finish(error));
        child.stdin.end(JSON.stringify({ version: 'relay-file-io-v1', ...request }) + '\n');
    });
}
export async function inspectWindowsFileRoot(rootPath) {
    const reply = await invokeWindowsFileIo({ op: 'inspect-root', root_path: rootPath });
    if (typeof reply.root_id !== 'string' || !ID.test(reply.root_id)) {
        throw new Error('Windows file I/O helper omitted root identity');
    }
    return reply.root_id;
}
export async function captureWindowsFilePaths(rootPath, rootId, changes) {
    const reply = await invokeWindowsFileIo({ op: 'capture', root_path: rootPath,
        expected_root_id: rootId,
        changes: changes.map((change) => ({ path: change.path, action: change.action,
            ...(change.baselineSha256 == null ? {} : { baseline_sha256: change.baselineSha256 }) })) });
    if (reply.root_id !== rootId || !Array.isArray(reply.files) || reply.files.length !== changes.length ||
        reply.files.some((file, index) => file?.path !== changes[index]?.path ||
            file?.action !== changes[index]?.action || !validChain(file?.parent_chain) ||
            (file?.target_id !== null && (typeof file?.target_id !== 'string' || !ID.test(file.target_id))) ||
            (file?.sha256 !== null && (typeof file?.sha256 !== 'string' || !SHA256.test(file.sha256))) ||
            (file?.text !== null && typeof file?.text !== 'string') ||
            (file?.text_unavailable_reason !== null && typeof file?.text_unavailable_reason !== 'string'))) {
        throw new Error('Windows file I/O helper returned incomplete capture');
    }
    return reply.files;
}
export async function executeWindowsFileChangeset(evidence, changes, signal) {
    if (changes.length !== evidence.captures.length)
        throw new Error('Frozen file capture count mismatch');
    const reply = await invokeWindowsFileIo({ op: 'execute', root_path: evidence.root_path,
        expected_root_id: evidence.root_id,
        changes: changes.map((change, index) => {
            const capture = evidence.captures[index];
            if (capture?.path !== change.path || capture.action !== change.action) {
                throw new Error('Frozen file capture path mismatch');
            }
            return { path: change.path, action: change.action,
                expected_parent_chain: capture.parent_chain,
                expected_target_id: capture.target_id,
                ...(change.baselineSha256 == null ? {} : { baseline_sha256: change.baselineSha256 }),
                ...(change.content === undefined ? {} : { content: change.content }),
                ...(change.targetSha256 === undefined ? {} : { target_sha256: change.targetSha256 }) };
        }) }, signal);
    if (reply.root_id !== evidence.root_id || !Array.isArray(reply.files) ||
        reply.files.length !== changes.length ||
        (reply.outcome !== 'SUCCEEDED' && reply.outcome !== 'FAILED') ||
        reply.files.some((file, index) => file?.path !== changes[index]?.path ||
            file?.action !== changes[index]?.action ||
            !['APPLIED', 'CONFLICT', 'FAILED'].includes(file?.status) ||
            typeof file?.effect_uncertain !== 'boolean' || !validChain(file?.parent_chain) ||
            (file?.target_id !== null && (typeof file?.target_id !== 'string' || !ID.test(file.target_id))) ||
            (file?.actual_sha256 !== null &&
                (typeof file?.actual_sha256 !== 'string' || !SHA256.test(file.actual_sha256))) ||
            (file?.status === 'APPLIED' && (file.effect_uncertain ||
                (changes[index]?.action === 'DELETE'
                    ? file.target_id !== null || file.actual_sha256 !== null
                    : file.target_id === null ||
                        file.actual_sha256?.toLowerCase() !== contentSha(changes[index]))))) ||
        (reply.outcome === 'SUCCEEDED' && reply.files.some((file) => file.status !== 'APPLIED'))) {
        throw new Error('Windows file I/O helper returned incomplete execution');
    }
    return { outcome: reply.outcome, files: reply.files };
}
export async function reconcileWindowsFileChangeset(evidence, files, signal) {
    const reply = await invokeWindowsFileIo({ op: 'reconcile', root_path: evidence.root_path,
        expected_root_id: evidence.root_id,
        files: files.map((file) => ({ path: file.path,
            expected_parent_chain: file.parent_chain,
            expected_target_id: file.target_id,
            expected_sha256: file.expected_sha256 })) }, signal);
    if (reply.root_id !== evidence.root_id || !Array.isArray(reply.files) ||
        reply.files.length !== files.length ||
        reply.files.some((file, index) => file?.path !== files[index]?.path ||
            typeof file?.matches !== 'boolean' ||
            (file?.target_id !== null && (typeof file?.target_id !== 'string' || !ID.test(file.target_id))) ||
            (file?.sha256 !== null && (typeof file?.sha256 !== 'string' || !SHA256.test(file.sha256))))) {
        throw new Error('Windows file I/O helper returned incomplete reconciliation');
    }
    return reply.files;
}
/** Candidates are current directory entries, not proof that an Invocation made them. */
export async function inspectWindowsFileResiduals(evidence, files, signal) {
    const reply = await invokeWindowsFileIo({ op: 'inspect-residuals',
        root_path: evidence.root_path, expected_root_id: evidence.root_id,
        files: files.map((file) => ({ path: file.path,
            expected_parent_chain: file.parent_chain,
            expected_target_id: file.target_id, expected_sha256: file.sha256 })) }, signal);
    const returned = reply.files;
    if (reply.root_id !== evidence.root_id || reply.complete !== true ||
        !Array.isArray(returned) || returned.length !== files.length ||
        returned.some((file, index) => file?.path !== files[index]?.path ||
            !validChain(file?.parent_chain) || !file?.target ||
            file.target.path !== file.path ||
            !['PRESENT', 'MISSING'].includes(file.target.state) ||
            !['READABLE', 'MISSING'].includes(file.target.status) ||
            (file.target.id !== null && (typeof file.target.id !== 'string' || !ID.test(file.target.id))) ||
            (file.target.sha256 !== null &&
                (typeof file.target.sha256 !== 'string' || !SHA256.test(file.target.sha256))) ||
            file.target.error !== null ||
            (file.target.status === 'READABLE' &&
                (file.target.state !== 'PRESENT' || file.target.id === null || file.target.sha256 === null)) ||
            (file.target.status === 'MISSING' &&
                (file.target.state !== 'MISSING' || file.target.id !== null || file.target.sha256 !== null)) ||
            !Array.isArray(file.candidates) || file.candidates.length > 32 ||
            file.candidates.some((item) => {
                const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
                return typeof item?.path !== 'string' || !item.path.startsWith(`${parent}.__relay-file-io-`) ||
                    item.path.slice(parent.length).includes('/') || item.path.includes('\\') ||
                    typeof item.id !== 'string' || !ID.test(item.id) ||
                    typeof item.sha256 !== 'string' || !SHA256.test(item.sha256) ||
                    item.status !== 'READABLE' || item.error !== null;
            }))) {
        throw new Error('Windows file I/O helper returned incomplete residual observation');
    }
    return { complete: reply.complete, files: returned };
}
