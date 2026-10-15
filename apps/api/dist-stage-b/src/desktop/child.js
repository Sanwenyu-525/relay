import { request } from 'node:http';
const STARTUP_FRAME_LIMIT = 4096;
const STARTUP_FRAME_TIMEOUT_MS = 10000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** The first line is delivered only over the parent's anonymous stdin pipe. */
export function readDesktopStartupFrame() {
    return new Promise((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(() => finish(new Error('desktop startup pipe timed out')), STARTUP_FRAME_TIMEOUT_MS);
        const finish = (error, frame) => {
            clearTimeout(timer);
            process.stdin.off('data', onData);
            process.stdin.off('end', onEnd);
            process.stdin.pause();
            if (error !== undefined)
                reject(error);
            else
                resolve(frame);
        };
        const onEnd = () => finish(new Error('desktop startup pipe closed'));
        const onData = (chunk) => {
            buffered += chunk.toString('utf8');
            if (buffered.length > STARTUP_FRAME_LIMIT) {
                finish(new Error('desktop startup frame too large'));
                return;
            }
            const lineEnd = buffered.indexOf('\n');
            if (lineEnd < 0)
                return;
            try {
                const value = JSON.parse(buffered.slice(0, lineEnd));
                if (typeof value !== 'object' || value === null
                    || !('nonce' in value) || typeof value.nonce !== 'string'
                    || !/^[0-9a-f]{32}$/iu.test(value.nonce)
                    || !('bearerToken' in value) || typeof value.bearerToken !== 'string'
                    || !/^[0-9a-f]{64}$/iu.test(value.bearerToken)) {
                    finish(new Error('invalid desktop startup frame'));
                    return;
                }
                finish(undefined, { nonce: value.nonce, bearerToken: value.bearerToken });
            }
            catch {
                finish(new Error('invalid desktop startup frame'));
            }
        };
        process.stdin.on('data', onData);
        process.stdin.once('end', onEnd);
        process.stdin.resume();
    });
}
export function desktopWorkspaceId(value) {
    if (value === undefined || !UUID_PATTERN.test(value)) {
        throw new Error('RELAY_DESKTOP_WORKSPACE_ID must name an existing workspace UUID');
    }
    return value;
}
export async function probeDesktopReadiness(database, schemaReadiness, workspaceId) {
    const readiness = await database.checkReadiness(schemaReadiness);
    if (readiness.database !== 'up')
        throw new Error('DATABASE_UNAVAILABLE');
    if (readiness.schema !== 'up')
        throw new Error('SCHEMA_UNAVAILABLE');
    const workspace = await database.executor
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
    if (workspace === undefined)
        throw new Error('WORKSPACE_UNAVAILABLE');
}
function status(port, host, origin, token) {
    return new Promise((resolve, reject) => {
        const req = request({
            hostname: '127.0.0.1', port, path: '/health/ready', method: 'GET',
            headers: {
                host,
                ...(origin === undefined ? {} : { origin }),
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
            timeout: 3000,
        }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('desktop boundary probe timed out')));
        req.end();
    });
}
export async function probeDesktopBoundary(port, bearerToken) {
    const host = `127.0.0.1:${port}`;
    const [ready, unauthenticated, badHost, badOrigin] = await Promise.all([
        status(port, host, 'http://tauri.localhost', bearerToken),
        status(port, host, 'http://tauri.localhost'),
        status(port, `localhost:${port}`, 'http://tauri.localhost', bearerToken),
        status(port, host, 'http://evil.localhost', bearerToken),
    ]);
    if (ready !== 200 || unauthenticated !== 401 || badHost !== 400 || badOrigin !== 403) {
        throw new Error('DESKTOP_BOUNDARY_FAILED');
    }
}
export function writeDesktopEvent(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
