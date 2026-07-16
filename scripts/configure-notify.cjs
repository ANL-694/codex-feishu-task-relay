'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { INSTALL_STATE_PATH, PROJECT_ROOT } = require('../src/constants.cjs');

const RELAY_SCRIPT = path.join(PROJECT_ROOT, 'src', 'codex-notify.cjs');
const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(os.homedir(), '.codex', 'config.toml');

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function detectLineEnding(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function findTopLevelNotify(lines) {
  let inTable = false;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();

    if (/^\[\[?[^\]]+\]\]?$/.test(trimmed)) {
      inTable = true;
      continue;
    }

    if (!inTable && /^notify\s*=/.test(trimmed)) {
      return { index, line: lines[index] };
    }
  }

  return null;
}

function parseTomlStringArray(literal) {
  const source = String(literal).trim();

  if (!source.startsWith('[') || !source.endsWith(']')) {
    throw new Error('notify 不是单行字符串数组，已停止修改。');
  }

  const values = [];
  let index = 1;

  while (index < source.length - 1) {
    while (/\s/.test(source[index] || '')) {
      index += 1;
    }

    if (source[index] === ']') {
      break;
    }

    const quote = source[index];

    if (quote !== '"' && quote !== "'") {
      throw new Error('notify 包含非字符串参数，已停止修改。');
    }

    index += 1;
    let value = '';

    if (quote === "'") {
      const end = source.indexOf("'", index);

      if (end === -1) {
        throw new Error('notify 的单引号字符串未闭合。');
      }

      value = source.slice(index, end);
      index = end + 1;
    } else {
      let escaped = false;
      const start = index - 1;

      while (index < source.length) {
        const character = source[index];

        if (character === '"' && !escaped) {
          index += 1;
          break;
        }

        escaped = character === '\\' && !escaped;

        if (character !== '\\') {
          escaped = false;
        }

        index += 1;
      }

      const serialized = source.slice(start, index);

      try {
        value = JSON.parse(serialized);
      } catch {
        throw new Error('notify 的双引号字符串无法解析。');
      }
    }

    values.push(value);

    while (/\s/.test(source[index] || '')) {
      index += 1;
    }

    if (source[index] === ',') {
      index += 1;
      continue;
    }

    if (source[index] !== ']') {
      throw new Error('notify 参数之间缺少逗号。');
    }
  }

  return values;
}

function renderNotifyLine(command) {
  return `notify = [${command.map((value) => JSON.stringify(String(value))).join(', ')}]`;
}

function readNotifyCommand(notify) {
  if (!notify) {
    return [];
  }

  const literal = notify.line.replace(/^\s*notify\s*=\s*/, '').trim();
  return parseTomlStringArray(literal);
}

function isRelayCommand(command) {
  return command.includes(RELAY_SCRIPT);
}

function writeState(state) {
  writeTextAtomically(INSTALL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
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

function readTomlConfig() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) {
    throw new Error(`没有找到 Codex 配置：${CODEX_CONFIG_PATH}`);
  }

  return fs.readFileSync(CODEX_CONFIG_PATH, 'utf8');
}

function writeTomlConfig(content) {
  writeTextAtomically(CODEX_CONFIG_PATH, content);
}

function backupConfig(content, suffix) {
  const backupPath = `${CODEX_CONFIG_PATH}.codex-relay-${suffix}-${timestamp()}`;
  writeTextAtomically(backupPath, content);
  return backupPath;
}

function install() {
  const content = readTomlConfig();
  const lineEnding = detectLineEnding(content);
  const lines = content.split(/\r?\n/);
  const current = findTopLevelNotify(lines);

  if (current && isRelayCommand(readNotifyCommand(current))) {
    console.log('Codex 飞书通知钩子已经安装。');
    return;
  }

  const existingCommand = current ? readNotifyCommand(current) : [];

  const relayCommand = [process.execPath, '--no-warnings', RELAY_SCRIPT];

  if (existingCommand.length > 0) {
    relayCommand.push('--forward', ...existingCommand);
  }

  const backupPath = backupConfig(content, 'before-install');
  const notifyLine = renderNotifyLine(relayCommand);

  if (current) {
    lines[current.index] = notifyLine;
  } else {
    const firstTable = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
    const insertAt = firstTable === -1 ? lines.length : firstTable;
    lines.splice(insertAt, 0, notifyLine);
  }

  const state = {
    backupPath,
    configPath: CODEX_CONFIG_PATH,
    installedAt: null,
    originalNotifyLine: current?.line || null,
    relayScript: RELAY_SCRIPT,
    status: 'prepared',
  };
  writeState(state);

  try {
    writeTomlConfig(lines.join(lineEnding));
  } catch (error) {
    fs.rmSync(INSTALL_STATE_PATH, { force: true });
    throw error;
  }

  writeState({
    ...state,
    installedAt: new Date().toISOString(),
    status: 'installed',
  });
  console.log(`已安装 Codex 飞书通知钩子。备份：${backupPath}`);
}

function remove() {
  if (!fs.existsSync(INSTALL_STATE_PATH)) {
    throw new Error('没有找到本中继写入的安装状态，已停止修改。');
  }

  const state = JSON.parse(fs.readFileSync(INSTALL_STATE_PATH, 'utf8'));

  if (state.configPath !== CODEX_CONFIG_PATH) {
    throw new Error('安装状态对应的 Codex 配置路径不同，已停止修改。');
  }

  const content = readTomlConfig();
  const lineEnding = detectLineEnding(content);
  const lines = content.split(/\r?\n/);
  const current = findTopLevelNotify(lines);

  if (!current || !isRelayCommand(readNotifyCommand(current))) {
    throw new Error('当前 notify 不是本中继安装的版本，已停止修改。');
  }

  const backupPath = backupConfig(content, 'before-remove');

  if (state.originalNotifyLine) {
    lines[current.index] = state.originalNotifyLine;
  } else {
    lines.splice(current.index, 1);
  }

  writeTomlConfig(lines.join(lineEnding));
  fs.rmSync(INSTALL_STATE_PATH, { force: true });
  console.log(`已移除 Codex 飞书通知钩子。备份：${backupPath}`);
}

function main(command = process.argv[2]) {
  if (command === 'install') {
    install();
    return;
  }

  if (command === 'remove') {
    remove();
    return;
  }

  throw new Error('用法：node scripts/configure-notify.cjs <install|remove>');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`配置失败：${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  findTopLevelNotify,
  isRelayCommand,
  main,
  parseTomlStringArray,
  readNotifyCommand,
  writeTextAtomically,
};
