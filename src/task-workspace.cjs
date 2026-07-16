'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('./constants.cjs');

function defaultNewTaskRoot(projectRoot = PROJECT_ROOT) {
  return path.join(path.parse(path.resolve(projectRoot)).root, 'Codex临时任务');
}

function formatDirectoryTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError('now must return a valid date');
  }

  const pad = (number) => String(number).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function ensureNestedWorkspacePath(rootDirectory, directoryName) {
  const root = path.resolve(rootDirectory);
  const workspace = path.resolve(root, directoryName);
  const relative = path.relative(root, workspace);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('新任务工作目录不在隔离根目录内。');
  }

  return { root, workspace };
}

function createTaskWorkspace(options = {}) {
  const rootDirectory = options.rootDirectory || defaultNewTaskRoot(options.projectRoot);
  const now = options.now || (() => new Date());
  const createId = options.createId || randomUUID;
  const workspaceId = String(createId()).trim();

  if (!/^[A-Za-z0-9-]{8,64}$/.test(workspaceId)) {
    throw new Error('无法生成安全的新任务标识。');
  }

  const shortId = workspaceId.replaceAll('-', '').slice(0, 8);
  const directoryName = `${formatDirectoryTimestamp(now())}-${shortId}`;
  const { root, workspace } = ensureNestedWorkspacePath(rootDirectory, directoryName);

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(workspace, { recursive: false });

  return {
    id: workspaceId,
    root,
    workspace,
  };
}

module.exports = {
  createTaskWorkspace,
  defaultNewTaskRoot,
  ensureNestedWorkspacePath,
  formatDirectoryTimestamp,
};
