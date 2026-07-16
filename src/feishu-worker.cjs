'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { createCodexExecutor } = require('./codex-executor.cjs');
const { assertFeishuConfigured, ensurePairingCode, readFeishuConfig, writeFeishuConfig } = require('./feishu-config.cjs');
const { createFeishuTransport } = require('./feishu-transport.cjs');
const { formatCompletion, splitMessage } = require('./formatters.cjs');
const { handleIncomingText } = require('./message-router.cjs');
const { readRuntimeConfig } = require('./runtime-config.cjs');
const { createStore } = require('./store.cjs');
const {
  DATA_DIR,
  FEISHU_STATUS_PATH,
  WORKER_CONTROL_PIPE,
  WORKER_LOCK_PATH,
} = require('./constants.cjs');
const { createWorkerControlServer } = require('./worker-control.cjs');
const { acquireWorkerLock } = require('./worker-lock.cjs');

const DELIVERY_INTERVAL_MS = 5_000;
const STATUS_INTERVAL_MS = 5_000;

function loadFeishuSdk() {
  try {
    return require('@larksuiteoapi/node-sdk');
  } catch (error) {
    throw new Error(`无法加载飞书 SDK。请先运行 npm install。${error.message || error}`);
  }
}

function completionChunkKey(completionId, chunkIndex) {
  const digest = crypto
    .createHash('sha256')
    .update(`codex-task-relay:completion:${completionId}:chunk:${chunkIndex}`)
    .digest('hex');

  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function replyKey(messageId) {
  const digest = crypto.createHash('sha256').update(`codex-task-relay:reply:${messageId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function writeWorkerStatus(status, statusPath = FEISHU_STATUS_PATH) {
  const directory = path.dirname(statusPath);
  const payload = {
    ...status,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function createDeliveryLoop(deliverOnce) {
  let activeDelivery = null;

  async function deliver({ rerunIfBusy = false } = {}) {
    if (activeDelivery) {
      const currentDelivery = activeDelivery;

      if (!rerunIfBusy) {
        return currentDelivery;
      }

      await currentDelivery;

      if (activeDelivery === currentDelivery) {
        activeDelivery = null;
      }
    }

    const currentDelivery = Promise.resolve().then(deliverOnce);
    activeDelivery = currentDelivery;

    try {
      return await currentDelivery;
    } finally {
      if (activeDelivery === currentDelivery) {
        activeDelivery = null;
      }
    }
  }

  return { deliver };
}

async function deliverQueuedCompletions(transport, store, config) {
  const ownerOpenId = String(config?.ownerOpenId || '').trim();

  if (!ownerOpenId) {
    return 0;
  }

  const queued = store.listQueuedCompletions(20);
  let delivered = 0;

  for (const completion of queued) {
    try {
      const messages = splitMessage(formatCompletion(completion), config.completionCharsPerMessage);
      const firstUndeliveredChunk = Math.min(
        Math.max(Number(completion.delivery_cursor) || 0, 0),
        messages.length,
      );

      for (let index = firstUndeliveredChunk; index < messages.length; index += 1) {
        await transport.sendText({
          idempotencyKey: completionChunkKey(completion.completion_id, index + 1),
          recipientId: ownerOpenId,
          text: messages[index],
        });
        store.markCompletionChunkSent(completion.completion_id, index + 1);
      }

      store.markCompletionSent(completion.completion_id);
      delivered += 1;
    } catch (error) {
      store.markCompletionDeliveryFailure(completion.completion_id, error.message || error);
      break;
    }
  }

  return delivered;
}

function createRouterConfig(runtimeConfig, feishuConfig) {
  return {
    ...runtimeConfig,
    ownerUserIds: feishuConfig.ownerOpenId ? [feishuConfig.ownerOpenId] : [],
  };
}

function isPairingCommand(text, pairingCode) {
  const escapedCode = String(pairingCode || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return Boolean(
    escapedCode && new RegExp(`^\\s*/(?:绑定|bind)\\s+${escapedCode}\\s*$`, 'i').test(String(text || '')),
  );
}

function createIncomingMessageHandler({
  ensurePairing = ensurePairingCode,
  executor,
  logger,
  readFeishu = readFeishuConfig,
  readRuntime = readRuntimeConfig,
  store,
  transport,
  writeFeishu = writeFeishuConfig,
}) {
  return async (message) => {
    if (message.chatType && message.chatType !== 'p2p') {
      return;
    }

    if (
      message.id &&
      typeof store.claimInboundMessage === 'function' &&
      !store.claimInboundMessage({
        messageId: message.id,
        provider: 'feishu',
        userId: message.userId,
      })
    ) {
      return;
    }

    const feishuConfig = ensurePairing(readFeishu());
    let reply = null;

    if (!feishuConfig.ownerOpenId) {
      if (isPairingCommand(message.text, feishuConfig.pairingCode)) {
        writeFeishu({
          ...feishuConfig,
          ownerOpenId: message.userId,
          pairingCode: '',
        });
        reply = '飞书绑定成功。以后可直接按“线程名字：下一步”向 Codex 指派任务。';
      } else {
        store.recordUnauthorizedUser(message.userId);
        reply = '当前飞书机器人尚未绑定。请在本机中继控制台查看绑定口令后发送“/绑定 <口令>”。';
      }
    } else {
      const result = handleIncomingText({
        config: createRouterConfig(readRuntime(), feishuConfig),
        message,
        store,
      });
      reply = result.reply;

      if (result.task) {
        executor?.wake();
      }
    }

    if (reply) {
      void transport
        .replyText({
          chatId: message.chatId,
          idempotencyKey: message.id ? replyKey(message.id) : null,
          text: reply,
        })
        .catch((error) => logger.warn(`飞书回复失败：${error.message || error}`));
    }
  };
}

async function main(dependencies = {}) {
  const logger = dependencies.logger || console;
  const runtimeConfigReader = dependencies.readRuntimeConfig || readRuntimeConfig;
  const feishuConfigReader = dependencies.readFeishuConfig || readFeishuConfig;
  const feishuConfigWriter = dependencies.writeFeishuConfig || writeFeishuConfig;
  const pairingEnsurer = dependencies.ensurePairingCode || ensurePairingCode;
  const runtimeConfig = runtimeConfigReader();
  const initialFeishuConfig = assertFeishuConfigured(pairingEnsurer(feishuConfigReader()));
  const releaseWorkerLock = (dependencies.acquireWorkerLock || acquireWorkerLock)(WORKER_LOCK_PATH, {
    pipe: WORKER_CONTROL_PIPE,
  });
  const workerLock = releaseWorkerLock.lock;
  let store;
  let transport;

  try {
    store = (dependencies.createStore || createStore)();
    transport = (dependencies.createTransport || createFeishuTransport)({
      appId: initialFeishuConfig.appId,
      appSecret: initialFeishuConfig.appSecret,
      onDiagnostic(message) {
        logger.error(message);
      },
      sdk: dependencies.sdk || loadFeishuSdk(),
    });
  } catch (error) {
    store?.close();
    releaseWorkerLock();
    throw error;
  }
  const writeStatus = dependencies.writeWorkerStatus || writeWorkerStatus;
  let controlServer = null;
  let executor = null;
  let deliveryTimer = null;
  let statusTimer = null;
  let stopping = false;
  let resolveShutdownWait;
  let shutdownPromise = null;
  const shutdownWait = new Promise((resolve) => {
    resolveShutdownWait = resolve;
  });

  function reportStatus(status = transport.getConnectionStatus()) {
    try {
      writeStatus(status);
    } catch (error) {
      logger.error(`写入飞书连接状态失败：${error.message || error}`);
    }
  }

  async function shutdown(reason = 'shutdown') {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    stopping = true;
    shutdownPromise = (async () => {
      if (deliveryTimer) {
        clearInterval(deliveryTimer);
        deliveryTimer = null;
      }

      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }

      try {
        await executor?.stop();
      } catch (error) {
        logger.error(`停止 Codex 执行器失败：${error.message || error}`);
      }

      transport.stop();
      reportStatus({ reason, state: 'stopped' });

      if (controlServer) {
        try {
          await controlServer.close();
        } catch (error) {
          logger.error(`关闭 worker 控制管道失败：${error.message || error}`);
        }
      }

      resolveShutdownWait();
    })();

    return shutdownPromise;
  }

  const handleSigint = () => {
    void shutdown('SIGINT');
  };
  const handleSigterm = () => {
    void shutdown('SIGTERM');
  };

  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  try {
    controlServer = createWorkerControlServer({
      controlToken: workerLock.controlToken,
      onDiagnostic(message) {
        logger.error(message);
      },
      onShutdown({ reason }) {
        return shutdown(reason);
      },
      pid: workerLock.pid,
      pipe: workerLock.pipe,
    });
    await controlServer.listen();

    if (runtimeConfig.executorEnabled) {
      executor = createCodexExecutor({
        logger,
        store,
      });
      executor.start();
      logger.log?.('Codex 自动执行器已启用。');
    }

    const deliveryLoop = createDeliveryLoop(() =>
      deliverQueuedCompletions(transport, store, {
        ...runtimeConfig,
        ownerOpenId: feishuConfigReader().ownerOpenId,
      }),
    );
    const handleIncomingMessage = createIncomingMessageHandler({
      executor,
      ensurePairing: pairingEnsurer,
      logger,
      readFeishu: feishuConfigReader,
      readRuntime: runtimeConfigReader,
      store,
      transport,
      writeFeishu: feishuConfigWriter,
    });

    reportStatus({ state: 'connecting' });
    await transport.start({
      onText: handleIncomingMessage,
      onTransportState(status) {
        reportStatus(status);
      },
    });
    deliveryTimer = setInterval(() => {
      if (!stopping) {
        deliveryLoop.deliver().catch((error) => logger.error(`飞书推送失败：${error.message || error}`));
      }
    }, DELIVERY_INTERVAL_MS);
    statusTimer = setInterval(() => {
      if (!stopping) {
        reportStatus();
      }
    }, STATUS_INTERVAL_MS);
    void deliveryLoop.deliver();
    logger.log?.('飞书长连接已启动。');
    await shutdownWait;
  } finally {
    await shutdown('finalize');
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    store.close();
    releaseWorkerLock();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`飞书中继未启动：${error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DELIVERY_INTERVAL_MS,
  STATUS_INTERVAL_MS,
  completionChunkKey,
  createDeliveryLoop,
  createIncomingMessageHandler,
  createRouterConfig,
  deliverQueuedCompletions,
  isPairingCommand,
  loadFeishuSdk,
  main,
  replyKey,
  writeWorkerStatus,
};
