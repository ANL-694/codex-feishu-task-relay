'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, FEISHU_CONFIG_PATH } = require('./constants.cjs');

const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-f]{16}$/i;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFeishuConfig(value) {
  return {
    appId: normalizeString(value?.appId),
    appSecret: normalizeString(value?.appSecret),
    ownerOpenId: normalizeString(value?.ownerOpenId),
    pairingCode: normalizeString(value?.pairingCode),
  };
}

function isFeishuConfigured(config) {
  return Boolean(normalizeString(config?.appId) && normalizeString(config?.appSecret));
}

function assertFeishuConfigured(config) {
  const normalized = normalizeFeishuConfig(config);

  if (!normalized.appId || !normalized.appSecret) {
    throw new Error('尚未配置飞书 App ID 和 App Secret。请先在桌面控制台点击“配置飞书”。');
  }

  if (!FEISHU_APP_ID_PATTERN.test(normalized.appId)) {
    throw new Error('飞书 App ID 格式无效，应为以 cli_ 开头的自建应用 ID。');
  }

  return normalized;
}

function readFeishuConfig(configPath = FEISHU_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    return normalizeFeishuConfig();
  }

  try {
    return normalizeFeishuConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (error) {
    throw new Error(`无法读取飞书配置 ${configPath}: ${error.message || error}`);
  }
}

function writeTextAtomically(targetPath, content) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor;

  fs.mkdirSync(directory, { recursive: true });

  try {
    descriptor = fs.openSync(temporaryPath, 'w');
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }

    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function writeFeishuConfig(config, configPath = FEISHU_CONFIG_PATH) {
  const normalized = normalizeFeishuConfig(config);
  writeTextAtomically(configPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function generatePairingCode(randomBytes = crypto.randomBytes) {
  return `relay-${randomBytes(12).toString('base64url')}`;
}

function ensurePairingCode(config, options = {}) {
  const normalized = normalizeFeishuConfig(config);

  if (normalized.ownerOpenId || normalized.pairingCode || !isFeishuConfigured(normalized)) {
    return normalized;
  }

  const updated = {
    ...normalized,
    pairingCode: generatePairingCode(options.randomBytes),
  };
  writeFeishuConfig(updated, options.configPath || FEISHU_CONFIG_PATH);
  return updated;
}

module.exports = {
  FEISHU_APP_ID_PATTERN,
  assertFeishuConfigured,
  ensurePairingCode,
  generatePairingCode,
  isFeishuConfigured,
  normalizeFeishuConfig,
  readFeishuConfig,
  writeFeishuConfig,
  writeTextAtomically,
};
