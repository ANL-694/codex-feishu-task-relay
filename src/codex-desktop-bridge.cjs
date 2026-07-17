'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Buffer } = require('node:buffer');
const { promisify } = require('node:util');
const { createExecutorPrompt } = require('./codex-task-runner.cjs');

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DESKTOP_PAGE_URL = 'app://-/index.html';
const LOCAL_DEBUG_HOST = '127.0.0.1';
const REMOTE_DEBUGGING_PORT_PATTERN = /--remote-debugging-port=(\d{2,5})\b/g;

const executeFile = promisify(execFile);

class CodexDesktopBridgeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.code = options.code || 'CODEX_DESKTOP_BRIDGE_FAILED';
    this.name = 'CodexDesktopBridgeError';
    this.retryable = options.retryable !== false;
  }
}

function normalizePort(value) {
  const port = Number(value);

  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function uniquePorts(values) {
  const seen = new Set();
  const ports = [];

  for (const value of values) {
    const port = normalizePort(value);

    if (port != null && !seen.has(port)) {
      seen.add(port);
      ports.push(port);
    }
  }

  return ports;
}

function extractRemoteDebuggingPorts(commandLines) {
  const ports = [];

  for (const commandLine of commandLines || []) {
    const normalizedCommandLine = String(commandLine || '');
    REMOTE_DEBUGGING_PORT_PATTERN.lastIndex = 0;
    let match;

    while ((match = REMOTE_DEBUGGING_PORT_PATTERN.exec(normalizedCommandLine)) != null) {
      ports.push(match[1]);
    }
  }

  return uniquePorts(ports);
}

function parseCommandLineOutput(value) {
  const text = String(value || '').trim();

  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.map((item) => String(item || '').trim()).filter(Boolean);
  } catch {
    return text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
}

async function listChatGptCommandLines(options = {}) {
  const platform = options.platform || process.platform;

  if (platform !== 'win32') {
    return [];
  }

  const invoke = options.execFile || executeFile;
  const script = "Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress";
  const executables = options.powerShellExecutables || ['pwsh.exe', 'powershell.exe'];

  for (const executable of executables) {
    try {
      const result = await invoke(
        executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true },
      );
      return parseCommandLineOutput(result?.stdout ?? result);
    } catch {
    }
  }

  return [];
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new CodexDesktopBridgeError('当前 Node 运行时不支持本机 Desktop 桥接请求。', {
      code: 'DESKTOP_FETCH_UNAVAILABLE',
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isTrustedDesktopPage(page, port) {
  if (!page || page.type !== 'page' || page.url !== DESKTOP_PAGE_URL) {
    return false;
  }

  try {
    const debuggerUrl = new URL(page.webSocketDebuggerUrl);
    return (
      debuggerUrl.protocol === 'ws:' &&
      debuggerUrl.hostname === LOCAL_DEBUG_HOST &&
      Number(debuggerUrl.port) === Number(port)
    );
  } catch {
    return false;
  }
}

async function discoverCodexDesktopPage(options = {}) {
  const configuredPort = normalizePort(options.environment?.CODEX_DESKTOP_DEBUG_PORT);
  const commandLines = await (options.listChatGptCommandLines || listChatGptCommandLines)(options);
  const ports = uniquePorts([configuredPort, ...extractRemoteDebuggingPorts(commandLines)]);

  for (const port of ports) {
    const pages = await fetchJson(`http://${LOCAL_DEBUG_HOST}:${port}/json/list`, options);

    if (!Array.isArray(pages)) {
      continue;
    }

    const page = pages.find((candidate) => isTrustedDesktopPage(candidate, port));

    if (page) {
      return page;
    }
  }

  return null;
}

function attachSocketListener(socket, eventName, listener) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(eventName, listener);
    return;
  }

  if (typeof socket.on === 'function') {
    socket.on(eventName, listener);
    return;
  }

  socket[`on${eventName}`] = listener;
}

function socketMessageText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('utf8');
  }

  return String(value);
}

class CdpClient {
  constructor(webSocketUrl, options = {}) {
    this.WebSocket = options.WebSocket || globalThis.WebSocket;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.webSocketUrl = webSocketUrl;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.socket = null;
  }

  async connect() {
    if (typeof this.WebSocket !== 'function') {
      throw new CodexDesktopBridgeError('当前 Node 运行时不支持本机 Desktop WebSocket 桥接。', {
        code: 'DESKTOP_WEBSOCKET_UNAVAILABLE',
      });
    }

    const socket = new this.WebSocket(this.webSocketUrl);
    this.socket = socket;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new CodexDesktopBridgeError('连接 Codex Desktop 超时。', { code: 'DESKTOP_CONNECT_TIMEOUT' }));
        }
      }, this.requestTimeoutMs);
      const settle = (callback) => (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          callback(event);
        }
      };

      attachSocketListener(socket, 'open', settle(resolve));
      attachSocketListener(socket, 'error', settle(() => reject(new CodexDesktopBridgeError('无法连接 Codex Desktop。', { code: 'DESKTOP_CONNECT_FAILED' }))));
    });

    attachSocketListener(socket, 'message', (event) => this.handleMessage(event?.data ?? event));
    attachSocketListener(socket, 'close', () => this.closePending('Codex Desktop 连接已关闭。'));
    attachSocketListener(socket, 'error', () => this.closePending('Codex Desktop 连接异常。'));
  }

  closePending(message) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexDesktopBridgeError(message, { code: 'DESKTOP_CONNECTION_CLOSED' }));
    }

    this.pendingRequests.clear();
  }

  handleMessage(data) {
    let message;

    try {
      message = JSON.parse(socketMessageText(data));
    } catch {
      return;
    }

    const pending = this.pendingRequests.get(message.id);

    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.error) {
      pending.reject(
        new CodexDesktopBridgeError(`Codex Desktop 请求失败：${message.error.message || '未知错误'}`, {
          code: 'DESKTOP_CDP_REQUEST_FAILED',
        }),
      );
      return;
    }

    pending.resolve(message.result);
  }

  request(method, params = {}) {
    if (!this.socket) {
      throw new CodexDesktopBridgeError('Codex Desktop 桥接尚未连接。', {
        code: 'DESKTOP_NOT_CONNECTED',
      });
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new CodexDesktopBridgeError(`Codex Desktop 请求超时：${method}`, { code: 'DESKTOP_REQUEST_TIMEOUT' }));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, { reject, resolve, timeout });
      this.socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }

  close() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
      }
    }

    this.closePending('Codex Desktop 桥接已关闭。');
    this.socket = null;
  }
}

function cdpExceptionMessage(result) {
  return (
    result?.exceptionDetails?.exception?.description ||
    result?.exceptionDetails?.text ||
    '未知桌面脚本错误'
  );
}

async function invokeDesktopTurn(page, payload, options = {}) {
  const client = new CdpClient(page.webSocketDebuggerUrl, options);

  try {
    await client.connect();
    const globalResult = await client.request('Runtime.evaluate', {
      expression: 'globalThis',
      returnByValue: false,
    });

    if (globalResult.exceptionDetails || !globalResult.result?.objectId) {
      throw new CodexDesktopBridgeError(`无法访问 Codex Desktop 运行时：${cdpExceptionMessage(globalResult)}`, {
        code: 'DESKTOP_RUNTIME_UNAVAILABLE',
      });
    }

    const dispatchResult = await client.request('Runtime.callFunctionOn', {
      arguments: [{ value: payload }],
      awaitPromise: true,
      functionDeclaration: `async (payload) => {
        const indexScript = Array.from(document.scripts).find((script) => /\\/assets\\/index-[A-Za-z0-9_-]+\\.js$/.test(script.src));
        if (!indexScript) {
          throw new Error('未找到 Codex Desktop 入口脚本。');
        }
        const indexSource = await (await fetch(indexScript.src)).text();
        const assetMatch = indexSource.match(/use-host-config-[A-Za-z0-9_-]+\\.js/);
        if (!assetMatch) {
          throw new Error('未找到 Codex Desktop 请求桥接模块。');
        }
        const module = await import('app://-/assets/' + assetMatch[0]);
        const requestBridge = Object.values(module).find((value) => value && typeof value.sendRequest === 'function' && typeof value.setMessageHandler === 'function');
        if (!requestBridge) {
          throw new Error('Codex Desktop 请求桥接不可用。');
        }
        await requestBridge.sendRequest('ensure-conversation-history-loaded', {
          conversationId: payload.threadId,
          dependentConversationIds: [],
        });
        const resumeState = await requestBridge.sendRequest('maybe-resume-conversation', {
          hostId: payload.hostId,
          conversationId: payload.threadId,
          model: null,
          serviceTier: null,
          reasoningEffort: null,
          workspaceRoots: [payload.cwd],
        });
        if (resumeState && resumeState.activeTurnId) {
          return { state: 'busy', activeTurnId: resumeState.activeTurnId };
        }
        const started = await requestBridge.sendRequest('start-turn-for-host', {
          hostId: payload.hostId,
          conversationId: payload.threadId,
          params: {
            clientUserMessageId: payload.clientUserMessageId,
            input: [{ type: 'text', text: payload.prompt, text_elements: [] }],
            commentAttachments: [],
            cwd: payload.cwd,
            model: null,
            effort: null,
            multiAgentMode: 'explicitRequestOnly',
            serviceTier: null,
            useAppServerPermissionDefault: true,
            attachments: [],
          },
        });
        const turnId = started && started.turn && started.turn.id;
        if (!turnId) {
          throw new Error('Codex Desktop 未返回 turn 标识。');
        }
        return { state: 'started', turnId };
      }`,
      objectId: globalResult.result.objectId,
      returnByValue: true,
    });

    if (dispatchResult.exceptionDetails) {
      throw new CodexDesktopBridgeError(`Codex Desktop 投递失败：${cdpExceptionMessage(dispatchResult)}`, {
        code: 'DESKTOP_DISPATCH_FAILED',
      });
    }

    return dispatchResult.result?.value || null;
  } finally {
    client.close();
  }
}

function buildDesktopTurnPayload(task, options = {}) {
  const taskId = Number(task?.task_id);
  const threadId = String(task?.thread_id || '').trim();
  const cwd = String(task?.cwd || '').trim();

  if (!Number.isInteger(taskId) || taskId <= 0 || !threadId || !cwd) {
    throw new CodexDesktopBridgeError('任务缺少桌面投递所需的线程或工作目录。', {
      code: 'DESKTOP_TASK_INVALID',
      retryable: false,
    });
  }

  const createId = options.randomUUID || randomUUID;

  return {
    clientUserMessageId: createId(),
    cwd,
    hostId: 'local',
    prompt: createExecutorPrompt(task.instruction),
    threadId,
  };
}

function createCodexDesktopBridge(options = {}) {
  const discoverPage = options.discoverPage || discoverCodexDesktopPage;
  const invokeTurn = options.invokeTurn || invokeDesktopTurn;
  const environment = options.environment || process.env;

  return {
    async dispatch(task) {
      const payload = buildDesktopTurnPayload(task, options);
      const page = await discoverPage({ ...options, environment });

      if (!page) {
        return { available: false, reason: 'desktop_unavailable' };
      }

      const result = await invokeTurn(page, payload, options);

      if (result?.state === 'busy') {
        throw new CodexDesktopBridgeError('目标 Codex Desktop 线程仍在执行，任务将等待后重试。', {
          code: 'DESKTOP_THREAD_BUSY',
        });
      }

      const turnId = String(result?.turnId || '').trim();

      if (result?.state !== 'started' || !turnId) {
        throw new CodexDesktopBridgeError('Codex Desktop 未确认接收任务。', {
          code: 'DESKTOP_DISPATCH_UNCONFIRMED',
        });
      }

      return {
        available: true,
        threadId: payload.threadId,
        turnId,
      };
    },
  };
}

module.exports = {
  CodexDesktopBridgeError,
  CdpClient,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  buildDesktopTurnPayload,
  createCodexDesktopBridge,
  discoverCodexDesktopPage,
  extractRemoteDebuggingPorts,
  invokeDesktopTurn,
  isTrustedDesktopPage,
  listChatGptCommandLines,
  parseCommandLineOutput,
};
