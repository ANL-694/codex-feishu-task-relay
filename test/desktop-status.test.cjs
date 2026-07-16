'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const COMPILER = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

test('桌面状态兼容旧 JSON 并显示执行器任务与错误', (context) => {
  if (!fs.existsSync(COMPILER)) {
    context.skip('当前环境缺少 .NET Framework C# 编译器');
    return;
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-feishu-desktop-test-'));
  const testExecutable = path.join(temporaryDirectory, 'StatusPresentationTests.exe');

  try {
    const compilation = spawnSync(
      COMPILER,
      [
        '/nologo',
        '/target:exe',
        '/codepage:65001',
        '/utf8output',
        '/reference:System.dll',
        '/reference:System.Core.dll',
        '/reference:System.Web.Extensions.dll',
        `/out:${testExecutable}`,
        '/main:CodexFeishuRelayDesktop.Tests.StatusPresentationTests',
        path.join(PROJECT_ROOT, 'desktop-app', 'RelayBackend.cs'),
        path.join(PROJECT_ROOT, 'desktop-app', 'StatusPresentation.cs'),
        path.join(PROJECT_ROOT, 'desktop-app', 'tests', 'StatusPresentationTests.cs'),
      ],
      { encoding: 'utf8', windowsHide: true },
    );

    assert.equal(
      compilation.status,
      0,
      `C# 单元测试编译失败：\n${compilation.stdout}\n${compilation.stderr}`,
    );

    const execution = spawnSync(testExecutable, [], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(
      execution.status,
      0,
      `C# 单元测试失败：\n${execution.stdout}\n${execution.stderr}`,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('完整 WinForms 源码可在不引用 System.Management 时编译', (context) => {
  if (!fs.existsSync(COMPILER)) {
    context.skip('当前环境缺少 .NET Framework C# 编译器');
    return;
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-feishu-winforms-'));
  const outputPath = path.join(temporaryDirectory, 'CodexFeishuRelayDesktop.exe');
  const desktopDirectory = path.join(PROJECT_ROOT, 'desktop-app');

  try {
    const sources = fs
      .readdirSync(desktopDirectory)
      .filter((fileName) => fileName.endsWith('.cs'))
      .sort()
      .map((fileName) => path.join(desktopDirectory, fileName));
    const compilation = spawnSync(
      COMPILER,
      [
        '/nologo',
        '/target:winexe',
        '/platform:x64',
        '/warn:4',
        '/nowarn:1668',
        '/codepage:65001',
        '/utf8output',
        `/win32manifest:${path.join(desktopDirectory, 'app.manifest')}`,
        '/reference:System.dll',
        '/reference:System.Core.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Web.Extensions.dll',
        `/out:${outputPath}`,
        ...sources,
      ],
      { encoding: 'utf8', windowsHide: true },
    );

    assert.equal(
      compilation.status,
      0,
      `WinForms 编译失败：\n${compilation.stdout}\n${compilation.stderr}`,
    );
    assert.ok(fs.statSync(outputPath).size > 0);
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('桌面停止操作只调用 control stop', () => {
  const relaySource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'desktop-app', 'RelayBackend.cs'),
    'utf8',
  );

  assert.ok(relaySource.includes('RunNodeAsync("src\\\\control.cjs", "stop", 15000)'));
  assert.doesNotMatch(relaySource, /Process\.GetProcessById|VerifyWorkerCommandLine/);
  assert.doesNotMatch(relaySource, /ManagementObjectSearcher|using System\.Management/);
  assert.doesNotMatch(relaySource, /worker\.Kill\(\)/);
});
