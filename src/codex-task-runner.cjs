'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DATA_DIR, PROJECT_ROOT } = require('./constants.cjs');
const { findCodexExecutable } = require('./codex-locator.cjs');

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_STDERR_TAIL_CHARS = 12_000;

function createExecutorPrompt(instruction) {
  return [
    '以下内容来自已授权飞书 owner，是当前 Codex 任务的下一步指令。',
    '请沿用本任务已有上下文、工作目录、规则和安全边界执行；不要因为来源是飞书而降低确认要求。',
    '完成后正常给出最终总结；如果被权限、登录、验证码或必须由用户决定的事项阻塞，请明确说明。',
    '',
    String(instruction || '').trim(),
  ].join('\n');
}

function buildCodexResumeArguments({ lastMessagePath, threadId, workingDirectory }) {
  return [
    'exec',
    '-C',
    workingDirectory,
    '--skip-git-repo-check',
    '--json',
    '--output-last-message',
    lastMessagePath,
    'resume',
    threadId,
    '-',
  ];
}

function buildCodexNewArguments({ lastMessagePath, workingDirectory }) {
  return [
    'exec',
    '-C',
    workingDirectory,
    '--skip-git-repo-check',
    '--json',
    '--output-last-message',
    lastMessagePath,
    '-',
  ];
}

function isExistingDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function parseCodexJsonLine(line, state) {
  let event;

  try {
    event = JSON.parse(String(line).trim());
  } catch {
    return false;
  }

  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    state.threadId = event.thread_id;
  }

  if (
    event.type === 'item.completed' &&
    event.item?.type === 'agent_message' &&
    typeof event.item.text === 'string'
  ) {
    state.lastAgentMessage = event.item.text;
  }

  if (event.type === 'turn.completed') {
    state.turnCompleted = true;
  }

  return true;
}

function appendTail(current, addition, maximumCharacters = MAX_STDERR_TAIL_CHARS) {
  const combined = `${current}${addition}`;
  return combined.length > maximumCharacters
    ? combined.slice(combined.length - maximumCharacters)
    : combined;
}

function closeWritable(stream) {
  return new Promise((resolve) => {
    if (stream.closed || stream.destroyed) {
      resolve();
      return;
    }

    stream.once('finish', resolve);
    stream.end();
  });
}

async function runCodexTask(task, options = {}) {
  const outputRoot = options.outputRoot || path.join(DATA_DIR, 'executor-runs');
  const attempt = Math.max(Number(task.attempt_count) || 1, 1);
  const runName = `task-${task.task_id}-attempt-${attempt}`;
  const runDirectory = path.join(outputRoot, runName);
  const stdoutPath = path.join(runDirectory, 'events.jsonl');
  const stderrPath = path.join(runDirectory, 'stderr.log');
  const lastMessagePath = path.join(runDirectory, 'last-message.txt');
  const prompt = createExecutorPrompt(task.instruction);
  const codexPath = options.codexPath || findCodexExecutable(options.locatorOptions);
  const executionMode = String(task.execution_mode || 'resume').trim();
  let workingDirectory;

  if (executionMode === 'new') {
    if (!task.cwd || !isExistingDirectory(task.cwd)) {
      throw new Error('新任务的隔离工作目录不存在。');
    }

    workingDirectory = task.cwd;
  } else {
    workingDirectory =
      task.cwd && isExistingDirectory(task.cwd) ? task.cwd : options.projectRoot || PROJECT_ROOT;
  }

  const argumentsToPass = executionMode === 'new'
    ? buildCodexNewArguments({ lastMessagePath, workingDirectory })
    : buildCodexResumeArguments({
        lastMessagePath,
        threadId: task.thread_id,
        workingDirectory,
      });
  const state = {
    lastAgentMessage: null,
    threadId: null,
    turnCompleted: false,
  };
  const spawnProcess = options.spawn || spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  fs.mkdirSync(runDirectory, { recursive: true });
  const stdoutFile = fs.createWriteStream(stdoutPath, { encoding: 'utf8' });
  const stderrFile = fs.createWriteStream(stderrPath, { encoding: 'utf8' });
  const child = spawnProcess(codexPath, argumentsToPass, {
    cwd: workingDirectory,
    env: {
      ...process.env,
      ...(options.environment || {}),
      CODEX_RELAY_EXECUTOR_TASK_ID: String(task.task_id),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  options.onChild?.(child);
  child.stdin.on('error', () => {});
  child.stdin.end(prompt, 'utf8');
  let stdoutBuffer = '';
  let stderrTail = '';
  let timedOut = false;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdoutFile.write(text);
    stdoutBuffer += text;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      parseCodexJsonLine(line, state);
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrFile.write(text);
    stderrTail = appendTail(stderrTail, text);
  });

  let exit;

  try {
    exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
  } finally {
    options.onChild?.(null);
    await Promise.all([closeWritable(stdoutFile), closeWritable(stderrFile)]);
  }

  if (stdoutBuffer.trim()) {
    parseCodexJsonLine(stdoutBuffer, state);
  }

  let lastMessage = state.lastAgentMessage;

  try {
    const writtenMessage = fs.readFileSync(lastMessagePath, 'utf8').trim();

    if (writtenMessage) {
      lastMessage = writtenMessage;
    }
  } catch {
  }

  return {
    arguments: argumentsToPass,
    codexPath,
    completed: state.turnCompleted,
    exitCode: exit.code,
    lastMessage,
    lastMessagePath,
    runDirectory,
    signal: exit.signal,
    stderrPath,
    stderrTail,
    stdoutPath,
    threadId: state.threadId,
    timedOut,
    workingDirectory,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_STDERR_TAIL_CHARS,
  appendTail,
  buildCodexNewArguments,
  buildCodexResumeArguments,
  createExecutorPrompt,
  parseCodexJsonLine,
  runCodexTask,
};
