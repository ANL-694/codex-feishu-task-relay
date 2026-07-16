'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_DIR, CONFIG_PATH } = require('./constants.cjs');

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function normalizePathForMatch(value) {
  if (!value) {
    return '';
  }

  return path.win32
    .normalize(String(value).trim().replaceAll('/', '\\'))
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function normalizeProject(project, index) {
  const id = String(project?.id || `project-${index + 1}`).trim();
  const name = String(project?.name || id).trim();
  const aliases = uniqueStrings([id, name, ...(Array.isArray(project?.aliases) ? project.aliases : [])]);
  const cwdPrefixes = uniqueStrings(Array.isArray(project?.cwdPrefixes) ? project.cwdPrefixes : []);

  return {
    aliases,
    cwdPrefixes,
    id,
    name,
  };
}

function normalizeConfig(value) {
  const completionCharsPerMessage = Number(value?.completionCharsPerMessage);

  return {
    completionCharsPerMessage:
      Number.isFinite(completionCharsPerMessage) && completionCharsPerMessage >= 500
        ? Math.floor(completionCharsPerMessage)
        : 3000,
    executorEnabled: value?.executorEnabled === true,
    notifyUnmappedProjects: value?.notifyUnmappedProjects === true,
    ownerUserIds: uniqueStrings(Array.isArray(value?.ownerUserIds) ? value.ownerUserIds : []).slice(0, 1),
    projects: (Array.isArray(value?.projects) ? value.projects : []).map(normalizeProject),
  };
}

function readRuntimeConfig(configPath = CONFIG_PATH) {
  let parsed;

  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取项目配置 ${configPath}: ${error.message}`);
  }

  return normalizeConfig(parsed);
}

function writeRuntimeConfig(config, configPath = CONFIG_PATH) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, 'utf8');
}

function findProjectByAlias(alias, config) {
  const wanted = String(alias || '').trim().toLocaleLowerCase('en-US');

  if (!wanted) {
    return null;
  }

  if (config.notifyUnmappedProjects && wanted === '未分类') {
    return {
      aliases: ['未分类'],
      cwdPrefixes: [],
      id: 'unclassified',
      name: '未分类',
    };
  }

  return (
    config.projects.find((project) =>
      project.aliases.some((candidate) => candidate.toLocaleLowerCase('en-US') === wanted),
    ) || null
  );
}

function resolveProjectByCwd(cwd, config) {
  const normalizedCwd = normalizePathForMatch(cwd);
  const candidates = [];

  for (const project of config.projects) {
    for (const prefix of project.cwdPrefixes) {
      const normalizedPrefix = normalizePathForMatch(prefix);

      if (
        normalizedPrefix &&
        (normalizedCwd === normalizedPrefix || normalizedCwd.startsWith(`${normalizedPrefix}\\`))
      ) {
        candidates.push({ normalizedPrefix, project });
      }
    }
  }

  candidates.sort((left, right) => right.normalizedPrefix.length - left.normalizedPrefix.length);

  if (candidates.length > 0) {
    return candidates[0].project;
  }

  if (!config.notifyUnmappedProjects) {
    return null;
  }

  return {
    aliases: ['未分类'],
    cwdPrefixes: [],
    id: 'unclassified',
    name: '未分类',
  };
}

module.exports = {
  findProjectByAlias,
  normalizeConfig,
  normalizePathForMatch,
  readRuntimeConfig,
  resolveProjectByCwd,
  writeRuntimeConfig,
};
