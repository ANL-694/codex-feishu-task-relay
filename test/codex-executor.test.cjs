'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_LEASE_HEADROOM_MS,
  calculateRetryDelay,
  createCodexExecutor,
  createSyntheticTurnId,
} = require('../src/codex-executor.cjs');
const { DEFAULT_TIMEOUT_MS } = require('../src/codex-task-runner.cjs');

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const START_TIME = '2026-07-16T10:00:00.000Z';

function taskInput(taskId, overrides = {}) {
  return {
    attempt_count: 0,
    cwd: 'E:\\workweb',
    execution_mode: 'resume',
    instruction: `查看 T-${taskId} 当前版本`,
    project_id: `thread:${THREAD_ID}`,
    project_name: 'anl api',
    status: 'pending',
    task_id: taskId,
    thread_id: THREAD_ID,
    ...overrides,
  };
}

class FakeStore {
  constructor(tasks = []) {
    this.claimCalls = [];
    this.completions = [];
    this.failedCalls = [];
    this.markDoneCalls = [];
    this.nextCompletionId = 1;
    this.recordedInputs = [];
    this.recoverCalls = [];
    this.requeueCalls = [];
    this.tasks = tasks.map((task) => ({ ...task }));
  }

  addTask(task) {
    this.tasks.push({ ...task });
  }

  bindNewTaskToThread(taskId, options) {
    const stored = this.tasks.find((task) => task.task_id === taskId);

    if (
      !stored ||
      stored.status !== 'running' ||
      stored.lease_owner !== options.leaseOwner ||
      stored.execution_mode !== 'new'
    ) {
      return null;
    }

    stored.execution_mode = 'resume';
    stored.project_id = `thread:${options.threadId}`;
    stored.thread_id = options.threadId;
    return { ...stored };
  }

  addHookCompletion(task, overrides = {}) {
    const completion = {
      completion_id: this.nextCompletionId,
      created_at: task.started_at,
      cwd: task.cwd,
      executor_task_id: task.task_id,
      final_message: 'notify hook 答复',
      project_id: task.project_id,
      project_name: task.project_name,
      thread_id: task.thread_id,
      turn_id: `hook-turn-${task.task_id}`,
      ...overrides,
    };
    this.nextCompletionId += 1;
    this.completions.push(completion);
    return completion;
  }

  claimNextExecutableTask(options) {
    this.claimCalls.push(options);
    const stored = this.tasks.find((task) => task.status === 'pending');

    if (!stored) {
      return null;
    }

    stored.attempt_count += 1;
    stored.lease_owner = options.leaseOwner;
    stored.started_at = options.now.toISOString();
    stored.status = 'running';
    return { ...stored };
  }

  findLatestCompletionForThreadSince(threadId, sinceIso) {
    return (
      [...this.completions]
        .reverse()
        .find(
          (completion) =>
            completion.thread_id === threadId && completion.created_at >= sinceIso,
        ) || null
    );
  }

  findCompletionForExecutorTask(taskId) {
    return this.completions.find((completion) => completion.executor_task_id === taskId) || null;
  }

  markTaskDone(taskId, options) {
    this.markDoneCalls.push({ options, taskId });
    const stored = this.tasks.find((task) => task.task_id === taskId);

    if (!stored || stored.status !== 'running' || stored.lease_owner !== options.leaseOwner) {
      return null;
    }

    stored.result_completion_id = options.resultCompletionId;
    stored.status = 'done';
    stored.lease_owner = null;
    return { ...stored };
  }

  markTaskFailed(taskId, options) {
    this.failedCalls.push({ options, taskId });
    const stored = this.tasks.find((task) => task.task_id === taskId);

    if (!stored || stored.status !== 'running' || stored.lease_owner !== options.leaseOwner) {
      return null;
    }

    stored.last_error = String(options.error);
    stored.status = 'failed';
    stored.lease_owner = null;
    return { ...stored };
  }

  recordCompletion(input) {
    this.recordedInputs.push(input);
    let completion = this.completions.find(
      (candidate) =>
        candidate.thread_id === input.threadId && candidate.turn_id === input.turnId,
    );

    if (!completion) {
      completion = {
        completion_id: this.nextCompletionId,
        created_at: START_TIME,
        cwd: input.cwd,
        executor_task_id: input.executorTaskId,
        final_message: input.finalMessage,
        project_id: input.projectId,
        project_name: input.projectName,
        thread_id: input.threadId,
        turn_id: input.turnId,
      };
      this.nextCompletionId += 1;
      this.completions.push(completion);
    }

    return { completion, inserted: true };
  }

  recoverAbandonedTaskLeases(now) {
    this.recoverCalls.push(now);
    return 0;
  }

  requeueTask(taskId, options) {
    this.requeueCalls.push({ options, taskId });
    const stored = this.tasks.find((task) => task.task_id === taskId);

    if (!stored || stored.status !== 'running' || stored.lease_owner !== options.leaseOwner) {
      return null;
    }

    stored.last_error = Object.hasOwn(options, 'error') ? String(options.error) : stored.last_error;
    stored.lease_owner = null;
    stored.started_at = null;
    stored.status = 'pending';
    return { ...stored };
  }
}

function successfulResult(task, message = '当前版本为 1.2.3。') {
  return {
    completed: true,
    exitCode: 0,
    lastMessage: message,
    threadId: task.thread_id,
    timedOut: false,
    workingDirectory: task.cwd,
  };
}

function silentLogger(messages = []) {
  return (level, message) => messages.push({ level, message });
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 2_000;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`等待超时：${description}`);
    }

    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('优先采用 notify hook 完成记录并只回收一次遗留租约', async () => {
  const store = new FakeStore();
  const task = taskInput(1);
  let hookCompletion;
  const executor = createCodexExecutor({
    leaseOwner: 'executor-test',
    logger: silentLogger(),
    notifyWaitMs: 10,
    now: () => new Date(START_TIME),
    pollIntervalMs: 60_000,
    runTask: async (claimedTask) => {
      hookCompletion = store.addHookCompletion(claimedTask);
      return successfulResult(claimedTask);
    },
    store,
  });

  executor.start();
  store.addTask(task);
  executor.wake();
  await waitUntil(() => store.tasks[0].status === 'done', 'notify hook 任务完成');
  await executor.stop();
  executor.start();
  await executor.stop();

  assert.equal(store.recordedInputs.length, 0);
  assert.equal(store.markDoneCalls[0].options.resultCompletionId, hookCompletion.completion_id);
  assert.equal(store.recoverCalls.length, 1);
  assert.ok(store.claimCalls[0].leaseMs >= DEFAULT_TIMEOUT_MS + DEFAULT_LEASE_HEADROOM_MS);
  assert.equal(executor.getState().completedTasks, 1);
});

test('notify hook 未入库时使用稳定 turnId 补建完成摘要', async () => {
  const task = taskInput(2);
  const store = new FakeStore([task]);
  const executor = createCodexExecutor({
    leaseOwner: 'executor-test',
    logger: silentLogger(),
    notifyWaitMs: 0,
    now: () => new Date(START_TIME),
    pollIntervalMs: 60_000,
    runTask: async (claimedTask) => successfulResult(claimedTask, '回退保存的最终答复'),
    store,
  });

  executor.start();
  await waitUntil(() => store.tasks[0].status === 'done', '回退完成摘要入库');
  await executor.stop();

  assert.equal(store.recordedInputs.length, 1);
  assert.equal(store.recordedInputs[0].turnId, createSyntheticTurnId(task));
  assert.equal(store.recordedInputs[0].executorTaskId, task.task_id);
  assert.equal(store.recordedInputs[0].finalMessage, '回退保存的最终答复');
  assert.equal(store.markDoneCalls[0].options.resultCompletionId, 1);
});

test('新任务返回线程标识后绑定为 resume 并用原名称通知', async () => {
  const newThreadId = '22222222-2222-4222-8222-222222222222';
  const task = taskInput(20, {
    cwd: 'E:\\Codex临时任务\\task-20',
    execution_mode: 'new',
    project_id: 'new:task-20',
    project_name: '新项目想法',
    thread_id: null,
  });
  const store = new FakeStore([task]);
  const executor = createCodexExecutor({
    leaseOwner: 'executor-test',
    logger: silentLogger(),
    notifyWaitMs: 0,
    now: () => new Date(START_TIME),
    pollIntervalMs: 60_000,
    runTask: async (claimedTask) => ({
      ...successfulResult(claimedTask, '最小方案已完成。'),
      threadId: newThreadId,
    }),
    store,
  });

  executor.start();
  await waitUntil(() => store.tasks[0].status === 'done', '新任务完成并绑定');
  await executor.stop();

  assert.equal(store.tasks[0].execution_mode, 'resume');
  assert.equal(store.tasks[0].thread_id, newThreadId);
  assert.equal(store.tasks[0].project_id, `thread:${newThreadId}`);
  assert.equal(store.recordedInputs[0].projectName, '新项目想法');
  assert.equal(store.recordedInputs[0].threadId, newThreadId);
});

test('新任务启动线程后即使首轮失败也在重试时 resume 同一线程', async () => {
  const newThreadId = '22222222-2222-4222-8222-222222222222';
  const task = taskInput(21, {
    cwd: 'E:\\Codex临时任务\\task-21',
    execution_mode: 'new',
    project_id: 'new:task-21',
    project_name: '失败重试项目',
    thread_id: null,
  });
  const store = new FakeStore([task]);
  const seenModes = [];
  const executor = createCodexExecutor({
    leaseOwner: 'executor-test',
    logger: silentLogger(),
    notifyWaitMs: 0,
    now: () => new Date(START_TIME),
    pollIntervalMs: 60_000,
    retryBaseMs: 0,
    retryMaxMs: 0,
    runTask: async (claimedTask) => {
      seenModes.push(claimedTask.execution_mode);

      if (seenModes.length === 1) {
        return {
          completed: false,
          exitCode: 1,
          lastMessage: null,
          threadId: newThreadId,
          timedOut: false,
          workingDirectory: claimedTask.cwd,
        };
      }

      return successfulResult(claimedTask, '重试完成。');
    },
    store,
  });

  executor.start();
  await waitUntil(() => store.tasks[0].status === 'done', '绑定后的任务重试完成');
  await executor.stop();

  assert.deepEqual(seenModes, ['new', 'resume']);
  assert.equal(store.tasks[0].thread_id, newThreadId);
  assert.equal(store.requeueCalls.length, 1);
});

test('可重试错误按指数退避并且日志不泄露飞书指令', async () => {
  const task = taskInput(3, { instruction: '这是一条不应进入日志的秘密指令' });
  const store = new FakeStore([task]);
  const messages = [];
  let runCalls = 0;
  const executor = createCodexExecutor({
    leaseOwner: 'executor-test',
    logger: silentLogger(messages),
    notifyWaitMs: 0,
    now: () => new Date(START_TIME),
    pollIntervalMs: 60_000,
    retryBaseMs: 25,
    retryMaxMs: 100,
    runTask: async (claimedTask) => {
      runCalls += 1;

      if (runCalls === 1) {
        throw new Error(`临时错误：${claimedTask.instruction}`);
      }

      return successfulResult(claimedTask);
    },
    store,
  });

  executor.start();
  await waitUntil(() => store.tasks[0].status === 'done', '重试后任务完成');
  await executor.stop();

  assert.equal(runCalls, 2);
  assert.equal(store.requeueCalls.length, 1);
  assert.equal(store.requeueCalls[0].options.delayMs, 25);
  assert.doesNotMatch(store.requeueCalls[0].options.error, /秘密指令/);
  assert.doesNotMatch(JSON.stringify(messages), /秘密指令/);
  assert.equal(calculateRetryDelay(3, 25, 100), 100);
});

test('线程不匹配属于永久失败且不会重试', async () => {
  const task = taskInput(4);
  const store = new FakeStore([task]);
  let runCalls = 0;
  const executor = createCodexExecutor({
    leaseOwner: 'executor-test',
    logger: silentLogger(),
    notifyWaitMs: 0,
    now: () => new Date(START_TIME),
    pollIntervalMs: 60_000,
    runTask: async (claimedTask) => {
      runCalls += 1;
      return { ...successfulResult(claimedTask), threadId: 'other-thread' };
    },
    store,
  });

  executor.start();
  await waitUntil(() => store.tasks[0].status === 'failed', '永久失败状态写入');
  await executor.stop();

  assert.equal(runCalls, 1);
  assert.equal(store.requeueCalls.length, 0);
  assert.equal(store.failedCalls.length, 1);
});

test('任务严格串行执行', async () => {
  const store = new FakeStore([taskInput(5), taskInput(6)]);
  let activeRuns = 0;
  let maximumActiveRuns = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const startedTasks = [];
  const executor = createCodexExecutor({
    leaseOwner: 'executor-test',
    logger: silentLogger(),
    notifyWaitMs: 0,
    now: () => new Date(START_TIME),
    pollIntervalMs: 60_000,
    runTask: async (claimedTask) => {
      startedTasks.push(claimedTask.task_id);
      activeRuns += 1;
      maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);

      if (claimedTask.task_id === 5) {
        await firstGate;
      }

      activeRuns -= 1;
      return successfulResult(claimedTask);
    },
    store,
  });

  executor.start();
  await waitUntil(() => startedTasks.length === 1, '第一项任务启动');
  assert.deepEqual(startedTasks, [5]);
  releaseFirst();
  await waitUntil(() => store.tasks.every((task) => task.status === 'done'), '两项任务完成');
  await executor.stop();

  assert.deepEqual(startedTasks, [5, 6]);
  assert.equal(maximumActiveRuns, 1);
});

test('停止会终止活动子进程、等待退出并保留后续任务', async () => {
  const store = new FakeStore([taskInput(7), taskInput(8)]);
  let childKilled = 0;
  let releaseRun;
  let runCalls = 0;
  const executor = createCodexExecutor({
    leaseOwner: 'executor-test',
    logger: silentLogger(),
    notifyWaitMs: 0,
    now: () => new Date(START_TIME),
    pollIntervalMs: 60_000,
    runTask: async (claimedTask, options) => {
      runCalls += 1;
      const child = {
        kill() {
          childKilled += 1;
          setImmediate(releaseRun);
          return true;
        },
      };
      options.onChild(child);
      await new Promise((resolve) => {
        releaseRun = resolve;
      });
      options.onChild(null);
      return {
        completed: false,
        exitCode: null,
        lastMessage: null,
        threadId: claimedTask.thread_id,
      };
    },
    store,
  });

  executor.start();
  await waitUntil(() => executor.getState().activeTask?.taskId === 7, '活动子进程出现');
  const stopped = await executor.stop();

  assert.equal(childKilled, 1);
  assert.equal(runCalls, 1);
  assert.equal(store.tasks[0].status, 'pending');
  assert.equal(store.tasks[1].status, 'pending');
  assert.equal(stopped.started, false);
  assert.equal(stopped.activeTask, null);
});
