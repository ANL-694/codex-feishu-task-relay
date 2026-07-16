'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkerControlPipePath } = require('./worker-control.cjs');

class WorkerAlreadyRunningError extends Error {
  constructor(processId) {
    super(`飞书中继已经运行，进程 PID 为 ${processId}。`);
    this.code = 'WORKER_ALREADY_RUNNING';
    this.name = 'WorkerAlreadyRunningError';
    this.processId = processId;
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function isProcessRunning(processId) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function hasWorkerControlMetadata(lock) {
  return (
    typeof lock?.controlToken === 'string' &&
    /^[a-f0-9]{64}$/i.test(lock.controlToken) &&
    typeof lock?.pipe === 'string' &&
    lock.pipe.startsWith('\\\\.\\pipe\\')
  );
}

function getWorkerStatus(lockPath) {
  const lockPresent = fs.existsSync(lockPath);
  const lock = readLock(lockPath);
  const processId = Number(lock?.pid);
  const validProcessId = Number.isInteger(processId) && processId > 0;
  const running = validProcessId && isProcessRunning(processId);
  const startedAt =
    running && typeof lock?.startedAt === 'string' && Number.isFinite(Date.parse(lock.startedAt))
      ? lock.startedAt
      : null;

  return {
    controlAvailable: running && hasWorkerControlMetadata(lock),
    lockPresent,
    pid: running ? processId : null,
    running,
    staleLock: lockPresent && !running,
    startedAt,
  };
}

function acquireWorkerLock(lockPath, options = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const controlToken = options.controlToken || crypto.randomBytes(32).toString('hex');
  const pipe = options.pipe || createWorkerControlPipePath(path.dirname(lockPath));

  if (!/^[a-f0-9]{64}$/i.test(controlToken)) {
    throw new TypeError('worker 控制令牌必须是 32 字节十六进制字符串。');
  }

  if (typeof pipe !== 'string' || !pipe.startsWith('\\\\.\\pipe\\')) {
    throw new TypeError('worker 控制管道必须是 Windows 本地命名管道。');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;

    try {
      descriptor = fs.openSync(lockPath, 'wx');
      const lock = {
        controlToken,
        pid: process.pid,
        pipe,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify(lock)}\n`,
        'utf8',
      );
      fs.closeSync(descriptor);
      descriptor = undefined;
      let released = false;

      const release = () => {
        if (released) {
          return;
        }

        released = true;
        const current = readLock(lockPath);

        if (
          !current ||
          (current.pid === process.pid && current.controlToken === controlToken)
        ) {
          fs.rmSync(lockPath, { force: true });
        }
      };
      release.lock = lock;

      return release;
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }

      if (error.code !== 'EEXIST') {
        throw error;
      }

      const current = readLock(lockPath);

      if (current && isProcessRunning(current.pid)) {
        throw new WorkerAlreadyRunningError(current.pid);
      }

      fs.rmSync(lockPath, { force: true });
    }
  }

  throw new Error('无法获取飞书中继单实例锁。');
}

module.exports = {
  WorkerAlreadyRunningError,
  acquireWorkerLock,
  getWorkerStatus,
  hasWorkerControlMetadata,
  isProcessRunning,
  readLock,
};
