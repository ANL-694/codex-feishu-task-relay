'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  findThreadTurnCompletion,
  listThreadSessionFiles,
} = require('../src/thread-session.cjs');

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_TURN_ID = '22222222-2222-4222-8222-222222222222';

function writeSessionFile(directory, fileName, entries) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, fileName),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
}

test('从本机 session JSONL 读取指定 Desktop turn 的 task_complete', () => {
  const sessionsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-'));

  try {
    const olderDirectory = path.join(sessionsDirectory, '2026', '07', '16');
    const newerDirectory = path.join(sessionsDirectory, '2026', '07', '17');
    writeSessionFile(olderDirectory, `rollout-old-${THREAD_ID}.jsonl`, [
      {
        type: 'event_msg',
        payload: {
          completed_at: 1_784_236_582,
          last_agent_message: '  已在桌面线程完成。  ',
          turn_id: TARGET_TURN_ID,
          type: 'task_complete',
        },
      },
    ]);
    writeSessionFile(newerDirectory, `rollout-new-${THREAD_ID}.jsonl`, [
      {
        type: 'event_msg',
        payload: {
          last_agent_message: '其他任务。',
          turn_id: '33333333-3333-4333-8333-333333333333',
          type: 'task_complete',
        },
      },
      '{not valid json',
    ]);

    const completion = findThreadTurnCompletion(THREAD_ID, TARGET_TURN_ID, sessionsDirectory);

    assert.deepEqual(completion, {
      completedAt: 1_784_236_582,
      finalMessage: '已在桌面线程完成。',
      turnId: TARGET_TURN_ID,
    });
    assert.equal(listThreadSessionFiles(THREAD_ID, sessionsDirectory).length, 2);
  } finally {
    fs.rmSync(sessionsDirectory, { force: true, recursive: true });
  }
});

test('未完成或无效的 turn 不会被误认为完成', () => {
  const sessionsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-'));

  try {
    writeSessionFile(
      path.join(sessionsDirectory, '2026', '07', '17'),
      `rollout-${THREAD_ID}.jsonl`,
      [{ type: 'event_msg', payload: { turn_id: TARGET_TURN_ID, type: 'task_started' } }],
    );

    assert.equal(findThreadTurnCompletion(THREAD_ID, TARGET_TURN_ID, sessionsDirectory), null);
    assert.equal(findThreadTurnCompletion(THREAD_ID, 'invalid-turn', sessionsDirectory), null);
  } finally {
    fs.rmSync(sessionsDirectory, { force: true, recursive: true });
  }
});
