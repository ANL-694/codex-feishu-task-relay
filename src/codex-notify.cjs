'use strict';

const { spawn } = require('node:child_process');
const { createStore } = require('./store.cjs');
const { isSubagentThread } = require('./thread-session.cjs');
const { resolveThreadTitle } = require('./thread-title.cjs');

function parsePayload(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function forwardLegacyNotification(argumentsToForward, rawPayload) {
  if (argumentsToForward.length === 0 || !rawPayload) {
    return;
  }

  try {
    const child = spawn(
      argumentsToForward[0],
      [...argumentsToForward.slice(1), rawPayload],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.once('error', () => {});
    child.unref();
  } catch {
    return;
  }
}

function describeThread(threadId, title) {
  const normalizedThreadId = String(threadId || '').trim();
  const normalizedTitle = String(title || '').trim();

  return {
    id: `thread:${normalizedThreadId || 'unknown'}`,
    name: normalizedTitle || '未命名对话',
  };
}

function readExecutorTaskId(environment = process.env) {
  const value = Number(environment.CODEX_RELAY_EXECUTOR_TASK_ID);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function resolveExecutorTaskContext({ executorTaskId, sessionsDirectory, store, threadId }) {
  if (!executorTaskId || typeof store.getTask !== 'function') {
    return null;
  }

  const task = store.getTask(executorTaskId);

  if (!task || task.status !== 'running') {
    return null;
  }

  const executionMode = String(task.execution_mode || 'resume').trim();

  if (executionMode === 'resume' && String(task.thread_id || '').trim() === threadId) {
    return {
      executorTaskId,
      projectName: String(task.project_name || '').trim() || null,
    };
  }

  if (executionMode === 'new' && !isSubagentThread(threadId, sessionsDirectory)) {
    return {
      executorTaskId: null,
      projectName: String(task.project_name || '').trim() || null,
    };
  }

  return null;
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const rawPayload = argv.at(-1);
  const forwardIndex = argv.indexOf('--forward');
  const argumentsToForward =
    forwardIndex === -1 ? [] : argv.slice(forwardIndex + 1, Math.max(forwardIndex + 1, argv.length - 1));

  forwardLegacyNotification(argumentsToForward, rawPayload);

  const payload = parsePayload(rawPayload);

  if (!payload || payload.type !== 'agent-turn-complete') {
    return { ignored: true, reason: '不是 Codex 任务完成事件' };
  }

  const finalMessage = String(payload['last-assistant-message'] || '任务已结束，但没有生成最终摘要。');
  const inputMessages = Array.isArray(payload['input-messages']) ? payload['input-messages'] : [];
  const threadId = String(payload['thread-id'] || '');
  const store = dependencies.store || createStore();
  const ownsStore = !dependencies.store;
  const executorTaskId = readExecutorTaskId(dependencies.environment || process.env);

  try {
    const executorTask = resolveExecutorTaskContext({
      executorTaskId,
      sessionsDirectory: dependencies.sessionsDirectory,
      store,
      threadId,
    });
    const titleResolver = dependencies.resolveThreadTitle || resolveThreadTitle;
    const threadTitle = executorTask?.projectName || titleResolver({
      cwd: payload.cwd,
      inputMessages,
      sessionIndexPath: dependencies.sessionIndexPath,
      sessionsDirectory: dependencies.sessionsDirectory,
      threadId,
    });

    if (!threadTitle) {
      return { ignored: true, reason: '不是可关联到主任务的 Codex 对话线程' };
    }

    const thread = describeThread(threadId, threadTitle);

    return store.recordCompletion({
      cwd: String(payload.cwd || ''),
      executorTaskId: executorTask?.executorTaskId || null,
      finalMessage,
      inputSummary: inputMessages.join(' | ').slice(0, 1000),
      projectId: thread.id,
      projectName: thread.name,
      threadId,
      turnId: String(payload['turn-id'] || ''),
    });
  } finally {
    if (ownsStore) {
      store.close();
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exitCode = 0;
  }
}

module.exports = {
  describeThread,
  main,
  parsePayload,
  readExecutorTaskId,
  resolveExecutorTaskContext,
};
