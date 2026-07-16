'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createTaskWorkspace,
  ensureNestedWorkspacePath,
} = require('../src/task-workspace.cjs');

test('新任务目录只使用时间和随机标识且始终位于隔离根目录', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-new-task-root-'));

  try {
    const result = createTaskWorkspace({
      createId: () => '12345678-1234-1234-1234-123456789abc',
      now: () => new Date('2026-07-17T01:02:03.000Z'),
      rootDirectory: temporaryDirectory,
    });
    const relative = path.relative(temporaryDirectory, result.workspace);

    assert.equal(result.id, '12345678-1234-1234-1234-123456789abc');
    assert.equal(relative.includes('项目'), false);
    assert.match(relative, /^\d{8}-\d{6}-12345678$/);
    assert.equal(fs.statSync(result.workspace).isDirectory(), true);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.startsWith('..'), false);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('隔离目录校验拒绝根目录本身和越界路径', () => {
  const root = path.resolve('E:\\Codex临时任务');

  assert.throws(() => ensureNestedWorkspacePath(root, '.'), /不在隔离根目录内/);
  assert.throws(() => ensureNestedWorkspacePath(root, '..\\其他目录'), /不在隔离根目录内/);
});
