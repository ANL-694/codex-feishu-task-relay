'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { main: processCodexNotification } = require('../src/codex-notify.cjs');
const { main: controlMain, writeJson } = require('../src/control.cjs');
const { buildFeishuStatus, detectHookInstalled } = require('../src/control-state.cjs');
const { formatCompletion } = require('../src/formatters.cjs');
const { handleIncomingText } = require('../src/message-router.cjs');
const { normalizeConfig, resolveProjectByCwd } = require('../src/runtime-config.cjs');
const { createStore } = require('../src/store.cjs');
const {
  readThreadTitle,
  resolveThreadTitle,
  subagentThreadTitle,
} = require('../src/thread-title.cjs');
const { acquireWorkerLock } = require('../src/worker-lock.cjs');
const {
  rotateLog,
  startWorker,
  waitForWorkerConfirmation,
} = require('../src/worker-launcher.cjs');

function makeConfig() {
  return normalizeConfig({
    ownerUserIds: ['owner-1'],
    projects: [
      {
        aliases: ['bds'],
        cwdPrefixes: ['E:\\workspace\\BDS'],
        id: 'bds',
        name: 'BDS',
      },
    ],
  });
}

function withStore(run) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-'));
  const store = createStore(path.join(temporaryDirectory, 'relay.sqlite'));

  try {
    return run(store);
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

test('按最长工作目录前缀匹配项目', () => {
  const config = makeConfig();
  const project = resolveProjectByCwd('E:\\workspace\\BDS\\plugins\\AdventureCore', config);

  assert.equal(project.id, 'bds');
});

test('完成摘要保留原文并按 thread 和 turn 去重', () =>
  withStore((store) => {
    const input = {
      cwd: 'E:\\workspace\\BDS',
      finalMessage: '已完成修复，并通过验证。',
      projectId: 'bds',
      projectName: 'BDS',
      threadId: 'thread-1',
      turnId: 'turn-1',
    };
    const first = store.recordCompletion(input);
    const second = store.recordCompletion(input);

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.match(formatCompletion(first.completion), /已完成修复，并通过验证。/);
  }));

test('状态接口精确统计全部待推送摘要和待处理任务', () =>
  withStore((store) => {
    const firstCompletion = store.recordCompletion({
      cwd: 'E:\\workspace\\first',
      finalMessage: '第一条摘要',
      projectId: 'thread:first',
      projectName: '第一条线程',
      threadId: 'first',
      turnId: 'first-turn',
    }).completion;
    store.recordCompletion({
      cwd: 'E:\\workspace\\second',
      finalMessage: '第二条摘要',
      projectId: 'thread:second',
      projectName: '第二条线程',
      threadId: 'second',
      turnId: 'second-turn',
    });
    store.markCompletionSent(firstCompletion.completion_id);
    const firstTask = store.createTask({
      completionId: firstCompletion.completion_id,
      instruction: '继续第一步',
      projectId: 'thread:first',
      projectName: '第一条线程',
      sourceUserId: 'owner-1',
    });
    store.createTask({
      instruction: '继续第二步',
      projectId: 'thread:second',
      projectName: '第二条线程',
      sourceUserId: 'owner-1',
    });
    store.markTaskDone(firstTask.task_id);

    assert.deepEqual(store.getQueueCounts(), {
      failedTasks: 0,
      pendingTasks: 1,
      queuedCompletions: 1,
      runningTasks: 0,
    });
  }));

test('任务列表隐藏已完成任务但保留历史记录', () =>
  withStore((store) => {
    const completedTask = store.createTask({
      instruction: '已经执行完成',
      projectId: 'thread:completed-thread',
      projectName: '已完成线程',
      sourceUserId: 'owner-1',
      threadId: 'completed-thread',
    });
    const pendingTask = store.createTask({
      instruction: '仍需继续处理',
      projectId: 'thread:pending-thread',
      projectName: '待处理线程',
      sourceUserId: 'owner-1',
      threadId: 'pending-thread',
    });
    store.markTaskDone(completedTask.task_id);

    const result = handleIncomingText({
      config: makeConfig(),
      message: { text: '/任务', userId: 'owner-1' },
      store,
    });

    assert.equal(result.reply.includes(`T-${completedTask.task_id} ·`), false);
    assert.match(result.reply, new RegExp(`T-${pendingTask.task_id} · 待处理线程 · pending`));
    assert.equal(store.listTasks().length, 2);
    assert.equal(store.getTask(completedTask.task_id).status, 'done');
  }));

test('任务列表忽略没有真实线程绑定的旧示例任务', () =>
  withStore((store) => {
    const legacyTask = store.createTask({
      instruction: '旧版示例指令',
      projectId: 'bds',
      projectName: 'BDS',
      sourceUserId: 'owner-1',
    });
    const threadTask = store.createTask({
      instruction: '真实线程待处理指令',
      projectId: 'thread:real-thread',
      projectName: '真实对话',
      sourceUserId: 'owner-1',
      threadId: 'real-thread',
    });

    const result = handleIncomingText({
      config: makeConfig(),
      message: { text: '/任务', userId: 'owner-1' },
      store,
    });

    assert.equal(result.reply.includes(`T-${legacyTask.task_id} ·`), false);
    assert.match(result.reply, new RegExp(`T-${threadTask.task_id} · 真实对话 · pending`));
    assert.equal(store.listTasks().length, 2);
  }));

test('控制状态不暴露飞书凭据和 owner 标识', () => {
  const status = buildFeishuStatus({
    config: {
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret-credential-token',
      ownerOpenId: 'ou-owner-1',
      pairingCode: 'relay-secret-code',
    },
    status: { state: 'connected' },
    statusUpdatedAt: '2026-07-16T09:00:00.000Z',
    workerRunning: true,
  });

  assert.deepEqual(status, {
    configured: true,
    online: true,
    ownerConfigured: true,
    pairingCode: null,
    state: 'connected',
    statusUpdatedAt: '2026-07-16T09:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(status), /secret-|ou-owner-1/);
});

test('飞书在线状态要求 worker 正在运行且长连接已连接', () => {
  const config = { appId: 'cli_0123456789abcdef', appSecret: 'secret' };

  assert.equal(
    buildFeishuStatus({ config, status: { state: 'connecting' }, workerRunning: true }).online,
    false,
  );
  assert.equal(
    buildFeishuStatus({ config, status: { state: 'connected' }, workerRunning: false }).online,
    false,
  );
});

test('控制状态按 Codex 顶层 notify 判断真实 hook', () => {
  const relayScript = 'E:\\codex-feishu-task-relay\\src\\codex-notify.cjs';
  const installed = `${JSON.stringify(['node', '--no-warnings', relayScript])}\n[features]\nflag = true\n`;
  const nestedOnly = `[features]\nnotify = ${JSON.stringify(['node', relayScript])}\n`;

  assert.equal(detectHookInstalled(`notify = ${installed}`, relayScript), true);
  assert.equal(detectHookInstalled(nestedOnly, relayScript), false);
});

test('控制 start 返回与 status 同构的单行 JSON', async () => {
  const baseStatus = {
    command: 'status',
    ok: true,
    schemaVersion: 1,
    worker: { pid: 123, running: true, startedAt: '2026-07-16T09:00:00.000Z' },
  };
  const result = await controlMain(['start'], {
    validateFeishuSetup() {},
    startWorker: async () => ({ alreadyRunning: false, started: true }),
    statusFactory: () => baseStatus,
  });
  let output = '';

  writeJson(result, {
    write(value) {
      output += value;
    },
  });

  assert.equal(output.split('\n').length, 2);
  assert.deepEqual(JSON.parse(output.trim()), {
    ...baseStatus,
    alreadyRunning: false,
    command: 'start',
    started: true,
  });
});

test('worker 日志启动前轮换并保留限定数量', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-logs-'));
  const logPath = path.join(temporaryDirectory, 'relay-worker.stdout.log');

  try {
    fs.writeFileSync(logPath, '第一轮日志', 'utf8');
    const firstArchive = rotateLog(logPath, {
      archiveLimit: 1,
      now: new Date('2026-07-16T09:00:00.000Z'),
    });
    fs.writeFileSync(logPath, '第二轮日志', 'utf8');
    const secondArchive = rotateLog(logPath, {
      archiveLimit: 1,
      now: new Date('2026-07-16T09:01:00.000Z'),
    });

    assert.equal(fs.existsSync(firstArchive), false);
    assert.equal(fs.readFileSync(secondArchive, 'utf8'), '第二轮日志');
    assert.equal(fs.existsSync(logPath), false);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('worker 启动器等待单实例锁作为启动确认', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-start-'));
  const workerLockPath = path.join(temporaryDirectory, 'worker.lock');
  const child = new EventEmitter();
  child.pid = process.pid;

  try {
    fs.writeFileSync(
      workerLockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: '2026-07-16T09:00:00.000Z' })}\n`,
      'utf8',
    );
    const result = await waitForWorkerConfirmation(child, {
      timeoutMs: 500,
      workerLockPath,
    });

    assert.equal(result.started, true);
    assert.equal(result.alreadyRunning, false);
    assert.equal(result.worker.pid, process.pid);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('worker 已运行时 start 不创建第二个进程', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-single-'));
  const workerLockPath = path.join(temporaryDirectory, 'worker.lock');
  let spawnCalled = false;

  try {
    fs.writeFileSync(
      workerLockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: '2026-07-16T09:00:00.000Z' })}\n`,
      'utf8',
    );
    const result = await startWorker({
      spawn() {
        spawnCalled = true;
      },
      startLockPath: path.join(temporaryDirectory, 'start.lock'),
      stderrLogPath: path.join(temporaryDirectory, 'stderr.log'),
      stdoutLogPath: path.join(temporaryDirectory, 'stdout.log'),
      timeoutMs: 500,
      workerLockPath,
    });

    assert.equal(result.started, false);
    assert.equal(result.alreadyRunning, true);
    assert.equal(spawnCalled, false);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('worker start 使用隐藏 detached 进程并重定向标准日志', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-spawn-'));
  const workerLockPath = path.join(temporaryDirectory, 'worker.lock');
  const workerScriptPath = path.join(temporaryDirectory, 'worker.cjs');
  const stdoutLogPath = path.join(temporaryDirectory, 'stdout.log');
  const stderrLogPath = path.join(temporaryDirectory, 'stderr.log');
  let spawnCall;
  let unrefCalled = false;

  try {
    const result = await startWorker({
      nodePath: 'node-test.exe',
      projectRoot: temporaryDirectory,
      spawn(nodePath, args, spawnOptions) {
        spawnCall = { args, nodePath, spawnOptions };
        fs.writeFileSync(
          workerLockPath,
          `${JSON.stringify({ pid: process.pid, startedAt: '2026-07-16T09:00:00.000Z' })}\n`,
          'utf8',
        );
        const child = new EventEmitter();
        child.pid = process.pid;
        child.unref = () => {
          unrefCalled = true;
        };
        return child;
      },
      startLockPath: path.join(temporaryDirectory, 'start.lock'),
      stderrLogPath,
      stdoutLogPath,
      timeoutMs: 500,
      workerLockPath,
      workerScriptPath,
    });

    assert.equal(result.started, true);
    assert.equal(unrefCalled, true);
    assert.equal(spawnCall.nodePath, 'node-test.exe');
    assert.deepEqual(spawnCall.args, ['--no-warnings', workerScriptPath]);
    assert.equal(spawnCall.spawnOptions.cwd, temporaryDirectory);
    assert.equal(spawnCall.spawnOptions.detached, true);
    assert.equal(spawnCall.spawnOptions.windowsHide, true);
    assert.equal(spawnCall.spawnOptions.stdio[0], 'ignore');
    assert.equal(Number.isInteger(spawnCall.spawnOptions.stdio[1]), true);
    assert.equal(Number.isInteger(spawnCall.spawnOptions.stdio[2]), true);
    assert.equal(fs.existsSync(stdoutLogPath), true);
    assert.equal(fs.existsSync(stderrLogPath), true);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('Codex notify 读取所有目录的完成事件并绑定线程标题', () =>
  withStore((store) => {
    const config = makeConfig();
    store.createTask({
      cwd: 'E:\\任意目录\\未配置项目',
      instruction: '执行验证',
      projectId: 'thread:thread-2',
      projectName: '飞书中继联调',
      sourceUserId: 'owner-1',
      threadId: 'thread-2',
    });
    store.claimNextExecutableTask({
      leaseOwner: 'executor-test',
      now: '2026-07-17T00:00:00.000Z',
    });
    const result = processCodexNotification(
      [
        JSON.stringify({
          cwd: 'E:\\任意目录\\未配置项目',
          'input-messages': ['执行验证'],
          'last-assistant-message': '最终摘要：校验已通过。',
          'thread-id': 'thread-2',
          'turn-id': 'turn-2',
          type: 'agent-turn-complete',
        }),
      ],
      {
        config,
        environment: { CODEX_RELAY_EXECUTOR_TASK_ID: '1' },
        resolveThreadTitle: () => '飞书中继联调',
        store,
      },
    );

    assert.equal(result.inserted, true);
    assert.equal(result.completion.final_message, '最终摘要：校验已通过。');
    assert.equal(result.completion.project_id, 'thread:thread-2');
    assert.equal(result.completion.project_name, '飞书中继联调');
    assert.equal(result.completion.executor_task_id, 1);
  }));

test('新建任务的 Hook 优先使用飞书指定名称', () =>
  withStore((store) => {
    store.createTask({
      cwd: 'E:\\Codex临时任务\\task-1',
      executionMode: 'new',
      instruction: '先调研可行性',
      projectId: 'new:task-1',
      projectName: '新项目想法',
      sourceUserId: 'owner-1',
    });
    store.claimNextExecutableTask({
      leaseOwner: 'executor-test',
      now: '2026-07-17T00:00:00.000Z',
    });

    const result = processCodexNotification(
      [
        JSON.stringify({
          cwd: 'E:\\Codex临时任务\\task-1',
          'input-messages': ['先调研可行性'],
          'last-assistant-message': '已给出最小方案。',
          'thread-id': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          'turn-id': 'new-task-turn',
          type: 'agent-turn-complete',
        }),
      ],
      {
        environment: { CODEX_RELAY_EXECUTOR_TASK_ID: '1' },
        resolveThreadTitle: () => '自动生成的其他标题',
        store,
      },
    );

    assert.equal(result.completion.project_name, '新项目想法');
    assert.equal(result.completion.project_id, 'thread:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.equal(result.completion.executor_task_id, null);
  }));

test('Codex notify 为子代理生成父任务可回复名称且不占用父执行器结果', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subagent-notify-'));
  const sessionIndexPath = path.join(temporaryDirectory, 'session_index.jsonl');
  const sessionsDirectory = path.join(temporaryDirectory, 'sessions');
  const parentThreadId = '33333333-3333-4333-8333-333333333333';
  const childThreadId = '44444444-4444-4444-8444-444444444444';
  const childDirectory = path.join(sessionsDirectory, '2026', '07', '17');
  const childSessionPath = path.join(
    childDirectory,
    `rollout-2026-07-17T00-00-00-${childThreadId}.jsonl`,
  );
  const store = createStore(path.join(temporaryDirectory, 'relay.sqlite'));

  try {
    fs.mkdirSync(childDirectory, { recursive: true });
    fs.writeFileSync(
      sessionIndexPath,
      `${JSON.stringify({ id: parentThreadId, thread_name: 'anl code' })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      childSessionPath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: 'E:\\workweb',
          parent_thread_id: parentThreadId,
          thread_source: 'subagent',
        },
      })}\n`,
      'utf8',
    );
    store.createTask({
      cwd: 'E:\\workweb',
      instruction: '继续父任务',
      projectId: `thread:${parentThreadId}`,
      projectName: 'anl code',
      sourceUserId: 'owner-1',
      threadId: parentThreadId,
    });

    const result = processCodexNotification(
      [
        JSON.stringify({
          cwd: 'E:\\workweb',
          'input-messages': ['内部提示词不应进入标题'],
          'last-assistant-message': '子任务已完成。',
          'thread-id': childThreadId,
          'turn-id': 'child-turn',
          type: 'agent-turn-complete',
        }),
      ],
      {
        environment: { CODEX_RELAY_EXECUTOR_TASK_ID: '1' },
        sessionIndexPath,
        sessionsDirectory,
        store,
      },
    );

    assert.equal(result.inserted, true);
    assert.equal(result.completion.project_name, 'anl code / 子任务·44444444');
    assert.equal(result.completion.thread_id, childThreadId);
    assert.equal(result.completion.executor_task_id, null);
    assert.doesNotMatch(result.completion.project_name, /内部提示词/);

    const followUp = handleIncomingText({
      config: makeConfig(),
      message: {
        text: 'anl code / 子任务·44444444：继续检查',
        userId: 'owner-1',
      },
      store,
    });

    assert.equal(followUp.task.thread_id, childThreadId);
    assert.equal(followUp.task.project_id, `thread:${childThreadId}`);
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('Codex notify 忽略没有侧栏标题的内部任务', () =>
  withStore((store) => {
    const result = processCodexNotification(
      [
        JSON.stringify({
          cwd: 'E:\\内部任务',
          'input-messages': ['内部提示词'],
          'last-assistant-message': '内部结果',
          'thread-id': 'internal-thread',
          'turn-id': 'internal-turn',
          type: 'agent-turn-complete',
        }),
      ],
      { resolveThreadTitle: () => null, store },
    );

    assert.equal(result.ignored, true);
    assert.equal(store.listQueuedCompletions().length, 0);
  }));

test('仅授权用户可以按线程名字回复并写入任务队列', () =>
  withStore((store) => {
    const config = makeConfig();
    store.recordCompletion({
      cwd: 'E:\\workspace\\BDS',
      finalMessage: '线程任务已完成。',
      projectId: 'thread:thread-3',
      projectName: 'BDS 联调线程',
      threadId: 'thread-3',
      turnId: 'turn-3',
    });
    const denied = handleIncomingText({
      config,
      message: { text: 'BDS 联调线程: 继续', userId: 'visitor' },
      store,
    });
    const accepted = handleIncomingText({
      config,
      message: { text: 'BDS 联调线程: 继续做下一步', userId: 'owner-1' },
      store,
    });

    assert.equal(denied.reply, '当前飞书机器人未授权。');
    assert.match(accepted.reply, /已收录 T-1 到「BDS 联调线程」/);
    assert.match(accepted.reply, /优先显示在对应线程/);
    assert.equal(store.listTasks('thread:thread-3').length, 1);
  }));

test('未授权消息不持久化原文', () =>
  withStore((store) => {
    const denied = handleIncomingText({
      config: makeConfig(),
      message: { text: '这段内容不应落库', userId: 'visitor' },
      store,
    });
    const candidate = store.listUnauthorizedUsers()[0];

    assert.equal(denied.reply, '当前飞书机器人未授权。');
    assert.equal(candidate.user_id, 'visitor');
    assert.equal(Object.hasOwn(candidate, 'last_message'), false);
  }));

test('授权用户可用新建命令创建隔离任务且未授权用户不会创建目录', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-new-command-'));
  const store = createStore(path.join(temporaryDirectory, 'relay.sqlite'));
  let createCalls = 0;
  const createWorkspace = () => {
    createCalls += 1;
    const workspace = path.join(temporaryDirectory, `workspace-${createCalls}`);
    fs.mkdirSync(workspace);
    return {
      id: `12345678-1234-1234-1234-123456789ab${createCalls}`,
      workspace,
    };
  };

  try {
    const denied = handleIncomingText({
      config: makeConfig(),
      createWorkspace,
      message: {
        text: '/新建 新项目想法：先调研可行性并给出最小方案',
        userId: 'visitor',
      },
      store,
    });
    const accepted = handleIncomingText({
      config: makeConfig(),
      createWorkspace,
      message: {
        text: '/新建 新项目想法：先调研可行性并给出最小方案',
        userId: 'owner-1',
      },
      store,
    });

    assert.equal(denied.reply, '当前飞书机器人未授权。');
    assert.equal(createCalls, 1);
    assert.match(accepted.reply, /已新建 T-1「新项目想法」/);
    assert.match(accepted.reply, /优先显示在对应线程/);
    assert.equal(accepted.task.execution_mode, 'new');
    assert.equal(accepted.task.thread_id, null);
    assert.match(accepted.task.project_id, /^new:/);
    assert.equal(accepted.task.cwd, path.join(temporaryDirectory, 'workspace-1'));
    assert.equal(store.getQueueCounts().pendingTasks, 1);

    const taskList = handleIncomingText({
      config: makeConfig(),
      message: { text: '/任务', userId: 'owner-1' },
      store,
    });
    assert.match(taskList.reply, /T-1 · 新项目想法 · pending/);
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('新建命令格式错误或隔离目录创建失败时不落库', () =>
  withStore((store) => {
    const malformed = handleIncomingText({
      config: makeConfig(),
      message: { text: '/新建 缺少分隔符', userId: 'owner-1' },
      store,
    });
    const failed = handleIncomingText({
      config: makeConfig(),
      createWorkspace() {
        throw new Error('磁盘不可用');
      },
      message: { text: '/新建 新项目：第一步', userId: 'owner-1' },
      store,
    });

    assert.equal(malformed.reply, '格式：/新建 <任务名字>：<第一步指令>');
    assert.match(failed.reply, /新建任务失败/);
    assert.equal(store.listTasks().length, 0);
  }));

test('线程名字可直接关联下一步', () =>
  withStore((store) => {
    const completion = store.recordCompletion({
      cwd: 'E:\\任意目录',
      finalMessage: '本轮任务已完成。',
      projectId: 'thread:thread-4',
      projectName: '当前飞书中继',
      threadId: 'thread-4',
      turnId: 'turn-4',
    }).completion;
    const accepted = handleIncomingText({
      config: makeConfig(),
      message: { text: '当前飞书中继: 继续下一步', userId: 'owner-1' },
      store,
    });

    assert.match(accepted.reply, /已收录 T-1 到「当前飞书中继」/);
    assert.match(accepted.reply, /优先显示在对应线程/);
    assert.equal(store.listTasks('thread:thread-4').length, 1);
  }));

test('优先读取 Codex 本机索引里的最新线程标题', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-title-'));
  const indexPath = path.join(temporaryDirectory, 'session_index.jsonl');

  try {
    fs.writeFileSync(
      indexPath,
      [
        JSON.stringify({ id: 'thread-5', thread_name: '旧标题', updated_at: '2026-07-16T00:00:00.000Z' }),
        JSON.stringify({ id: 'thread-5', thread_name: '最新标题', updated_at: '2026-07-15T00:00:00.000Z' }),
        '{"id":"thread-5"',
      ].join('\n'),
      'utf8',
    );

    assert.equal(readThreadTitle('thread-5', indexPath), '最新标题');
    assert.equal(
      resolveThreadTitle({
        cwd: 'E:\\workspace\\示例',
        inputMessages: ['回退标题'],
        threadId: 'thread-5',
        sessionIndexPath: indexPath,
      }),
      '最新标题',
    );
    assert.equal(resolveThreadTitle({ threadId: 'thread-6', sessionIndexPath: indexPath }), null);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('子代理名称始终附带短线程标识避免同名歧义', () => {
  assert.equal(
    subagentThreadTitle(
      '父任务',
      '44444444-4444-4444-8444-444444444444',
      'review',
    ),
    '父任务 / review·44444444',
  );
});

test('飞书 worker 同时只能启动一个实例', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-feishu-lock-'));
  const lockPath = path.join(temporaryDirectory, 'worker.lock');
  const release = acquireWorkerLock(lockPath);

  try {
    assert.throws(() => acquireWorkerLock(lockPath), /已经运行/);
  } finally {
    release();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
