'use strict';

const { WORKER_LOCK_PATH } = require('./constants.cjs');
const { createControlStatus } = require('./control-state.cjs');
const { assertFeishuConfigured, ensurePairingCode, readFeishuConfig } = require('./feishu-config.cjs');
const {
  WorkerControlError,
  sendWorkerControlCommand,
} = require('./worker-control.cjs');
const {
  getWorkerStatus,
  hasWorkerControlMetadata,
  isProcessRunning,
  readLock,
} = require('./worker-lock.cjs');
const { startWorker } = require('./worker-launcher.cjs');

const DEFAULT_STOP_TIMEOUT_MS = 10_000;

function validateFeishuSetup() {
  return assertFeishuConfigured(ensurePairingCode(readFeishuConfig()));
}

function writeJson(value, output = process.stdout) {
  output.write(`${JSON.stringify(value)}\n`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForWorkerExit(lock, options = {}) {
  const isRunning = options.isProcessRunning || isProcessRunning;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (isRunning(Number(lock.pid))) {
    if (Date.now() >= deadline) {
      throw new WorkerControlError(
        'WORKER_STOP_TIMEOUT',
        `等待飞书中继 PID ${lock.pid} 优雅退出超时。`,
      );
    }

    await (options.wait || wait)(pollIntervalMs);
  }
}

async function stopWorker(options = {}) {
  const lockPath = options.lockPath || WORKER_LOCK_PATH;
  const statusReader = options.getWorkerStatus || getWorkerStatus;
  const lockReader = options.readLock || readLock;
  const sendCommand = options.sendCommand || sendWorkerControlCommand;
  const status = statusReader(lockPath);

  if (!status.running) {
    return {
      alreadyStopped: true,
      alreadyStopping: false,
      stopped: false,
      worker: status,
    };
  }

  const lock = lockReader(lockPath);

  if (!hasWorkerControlMetadata(lock)) {
    throw new WorkerControlError(
      'WORKER_CONTROL_UNAVAILABLE',
      '当前运行中的 worker 使用旧版锁，缺少经过鉴权的控制管道；为避免误伤其他进程，已拒绝停止。',
    );
  }

  const controlOptions = {
    controlToken: lock.controlToken,
    pipe: lock.pipe,
    timeoutMs: options.controlTimeoutMs,
  };
  const ping = await sendCommand({ ...controlOptions, command: 'ping' });

  if (Number(ping.pid) !== Number(lock.pid)) {
    throw new WorkerControlError(
      'WORKER_CONTROL_IDENTITY_MISMATCH',
      'worker 控制管道返回的 PID 与锁文件不一致，已拒绝停止。',
    );
  }

  const currentLock = lockReader(lockPath);

  if (
    !currentLock ||
    currentLock.pid !== lock.pid ||
    currentLock.controlToken !== lock.controlToken ||
    currentLock.pipe !== lock.pipe
  ) {
    throw new WorkerControlError(
      'WORKER_CONTROL_INSTANCE_CHANGED',
      'worker 实例在停止确认期间发生变化，已拒绝向新实例发送停止命令。',
    );
  }

  const shutdown = await sendCommand({ ...controlOptions, command: 'shutdown' });

  if (Number(shutdown.pid) !== Number(lock.pid)) {
    throw new WorkerControlError(
      'WORKER_CONTROL_IDENTITY_MISMATCH',
      'worker 停止响应的 PID 与锁文件不一致。',
    );
  }

  await (options.waitForWorkerExit || waitForWorkerExit)(lock, {
    isProcessRunning: options.isProcessRunning,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs,
    wait: options.wait,
  });

  return {
    alreadyStopped: false,
    alreadyStopping: Boolean(shutdown.alreadyStopping),
    stopped: true,
    worker: statusReader(lockPath),
  };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const command = argv[0];
  const diagnostics = dependencies.diagnostics || ((message) => console.error(message));
  const statusFactory =
    dependencies.statusFactory ||
    (() => createControlStatus({ onDiagnostic: diagnostics }));

  if (command === 'status') {
    return statusFactory();
  }

  if (command === 'start') {
    (dependencies.validateFeishuSetup || validateFeishuSetup)();
    const result = await (dependencies.startWorker || startWorker)();

    return {
      ...statusFactory(),
      alreadyRunning: result.alreadyRunning,
      command: 'start',
      started: result.started,
    };
  }

  if (command === 'stop') {
    const result = await (dependencies.stopWorker || stopWorker)();

    return {
      ...statusFactory(),
      alreadyStopped: result.alreadyStopped,
      alreadyStopping: result.alreadyStopping,
      command: 'stop',
      stopped: result.stopped,
    };
  }

  const error = new Error('用法：node --no-warnings src/control.cjs <status|start|stop>');
  error.code = 'INVALID_COMMAND';
  throw error;
}

if (require.main === module) {
  main()
    .then((result) => writeJson(result))
    .catch((error) => {
      console.error(`控制命令失败：${error.message || error}`);
      writeJson({
        command: process.argv[2] || null,
        error: {
          code: error.code || 'CONTROL_ERROR',
          message: error.message || String(error),
        },
        ok: false,
        schemaVersion: 1,
      });
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_STOP_TIMEOUT_MS,
  main,
  stopWorker,
  validateFeishuSetup,
  waitForWorkerExit,
  writeJson,
};
