'use strict';

const fs = require('node:fs');
const { SESSION_INDEX_PATH } = require('./thread-title.cjs');
const {
  SESSIONS_DIR,
  THREAD_ID_PATTERN,
  findThreadSessionFile,
  readThreadSessionMetadata,
} = require('./thread-session.cjs');

const MAX_INDEX_LINE_LENGTH = 64 * 1024;

function normalizeThreadTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function titleKey(value) {
  return normalizeThreadTitle(value).toLocaleLowerCase('zh-CN');
}

function readThreadSessionCwd(threadId, sessionsDirectory = SESSIONS_DIR) {
  return readThreadSessionMetadata(threadId, sessionsDirectory)?.cwd || null;
}

function readLatestThreadRegistry(sessionIndexPath = SESSION_INDEX_PATH) {
  let source;

  try {
    source = fs.readFileSync(sessionIndexPath, 'utf8');
  } catch {
    return [];
  }

  const lines = source.split(/\r?\n/);
  const seenThreadIds = new Set();
  const threads = [];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (!line.trim() || line.length > MAX_INDEX_LINE_LENGTH) {
      continue;
    }

    try {
      const entry = JSON.parse(line);

      if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
        continue;
      }

      const threadId = String(entry.id || '').trim();

      if (!THREAD_ID_PATTERN.test(threadId) || seenThreadIds.has(threadId)) {
        continue;
      }

      seenThreadIds.add(threadId);
      const threadTitle = normalizeThreadTitle(entry.thread_name);

      if (!threadTitle || threadTitle.length > 240) {
        continue;
      }

      threads.push({
        cwd: null,
        projectId: `thread:${threadId}`,
        projectName: threadTitle,
        threadId,
        updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      });
    } catch {
      continue;
    }
  }

  return threads;
}

function findLatestThreadsByTitle(
  threadTitle,
  sessionIndexPath = SESSION_INDEX_PATH,
  sessionsDirectory = SESSIONS_DIR,
) {
  const normalizedTitleKey = titleKey(threadTitle);

  if (!normalizedTitleKey) {
    return [];
  }

  return readLatestThreadRegistry(sessionIndexPath)
    .filter((thread) => titleKey(thread.projectName) === normalizedTitleKey)
    .map((thread) => ({
      ...thread,
      cwd: readThreadSessionCwd(thread.threadId, sessionsDirectory),
    }));
}

module.exports = {
  SESSIONS_DIR,
  findThreadSessionFile,
  findLatestThreadsByTitle,
  normalizeThreadTitle,
  readLatestThreadRegistry,
  readThreadSessionCwd,
};
