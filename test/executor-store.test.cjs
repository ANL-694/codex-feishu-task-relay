'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { handleIncomingText } = require('../src/message-router.cjs');
const { createStore } = require('../src/store.cjs');

const THREAD_A = '33333333-3333-4333-8333-333333333333';
const THREAD_B = '22222222-2222-4222-8222-222222222222';

function createTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-feishu-executor-'));
}

function createLegacyDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);

  database.exec(`
    CREATE TABLE completions (
      completion_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      final_message TEXT NOT NULL,
      input_summary TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      UNIQUE(thread_id, turn_id)
    );

    CREATE TABLE tasks (
      task_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      completion_id INTEGER,
      instruction TEXT NOT NULL,
      source_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE unauthorized_users (
      user_id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1
    );
  `);
  const completion = database
    .prepare(`
      INSERT INTO completions (
        thread_id, turn_id, cwd, project_id, project_name, final_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      THREAD_A,
      'legacy-turn',
      'E:\\workweb\\anl-api',
      `thread:${THREAD_A}`,
      'anl api',
      '旧完成摘要',
      '2026-07-16T00:00:00.000Z',
    );

  database
    .prepare(`
      INSERT INTO tasks (
        project_id, project_name, completion_id, instruction, source_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      `thread:${THREAD_A}`,
      'anl api',
      completion.lastInsertRowid,
      '查看当前版本',
      'owner-1',
      '2026-07-16T00:01:00.000Z',
    );
  database
    .prepare(`
      INSERT INTO tasks (
        project_id, project_name, completion_id, instruction, source_user_id, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?)
    `)
    .run('bds', 'BDS', '旧项目任务', 'owner-1', '2026-07-16T00:02:00.000Z');
  database.close();
}

function createThreadTask(store, overrides = {}) {
  const threadId = overrides.threadId || THREAD_A;

  return store.createTask({
    cwd: 'E:\\workweb\\anl-api',
    instruction: '查看当前版本',
    projectId: `thread:${threadId}`,
    projectName: 'anl api',
    sourceUserId: 'owner-1',
    threadId,
    ...overrides,
  });
}

test('旧库迁移回填线程与目录并忽略旧 BDS 项目任务', () => {
  const temporaryDirectory = createTemporaryDirectory();
  const databasePath = path.join(temporaryDirectory, 'relay.sqlite');
  createLegacyDatabase(databasePath);
  const store = createStore(databasePath);

  try {
    const tasks = store.listTasks();
    const threadTask = tasks.find((task) => task.project_id.startsWith('thread:'));
    const legacyProjectTask = tasks.find((task) => task.project_id === 'bds');

    assert.equal(threadTask.thread_id, THREAD_A);
    assert.equal(threadTask.cwd, 'E:\\workweb\\anl-api');
    assert.equal(threadTask.execution_mode, 'resume');
    assert.equal(threadTask.attempt_count, 0);
    assert.equal(threadTask.lease_owner, null);
    assert.equal(legacyProjectTask.thread_id, null);
    assert.equal(legacyProjectTask.execution_mode, 'resume');
    assert.equal(store.getQueueCounts().pendingTasks, 1);

    const claimed = store.claimNextExecutableTask({
      leaseMs: 30_000,
      leaseOwner: 'executor-a',
      now: '2026-07-16T00:03:00.000Z',
    });

    assert.equal(claimed.task_id, threadTask.task_id);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempt_count, 1);
    assert.equal(store.getQueueCounts().pendingTasks, 0);
    assert.equal(
      store.claimNextExecutableTask({
        leaseOwner: 'executor-a',
        now: '2026-07-16T00:03:01.000Z',
      }),
      null,
    );
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('新任务可领取并在返回线程后原子绑定为后续 resume 任务', () => {
  const temporaryDirectory = createTemporaryDirectory();
  const workspace = path.join(temporaryDirectory, 'new-workspace');
  const store = createStore(path.join(temporaryDirectory, 'relay.sqlite'));

  try {
    fs.mkdirSync(workspace);
    const task = store.createTask({
      cwd: workspace,
      executionMode: 'new',
      instruction: '先调研可行性',
      projectId: 'new:12345678-1234-1234-1234-123456789abc',
      projectName: '新项目想法',
      sourceUserId: 'owner-1',
    });
    const claimed = store.claimNextExecutableTask({
      leaseOwner: 'executor-a',
      now: '2026-07-17T01:00:00.000Z',
    });

    assert.equal(claimed.task_id, task.task_id);
    assert.equal(claimed.execution_mode, 'new');
    assert.equal(
      store.bindNewTaskToThread(task.task_id, {
        leaseOwner: 'wrong-executor',
        threadId: THREAD_B,
      }),
      null,
    );

    const bound = store.bindNewTaskToThread(task.task_id, {
      leaseOwner: 'executor-a',
      threadId: THREAD_B,
    });

    assert.equal(bound.execution_mode, 'resume');
    assert.equal(bound.thread_id, THREAD_B);
    assert.equal(bound.project_id, `thread:${THREAD_B}`);
    assert.equal(bound.project_name, '新项目想法');

    const completion = store.recordCompletion({
      cwd: workspace,
      finalMessage: '最小方案已完成。',
      projectId: bound.project_id,
      projectName: bound.project_name,
      threadId: bound.thread_id,
      turnId: 'new-project-turn',
    }).completion;
    store.markTaskDone(bound.task_id, {
      leaseOwner: 'executor-a',
      resultCompletionId: completion.completion_id,
    });

    const followUp = handleIncomingText({
      config: { ownerUserIds: ['owner-1'] },
      message: { text: '新项目想法：继续做下一步', userId: 'owner-1' },
      store,
    });

    assert.equal(followUp.task.execution_mode, 'resume');
    assert.equal(followUp.task.thread_id, THREAD_B);
    assert.equal(followUp.task.project_id, `thread:${THREAD_B}`);
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('任务领取跨连接不重复并支持租约恢复和延迟重试', () => {
  const temporaryDirectory = createTemporaryDirectory();
  const databasePath = path.join(temporaryDirectory, 'relay.sqlite');
  const firstStore = createStore(databasePath);
  const secondStore = createStore(databasePath);

  try {
    const task = createThreadTask(firstStore);
    const firstClaim = firstStore.claimNextExecutableTask({
      leaseMs: 1_000,
      leaseOwner: 'executor-a',
      now: '2026-07-16T01:00:00.000Z',
    });

    assert.equal(firstClaim.task_id, task.task_id);
    assert.equal(
      secondStore.claimNextExecutableTask({
        leaseOwner: 'executor-b',
        now: '2026-07-16T01:00:00.500Z',
      }),
      null,
    );
    assert.equal(secondStore.recoverExpiredTaskLeases('2026-07-16T01:00:02.000Z'), 1);

    const secondClaim = secondStore.claimNextExecutableTask({
      leaseOwner: 'executor-b',
      now: '2026-07-16T01:00:02.000Z',
    });

    assert.equal(secondClaim.task_id, task.task_id);
    assert.equal(secondClaim.attempt_count, 2);
    const requeued = secondStore.requeueTask(task.task_id, {
      delayMs: 5_000,
      error: new Error('临时不可用'),
      leaseOwner: 'executor-b',
      now: '2026-07-16T01:00:02.000Z',
    });

    assert.equal(requeued.status, 'pending');
    assert.equal(requeued.last_error, '临时不可用');
    assert.equal(requeued.next_attempt_at, '2026-07-16T01:00:07.000Z');
    assert.equal(
      firstStore.claimNextExecutableTask({
        leaseOwner: 'executor-a',
        now: '2026-07-16T01:00:06.999Z',
      }),
      null,
    );

    const thirdClaim = firstStore.claimNextExecutableTask({
      leaseOwner: 'executor-a',
      now: '2026-07-16T01:00:07.000Z',
    });

    assert.equal(thirdClaim.attempt_count, 3);
    assert.equal(
      firstStore.markTaskFailed(task.task_id, {
        error: '错误执行器不能结算',
        leaseOwner: 'executor-b',
      }),
      null,
    );
    const failed = firstStore.markTaskFailed(task.task_id, {
      error: '已达到最大重试次数',
      leaseOwner: 'executor-a',
      now: '2026-07-16T01:00:08.000Z',
    });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.last_error, '已达到最大重试次数');
    assert.equal(failed.lease_owner, null);
    assert.equal(firstStore.getQueueCounts().pendingTasks, 0);
  } finally {
    secondStore.close();
    firstStore.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('执行结果可按线程和开始时间查找并关联回任务', () => {
  const temporaryDirectory = createTemporaryDirectory();
  const store = createStore(path.join(temporaryDirectory, 'relay.sqlite'));

  try {
    const task = createThreadTask(store);
    store.claimNextExecutableTask({
      leaseOwner: 'executor-a',
      now: '2026-07-16T02:00:00.000Z',
    });
    const completion = store.recordCompletion({
      cwd: 'E:\\workweb\\anl-api',
      finalMessage: '当前版本为 1.2.3。',
      projectId: `thread:${THREAD_A}`,
      projectName: 'anl api',
      threadId: THREAD_A,
      turnId: 'executor-result-turn',
    }).completion;

    assert.equal(
      store.findLatestCompletionForThreadSince(THREAD_A, '2026-07-16T00:00:00.000Z')
        .completion_id,
      completion.completion_id,
    );
    assert.equal(
      store.findLatestCompletionForThreadSince(THREAD_A, '2999-01-01T00:00:00.000Z'),
      null,
    );

    const done = store.markTaskDone(task.task_id, {
      leaseOwner: 'executor-a',
      now: '2026-07-16T02:01:00.000Z',
      resultCompletionId: completion.completion_id,
    });

    assert.equal(done.status, 'done');
    assert.equal(done.result_completion_id, completion.completion_id);
    assert.equal(done.completed_at, '2026-07-16T02:01:00.000Z');
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('完成库无记录时从最新侧栏索引按唯一标题创建线程任务', () => {
  const temporaryDirectory = createTemporaryDirectory();
  const sessionIndexPath = path.join(temporaryDirectory, 'session_index.jsonl');
  const store = createStore(path.join(temporaryDirectory, 'relay.sqlite'));

  try {
    fs.writeFileSync(
      sessionIndexPath,
      [
        JSON.stringify({ id: THREAD_A, thread_name: '旧标题' }),
        '{broken json',
        JSON.stringify({ id: THREAD_B, thread_name: '另一个线程' }),
        JSON.stringify({ id: THREAD_A, thread_name: 'anl api' }),
      ].join('\n'),
      'utf8',
    );
    const accepted = handleIncomingText({
      config: { ownerUserIds: ['owner-1'] },
      message: { text: 'anl api：查看当前版本', userId: 'owner-1' },
      sessionIndexPath,
      sessionsDirectory: path.join(temporaryDirectory, 'sessions'),
      store,
    });

    assert.match(accepted.reply, /已收录 T-1 到「anl api」/);
    assert.equal(accepted.task.thread_id, THREAD_A);
    assert.equal(accepted.task.project_id, `thread:${THREAD_A}`);
    assert.equal(accepted.task.completion_id, null);
    assert.equal(accepted.task.cwd, null);
    assert.equal(store.getQueueCounts().pendingTasks, 1);

    const oldTitle = handleIncomingText({
      config: { ownerUserIds: ['owner-1'] },
      message: { text: '旧标题：不应匹配历史名字', userId: 'owner-1' },
      sessionIndexPath,
      sessionsDirectory: path.join(temporaryDirectory, 'sessions'),
      store,
    });
    assert.match(oldTitle.reply, /没有找到侧栏线程/);

    fs.appendFileSync(
      sessionIndexPath,
      `\n${JSON.stringify({ id: THREAD_B, thread_name: 'anl api' })}`,
      'utf8',
    );
    const duplicate = handleIncomingText({
      config: { ownerUserIds: ['owner-1'] },
      message: { text: 'anl api：不能猜线程', userId: 'owner-1' },
      sessionIndexPath,
      sessionsDirectory: path.join(temporaryDirectory, 'sessions'),
      store,
    });

    assert.match(duplicate.reply, /有多个同名线程/);
    assert.equal(store.listTasks().length, 1);
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('执行器状态快照与异常退出租约可恢复', () => {
  const temporaryDirectory = createTemporaryDirectory();
  const store = createStore(path.join(temporaryDirectory, 'relay.sqlite'));

  try {
    const task = store.createTask({
      cwd: 'E:\\workweb',
      instruction: '查看当前版本',
      projectId: `thread:${THREAD_A}`,
      projectName: 'anl api',
      sourceUserId: 'owner-1',
      threadId: THREAD_A,
    });
    store.claimNextExecutableTask({
      leaseMs: 120_000,
      leaseOwner: 'executor-old',
      now: '2026-07-16T03:00:00.000Z',
    });

    assert.deepEqual(store.getQueueCounts(), {
      failedTasks: 0,
      pendingTasks: 0,
      queuedCompletions: 0,
      runningTasks: 1,
    });
    assert.equal(store.getExecutorSnapshot().runningTask.task_id, task.task_id);
    assert.equal(
      store.recoverAbandonedTaskLeases('2026-07-16T03:01:00.000Z'),
      1,
    );
    assert.equal(store.getTask(task.task_id).status, 'pending');

    store.claimNextExecutableTask({
      leaseMs: 120_000,
      leaseOwner: 'executor-new',
      now: '2026-07-16T03:02:00.000Z',
    });
    store.markTaskFailed(task.task_id, {
      error: 'Codex 恢复失败',
      leaseOwner: 'executor-new',
      now: '2026-07-16T03:03:00.000Z',
    });

    assert.equal(store.getQueueCounts().failedTasks, 1);
    assert.equal(store.getExecutorSnapshot().lastError.last_error, 'Codex 恢复失败');
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('同一飞书任务的 Hook 与回退摘要只保留一条', () => {
  const temporaryDirectory = createTemporaryDirectory();
  const store = createStore(path.join(temporaryDirectory, 'relay.sqlite'));

  try {
    const first = store.recordCompletion({
      cwd: 'E:\\workweb',
      executorTaskId: 99,
      finalMessage: '当前版本为 1.2.3。',
      projectId: `thread:${THREAD_A}`,
      projectName: 'anl api',
      threadId: THREAD_A,
      turnId: 'hook-turn',
    });
    const duplicate = store.recordCompletion({
      cwd: 'E:\\workweb',
      executorTaskId: 99,
      finalMessage: '不应覆盖原结果',
      projectId: `thread:${THREAD_A}`,
      projectName: 'anl api',
      threadId: THREAD_A,
      turnId: 'relay-executor-task-99',
    });

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.completion.completion_id, first.completion.completion_id);
    assert.equal(store.listQueuedCompletions().length, 1);
  } finally {
    store.close();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
