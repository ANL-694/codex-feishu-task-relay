'use strict';

const path = require('node:path');
const { createWorkerControlPipePath } = require('./worker-control.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const CONFIG_PATH = path.join(CONFIG_DIR, 'projects.json');
const DATABASE_PATH = path.join(DATA_DIR, 'relay.sqlite');
const FEISHU_CONFIG_PATH = path.join(DATA_DIR, 'feishu-config.json');
const FEISHU_STATUS_PATH = path.join(DATA_DIR, 'feishu-worker-status.json');
const INSTALL_STATE_PATH = path.join(DATA_DIR, 'notify-install-state.json');
const WORKER_LOCK_PATH = path.join(DATA_DIR, 'relay-worker.lock');
const WORKER_CONTROL_PIPE = createWorkerControlPipePath(PROJECT_ROOT);
const WORKER_START_LOCK_PATH = path.join(DATA_DIR, 'relay-worker.start.lock');
const WORKER_SCRIPT_PATH = path.join(PROJECT_ROOT, 'src', 'worker.cjs');
const WORKER_STDOUT_LOG_PATH = path.join(DATA_DIR, 'relay-worker.stdout.log');
const WORKER_STDERR_LOG_PATH = path.join(DATA_DIR, 'relay-worker.stderr.log');

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  DATA_DIR,
  DATABASE_PATH,
  FEISHU_CONFIG_PATH,
  FEISHU_STATUS_PATH,
  INSTALL_STATE_PATH,
  PROJECT_ROOT,
  WORKER_CONTROL_PIPE,
  WORKER_LOCK_PATH,
  WORKER_SCRIPT_PATH,
  WORKER_START_LOCK_PATH,
  WORKER_STDERR_LOG_PATH,
  WORKER_STDOUT_LOG_PATH,
};
