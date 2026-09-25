<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core';
import { onMounted, ref } from 'vue';

interface Bootstrap {
  automated: boolean;
  endpoint: string;
  frame_probe_control: boolean;
  sidecar_node_version: string;
  token: string;
  verification: {
    bad_host_status: number;
    bad_origin_status: number;
    no_token_status: number;
  };
}

const detail = ref('正在从受信 Tauri 主窗口取得本次内存连接信息…');
const stage = ref('启动中');

interface FrameProbeMessage {
  type:
    | 'relay-p00-frame-probe-loaded'
    | 'relay-p00-frame-probe-bridge'
    | 'relay-p00-frame-probe-invocation'
    | 'relay-p00-frame-probe-result';
  bootstrap_invocation_attempted?: boolean;
  bootstrap_succeeded?: boolean;
  bridge_available?: boolean;
}

interface FrameProbeOutcome {
  bootstrapSucceeded: boolean;
  bridgeAvailable: boolean;
  bridgeReported: boolean;
  completionReported: boolean;
  executed: boolean;
  bootstrapInvocationAttempted: boolean;
}

async function exerciseSameOriginFrameProbe(expectExecution: boolean): Promise<FrameProbeOutcome> {
  const frame = document.createElement('iframe');
  const probeResult = new Promise<FrameProbeOutcome>((resolve) => {
    let executed = false;
    let bridgeAvailable = false;
    let bridgeReported = false;
    let bootstrapInvocationAttempted = false;
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve({
        executed,
        bridgeAvailable,
        bridgeReported,
        bootstrapInvocationAttempted,
        bootstrapSucceeded: false,
        completionReported: false,
      });
    }, 1000);
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<FrameProbeMessage> | null;
      if (
        event.source === frame.contentWindow &&
        event.origin === window.location.origin &&
        (
          data?.type === 'relay-p00-frame-probe-loaded' ||
          data?.type === 'relay-p00-frame-probe-bridge' ||
          data?.type === 'relay-p00-frame-probe-invocation' ||
          data?.type === 'relay-p00-frame-probe-result'
        )
      ) {
        executed = true;
        if (data.type === 'relay-p00-frame-probe-bridge') {
          bridgeReported = true;
          bridgeAvailable = data.bridge_available === true;
        }
        if (data.type === 'relay-p00-frame-probe-invocation') {
          bootstrapInvocationAttempted = data.bootstrap_invocation_attempted === true;
        }
        if (data.type === 'relay-p00-frame-probe-result') {
          window.clearTimeout(timeout);
          window.removeEventListener('message', onMessage);
          resolve({
            executed: true,
            bridgeAvailable,
            bridgeReported,
            bootstrapInvocationAttempted: bootstrapInvocationAttempted || data.bootstrap_invocation_attempted === true,
            bootstrapSucceeded: data.bootstrap_succeeded === true,
            completionReported: true,
          });
        }
      }
    };
    window.addEventListener('message', onMessage);
  });
  frame.hidden = true;
  frame.src = new URL('frame-probe.html', window.location.href).toString();
  document.body.append(frame);
  const outcome = await probeResult;
  frame.remove();
  if (outcome.executed !== expectExecution) {
    throw new Error(
      expectExecution
        ? 'P00 controlled same-origin frame did not execute its CSP-permitted external probe script'
        : 'same-origin subframe executed despite the native P00 frame blocker',
    );
  }
  return outcome;
}

async function verifyConnection(): Promise<void> {
  const bootstrap = await invoke<Bootstrap>('desktop_bootstrap');
  const frameProbe = await exerciseSameOriginFrameProbe(bootstrap.frame_probe_control);
  const response = await fetch(`${bootstrap.endpoint}/p00/handshake`, {
    headers: {
      Authorization: `Bearer ${bootstrap.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`loopback handshake returned HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('ready' in body) ||
    body.ready !== true
  ) {
    throw new Error('loopback handshake response did not identify this ready instance');
  }

  const reloaded = sessionStorage.getItem('relay-p00-reloaded') === '1';
  if (!reloaded) {
    sessionStorage.setItem('relay-p00-reloaded', '1');
    stage.value = '首次握手完成，正在重载真实 WebView…';
    detail.value = '凭据没有写入 URL、日志或浏览器持久化存储。';
    window.setTimeout(() => window.location.reload(), 125);
    return;
  }

  stage.value = '真实 WebView 重载后握手通过';
  detail.value = [
    '随包 Vue 静态页通过窄 Tauri IPC 在内存取得本次连接信息。',
    'loopback Bearer 握手：HTTP 200。',
    `sidecar 负向探针：无 token ${bootstrap.verification.no_token_status}、错误 Host ${bootstrap.verification.bad_host_status}、错误 Origin ${bootstrap.verification.bad_origin_status}。`,
    `随包 Node：${bootstrap.sidecar_node_version}。`,
  ].join('\n');

  if (bootstrap.automated) {
    window.setTimeout(() => {
      void invoke('complete_automated_test', {
        frameProbeExecuted: frameProbe.executed,
        frameProbeBridgeAvailable: frameProbe.bridgeAvailable,
        frameProbeBridgeReported: frameProbe.bridgeReported,
        frameProbeBootstrapSucceeded: frameProbe.bootstrapSucceeded,
        frameProbeCompletionReported: frameProbe.completionReported,
        frameProbeBootstrapInvocationAttempted: frameProbe.bootstrapInvocationAttempted,
      });
    }, 750);
  }
}

onMounted(() => {
  void verifyConnection().catch((error: unknown) => {
    stage.value = 'P00 验证失败';
    detail.value = error instanceof Error ? error.message : String(error);
  });
});
</script>

<template>
  <main>
    <p class="eyebrow">Relay / desktop-p00 / isolated probe</p>
    <h1>{{ stage }}</h1>
    <pre>{{ detail }}</pre>
    <p class="boundary">
      这是受控 FakeWorker 和 loopback 边界实验；不包含业务 API、数据库、Provider、文件或 shell 能力。
    </p>
  </main>
</template>
