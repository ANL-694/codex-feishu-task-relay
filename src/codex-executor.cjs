'use strict';

const { randomUUID } = require('node:crypto');
const {
  DEFAULT_TIMEOUT_MS,
  runCodexTask,
} = require('./codex-task-runner.cjs');
const { findThreadTurnCompletion } = require('./thread-session.cjs');

const DEFAULT_LEASE_HEADROOM_MS = 15 * 60 * 1000;
const DEFAULT_LEASE_MS = DEFAULT_TIMEOUT_MS + DEFAULT_LEASE_HEADROOM_MS;
const DEFAULT_DESKTOP_COMPLETION_WAIT_MS = DEFAULT_TIMEOUT_MS;
const DEFAULT_DESKTOP_EMPTY_COMPLETION_MESSAGE =
  'Codex Desktop 已完成任务，但没有生成可转发的最终答复。';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_NOTIFY_POLL_MS = 250;
const DEFAULT_NOTIFY_WAIT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const MAX_ERROR_MESSAGE_CHARS = 1_000;

class CodexTaskExecutionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.code = options.code || 'CODEX_TASK_EXECUTION_FAILED';
    this.name = 'CodexTaskExecutionError';
    this.retryable = options.retryable !== false;
  }
}

function asNonNegativeNumber(value, name) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }

  return number;
}

function asPositiveInteger(value, name) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return number;
}

function calculateRetryDelay(attemptCount, baseDelayMs, maximumDelayMs) {
  const exponent = Math.max(Number(attemptCount) - 1, 0);
  return Math.min(baseDelayMs * 2 ** exponent, maximumDelayMs);
}

function createSyntheticTurnId(task) {
  return `relay-executor-task-${String(task.task_id)}`;
}

function redactTaskInstruction(value, task) {
  let message = String(value || 'Codex 执行失败');
  const instruction = String(task?.instruction || '').trim();

  if (instruction) {
    message = message.split(instruction).join('[飞书指令已隐藏]');
  }

  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function errorMessage(error, task) {
  return redactTaskInstruction(error instanceof Error ? error.message : error, task);
}

function taskExecutionMode(task) {
  return String(task?.execution_mode || 'resume').trim().toLocaleLowerCase('en-US');
}

function validateExecutableTask(task) {
  const taskId = Number(task?.task_id);
  const threadId = String(task?.thread_id || '').trim();
  const projectId = String(task?.project_id || '').trim();
  const executionMode = taskExecutionMode(task);

  if (
    executionMode === 'new' &&
    Number.isInteger(taskId) &&
    taskId > 0 &&
    !threadId &&
    projectId.startsWith('new:') &&
    String(task?.cwd || '').trim()
  ) {
    return;
  }

  if (
    executionMode !== 'resume' ||
    !Number.isInteger(taskId) ||
    taskId <= 0 ||
    !threadId ||
    projectId !== `thread:${threadId}`
  ) {
    throw new CodexTaskExecutionError('任务缺少合法的 Codex 线程标识。', {
      code: 'INVALID_THREAD_TASK',
      retryable: false,
    });
  }
}

function requireSuccessfulResult(task, result) {
  if (!result || typeof result !== 'object') {
    throw new CodexTaskExecutionError('Codex 没有返回执行结果。', {
      code: 'MISSING_RESULT',
    });
  }

  if (result.timedOut) {
    throw new CodexTaskExecutionError('Codex 执行超时。', {
      code: 'CODEX_TIMEOUT',
    });
  }

  if (result.exitCode !== 0) {
    throw new CodexTaskExecutionError(`Codex 退出码异常（${String(result.exitCode)}）。`, {
      code: 'CODEX_EXIT_FAILED',
    });
  }

  if (result.completed !== true) {
    throw new CodexTaskExecutionError('Codex 未产生 turn.completed 事件。', {
      code: 'TURN_NOT_COMPLETED',
    });
  }

  const resultThreadId = String(result.threadId || '').trim();

  if (!resultThreadId) {
    throw new CodexTaskExecutionError('Codex 未返回线程标识。', {
      code: 'THREAD_ID_MISSING',
    });
  }

  if (
    taskExecutionMode(task) !== 'new' &&
    resultThreadId !== String(task.thread_id).trim()
  ) {
    throw new CodexTaskExecutionError('Codex 返回了不匹配的线程标识。', {
      code: 'THREAD_ID_MISMATCH',
      retryable: false,
    });
  }

  const lastMessage = String(result.lastMessage || '').trim();

  if (!lastMessage) {
    throw new CodexTaskExecutionError('Codex 没有生成最终答复。', {
      code: 'LAST_MESSAGE_MISSING',
    });
  }

  return lastMessage;
}

function isRetryableError(error) {
  return error?.retryable !== false;
}

function createCodexExecutor(options = {}) {
  const store = options.store;

  if (!store || typeof store.claimNextExecutableTask !== 'function') {
    throw new TypeError('store with claimNextExecutableTask is required');
  }

  const runner = options.runTask || runCodexTask;
  const runnerOptions = { ...(options.runnerOptions || {}) };
  const desktopBridge = options.desktopBridge || null;
  const desktopTurnCompletionReader =
    options.desktopTurnCompletionReader || findThreadTurnCompletion;
  const desktopCompletionWaitMs = asNonNegativeNumber(
    options.desktopCompletionWaitMs ?? DEFAULT_DESKTOP_COMPLETION_WAIT_MS,
    'desktopCompletionWaitMs',
  );
  const notifyWaitMs = asNonNegativeNumber(
    options.notifyWaitMs ?? DEFAULT_NOTIFY_WAIT_MS,
    'notifyWaitMs',
  );
  const notifyPollMs = asNonNegativeNumber(
    options.notifyPollMs ?? DEFAULT_NOTIFY_POLL_MS,
    'notifyPollMs',
  );
  const pollIntervalMs = asNonNegativeNumber(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    'pollIntervalMs',
  );
  const retryBaseMs = asNonNegativeNumber(
    options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    'retryBaseMs',
  );
  const retryMaxMs = asNonNegativeNumber(
    options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    'retryMaxMs',
  );
  const maxAttempts = asPositiveInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    'maxAttempts',
  );
  const runnerTimeoutMs = asNonNegativeNumber(
    runnerOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'runnerOptions.timeoutMs',
  );
  const defaultLeaseMs = Math.max(
    DEFAULT_LEASE_MS,
    runnerTimeoutMs + notifyWaitMs + DEFAULT_LEASE_HEADROOM_MS,
    desktopCompletionWaitMs + DEFAULT_LEASE_HEADROOM_MS,
  );
  const leaseMs = asNonNegativeNumber(options.leaseMs ?? defaultLeaseMs, 'leaseMs');
  const leaseOwner = String(
    options.leaseOwner || `codex-executor-${process.pid}-${randomUUID()}`,
  ).trim();
  const now = options.now || (() => new Date());
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const logger = Object.hasOwn(options, 'logger') ? options.logger : console;
  let activeChild = null;
  let activeTask = null;
  let childTerminationRequested = false;
  let completedTasks = 0;
  let failedTasks = 0;
  let lastError = null;
  let lastErrorAt = null;
  let loopPromise = null;
  let recoveredAbandonedLeases = false;
  let retryingTasks = 0;
  let started = false;
  let stopping = false;
  let wakePending = false;
  let waiter = null;

  if (!leaseOwner) {
    throw new TypeError('leaseOwner is required');
  }

  if (leaseMs <= 0) {
    throw new TypeError('leaseMs must be a positive number');
  }

  if ((notifyWaitMs > 0 || desktopCompletionWaitMs > 0) && notifyPollMs <= 0) {
    throw new TypeError('notifyPollMs must be positive when completion waiting is enabled');
  }

  if (retryMaxMs < retryBaseMs) {
    throw new TypeError('retryMaxMs must be greater than or equal to retryBaseMs');
  }

  function currentDate() {
    const value = now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new TypeError('now must return a valid date');
    }

    return date;
  }

  function log(level, message) {
    if (!logger) {
      return;
    }

    if (typeof logger === 'function') {
      logger(level, message);
      return;
    }

    const write =
      (typeof logger[level] === 'function' && logger[level].bind(logger)) ||
      (typeof logger.log === 'function' && logger.log.bind(logger));
    write?.(message);
  }

  function rememberError(error, task) {
    lastError = errorMessage(error, task);
    lastErrorAt = currentDate().toISOString();
    return lastError;
  }

  function getState() {
    return {
      activeTask: activeTask
        ? {
            attemptCount: Number(activeTask.attempt_count) || 0,
            projectName: String(activeTask.project_name || '未命名对话'),
            startedAt: activeTask.started_at || null,
            taskId: Number(activeTask.task_id),
            threadId: String(activeTask.thread_id || ''),
          }
        : null,
      completedTasks,
      failedTasks,
      lastError,
      lastErrorAt,
      leaseMs,
      leaseOwner,
      retryingTasks,
      running: started && !stopping,
      started,
      stopping,
    };
  }

  function finishWait(reason) {
    const currentWaiter = waiter;

    if (!currentWaiter) {
      return false;
    }

    waiter = null;

    if (currentWaiter.timer !== null) {
      clearTimer(currentWaiter.timer);
    }

    currentWaiter.resolve(reason);
    return true;
  }

  function waitForSignal(milliseconds) {
    if (stopping) {
      return Promise.resolve('stop');
    }

    if (wakePending) {
      wakePending = false;
      return Promise.resolve('wake');
    }

    if (milliseconds <= 0) {
      return Promise.resolve('timer');
    }

    return new Promise((resolve) => {
      const currentWaiter = {
        resolve,
        timer: null,
      };
      currentWaiter.timer = setTimer(() => {
        if (waiter === currentWaiter) {
          waiter = null;
          resolve('timer');
        }
      }, milliseconds);
      waiter = currentWaiter;
    });
  }

  function wake() {
    if (!finishWait('wake')) {
      wakePending = true;
    }

    return getState();
  }

  function terminateActiveChild() {
    const child = activeChild;

    if (!child || typeof child.kill !== 'function' || childTerminationRequested) {
      return false;
    }

    try {
      const killed = child.kill();

      if (killed !== false) {
        childTerminationRequested = true;
        return true;
      }
    } catch {
      log('error', `停止 Codex 子进程失败：T-${Number(activeTask?.task_id) || '未知'}`);
    }

    return false;
  }

  function setActiveChild(child) {
    activeChild = child || null;

    try {
      runnerOptions.onChild?.(child);
    } catch {
      log('error', 'Codex 子进程状态回调失败。');
    }

    if (activeChild && stopping) {
      terminateActiveChild();
    }
  }

  async function findHookCompletion(task) {
    let remainingMs = notifyWaitMs;

    for (;;) {
      const completion =
        typeof store.findCompletionForExecutorTask === 'function'
          ? store.findCompletionForExecutorTask(task.task_id)
          : store.findLatestCompletionForThreadSince(task.thread_id, task.started_at);

      if (completion) {
        return completion;
      }

      if (remainingMs <= 0 || stopping) {
        return null;
      }

      const delayMs = Math.min(notifyPollMs, remainingMs);
      await waitForSignal(delayMs);
      remainingMs -= delayMs;
    }
  }

  function desktopTurnId(task) {
    return String(task?.desktop_turn_id || '').trim() || null;
  }

  function recordDesktopCompletion(task, turnId, desktopCompletion) {
    const finalMessage =
      String(desktopCompletion?.finalMessage || '').trim() ||
      DEFAULT_DESKTOP_EMPTY_COMPLETION_MESSAGE;
    const recorded = store.recordCompletion({
      cwd: String(task.cwd || ''),
      executorTaskId: task.task_id,
      finalMessage,
      inputSummary: `飞书任务 T-${task.task_id} 通过 Codex Desktop 执行`,
      projectId: String(task.project_id),
      projectName: String(task.project_name || '未命名对话'),
      threadId: String(task.thread_id),
      turnId,
    });
    const completion = recorded?.completion;

    if (!completion?.completion_id) {
      throw new CodexTaskExecutionError('无法保存 Codex Desktop 最终答复。', {
        code: 'DESKTOP_COMPLETION_NOT_RECORDED',
      });
    }

    return completion;
  }

  async function findDesktopCompletion(task, turnId) {
    let remainingMs = desktopCompletionWaitMs;

    for (;;) {
      const storedCompletion =
        typeof store.findCompletionForThreadTurn === 'function'
          ? store.findCompletionForThreadTurn(task.thread_id, turnId)
          : null;

      if (storedCompletion) {
        return storedCompletion;
      }

      const desktopCompletion = await desktopTurnCompletionReader(task.thread_id, turnId);

      if (desktopCompletion) {
        return recordDesktopCompletion(task, turnId, desktopCompletion);
      }

      if (remainingMs <= 0 || stopping) {
        return null;
      }

      const delayMs = Math.min(notifyPollMs, remainingMs);
      await waitForSignal(delayMs);
      remainingMs -= delayMs;
    }
  }

  async function completeTask(task, completion) {
    const done = store.markTaskDone(task.task_id, {
      leaseOwner,
      now: currentDate(),
      resultCompletionId: completion.completion_id,
    });

    if (!done) {
      throw new CodexTaskExecutionError('任务执行租约已失效，无法写入完成状态。', {
        code: 'TASK_LEASE_LOST',
      });
    }

    completedTasks += 1;
    log('info', `T-${task.task_id} 已完成，结果 C-${completion.completion_id} 已进入飞书队列。`);
  }

  async function tryDesktopDelivery(task) {
    if (taskExecutionMode(task) !== 'resume') {
      return null;
    }

    const existingTurnId = desktopTurnId(task);

    if (existingTurnId) {
      return { task, turnId: existingTurnId };
    }

    if (!desktopBridge) {
      return null;
    }

    const dispatched = await desktopBridge.dispatch(task);

    if (!dispatched?.available) {
      return null;
    }

    const turnId = String(dispatched.turnId || '').trim();

    if (!turnId) {
      throw new CodexTaskExecutionError('Codex Desktop 未返回任务 turn 标识。', {
        code: 'DESKTOP_TURN_ID_MISSING',
      });
    }

    if (typeof store.markTaskDesktopTurn !== 'function') {
      throw new CodexTaskExecutionError('任务库不支持保存 Codex Desktop turn。', {
        code: 'DESKTOP_TURN_PERSISTENCE_UNSUPPORTED',
        retryable: false,
      });
    }

    const updatedTask = store.markTaskDesktopTurn(task.task_id, {
      leaseOwner,
      turnId,
    });

    if (!updatedTask) {
      throw new CodexTaskExecutionError('无法保存 Codex Desktop turn 标识。', {
        code: 'DESKTOP_TURN_PERSISTENCE_FAILED',
      });
    }

    return { task: updatedTask, turnId };
  }

  function recordSyntheticCompletion(task, result, lastMessage) {
    const recorded = store.recordCompletion({
      cwd: String(result.workingDirectory || task.cwd || ''),
      executorTaskId: task.task_id,
      finalMessage: lastMessage,
        inputSummary: `飞书任务 T-${task.task_id} 自动执行`,
      projectId: String(task.project_id),
      projectName: String(task.project_name || '未命名对话'),
      threadId: String(task.thread_id),
      turnId: createSyntheticTurnId(task),
    });
    const completion = recorded?.completion;

    if (!completion?.completion_id) {
      throw new CodexTaskExecutionError('无法保存 Codex 最终答复。', {
        code: 'COMPLETION_NOT_RECORDED',
      });
    }

    return completion;
  }

  async function requeueStoppedTask(task) {
    const requeued = store.requeueTask(task.task_id, {
      delayMs: 0,
      leaseOwner,
      now: currentDate(),
    });

    if (requeued) {
      log('info', `Codex 执行器停止，T-${task.task_id} 已放回待执行队列。`);
      return;
    }

    log('warn', `Codex 执行器停止时无法重排 T-${task.task_id}，将由租约恢复机制接管。`);
  }

  function settleTaskFailure(task, error) {
    const message = rememberError(error, task);
    const attemptCount = Math.max(Number(task.attempt_count) || 1, 1);
    const retryable = isRetryableError(error);

    if (retryable && attemptCount < maxAttempts) {
      const delayMs = calculateRetryDelay(attemptCount, retryBaseMs, retryMaxMs);
      const requeued = store.requeueTask(task.task_id, {
        delayMs,
        error: message,
        leaseOwner,
        now: currentDate(),
      });

      if (!requeued) {
        log('warn', `T-${task.task_id} 的执行租约已失效，等待租约恢复。`);
        return;
      }

      retryingTasks += 1;
      log('warn', `T-${task.task_id} 第 ${attemptCount} 次执行失败，${delayMs} 毫秒后重试。`);
      return;
    }

    const failed = store.markTaskFailed(task.task_id, {
      error: message,
      leaseOwner,
      now: currentDate(),
    });

    if (!failed) {
      log('warn', `T-${task.task_id} 的执行租约已失效，无法写入失败状态。`);
      return;
    }

    failedTasks += 1;
    log(
      'error',
      retryable
        ? `T-${task.task_id} 已达到 ${maxAttempts} 次执行上限。`
        : `T-${task.task_id} 遇到不可重试错误，已停止执行。`,
    );
  }

  async function executeTask(task) {
    childTerminationRequested = false;

    try {
      validateExecutableTask(task);
    } catch (error) {
      settleTaskFailure(task, error);
      return;
    }

    try {
      log('info', `开始执行 T-${task.task_id}（${String(task.project_name || '未命名对话')}）。`);
      const desktopDelivery = await tryDesktopDelivery(task);

      if (desktopDelivery) {
        const completion = await findDesktopCompletion(
          desktopDelivery.task,
          desktopDelivery.turnId,
        );

        if (!completion) {
          throw new CodexTaskExecutionError('等待 Codex Desktop 会话完成结果超时。', {
            code: 'DESKTOP_COMPLETION_TIMEOUT',
          });
        }

        await completeTask(desktopDelivery.task, completion);
        return;
      }

      const result = await runner(task, {
        ...runnerOptions,
        onChild: setActiveChild,
      });
      activeChild = null;
      let resultTask = task;
      const resultThreadId = String(result?.threadId || '').trim();

      if (taskExecutionMode(task) === 'new' && resultThreadId) {
        if (typeof store.bindNewTaskToThread !== 'function') {
          throw new CodexTaskExecutionError('任务库不支持绑定新 Codex 线程。', {
            code: 'THREAD_BINDING_UNSUPPORTED',
            retryable: false,
          });
        }

        resultTask = store.bindNewTaskToThread(task.task_id, {
          leaseOwner,
          threadId: resultThreadId,
        });

        if (!resultTask) {
          throw new CodexTaskExecutionError('无法将新任务绑定到 Codex 线程。', {
            code: 'THREAD_BINDING_FAILED',
          });
        }
      }

      const lastMessage = requireSuccessfulResult(resultTask, result);
      let completion = await findHookCompletion(resultTask);

      if (!completion) {
        completion = recordSyntheticCompletion(resultTask, result, lastMessage);
      }

      await completeTask(resultTask, completion);
    } catch (error) {
      activeChild = null;

      if (stopping || childTerminationRequested) {
        await requeueStoppedTask(task);
        return;
      }

      settleTaskFailure(task, error);
    }
  }

  function recoverAbandonedLeasesOnce() {
    if (recoveredAbandonedLeases) {
      return;
    }

    recoveredAbandonedLeases = true;

    if (typeof store.recoverAbandonedTaskLeases !== 'function') {
      return;
    }

    const recovered = store.recoverAbandonedTaskLeases(currentDate());

    if (Number(recovered) > 0) {
      log('info', `已恢复 ${Number(recovered)} 个上次退出时遗留的 Codex 任务。`);
    }
  }

  async function runLoop() {
    try {
      recoverAbandonedLeasesOnce();
    } catch (error) {
      rememberError(error);
      log('error', 'Codex 执行器无法恢复遗留任务租约。');
    }

    while (!stopping) {
      let task;

      try {
        task = store.claimNextExecutableTask({
          leaseMs,
          leaseOwner,
          now: currentDate(),
        });
      } catch (error) {
        rememberError(error);
        log('error', 'Codex 执行器领取任务失败，稍后重试。');
        await waitForSignal(pollIntervalMs);
        continue;
      }

      if (!task) {
        await waitForSignal(pollIntervalMs);
        continue;
      }

      activeTask = task;

      try {
        await executeTask(task);
      } catch (error) {
        rememberError(error, task);
        log('error', `T-${task.task_id} 发生未处理的执行器错误。`);
      } finally {
        activeChild = null;
        activeTask = null;
        childTerminationRequested = false;
      }
    }
  }

  function start() {
    if (started) {
      return getState();
    }

    started = true;
    stopping = false;
    wakePending = false;
    const currentLoop = runLoop();
    loopPromise = currentLoop.finally(() => {
      if (loopPromise) {
        loopPromise = null;
      }

      activeChild = null;
      activeTask = null;
      started = false;
      stopping = false;
      wakePending = false;
      finishWait('stop');
    });
    return getState();
  }

  async function stop() {
    if (!started || !loopPromise) {
      return getState();
    }

    stopping = true;
    finishWait('stop');
    terminateActiveChild();
    await loopPromise;
    return getState();
  }

  return {
    getState,
    start,
    stop,
    wake,
  };
}

module.exports = {
  CodexTaskExecutionError,
  DEFAULT_DESKTOP_COMPLETION_WAIT_MS,
  DEFAULT_LEASE_HEADROOM_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_NOTIFY_POLL_MS,
  DEFAULT_NOTIFY_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
  calculateRetryDelay,
  createCodexExecutor,
  createSyntheticTurnId,
  isRetryableError,
  requireSuccessfulResult,
  taskExecutionMode,
  validateExecutableTask,
};
