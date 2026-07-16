'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function normalizeCandidate(candidate) {
  const value = String(candidate || '').trim().replace(/^"|"$/g, '');
  return value ? path.win32.normalize(value) : '';
}

function isExecutableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function collectVersionedCodexExecutables(binRoot) {
  if (!binRoot || !fs.existsSync(binRoot)) {
    return [];
  }

  return fs
    .readdirSync(binRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(binRoot, entry.name, 'codex.exe'))
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      candidate,
      modifiedAt: fs.statSync(candidate).mtimeMs,
    }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map(({ candidate }) => candidate);
}

function collectPathExecutables(pathValue) {
  return String(pathValue || '')
    .split(path.delimiter)
    .map((entry) => normalizeCandidate(entry))
    .filter(Boolean)
    .map((entry) => path.join(entry, 'codex.exe'));
}

function listCodexExecutableCandidates(options = {}) {
  const environment = options.environment || process.env;
  const homeDirectory = options.homeDirectory || os.homedir();
  const localAppData = environment.LOCALAPPDATA || path.join(homeDirectory, 'AppData', 'Local');
  const candidates = [
    options.explicitPath,
    environment.CODEX_EXECUTABLE,
    ...collectVersionedCodexExecutables(
      options.binRoot || path.join(localAppData, 'OpenAI', 'Codex', 'bin'),
    ),
    path.join(homeDirectory, '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
    path.join(homeDirectory, '.codex', '.sandbox-bin', 'codex.exe'),
    ...collectPathExecutables(environment.PATH),
  ];
  const seen = new Set();

  return candidates
    .map(normalizeCandidate)
    .filter(Boolean)
    .filter((candidate) => {
      const key = candidate.toLocaleLowerCase('en-US');

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

function findCodexExecutable(options = {}) {
  const candidates = listCodexExecutableCandidates(options);
  const executable = candidates.find(isExecutableFile);

  if (!executable) {
    const error = new Error('没有找到可执行的 Codex CLI。请先打开或更新 Codex Desktop。');
    error.code = 'CODEX_EXECUTABLE_NOT_FOUND';
    error.candidates = candidates;
    throw error;
  }

  return executable;
}

module.exports = {
  collectPathExecutables,
  collectVersionedCodexExecutables,
  findCodexExecutable,
  isExecutableFile,
  listCodexExecutableCandidates,
  normalizeCandidate,
};
