'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertFeishuConfigured,
  ensurePairingCode,
  readFeishuConfig,
  writeFeishuConfig,
} = require('../src/feishu-config.cjs');
const {
  createFeishuTransport,
  normalizeIncomingFeishuMessage,
} = require('../src/feishu-transport.cjs');
const {
  completionChunkKey,
  createIncomingMessageHandler,
  deliverQueuedCompletions,
  isPairingCommand,
} = require('../src/feishu-worker.cjs');
const { createStore } = require('../src/store.cjs');

function createTemporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-feishu-relay-'));
  const store = createStore(path.join(directory, 'relay.sqlite'));

  return {
    directory,
    store,
    close() {
      store.close();
      fs.rmSync(directory, { force: true, recursive: true });
    },
  };
}

function waitForAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createSdkMock() {
  const calls = [];
  let dispatcher = null;
  let status = { state: 'connected' };

  class Client {
    constructor() {
      this.im = {
        v1: {
          message: {
            async create(payload) {
              calls.push(payload);
              return { code: 0 };
            },
          },
        },
      };
    }
  }

  class EventDispatcher {
    constructor() {
      this.handlers = {};
    }

    register(handlers) {
      this.handlers = handlers;
      dispatcher = this;
      return this;
    }
  }

  class WSClient {
    constructor(options) {
      this.options = options;
    }

    async start() {
      this.options.onReady();
    }

    close() {
      status = { state: 'stopped' };
    }

    getConnectionStatus() {
      return status;
    }
  }

  return {
    AppType: { SelfBuild: 0 },
    Client,
    Domain: { Feishu: 0 },
    EventDispatcher,
    LoggerLevel: { error: 1 },
    WSClient,
    calls,
    get dispatcher() {
      return dispatcher;
    },
  };
}

test('飞书配置仅写入 data 配置并生成高熵绑定口令', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-feishu-config-'));
  const configPath = path.join(directory, 'feishu-config.json');

  try {
    const stored = writeFeishuConfig(
      {
        appId: 'cli_0123456789abcdef',
        appSecret: 'secret-value',
      },
      configPath,
    );
    const configured = ensurePairingCode(stored, {
      configPath,
      randomBytes(size) {
        return Buffer.alloc(size, 7);
      },
    });

    assert.equal(configured.pairingCode, 'relay-BwcHBwcHBwcHBwcH');
    assert.equal(readFeishuConfig(configPath).appSecret, 'secret-value');
    assert.match(configured.pairingCode, /^relay-[A-Za-z0-9_-]{16}$/);
    assert.throws(() => assertFeishuConfigured({ appId: 'invalid', appSecret: 'secret' }), /App ID/);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test('飞书文本事件规范化为中继输入，忽略非文本事件', () => {
  const event = {
    message: {
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      content: JSON.stringify({ text: '任务线程：继续' }),
      message_id: 'om_message',
      message_type: 'text',
    },
    sender: { sender_id: { open_id: 'ou_owner' } },
  };

  assert.deepEqual(normalizeIncomingFeishuMessage(event), {
    chatId: 'oc_chat',
    chatType: 'p2p',
    id: 'om_message',
    raw: event,
    text: '任务线程：继续',
    type: 'text',
    userId: 'ou_owner',
  });
  assert.equal(
    normalizeIncomingFeishuMessage({
      ...event,
      message: { ...event.message, message_type: 'image' },
    }),
    null,
  );
});

test('飞书 transport 使用 open_id、chat_id 和稳定 uuid 发送文本', async () => {
  const sdk = createSdkMock();
  const states = [];
  const received = [];
  const transport = createFeishuTransport({
    appId: 'cli_0123456789abcdef',
    appSecret: 'secret',
    sdk,
  });

  await transport.start({
    onText(message) {
      received.push(message);
    },
    onTransportState(status) {
      states.push(status.state);
    },
  });
  await transport.sendText({
    idempotencyKey: 'completion-1-chunk-1',
    recipientId: 'ou_owner',
    text: '完成摘要',
  });
  await transport.replyText({
    chatId: 'oc_chat',
    idempotencyKey: 'reply-1',
    text: '已收录',
  });
  await sdk.dispatcher.handlers['im.message.receive_v1']({
    message: {
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      content: JSON.stringify({ text: '/帮助' }),
      message_id: 'om_help',
      message_type: 'text',
    },
    sender: { sender_id: { open_id: 'ou_owner' } },
  });

  assert.deepEqual(states, ['connected', 'connected']);
  assert.equal(received[0].text, '/帮助');
  assert.deepEqual(sdk.calls[0].params, { receive_id_type: 'open_id' });
  assert.equal(sdk.calls[0].data.receive_id, 'ou_owner');
  assert.equal(sdk.calls[0].data.uuid, 'completion-1-chunk-1');
  assert.deepEqual(sdk.calls[1].params, { receive_id_type: 'chat_id' });
  assert.equal(sdk.calls[1].data.receive_id, 'oc_chat');
});

test('完成摘要失败时从飞书分片游标恢复并复用 uuid', async () => {
  const temporary = createTemporaryStore();
  const completion = temporary.store.recordCompletion({
    cwd: 'E:\\workspace\\project',
    finalMessage: '摘要'.repeat(700),
    projectId: 'thread:demo',
    projectName: '示例线程',
    threadId: 'thread-demo',
    turnId: 'turn-demo',
  }).completion;
  const firstAttempt = [];

  try {
    await deliverQueuedCompletions(
      {
        async sendText(payload) {
          firstAttempt.push(payload);

          if (firstAttempt.length === 2) {
            throw new Error('模拟网络中断');
          }
        },
      },
      temporary.store,
      { completionCharsPerMessage: 500, ownerOpenId: 'ou_owner' },
    );

    assert.equal(temporary.store.getCompletion(completion.completion_id).delivery_cursor, 1);
    const retry = [];
    await deliverQueuedCompletions(
      {
        async sendText(payload) {
          retry.push(payload);
        },
      },
      temporary.store,
      { completionCharsPerMessage: 500, ownerOpenId: 'ou_owner' },
    );

    assert.equal(temporary.store.getCompletion(completion.completion_id).status, 'sent');
    assert.equal(firstAttempt[1].idempotencyKey, retry[0].idempotencyKey);
    assert.equal(firstAttempt[1].idempotencyKey, completionChunkKey(completion.completion_id, 2));
  } finally {
    temporary.close();
  }
});

test('飞书首次绑定不需要手工复制 open_id，重复事件不会重复处理', async () => {
  const temporary = createTemporaryStore();
  let feishuConfig = {
    appId: 'cli_0123456789abcdef',
    appSecret: 'secret',
    ownerOpenId: '',
    pairingCode: 'relay-test-code',
  };
  const replies = [];
  const handler = createIncomingMessageHandler({
    ensurePairing(config) {
      return config;
    },
    logger: { warn() {} },
    readFeishu() {
      return feishuConfig;
    },
    readRuntime() {
      return { completionCharsPerMessage: 3000, ownerUserIds: [], projects: [] };
    },
    store: temporary.store,
    transport: {
      async replyText(payload) {
        replies.push(payload);
      },
    },
    writeFeishu(config) {
      feishuConfig = config;
    },
  });

  try {
    await handler({
      chatId: 'oc_owner',
      chatType: 'p2p',
      id: 'om_bind',
      text: '/绑定 relay-test-code',
      userId: 'ou_owner',
    });
    await waitForAsyncWork();

    assert.equal(feishuConfig.ownerOpenId, 'ou_owner');
    assert.equal(feishuConfig.pairingCode, '');
    assert.match(replies[0].text, /绑定成功/);
    assert.equal(isPairingCommand('/绑定 relay-test-code', 'relay-test-code'), true);
    assert.equal(isPairingCommand('/绑定 wrong', 'relay-test-code'), false);

    await handler({
      chatId: 'oc_owner',
      chatType: 'p2p',
      id: 'om_bind',
      text: '/帮助',
      userId: 'ou_owner',
    });
    await waitForAsyncWork();

    assert.equal(replies.length, 1);
  } finally {
    temporary.close();
  }
});
