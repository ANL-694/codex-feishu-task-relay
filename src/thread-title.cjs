'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  CODEX_HOME,
  SESSIONS_DIR,
  readThreadSessionMetadata,
} = require('./thread-session.cjs');

const SESSION_INDEX_PATH = path.join(CODEX_HOME, 'session_index.jsonl');

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readThreadTitle(threadId, sessionIndexPath = SESSION_INDEX_PATH) {
  const normalizedThreadId = String(threadId || '').trim();

  if (!normalizedThreadId) {
    return null;
  }

  let source;

  try {
    source = fs.readFileSync(sessionIndexPath, 'utf8');
  } catch {
    return null;
  }

  const lines = source.split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      const title = normalizeTitle(entry.thread_name);

      if (entry.id !== normalizedThreadId || !title) {
        continue;
      }

      return title;
    } catch {
      continue;
    }
  }

  return null;
}

function subagentThreadTitle(parentTitle, threadId, subagentLabel) {
  const shortThreadId = String(threadId).replaceAll('-', '').slice(-8);
  const suffix = subagentLabel
    ? `${subagentLabel}·${shortThreadId}`
    : `子任务·${shortThreadId}`;
  const maximumParentLength = Math.max(240 - suffix.length - 3, 1);
  const normalizedParentTitle = normalizeTitle(parentTitle).slice(0, maximumParentLength);
  return `${normalizedParentTitle} / ${suffix}`;
}

function resolveThreadTitle({ threadId, sessionIndexPath, sessionsDirectory = SESSIONS_DIR }) {
  const directTitle = readThreadTitle(threadId, sessionIndexPath);

  if (directTitle) {
    return directTitle;
  }

  const metadata = readThreadSessionMetadata(threadId, sessionsDirectory);

  if (metadata?.threadSource !== 'subagent' || !metadata.parentThreadId) {
    return null;
  }

  const parentTitle = readThreadTitle(metadata.parentThreadId, sessionIndexPath);
  return parentTitle
    ? subagentThreadTitle(parentTitle, threadId, metadata.subagentLabel)
    : null;
}

module.exports = {
  CODEX_HOME,
  SESSION_INDEX_PATH,
  readThreadTitle,
  resolveThreadTitle,
  subagentThreadTitle,
};
