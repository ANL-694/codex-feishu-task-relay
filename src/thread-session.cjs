'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeThreadId(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase('en-US');
  return THREAD_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeSubagentLabel(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();

  if (!/^[A-Za-z0-9_-]{1,48}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function readSubagentLabel(payload) {
  const nickname = normalizeSubagentLabel(payload?.agent_nickname);

  if (nickname) {
    return nickname;
  }

  const agentPath = Array.isArray(payload?.agent_path) ? payload.agent_path.at(-1) : null;
  return normalizeSubagentLabel(agentPath);
}

function findThreadSessionFile(threadId, sessionsDirectory = SESSIONS_DIR) {
  const normalizedThreadId = normalizeThreadId(threadId);

  if (!normalizedThreadId) {
    return null;
  }

  const stack = [sessionsDirectory];
  const candidates = [];

  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;

    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (
        entry.isFile() &&
        entry.name.toLocaleLowerCase('en-US').endsWith(`${normalizedThreadId}.jsonl`)
      ) {
        candidates.push(entryPath);
      }
    }
  }

  candidates.sort((left, right) => {
    try {
      return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });

  return candidates[0] || null;
}

function readThreadSessionMetadata(threadId, sessionsDirectory = SESSIONS_DIR) {
  const sessionFile = findThreadSessionFile(threadId, sessionsDirectory);

  if (!sessionFile) {
    return null;
  }

  let source;

  try {
    source = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    return null;
  }

  let metadata = null;

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);

      if (!entry?.payload || typeof entry.payload !== 'object') {
        continue;
      }

      const payload = entry.payload;

      if (entry.type === 'session_meta') {
        metadata = {
          cwd: typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : null,
          parentThreadId: normalizeThreadId(payload.parent_thread_id),
          subagentLabel: readSubagentLabel(payload),
          threadSource: String(payload.thread_source || '').trim(),
        };
        continue;
      }

      if (
        entry.type === 'turn_context' &&
        metadata &&
        typeof payload.cwd === 'string' &&
        payload.cwd.trim()
      ) {
        metadata.cwd = payload.cwd.trim();
      }
    } catch {
      continue;
    }
  }

  return metadata;
}

function isSubagentThread(threadId, sessionsDirectory = SESSIONS_DIR) {
  return readThreadSessionMetadata(threadId, sessionsDirectory)?.threadSource === 'subagent';
}

module.exports = {
  CODEX_HOME,
  SESSIONS_DIR,
  THREAD_ID_PATTERN,
  findThreadSessionFile,
  isSubagentThread,
  normalizeThreadId,
  readThreadSessionMetadata,
};
