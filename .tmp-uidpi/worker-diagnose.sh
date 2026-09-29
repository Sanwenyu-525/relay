#!/bin/bash
# 诊断：以桌面 worker 相同环境手动运行一次 worker，捕获 stderr。
cd "D:\Develop\Relay-Agent"
NODE=".research/runtime-cache/node-v24.21.0-win-x64/node.exe"
# 使用便携 node（与 test-release/node.exe 同为 v24；入口用仓库源码构建产物 apps/api/dist）
export RELAY_DB_URL="postgresql://relay_app@127.0.0.1:6189/relay_trial"
export RELAY_DATA_ROOT="D:\\Develop\\Relay-Agent\\.relay-test\\data"
"$NODE" test-release/api/dist/src/worker/main.js --once > .tmp-uidpi/worker-diag-stdout.log 2> .tmp-uidpi/worker-diag-stderr.log
echo "exit=$?"
echo "--- stdout ---"
cat .tmp-uidpi/worker-diag-stdout.log
echo "--- stderr ---"
cat .tmp-uidpi/worker-diag-stderr.log
