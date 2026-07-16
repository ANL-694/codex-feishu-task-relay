'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const CONTROL_SCHEMA_VERSION = 1;
const DEFAULT_CONTROL_TIMEOUT_MS = 3_000;
const MAX_CONTROL_MESSAGE_BYTES = 16 * 1024;

class WorkerControlError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.code = code;
    this.name = 'WorkerControlError';
  }
}

function createWorkerControlPipePath(projectRoot) {
  const normalizedRoot = path.win32
    .normalize(path.win32.resolve(String(projectRoot || '.')))
    .replace(/[\\/]+$/, '')
    .toLocaleLowerCase('en-US');
  const projectHash = crypto
    .createHash('sha256')
    .update(normalizedRoot, 'utf8')
    .digest('hex')
    .slice(0, 24);

  return `\\\\.\\pipe\\codex-task-relay-${projectHash}`;
}

function tokensMatch(expectedToken, suppliedToken) {
  const expectedDigest = crypto
    .createHash('sha256')
    .update(String(expectedToken || ''), 'utf8')
    .digest();
  const suppliedDigest = crypto
    .createHash('sha256')
    .update(String(suppliedToken || ''), 'utf8')
    .digest();

  return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function createErrorResponse(code, message) {
  return {
    error: { code, message },
    ok: false,
    schemaVersion: CONTROL_SCHEMA_VERSION,
  };
}

function createWorkerControlServer(options) {
  const controlToken = String(options?.controlToken || '');
  const pipe = String(options?.pipe || '');
  const processId = Number(options?.pid || process.pid);
  const onDiagnostic = options?.onDiagnostic || (() => {});
  const onShutdown = options?.onShutdown || (() => {});
  const sockets = new Set();
  let closePromise = null;
  let listening = false;
  let stopping = false;

  if (!pipe) {
    throw new TypeError('worker 控制管道不能为空。');
  }

  if (!controlToken) {
    throw new TypeError('worker 控制令牌不能为空。');
  }

  function respond(socket, response, afterSend) {
    socket.end(`${JSON.stringify(response)}\n`, () => {
      if (!afterSend) {
        return;
      }

      Promise.resolve()
        .then(afterSend)
        .catch((error) => onDiagnostic(`worker 关闭回调失败：${error.message || error}`));
    });
  }

  function handleRequest(socket, request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      respond(socket, createErrorResponse('INVALID_REQUEST', '控制请求必须是 JSON 对象。'));
      return;
    }

    if (!tokensMatch(controlToken, request.controlToken)) {
      respond(socket, createErrorResponse('UNAUTHORIZED', 'worker 控制鉴权失败。'));
      return;
    }

    if (request.command === 'ping') {
      respond(socket, {
        command: 'ping',
        ok: true,
        pid: processId,
        schemaVersion: CONTROL_SCHEMA_VERSION,
        stopping,
      });
      return;
    }

    if (request.command === 'shutdown') {
      const alreadyStopping = stopping;
      stopping = true;
      respond(
        socket,
        {
          alreadyStopping,
          command: 'shutdown',
          ok: true,
          pid: processId,
          schemaVersion: CONTROL_SCHEMA_VERSION,
          stopping: true,
        },
        alreadyStopping ? null : () => onShutdown({ reason: 'control', requestedAt: new Date() }),
      );
      return;
    }

    respond(socket, createErrorResponse('INVALID_COMMAND', '不支持的 worker 控制命令。'));
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;

    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (error) => {
      onDiagnostic(`worker 控制连接错误：${error.message || error}`);
    });
    socket.on('data', (chunk) => {
      if (handled) {
        return;
      }

      buffer += chunk;

      if (Buffer.byteLength(buffer, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) {
        handled = true;
        respond(socket, createErrorResponse('REQUEST_TOO_LARGE', 'worker 控制请求过大。'));
        return;
      }

      const newlineIndex = buffer.indexOf('\n');

      if (newlineIndex < 0) {
        return;
      }

      handled = true;
      const line = buffer.slice(0, newlineIndex).trim();

      try {
        handleRequest(socket, JSON.parse(line));
      } catch {
        respond(socket, createErrorResponse('INVALID_JSON', 'worker 控制请求不是有效 JSON。'));
      }
    });
  });

  async function listen() {
    if (listening) {
      return;
    }

    await new Promise((resolve, reject) => {
      function handleListenError(error) {
        server.off('listening', handleListening);
        reject(error);
      }

      function handleListening() {
        server.off('error', handleListenError);
        listening = true;
        resolve();
      }

      server.once('error', handleListenError);
      server.once('listening', handleListening);
      server.listen(pipe);
    });
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }

    closePromise = new Promise((resolve, reject) => {
      for (const socket of sockets) {
        socket.end();
      }

      if (!server.listening) {
        listening = false;
        resolve();
        return;
      }

      server.close((error) => {
        listening = false;

        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    return closePromise;
  }

  return {
    close,
    get listening() {
      return listening;
    },
    get stopping() {
      return stopping;
    },
    listen,
    pipe,
  };
}

function sendWorkerControlCommand(options) {
  const command = String(options?.command || '');
  const controlToken = String(options?.controlToken || '');
  const pipe = String(options?.pipe || '');
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const socket = net.createConnection({ path: pipe });

    function finish(error, response) {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();

      if (error) {
        reject(error);
        return;
      }

      resolve(response);
    }

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          command,
          controlToken,
          schemaVersion: CONTROL_SCHEMA_VERSION,
        })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      buffer += chunk;

      if (Buffer.byteLength(buffer, 'utf8') > MAX_CONTROL_MESSAGE_BYTES) {
        finish(
          new WorkerControlError(
            'WORKER_CONTROL_PROTOCOL_ERROR',
            'worker 控制响应超过允许大小。',
          ),
        );
        return;
      }

      const newlineIndex = buffer.indexOf('\n');

      if (newlineIndex < 0) {
        return;
      }

      let response;

      try {
        response = JSON.parse(buffer.slice(0, newlineIndex));
      } catch (error) {
        finish(
          new WorkerControlError(
            'WORKER_CONTROL_PROTOCOL_ERROR',
            'worker 控制响应不是有效 JSON。',
            { cause: error },
          ),
        );
        return;
      }

      if (!response?.ok) {
        finish(
          new WorkerControlError(
            response?.error?.code || 'WORKER_CONTROL_REJECTED',
            response?.error?.message || 'worker 拒绝了控制请求。',
          ),
        );
        return;
      }

      finish(null, response);
    });
    socket.once('timeout', () => {
      finish(new WorkerControlError('WORKER_CONTROL_TIMEOUT', 'worker 控制请求超时。'));
    });
    socket.once('error', (error) => {
      finish(
        new WorkerControlError(
          'WORKER_CONTROL_UNAVAILABLE',
          `无法连接 worker 控制管道：${error.message || error}`,
          { cause: error },
        ),
      );
    });
    socket.once('end', () => {
      if (!settled) {
        finish(
          new WorkerControlError(
            'WORKER_CONTROL_PROTOCOL_ERROR',
            'worker 在返回完整控制响应前关闭了连接。',
          ),
        );
      }
    });
  });
}

module.exports = {
  CONTROL_SCHEMA_VERSION,
  DEFAULT_CONTROL_TIMEOUT_MS,
  MAX_CONTROL_MESSAGE_BYTES,
  WorkerControlError,
  createWorkerControlPipePath,
  createWorkerControlServer,
  sendWorkerControlCommand,
  tokensMatch,
};
