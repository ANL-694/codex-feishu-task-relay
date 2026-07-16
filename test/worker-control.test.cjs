'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { main: controlMain, stopWorker } = require('../src/control.cjs');
const {
  createWorkerControlPipePath,
  createWorkerControlServer,
  sendWorkerControlCommand,
} = require('../src/worker-control.cjs');
const {
  acquireWorkerLock,
  getWorkerStatus,
} = require('../src/worker-lock.cjs');

test('命名管道按 Windows 项目路径稳定生成', () => {
  const first = createWorkerControlPipePath('E:\\codex-feishu-task-relay');
  const samePath = createWorkerControlPipePath('e:\\codex-feishu-task-relay\\');
  const other = createWorkerControlPipePath('E:\\其他项目');

  assert.equal(first, samePath);
  assert.notEqual(first, other);
  assert.match(first, /^\\\\\.\\pipe\\codex-task-relay-[a-f0-9]{24}$/);
});

test('控制管道鉴权并支持 ping、停止和重复停止', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-worker-ipc-'));
  const pipe = createWorkerControlPipePath(temporaryDirectory);
  const controlToken = 'a'.repeat(64);
  let shutdownCalls = 0;
  let confirmShutdown;
  const shutdownCalled = new Promise((resolve) => {
    confirmShutdown = resolve;
  });
  const server = createWorkerControlServer({
    controlToken,
    onShutdown() {
      shutdownCalls += 1;
      confirmShutdown();
    },
    pid: 43210,
    pipe,
  });

  try {
    await server.listen();

    await assert.rejects(
      sendWorkerControlCommand({
        command: 'shutdown',
        controlToken: 'b'.repeat(64),
        pipe,
      }),
      (error) => error.code === 'UNAUTHORIZED',
    );
    assert.equal(shutdownCalls, 0);

    const running = await sendWorkerControlCommand({
      command: 'ping',
      controlToken,
      pipe,
    });
    assert.deepEqual(
      {
        command: running.command,
        pid: running.pid,
        stopping: running.stopping,
      },
      { command: 'ping', pid: 43210, stopping: false },
    );

    const firstStop = await sendWorkerControlCommand({
      command: 'shutdown',
      controlToken,
      pipe,
    });
    await shutdownCalled;
    assert.equal(firstStop.alreadyStopping, false);
    assert.equal(shutdownCalls, 1);

    const secondStop = await sendWorkerControlCommand({
      command: 'shutdown',
      controlToken,
      pipe,
    });
    const stopping = await sendWorkerControlCommand({
      command: 'ping',
      controlToken,
      pipe,
    });
    assert.equal(secondStop.alreadyStopping, true);
    assert.equal(stopping.stopping, true);
    assert.equal(shutdownCalls, 1);
  } finally {
    await server.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('worker 锁写入随机控制令牌且状态不泄露令牌', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-worker-lock-'));
  const lockPath = path.join(temporaryDirectory, 'worker.lock');
  const pipe = createWorkerControlPipePath(temporaryDirectory);
  const release = acquireWorkerLock(lockPath, { pipe });

  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const status = getWorkerStatus(lockPath);

    assert.match(lock.controlToken, /^[a-f0-9]{64}$/);
    assert.equal(lock.pipe, pipe);
    assert.equal(status.running, true);
    assert.equal(status.controlAvailable, true);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(lock.controlToken));
  } finally {
    release();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('stop 先 ping 核验实例，再停止并等待退出', async () => {
  const lock = {
    controlToken: 'c'.repeat(64),
    pid: 24680,
    pipe: createWorkerControlPipePath('E:\\codex-feishu-task-relay'),
    startedAt: '2026-07-16T10:00:00.000Z',
  };
  const commands = [];
  let running = true;
  const options = {
    getWorkerStatus() {
      return {
        controlAvailable: running,
        lockPresent: running,
        pid: running ? lock.pid : null,
        running,
        staleLock: false,
        startedAt: running ? lock.startedAt : null,
      };
    },
    readLock() {
      return lock;
    },
    async sendCommand(request) {
      commands.push(request.command);
      return {
        alreadyStopping: false,
        command: request.command,
        ok: true,
        pid: lock.pid,
      };
    },
    async waitForWorkerExit() {
      running = false;
    },
  };

  const stopped = await stopWorker(options);
  const repeated = await stopWorker(options);

  assert.deepEqual(commands, ['ping', 'shutdown']);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.alreadyStopped, false);
  assert.equal(repeated.stopped, false);
  assert.equal(repeated.alreadyStopped, true);
});

test('运行中的旧版锁缺少鉴权信息时安全拒绝停止', async () => {
  const lock = {
    pid: 13579,
    startedAt: '2026-07-16T10:00:00.000Z',
  };

  await assert.rejects(
    stopWorker({
      getWorkerStatus() {
        return {
          controlAvailable: false,
          lockPresent: true,
          pid: lock.pid,
          running: true,
          staleLock: false,
          startedAt: lock.startedAt,
        };
      },
      readLock() {
        return lock;
      },
    }),
    (error) => error.code === 'WORKER_CONTROL_UNAVAILABLE' && /避免误伤/.test(error.message),
  );
});

test('control stop 返回停止后的统一状态结构', async () => {
  const status = {
    command: 'status',
    ok: true,
    schemaVersion: 1,
    worker: { controlAvailable: false, pid: null, running: false },
  };
  const result = await controlMain(['stop'], {
    statusFactory: () => status,
    stopWorker: async () => ({
      alreadyStopped: false,
      alreadyStopping: false,
      stopped: true,
    }),
  });

  assert.deepEqual(result, {
    ...status,
    alreadyStopped: false,
    alreadyStopping: false,
    command: 'stop',
    stopped: true,
  });
});
