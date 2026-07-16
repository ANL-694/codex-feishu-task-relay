'use strict';

function formatFeishuError(operation, response) {
  const code = response?.code;
  const message = String(response?.msg || response?.message || '未知错误').trim();
  return new Error(`飞书${operation}失败（code=${code ?? 'unknown'}）：${message}`);
}

function assertFeishuSuccess(operation, response) {
  if (Number(response?.code) === 0) {
    return response;
  }

  throw formatFeishuError(operation, response);
}

function parseFeishuTextContent(content) {
  try {
    const parsed = JSON.parse(String(content || ''));
    return typeof parsed?.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

function normalizeIncomingFeishuMessage(event) {
  const message = event?.message;
  const sender = event?.sender;
  const userId = String(sender?.sender_id?.open_id || '').trim();
  const chatId = String(message?.chat_id || '').trim();
  const text = parseFeishuTextContent(message?.content);

  if (message?.message_type !== 'text' || !userId || !chatId || text === null) {
    return null;
  }

  return {
    chatId,
    chatType: String(message?.chat_type || '').trim().toLocaleLowerCase('en-US'),
    id: String(message?.message_id || '').trim(),
    raw: event,
    text,
    type: 'text',
    userId,
  };
}

function createFeishuTransport({ appId, appSecret, onDiagnostic = () => {}, sdk }) {
  if (!sdk) {
    throw new TypeError('Feishu SDK is required');
  }

  let client = null;
  let wsClient = null;
  let onState = () => {};

  function reportState(state) {
    try {
      onState(state);
    } catch (error) {
      onDiagnostic(`飞书状态回调失败：${error.message || error}`);
    }
  }

  async function sendText({ idempotencyKey, recipientId, text }) {
    if (!client) {
      throw new Error('飞书客户端尚未启动。');
    }

    const data = {
      content: JSON.stringify({ text: String(text) }),
      msg_type: 'text',
      receive_id: String(recipientId),
    };

    if (idempotencyKey) {
      data.uuid = String(idempotencyKey);
    }

    const response = await client.im.v1.message.create({
      data,
      params: { receive_id_type: 'open_id' },
    });
    return assertFeishuSuccess('发送消息', response);
  }

  async function replyText({ chatId, idempotencyKey, text }) {
    if (!client) {
      throw new Error('飞书客户端尚未启动。');
    }

    const data = {
      content: JSON.stringify({ text: String(text) }),
      msg_type: 'text',
      receive_id: String(chatId),
    };

    if (idempotencyKey) {
      data.uuid = String(idempotencyKey);
    }

    const response = await client.im.v1.message.create({
      data,
      params: { receive_id_type: 'chat_id' },
    });
    return assertFeishuSuccess('回复消息', response);
  }

  async function start({ onText, onTransportState = () => {} }) {
    if (typeof onText !== 'function') {
      throw new TypeError('飞书入站消息处理器必须是函数。');
    }

    onState = onTransportState;
    client = new sdk.Client({
      appId,
      appSecret,
      appType: sdk.AppType.SelfBuild,
      domain: sdk.Domain.Feishu,
      loggerLevel: sdk.LoggerLevel.error,
    });
    const eventDispatcher = new sdk.EventDispatcher({}).register({
      'im.message.receive_v1': async (event) => {
        const message = normalizeIncomingFeishuMessage(event);

        if (message) {
          await onText(message);
        }
      },
    });
    wsClient = new sdk.WSClient({
      appId,
      appSecret,
      loggerLevel: sdk.LoggerLevel.error,
      onError(error) {
        onDiagnostic(`飞书长连接失败：${error.message || error}`);
        reportState({ state: 'failed' });
      },
      onReady() {
        reportState(wsClient.getConnectionStatus());
      },
      onReconnected() {
        reportState(wsClient.getConnectionStatus());
      },
      onReconnecting() {
        reportState(wsClient.getConnectionStatus());
      },
    });

    await wsClient.start({ eventDispatcher });
    reportState(wsClient.getConnectionStatus());
  }

  function getConnectionStatus() {
    return wsClient?.getConnectionStatus?.() || { state: 'idle' };
  }

  function stop() {
    wsClient?.close?.();
    reportState({ state: 'stopped' });
  }

  return {
    getConnectionStatus,
    replyText,
    sendText,
    start,
    stop,
  };
}

module.exports = {
  assertFeishuSuccess,
  createFeishuTransport,
  formatFeishuError,
  normalizeIncomingFeishuMessage,
  parseFeishuTextContent,
};
