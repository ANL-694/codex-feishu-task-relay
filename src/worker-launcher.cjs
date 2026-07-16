'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  PROJECT_ROOT,
  WORKER_LOCK_PATH,
  WORKER_SCRIPT_PATH,
  WORKER_START_LOCK_PATH,
  WORKER_STDERR_LOG_PATH,
  WORKER_STDOUT_LOG_PATH,
} = require('./constants.cjs');
const { getWorkerStatus, isProcessRunning, readLock } = require('./worker-lock.cjs');

const DEFAULT_START_TIMEOUT_MS = 10_000;
const LOG_ARCHIVE_LIMIT = 5;

class WorkerStartError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'WorkerStartError';
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatLogTimestamp(now = new Date()) {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}Z$/, '');
}

function rotateLog(logPath, options = {}) {
  const archiveLimit = options.archiveLimit ?? LOG_ARCHIVE_LIMIT;
  const directory = path.dirname(logPath);
  const extension = '.previous.log';
  const archivePrefix = `${path.basename(logPath, '.log')}.`;
  let archivedPath = null;

  fs.mkdirSync(directory, { recursive: true });

  if (fs.existsSync(logPath)) {
    const timestamp = formatLogTimestamp(options.now || new Date());
    let candidate = path.join(directory, `${archivePrefix}${timestamp}${extension}`);
    let suffix = 1;

    while (fs.existsSync(candidate)) {
      candidate = path.join(directory, `${archivePrefix}${timestamp}-${suffix}${extension}`);
      suffix += 1;
    }

    fs.renameSync(logPath, candidate);
    archivedPath = candidate;
  }

  const archives = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(archivePrefix) &&
        entry.name.endsWith(extension),
    )
    .map((entry) => {
      const archivePath = path.join(directory, entry.name);
      return { archivePath, modifiedAt: fs.statSync(archivePath).mtimeMs };
    })
    .sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        right.archivePath.localeCompare(left.archivePath, 'en-US'),
    );

  for (const archive of archives.slice(Math.max(archiveLimit, 0))) {
    fs.rmSync(archive.archivePath, { force: true });
  }

  return archivedPath;
}

function tryAcquireStartLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;

    try {
      descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        'utf8',
      );
      fs.closeSync(descriptor);
      descriptor = undefined;

      return () => {
        const current = readLock(lockPath);

        if (!current || current.pid === process.pid) {
          fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }

      if (error.code !== 'EEXIST') {
        throw error;
      }

      const current = readLock(lockPath);

      if (current && isProcessRunning(Number(current.pid))) {
        return null;
      }

      fs.rmSync(lockPath, { force: true });
    }
  }

  return null;
}

async function acquireStartSlot(options = {}) {
  const lockPath = options.lockPath || WORKER_START_LOCK_PATH;
  const workerLockPath = options.workerLockPath || WORKER_LOCK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const worker = getWorkerStatus(workerLockPath);

    if (worker.running) {
      return { release: null, worker };
    }

    const release = tryAcquireStartLock(lockPath);

    if (release) {
      return { release, worker: null };
    }

    if (Date.now() >= deadline) {
      throw new WorkerStartError('WORKER_START_BUSY', '另一个启动请求仍在处理中。');
    }

    await wait(100);
  }
}

async function waitForWorkerConfirmation(child, options = {}) {
  const workerLockPath = options.workerLockPath || WORKER_LOCK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let childError = null;
  let childExit = null;

  child.once('error', (error) => {
    childError = error;
  });
  child.once('exit', (code, signal) => {
    childExit = { code, signal };
  });

  for (;;) {
    if (childError) {
      throw new WorkerStartError('WORKER_SPAWN_FAILED', `无法启动飞书中继：${childError.message}`);
    }

    const worker = getWorkerStatus(workerLockPath);

    if (worker.running) {
      return {
        alreadyRunning: worker.pid !== child.pid,
        started: worker.pid === child.pid,
        worker,
      };
    }

    if (childExit) {
      throw new WorkerStartError(
        'WORKER_EXITED',
        `飞书中继在启动确认前退出（code=${childExit.code}, signal=${childExit.signal}）。`,
      );
    }

    if (Date.now() >= deadline) {
      throw new WorkerStartError('WORKER_START_TIMEOUT', '等待飞书中继启动确认超时。');
    }

    await wait(100);
  }
}

async function startWorker(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const workerLockPath = options.workerLockPath || WORKER_LOCK_PATH;
  const slot = await acquireStartSlot({
    lockPath: options.startLockPath || WORKER_START_LOCK_PATH,
    timeoutMs,
    workerLockPath,
  });

  if (slot.worker) {
    return { alreadyRunning: true, started: false, worker: slot.worker };
  }

  try {
    const workerAfterLock = getWorkerStatus(workerLockPath);

    if (workerAfterLock.running) {
      return { alreadyRunning: true, started: false, worker: workerAfterLock };
    }

    const stdoutLogPath = options.stdoutLogPath || WORKER_STDOUT_LOG_PATH;
    const stderrLogPath = options.stderrLogPath || WORKER_STDERR_LOG_PATH;
    rotateLog(stdoutLogPath, options.logRotation);
    rotateLog(stderrLogPath, options.logRotation);

    const stdoutDescriptor = fs.openSync(stdoutLogPath, 'a');
    const stderrDescriptor = fs.openSync(stderrLogPath, 'a');
    let child;

    try {
      child = (options.spawn || spawn)(
        options.nodePath || process.execPath,
        ['--no-warnings', options.workerScriptPath || WORKER_SCRIPT_PATH],
        {
          cwd: options.projectRoot || PROJECT_ROOT,
          detached: true,
          env: options.environment || process.env,
          stdio: ['ignore', stdoutDescriptor, stderrDescriptor],
          windowsHide: true,
        },
      );
    } finally {
      fs.closeSync(stdoutDescriptor);
      fs.closeSync(stderrDescriptor);
    }

    child.unref();

    return await waitForWorkerConfirmation(child, { timeoutMs, workerLockPath });
  } finally {
    slot.release();
  }
}

module.exports = {
  LOG_ARCHIVE_LIMIT,
  WorkerStartError,
  acquireStartSlot,
  formatLogTimestamp,
  rotateLog,
  startWorker,
  tryAcquireStartLock,
  waitForWorkerConfirmation,
};
