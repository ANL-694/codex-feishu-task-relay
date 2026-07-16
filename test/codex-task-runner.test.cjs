'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  findCodexExecutable,
  normalizeCandidate,
} = require('../src/codex-locator.cjs');
const {
  buildCodexNewArguments,
  buildCodexResumeArguments,
  createExecutorPrompt,
  parseCodexJsonLine,
  runCodexTask,
} = require('../src/codex-task-runner.cjs');

test('Codex 定位器忽略空路径和目录，只返回真实可执行文件', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-locator-'));
  const binRoot = path.join(temporaryDirectory, 'bin');
  const executable = path.join(binRoot, 'version-1', 'codex.exe');

  try {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '', 'utf8');

    assert.equal(normalizeCandidate(undefined), '');
    assert.equal(
      findCodexExecutable({
        binRoot,
        environment: { LOCALAPPDATA: temporaryDirectory, PATH: '' },
        explicitPath: temporaryDirectory,
        homeDirectory: temporaryDirectory,
      }),
      executable,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('Codex resume 参数使用任务 UUID 且不绕过安全配置', () => {
  const argumentsToPass = buildCodexResumeArguments({
    lastMessagePath: 'E:\\tmp\\last.txt',
    threadId: '11111111-1111-4111-8111-111111111111',
    workingDirectory: 'E:\\workweb',
  });

  assert.deepEqual(argumentsToPass.slice(0, 3), ['exec', '-C', 'E:\\workweb']);
  assert.ok(argumentsToPass.includes('--json'));
  assert.ok(argumentsToPass.includes('--output-last-message'));
  assert.ok(argumentsToPass.includes('11111111-1111-4111-8111-111111111111'));
  assert.equal(argumentsToPass.at(-1), '-');
  assert.ok(!argumentsToPass.includes('查看当前版本'));
  assert.ok(!argumentsToPass.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('Codex 新任务参数创建持久会话且不使用 resume 或危险开关', () => {
  const argumentsToPass = buildCodexNewArguments({
    lastMessagePath: 'E:\\tmp\\last.txt',
    workingDirectory: 'E:\\Codex临时任务\\task-1',
  });

  assert.deepEqual(argumentsToPass.slice(0, 3), [
    'exec',
    '-C',
    'E:\\Codex临时任务\\task-1',
  ]);
  assert.equal(argumentsToPass.at(-1), '-');
  assert.ok(argumentsToPass.includes('--json'));
  assert.ok(!argumentsToPass.includes('resume'));
  assert.ok(!argumentsToPass.includes('--ephemeral'));
  assert.ok(!argumentsToPass.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('飞书指令提示保持原任务安全边界', () => {
  const prompt = createExecutorPrompt('查看当前版本');

  assert.match(prompt, /沿用本任务已有上下文/);
  assert.match(prompt, /不要因为来源是飞书而降低确认要求/);
  assert.match(prompt, /查看当前版本$/);
});

test('解析 Codex JSONL 中的线程和最终答复', () => {
  const state = {};

  parseCodexJsonLine('{"type":"thread.started","thread_id":"thread-1"}', state);
  parseCodexJsonLine(
    '{"type":"item.completed","item":{"type":"agent_message","text":"完成"}}',
    state,
  );
  parseCodexJsonLine('{"type":"turn.completed"}', state);

  assert.equal(state.threadId, 'thread-1');
  assert.equal(state.lastAgentMessage, '完成');
  assert.equal(state.turnCompleted, true);
});

test('单任务运行器保存事件并读取 output-last-message', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-runner-'));
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};

  try {
    const resultPromise = runCodexTask(
      {
        attempt_count: 1,
        cwd: temporaryDirectory,
        instruction: '查看当前版本',
        task_id: 7,
        thread_id: '11111111-1111-4111-8111-111111111111',
      },
      {
        codexPath: 'codex-test.exe',
        outputRoot: temporaryDirectory,
        spawn(executable, argumentsToPass) {
          const outputIndex = argumentsToPass.indexOf('--output-last-message');
          const lastMessagePath = argumentsToPass[outputIndex + 1];
          let prompt = '';

          child.stdin.on('data', (chunk) => {
            prompt += chunk.toString('utf8');
          });
          child.stdin.on('finish', () => {
            assert.match(prompt, /查看当前版本/);
          });

          process.nextTick(() => {
            child.stdout.write('{"type":"thread.started","thread_id":"thread-7"}\n');
            child.stdout.write(
              '{"type":"item.completed","item":{"type":"agent_message","text":"事件答复"}}\n',
            );
            child.stdout.write('{"type":"turn.completed"}\n');
            child.stderr.write('warning\n');
            fs.writeFileSync(lastMessagePath, '文件答复\n', 'utf8');
            child.stdout.end();
            child.stderr.end();
            child.emit('close', 0, null);
          });

          assert.equal(executable, 'codex-test.exe');
          assert.deepEqual(argumentsToPass.slice(0, 3), ['exec', '-C', temporaryDirectory]);
          return child;
        },
      },
    );
    const result = await resultPromise;

    assert.equal(result.exitCode, 0);
    assert.equal(result.completed, true);
    assert.equal(result.threadId, 'thread-7');
    assert.equal(result.lastMessage, '文件答复');
    assert.match(fs.readFileSync(result.stdoutPath, 'utf8'), /turn.completed/);
    assert.match(fs.readFileSync(result.stderrPath, 'utf8'), /warning/);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('新任务运行器不传 resume 并返回新线程标识', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-new-task-runner-'));
  const child = new EventEmitter();
  child.pid = 22345;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};

  try {
    const resultPromise = runCodexTask(
      {
        attempt_count: 1,
        cwd: temporaryDirectory,
        execution_mode: 'new',
        instruction: '先调研可行性',
        task_id: 9,
        thread_id: null,
      },
      {
        codexPath: 'codex-test.exe',
        outputRoot: temporaryDirectory,
        spawn(executable, argumentsToPass) {
          const outputIndex = argumentsToPass.indexOf('--output-last-message');
          const lastMessagePath = argumentsToPass[outputIndex + 1];

          process.nextTick(() => {
            child.stdout.write(
              '{"type":"thread.started","thread_id":"11111111-1111-4111-8111-111111111111"}\n',
            );
            child.stdout.write('{"type":"turn.completed"}\n');
            fs.writeFileSync(lastMessagePath, '新任务已完成\n', 'utf8');
            child.stdout.end();
            child.stderr.end();
            child.emit('close', 0, null);
          });

          assert.equal(executable, 'codex-test.exe');
          assert.ok(!argumentsToPass.includes('resume'));
          assert.ok(!argumentsToPass.includes('--ephemeral'));
          return child;
        },
      },
    );
    const result = await resultPromise;

    assert.equal(result.completed, true);
    assert.equal(result.lastMessage, '新任务已完成');
    assert.equal(result.threadId, '11111111-1111-4111-8111-111111111111');
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('Codex 子进程启动失败时关闭运行日志并返回原错误', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-runner-error-'));
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};

  try {
    await assert.rejects(
      runCodexTask(
        {
          attempt_count: 1,
          cwd: temporaryDirectory,
          instruction: '查看当前版本',
          task_id: 8,
          thread_id: '11111111-1111-4111-8111-111111111111',
        },
        {
          codexPath: 'codex-test.exe',
          outputRoot: temporaryDirectory,
          spawn() {
            process.nextTick(() => child.emit('error', new Error('spawn failed')));
            return child;
          },
        },
      ),
      /spawn failed/,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
