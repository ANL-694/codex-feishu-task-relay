'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  findLatestThreadsByTitle,
  readThreadSessionCwd,
} = require('../src/thread-registry.cjs');

test('侧栏线程从最新 turn_context 恢复原工作目录', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-registry-'));
  const sessionIndexPath = path.join(temporaryDirectory, 'session_index.jsonl');
  const sessionsDirectory = path.join(temporaryDirectory, 'sessions');
  const threadId = '11111111-1111-4111-8111-111111111111';
  const sessionDirectory = path.join(sessionsDirectory, '2026', '06', '27');
  const sessionPath = path.join(
    sessionDirectory,
    `rollout-2026-06-27T05-10-03-${threadId}.jsonl`,
  );

  try {
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(
      sessionIndexPath,
      `${JSON.stringify({ id: threadId, thread_name: 'anl api' })}\n`,
      'utf8',
    );
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd: 'E:\\旧目录' } }),
        JSON.stringify({ type: 'turn_context', payload: { cwd: 'E:\\workweb' } }),
      ].join('\n'),
      'utf8',
    );

    assert.equal(readThreadSessionCwd(threadId, sessionsDirectory), 'E:\\workweb');
    assert.deepEqual(findLatestThreadsByTitle('anl api', sessionIndexPath, sessionsDirectory), [
      {
        cwd: 'E:\\workweb',
        projectId: `thread:${threadId}`,
        projectName: 'anl api',
        threadId,
        updatedAt: null,
      },
    ]);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
