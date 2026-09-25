import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const configLine = await new Promise((resolve) => input.once('line', resolve));
const config = JSON.parse(configLine);
const mode = process.env.P00_FAKE_WORKER_MODE ?? 'normal';
if (typeof config?.instance_nonce !== 'string' || config.instance_nonce.length < 32) {
  process.exit(41);
}
if (mode === 'exit-before-ready') {
  process.exit(42);
}
const instanceNonce = mode === 'wrong-nonce' ? 'wrong-instance' : config.instance_nonce;
const heartbeat = setInterval(() => {}, 1_000);

process.stdout.write(`${JSON.stringify({ instance_nonce: instanceNonce, type: 'ready' })}\n`);
input.on('line', (line) => {
  if (line === 'shutdown') {
    clearInterval(heartbeat);
    process.exit(0);
  }
});
