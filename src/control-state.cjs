'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CONFIG_PATH,
  DATABASE_PATH,
  FEISHU_CONFIG_PATH,
  FEISHU_STATUS_PATH,
  INSTALL_STATE_PATH,
  PROJECT_ROOT,
  WORKER_LOCK_PATH,
  WORKER_SCRIPT_PATH,
  WORKER_START_LOCK_PATH,
  WORKER_STDERR_LOG_PATH,
  WORKER_STDOUT_LOG_PATH,
} = require('./constants.cjs');
const { isFeishuConfigured, readFeishuConfig } = require('./feishu-config.cjs');
const { readRuntimeConfig } = require('./runtime-config.cjs');
const { createStore } = require('./store.cjs');
const { getWorkerStatus } = require('./worker-lock.cjs');

function readJsonFile(filePath, onDiagnostic = () => {}) {
  if (!fs.existsSync(filePath)) {
    return { updatedAt: null, value: null };
  }

  try {
    return {
      updatedAt: fs.statSync(filePath).mtime.toISOString(),
      value: JSON.parse(fs.readFileSync(filePath, 'utf8')),
    };
  } catch (error) {
    onDiagnostic(`无法读取 ${filePath}：${error.message || error}`);
    return { updatedAt: null, value: null };
  }
}

function parseTopLevelNotifyCommand(configContent) {
  for (const line of String(configContent || '').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (/^\[\[?[^\]]+\]\]?$/.test(trimmed)) {
      break;
    }

    if (!/^notify\s*=/.test(trimmed)) {
      continue;
    }

    const literal = trimmed.replace(/^notify\s*=\s*/, '');

    try {
      const command = JSON.parse(literal);
      return Array.isArray(command) && command.every((value) => typeof value === 'string')
        ? command
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeComparablePath(value) {
  return path.win32.normalize(String(value || '')).toLocaleLowerCase('en-US');
}

function detectHookInstalled(configContent, relayScriptPath = path.join(PROJECT_ROOT, 'src', 'codex-notify.cjs')) {
  const expected = normalizeComparablePath(relayScriptPath);

  return parseTopLevelNotifyCommand(configContent).some(
    (argument) => normalizeComparablePath(argument) === expected,
  );
}

function buildFeishuStatus({ config, status, statusUpdatedAt, workerRunning }) {
  const ownerOpenId = String(config?.ownerOpenId || '').trim();
  const state = String(status?.state || (workerRunning ? 'unknown' : 'stopped')).trim();

  return {
    configured: isFeishuConfigured(config),
    online: Boolean(workerRunning && state === 'connected'),
    ownerConfigured: Boolean(ownerOpenId),
    pairingCode: ownerOpenId ? null : String(config?.pairingCode || '').trim() || null,
    state,
    statusUpdatedAt: statusUpdatedAt || null,
  };
}

function getControlPaths(environment = process.env) {
  const codexConfigPath =
    environment.CODEX_CONFIG_PATH || path.join(os.homedir(), '.codex', 'config.toml');

  return {
    codexConfigPath,
    configPath: CONFIG_PATH,
    databasePath: DATABASE_PATH,
    feishuConfigPath: FEISHU_CONFIG_PATH,
    feishuStatusPath: FEISHU_STATUS_PATH,
    notifyInstallStatePath: INSTALL_STATE_PATH,
    projectRoot: PROJECT_ROOT,
    workerLockPath: WORKER_LOCK_PATH,
    workerScriptPath: WORKER_SCRIPT_PATH,
    workerStartLockPath: WORKER_START_LOCK_PATH,
    workerStderrLogPath: WORKER_STDERR_LOG_PATH,
    workerStdoutLogPath: WORKER_STDOUT_LOG_PATH,
  };
}

function createControlStatus(options = {}) {
  const onDiagnostic = options.onDiagnostic || (() => {});
  const paths = options.paths || getControlPaths(options.environment);
  const now = options.now || new Date();
  const feishuWorkerStatus = readJsonFile(
    options.feishuStatusPath || paths.feishuStatusPath || FEISHU_STATUS_PATH,
    onDiagnostic,
  );
  const installState = readJsonFile(paths.notifyInstallStatePath, onDiagnostic);
  let config = null;
  let feishuConfig = null;
  let feishuConfigValid = false;
  let hookInstalled = false;
  let executorSnapshot = { lastError: null, runningTask: null };
  let queueCounts = {
    failedTasks: 0,
    pendingTasks: 0,
    queuedCompletions: 0,
    runningTasks: 0,
  };

  try {
    config = readRuntimeConfig(paths.configPath);
  } catch (error) {
    onDiagnostic(error.message || String(error));
  }

  try {
    feishuConfig = readFeishuConfig(options.feishuConfigPath || paths.feishuConfigPath);
    feishuConfigValid = true;
  } catch (error) {
    onDiagnostic(error.message || String(error));
  }

  try {
    hookInstalled = detectHookInstalled(
      fs.readFileSync(paths.codexConfigPath, 'utf8'),
      path.join(PROJECT_ROOT, 'src', 'codex-notify.cjs'),
    );
  } catch (error) {
    onDiagnostic(`无法检查 Codex 通知钩子：${error.message || error}`);
  }

  const storeFactory = options.storeFactory || createStore;
  let store;

  try {
    store = storeFactory(paths.databasePath);
    queueCounts = store.getQueueCounts();
    executorSnapshot = store.getExecutorSnapshot?.() || executorSnapshot;
  } catch (error) {
    onDiagnostic(`无法读取任务队列：${error.message || error}`);
    queueCounts = {
      failedTasks: null,
      pendingTasks: null,
      queuedCompletions: null,
      runningTasks: null,
    };
  } finally {
    store?.close();
  }

  const worker = getWorkerStatus(paths.workerLockPath);

  return {
    command: 'status',
    executor: {
      enabled: Boolean(config?.executorEnabled),
      lastError: executorSnapshot.lastError
        ? {
            at: executorSnapshot.lastError.completed_at,
            message: executorSnapshot.lastError.last_error,
            projectName: executorSnapshot.lastError.project_name,
            taskId: Number(executorSnapshot.lastError.task_id),
          }
        : null,
      runningTask: executorSnapshot.runningTask
        ? {
            instruction: executorSnapshot.runningTask.instruction,
            projectName: executorSnapshot.runningTask.project_name,
            startedAt: executorSnapshot.runningTask.started_at,
            taskId: Number(executorSnapshot.runningTask.task_id),
          }
        : null,
    },
    feishu: {
      configValid: feishuConfigValid,
      ...buildFeishuStatus({
        config: feishuConfig,
        status: feishuWorkerStatus.value,
        statusUpdatedAt: feishuWorkerStatus.updatedAt,
        workerRunning: worker.running,
      }),
    },
    generatedAt: now.toISOString(),
    hook: {
      installed: hookInstalled,
      installedAt:
        installState.value?.status === 'installed' ? installState.value.installedAt || null : null,
      statePresent: Boolean(installState.value),
    },
    ok: true,
    paths,
    queues: queueCounts,
    schemaVersion: 1,
    worker,
  };
}

module.exports = {
  buildFeishuStatus,
  createControlStatus,
  detectHookInstalled,
  getControlPaths,
  parseTopLevelNotifyCommand,
  readJsonFile,
};
