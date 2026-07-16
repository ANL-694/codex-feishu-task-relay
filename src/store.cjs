'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DATABASE_PATH, DATA_DIR } = require('./constants.cjs');

const EXECUTABLE_TASK_SQL = `
  (
    execution_mode = 'new'
    AND (thread_id IS NULL OR length(trim(thread_id)) = 0)
    AND project_id LIKE 'new:%'
    AND cwd IS NOT NULL
    AND length(trim(cwd)) > 0
  )
  OR (
    (execution_mode IS NULL OR execution_mode = 'resume')
    AND thread_id IS NOT NULL
    AND length(trim(thread_id)) > 0
    AND project_id = 'thread:' || thread_id
  )
`;
const TASK_ERROR_LIMIT = 4000;

function nowIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Invalid timestamp');
  }

  return date.toISOString();
}

function projectThreadId(projectId) {
  const normalizedProjectId = String(projectId || '').trim();

  if (!normalizedProjectId.startsWith('thread:')) {
    return null;
  }

  return normalizedProjectId.slice('thread:'.length).trim() || null;
}

function taskError(error) {
  return String(error instanceof Error ? error.message : error || '').slice(0, TASK_ERROR_LIMIT);
}

function normalizeExecutionMode(value) {
  const normalized = String(value || 'resume').trim().toLocaleLowerCase('en-US');

  if (normalized === 'new' || normalized === 'resume') {
    return normalized;
  }

  throw new TypeError('Task execution mode must be new or resume');
}

function createStore(databasePath = DATABASE_PATH) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS completions (
      completion_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      final_message TEXT NOT NULL,
      input_summary TEXT,
      executor_task_id INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      delivery_cursor INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      UNIQUE(thread_id, turn_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      completion_id INTEGER,
      thread_id TEXT,
      cwd TEXT,
      instruction TEXT NOT NULL,
      source_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      next_attempt_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      result_completion_id INTEGER,
      execution_mode TEXT NOT NULL DEFAULT 'resume',
      FOREIGN KEY(completion_id) REFERENCES completions(completion_id),
      FOREIGN KEY(result_completion_id) REFERENCES completions(completion_id)
    );

    CREATE TABLE IF NOT EXISTS unauthorized_users (
      user_id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS inbound_messages (
      provider TEXT NOT NULL,
      message_id TEXT NOT NULL,
      user_id TEXT,
      received_at TEXT NOT NULL,
      PRIMARY KEY (provider, message_id)
    );
  `);

  const completionColumns = database.prepare('PRAGMA table_info(completions)').all();

  if (!completionColumns.some((column) => column.name === 'delivery_cursor')) {
    database.exec('ALTER TABLE completions ADD COLUMN delivery_cursor INTEGER NOT NULL DEFAULT 0');
  }

  if (!completionColumns.some((column) => column.name === 'executor_task_id')) {
    database.exec('ALTER TABLE completions ADD COLUMN executor_task_id INTEGER');
  }

  const taskColumnDefinitions = new Map([
    ['thread_id', 'TEXT'],
    ['cwd', 'TEXT'],
    ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['started_at', 'TEXT'],
    ['last_error', 'TEXT'],
    ['next_attempt_at', 'TEXT'],
    ['lease_owner', 'TEXT'],
    ['lease_expires_at', 'TEXT'],
    ['result_completion_id', 'INTEGER'],
    ['execution_mode', "TEXT NOT NULL DEFAULT 'resume'"],
  ]);
  const taskColumns = new Set(
    database.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name),
  );

  for (const [columnName, definition] of taskColumnDefinitions) {
    if (!taskColumns.has(columnName)) {
      database.exec(`ALTER TABLE tasks ADD COLUMN ${columnName} ${definition}`);
    }
  }

  database.exec(`
    UPDATE tasks
    SET thread_id = substr(project_id, 8)
    WHERE thread_id IS NULL
      AND project_id LIKE 'thread:%'
      AND length(trim(substr(project_id, 8))) > 0;

    UPDATE tasks
    SET cwd = (
      SELECT completions.cwd
      FROM completions
      WHERE completions.completion_id = tasks.completion_id
    )
    WHERE cwd IS NULL
      AND completion_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_tasks_executor_queue
      ON tasks(status, next_attempt_at, task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_thread
      ON tasks(thread_id, task_id DESC);
    CREATE INDEX IF NOT EXISTS idx_completions_thread_created
      ON completions(thread_id, created_at DESC, completion_id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_completions_executor_task
      ON completions(executor_task_id)
      WHERE executor_task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_inbound_messages_received
      ON inbound_messages(received_at);
  `);

  const unauthorizedUserColumns = database.prepare('PRAGMA table_info(unauthorized_users)').all();

  if (unauthorizedUserColumns.some((column) => column.name === 'last_message')) {
    database.exec('UPDATE unauthorized_users SET last_message = NULL');
  }

  function recordCompletion(completion) {
    const executorTaskIdValue = Number(completion.executorTaskId);
    const executorTaskId =
      Number.isInteger(executorTaskIdValue) && executorTaskIdValue > 0
        ? executorTaskIdValue
        : null;
    const insert = database.prepare(`
      INSERT OR IGNORE INTO completions (
        thread_id,
        turn_id,
        cwd,
        project_id,
        project_name,
        final_message,
        input_summary,
        executor_task_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertResult = insert.run(
      completion.threadId,
      completion.turnId,
      completion.cwd,
      completion.projectId,
      completion.projectName,
      completion.finalMessage,
      completion.inputSummary || null,
      executorTaskId,
      nowIso(),
    );
    let stored = database
      .prepare('SELECT * FROM completions WHERE thread_id = ? AND turn_id = ?')
      .get(completion.threadId, completion.turnId);

    if (!stored && executorTaskId) {
      stored = database
        .prepare('SELECT * FROM completions WHERE executor_task_id = ?')
        .get(executorTaskId);
    }

    return {
      completion: stored,
      inserted: Number(insertResult.changes) > 0,
    };
  }

  function getCompletion(completionId) {
    return database.prepare('SELECT * FROM completions WHERE completion_id = ?').get(completionId) || null;
  }

  function findCompletionForExecutorTask(taskId) {
    const normalizedTaskId = Number(taskId);

    if (!Number.isInteger(normalizedTaskId) || normalizedTaskId <= 0) {
      return null;
    }

    return (
      database
        .prepare('SELECT * FROM completions WHERE executor_task_id = ? LIMIT 1')
        .get(normalizedTaskId) || null
    );
  }

  function findLatestCompletionForThreadSince(threadId, sinceIso) {
    const normalizedThreadId = String(threadId || '').trim();

    if (!normalizedThreadId) {
      return null;
    }

    const normalizedSince = sinceIso ? nowIso(sinceIso) : '1970-01-01T00:00:00.000Z';

    return (
      database
        .prepare(`
          SELECT *
          FROM completions
          WHERE thread_id = ? AND created_at >= ?
          ORDER BY created_at DESC, completion_id DESC
          LIMIT 1
        `)
        .get(normalizedThreadId, normalizedSince) || null
    );
  }

  function findLatestCompletionsByThreadTitle(threadTitle) {
    const normalizedTitle = String(threadTitle || '').trim();

    if (!normalizedTitle) {
      return [];
    }

    const completions = database
      .prepare(
        'SELECT * FROM completions WHERE project_name = ? COLLATE NOCASE ORDER BY completion_id DESC',
      )
      .all(normalizedTitle);
    const seenThreadIds = new Set();

    return completions.filter((completion) => {
      if (seenThreadIds.has(completion.thread_id)) {
        return false;
      }

      seenThreadIds.add(completion.thread_id);
      return true;
    });
  }

  function listQueuedCompletions(limit = 20) {
    return database
      .prepare(
        'SELECT * FROM completions WHERE status = ? ORDER BY attempt_count ASC, completion_id ASC LIMIT ?',
      )
      .all('queued', limit);
  }

  function getQueueCounts() {
    const counts = database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM completions WHERE status = 'queued') AS queued_completions,
          (
            SELECT COUNT(*)
            FROM tasks
            WHERE status = 'pending' AND (${EXECUTABLE_TASK_SQL})
          ) AS pending_tasks,
          (
            SELECT COUNT(*)
            FROM tasks
            WHERE status = 'running' AND (${EXECUTABLE_TASK_SQL})
          ) AS running_tasks,
          (
            SELECT COUNT(*)
            FROM tasks
            WHERE status = 'failed' AND (${EXECUTABLE_TASK_SQL})
          ) AS failed_tasks
      `)
      .get();

    return {
      failedTasks: Number(counts.failed_tasks),
      pendingTasks: Number(counts.pending_tasks),
      queuedCompletions: Number(counts.queued_completions),
      runningTasks: Number(counts.running_tasks),
    };
  }

  function getExecutorSnapshot() {
    const runningTask =
      database
        .prepare(`
          SELECT task_id, project_name, instruction, started_at
          FROM tasks
          WHERE status = 'running' AND (${EXECUTABLE_TASK_SQL})
          ORDER BY started_at ASC, task_id ASC
          LIMIT 1
        `)
        .get() || null;
    const lastError =
      database
        .prepare(`
          SELECT task_id, project_name, last_error, completed_at
          FROM tasks
          WHERE status = 'failed'
            AND (${EXECUTABLE_TASK_SQL})
            AND last_error IS NOT NULL
          ORDER BY completed_at DESC, task_id DESC
          LIMIT 1
        `)
        .get() || null;

    return { lastError, runningTask };
  }

  function markCompletionSent(completionId) {
    database
      .prepare(
        "UPDATE completions SET status = 'sent', sent_at = ?, last_error = NULL WHERE completion_id = ?",
      )
      .run(nowIso(), completionId);
  }

  function markCompletionDeliveryFailure(completionId, error) {
    database
      .prepare(
        'UPDATE completions SET attempt_count = attempt_count + 1, last_error = ? WHERE completion_id = ?',
      )
      .run(String(error).slice(0, 1000), completionId);
  }

  function markCompletionChunkSent(completionId, deliveryCursor) {
    database
      .prepare('UPDATE completions SET delivery_cursor = ? WHERE completion_id = ?')
      .run(deliveryCursor, completionId);
  }

  function claimInboundMessage({ messageId, provider, userId }) {
    const normalizedMessageId = String(messageId || '').trim();
    const normalizedProvider = String(provider || '').trim();

    if (!normalizedMessageId || !normalizedProvider) {
      return true;
    }

    const result = database
      .prepare(
        `
          INSERT OR IGNORE INTO inbound_messages (provider, message_id, user_id, received_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(normalizedProvider, normalizedMessageId, String(userId || '').trim() || null, nowIso());

    return Number(result.changes) === 1;
  }

  function createTask(task) {
    const completion = task.completionId ? getCompletion(task.completionId) : null;
    const explicitThreadId = String(task.threadId || '').trim();
    const threadId =
      explicitThreadId ||
      String(completion?.thread_id || '').trim() ||
      projectThreadId(task.projectId);
    const projectId = String(task.projectId || (threadId ? `thread:${threadId}` : '')).trim();
    const projectName = String(task.projectName || completion?.project_name || '').trim();
    const instruction = String(task.instruction || '').trim();
    const sourceUserId = String(task.sourceUserId || '').trim();
    const cwdSource = Object.hasOwn(task, 'cwd') ? task.cwd : completion?.cwd;
    const cwd = String(cwdSource || '').trim() || null;
    const executionMode = normalizeExecutionMode(task.executionMode);

    if (!projectId || !projectName || !instruction || !sourceUserId) {
      throw new TypeError('Task project, name, instruction and source user are required');
    }

    if (executionMode === 'new' && (threadId || !projectId.startsWith('new:') || !cwd)) {
      throw new TypeError('New task requires an isolated directory and a new project identifier');
    }

    const result = database
      .prepare(`
        INSERT INTO tasks (
          project_id,
          project_name,
          completion_id,
          thread_id,
          cwd,
          instruction,
          source_user_id,
          execution_mode,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        projectId,
        projectName,
        task.completionId || null,
        threadId || null,
        cwd,
        instruction,
        sourceUserId,
        executionMode,
        nowIso(),
      );

    return database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(result.lastInsertRowid);
  }

  function getTask(taskId) {
    return database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) || null;
  }

  function bindNewTaskToThread(taskId, options = {}) {
    const threadId = String(options.threadId || '').trim();
    const leaseOwner = String(options.leaseOwner || '').trim();

    if (!threadId) {
      throw new TypeError('threadId is required');
    }

    const existing = getTask(taskId);

    if (
      existing?.execution_mode === 'resume' &&
      existing.thread_id === threadId &&
      existing.project_id === `thread:${threadId}`
    ) {
      return existing;
    }

    if (!existing || existing.execution_mode !== 'new') {
      return null;
    }

    const parameters = [`thread:${threadId}`, threadId, taskId];
    const leaseGuard = leaseOwner ? ' AND lease_owner = ?' : '';

    if (leaseOwner) {
      parameters.push(leaseOwner);
    }

    const result = database
      .prepare(`
        UPDATE tasks
        SET
          project_id = ?,
          thread_id = ?,
          execution_mode = 'resume'
        WHERE task_id = ?
          AND status = 'running'
          AND execution_mode = 'new'
          AND (thread_id IS NULL OR length(trim(thread_id)) = 0)
          ${leaseGuard}
      `)
      .run(...parameters);

    return Number(result.changes) === 1 ? getTask(taskId) : null;
  }

  function listTasks(projectId = null) {
    if (projectId) {
      return database
        .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY task_id DESC LIMIT 50')
        .all(projectId);
    }

    return database.prepare('SELECT * FROM tasks ORDER BY task_id DESC LIMIT 50').all();
  }

  function listIncompleteThreadTasks(projectId = null) {
    if (projectId) {
      return database
        .prepare(`
          SELECT *
          FROM tasks
          WHERE project_id = ?
            AND status <> 'done'
            AND (${EXECUTABLE_TASK_SQL})
          ORDER BY task_id DESC
          LIMIT 50
        `)
        .all(projectId);
    }

    return database
      .prepare(`
        SELECT *
        FROM tasks
        WHERE status <> 'done'
          AND (${EXECUTABLE_TASK_SQL})
        ORDER BY task_id DESC
        LIMIT 50
      `)
      .all();
  }

  function recoverExpiredTaskLeasesAt(timestamp) {
    return database
      .prepare(`
        UPDATE tasks
        SET
          status = 'pending',
          started_at = NULL,
          next_attempt_at = CASE
            WHEN next_attempt_at IS NULL OR next_attempt_at < ? THEN ?
            ELSE next_attempt_at
          END,
          lease_owner = NULL,
          lease_expires_at = NULL
        WHERE status = 'running'
          AND (${EXECUTABLE_TASK_SQL})
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
      `)
      .run(timestamp, timestamp, timestamp);
  }

  function recoverExpiredTaskLeases(now = new Date()) {
    const result = recoverExpiredTaskLeasesAt(nowIso(now));
    return Number(result.changes);
  }

  function recoverAbandonedTaskLeases(now = new Date()) {
    const timestamp = nowIso(now);
    const result = database
      .prepare(`
        UPDATE tasks
        SET
          status = 'pending',
          started_at = NULL,
          next_attempt_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL
        WHERE status = 'running' AND (${EXECUTABLE_TASK_SQL})
      `)
      .run(timestamp);

    return Number(result.changes);
  }

  function claimNextExecutableTask(options = {}) {
    const leaseOwner = String(options.leaseOwner || '').trim();
    const leaseMs = Number(options.leaseMs || 300_000);

    if (!leaseOwner) {
      throw new TypeError('leaseOwner is required');
    }

    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new TypeError('leaseMs must be a positive number');
    }

    const timestamp = nowIso(options.now || new Date());
    const leaseExpiresAt = new Date(new Date(timestamp).getTime() + leaseMs).toISOString();

    database.exec('BEGIN IMMEDIATE');

    try {
      recoverExpiredTaskLeasesAt(timestamp);
      const task = database
        .prepare(`
          SELECT *
          FROM tasks
          WHERE status = 'pending'
            AND (${EXECUTABLE_TASK_SQL})
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY task_id ASC
          LIMIT 1
        `)
        .get(timestamp);

      if (!task) {
        database.exec('COMMIT');
        return null;
      }

      const claimed = database
        .prepare(`
          UPDATE tasks
          SET
            status = 'running',
            attempt_count = attempt_count + 1,
            started_at = ?,
            next_attempt_at = NULL,
            lease_owner = ?,
            lease_expires_at = ?
          WHERE task_id = ?
            AND status = 'pending'
            AND (${EXECUTABLE_TASK_SQL})
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        `)
        .run(timestamp, leaseOwner, leaseExpiresAt, task.task_id, timestamp);

      if (Number(claimed.changes) !== 1) {
        throw new Error(`Unable to claim task ${task.task_id}`);
      }

      const stored = getTask(task.task_id);
      database.exec('COMMIT');
      return stored;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function taskMutationWhere(leaseOwner, defaultStatusSql) {
    if (leaseOwner) {
      return {
        parameters: [leaseOwner],
        sql: "status = 'running' AND lease_owner = ?",
      };
    }

    return { parameters: [], sql: defaultStatusSql };
  }

  function markTaskDone(taskId, options = {}) {
    const leaseOwner = String(options.leaseOwner || '').trim();
    const timestamp = nowIso(options.now || new Date());
    const resultCompletionId = options.resultCompletionId || null;
    const guard = taskMutationWhere(leaseOwner, "status NOT IN ('done', 'failed')");
    const result = database
      .prepare(`
        UPDATE tasks
        SET
          status = 'done',
          completed_at = ?,
          last_error = NULL,
          next_attempt_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          result_completion_id = ?
        WHERE task_id = ? AND ${guard.sql}
      `)
      .run(timestamp, resultCompletionId, taskId, ...guard.parameters);

    if (leaseOwner && Number(result.changes) !== 1) {
      return null;
    }

    return getTask(taskId);
  }

  function markTaskFailed(taskId, options = {}) {
    const normalizedOptions =
      options instanceof Error || typeof options === 'string' ? { error: options } : options;
    const leaseOwner = String(normalizedOptions.leaseOwner || '').trim();
    const timestamp = nowIso(normalizedOptions.now || new Date());
    const guard = taskMutationWhere(leaseOwner, "status NOT IN ('done', 'failed')");
    const result = database
      .prepare(`
        UPDATE tasks
        SET
          status = 'failed',
          completed_at = ?,
          last_error = ?,
          next_attempt_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL
        WHERE task_id = ? AND ${guard.sql}
      `)
      .run(timestamp, taskError(normalizedOptions.error), taskId, ...guard.parameters);

    if (Number(result.changes) !== 1) {
      return null;
    }

    return getTask(taskId);
  }

  function requeueTask(taskId, options = {}) {
    const normalizedOptions =
      options instanceof Error || typeof options === 'string' ? { error: options } : options;
    const leaseOwner = String(normalizedOptions.leaseOwner || '').trim();
    const timestamp = nowIso(normalizedOptions.now || new Date());
    const delayMs = Number(normalizedOptions.delayMs || 0);

    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError('delayMs must be a non-negative number');
    }

    const nextAttemptAt = normalizedOptions.nextAttemptAt
      ? nowIso(normalizedOptions.nextAttemptAt)
      : new Date(new Date(timestamp).getTime() + delayMs).toISOString();
    const hasError = Object.hasOwn(normalizedOptions, 'error');
    const guard = taskMutationWhere(leaseOwner, "status != 'done'");
    const result = database
      .prepare(`
        UPDATE tasks
        SET
          status = 'pending',
          started_at = NULL,
          completed_at = NULL,
          last_error = CASE WHEN ? = 1 THEN ? ELSE last_error END,
          next_attempt_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          result_completion_id = NULL
        WHERE task_id = ? AND ${guard.sql}
      `)
      .run(
        hasError ? 1 : 0,
        hasError ? taskError(normalizedOptions.error) : null,
        nextAttemptAt,
        taskId,
        ...guard.parameters,
      );

    if (Number(result.changes) !== 1) {
      return null;
    }

    return getTask(taskId);
  }

  function recordUnauthorizedUser(userId) {
    const timestamp = nowIso();
    database
      .prepare(`
        INSERT INTO unauthorized_users (user_id, first_seen_at, last_seen_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          request_count = unauthorized_users.request_count + 1
      `)
      .run(String(userId), timestamp, timestamp);
  }

  function listUnauthorizedUsers() {
    return database
      .prepare(
        'SELECT user_id, first_seen_at, last_seen_at, request_count FROM unauthorized_users ORDER BY last_seen_at DESC LIMIT 50',
      )
      .all();
  }

  return {
    bindNewTaskToThread,
    claimInboundMessage,
    close: () => database.close(),
    claimNextExecutableTask,
    createTask,
    findCompletionForExecutorTask,
    findLatestCompletionsByThreadTitle,
    findLatestCompletionForThreadSince,
    getCompletion,
    getExecutorSnapshot,
    getQueueCounts,
    getTask,
    listIncompleteThreadTasks,
    listQueuedCompletions,
    listTasks,
    listUnauthorizedUsers,
    markCompletionDeliveryFailure,
    markCompletionChunkSent,
    markCompletionSent,
    markTaskDone,
    markTaskFailed,
    recordCompletion,
    recordUnauthorizedUser,
    recoverAbandonedTaskLeases,
    recoverExpiredTaskLeases,
    requeueTask,
  };
}

module.exports = {
  createStore,
};
