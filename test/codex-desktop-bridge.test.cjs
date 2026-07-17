'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CodexDesktopBridgeError,
  buildDesktopTurnPayload,
  createCodexDesktopBridge,
  extractRemoteDebuggingPorts,
  isTrustedDesktopPage,
} = require('../src/codex-desktop-bridge.cjs');

const THREAD_ID = '11111111-1111-4111-8111-111111111111';

function task(overrides = {}) {
  return {
    attempt_count: 1,
    cwd: 'C:\\codex-relay-test\\project',
    instruction: '只检查状态，不修改文件。',
    task_id: 7,
    thread_id: THREAD_ID,
    ...overrides,
  };
}

test('提取 ChatGPT 进程的本机调试端口并忽略无效值', () => {
  const ports = extractRemoteDebuggingPorts([
    'ChatGPT.exe --remote-debugging-port=64889',
    'ChatGPT.exe --remote-debugging-port=64889 --inspect=127.0.0.1:64989',
    'ChatGPT.exe --remote-debugging-port=70000',
    'ChatGPT.exe --remote-debugging-port=0',
  ]);

  assert.deepEqual(ports, [64889]);
});

test('仅接受回环地址上的 Codex Desktop 页面', () => {
  assert.equal(
    isTrustedDesktopPage(
      {
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:64889/devtools/page/abc',
      },
      64889,
    ),
    true,
  );
  assert.equal(
    isTrustedDesktopPage(
      {
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: 'ws://192.168.1.8:64889/devtools/page/abc',
      },
      64889,
    ),
    false,
  );
});

test('桌面投递负载保留原任务安全提示并使用独立消息标识', () => {
  const payload = buildDesktopTurnPayload(task(), {
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
  });

  assert.equal(payload.clientUserMessageId, '22222222-2222-4222-8222-222222222222');
  assert.equal(payload.threadId, THREAD_ID);
  assert.match(payload.prompt, /已授权飞书 owner/);
  assert.match(payload.prompt, /只检查状态，不修改文件。/);
});

test('桌面可用时投递原线程并返回 Desktop turn 标识', async () => {
  let observedPayload = null;
  const bridge = createCodexDesktopBridge({
    discoverPage: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:64889/devtools/page/abc' }),
    invokeTurn: async (_page, payload) => {
      observedPayload = payload;
      return { state: 'started', turnId: 'desktop-turn-7' };
    },
    randomUUID: () => '33333333-3333-4333-8333-333333333333',
  });

  const result = await bridge.dispatch(task());

  assert.deepEqual(result, {
    available: true,
    threadId: THREAD_ID,
    turnId: 'desktop-turn-7',
  });
  assert.equal(observedPayload.hostId, 'local');
});

test('桌面不可用时返回 CLI 降级信号，繁忙线程保留重试语义', async () => {
  const unavailableBridge = createCodexDesktopBridge({ discoverPage: async () => null });
  const unavailable = await unavailableBridge.dispatch(task());

  assert.deepEqual(unavailable, { available: false, reason: 'desktop_unavailable' });

  const busyBridge = createCodexDesktopBridge({
    discoverPage: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:64889/devtools/page/abc' }),
    invokeTurn: async () => ({ activeTurnId: 'active-turn', state: 'busy' }),
  });

  await assert.rejects(
    () => busyBridge.dispatch(task()),
    (error) => error instanceof CodexDesktopBridgeError && error.code === 'DESKTOP_THREAD_BUSY',
  );
});
