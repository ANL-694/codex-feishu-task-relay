'use strict';

const process = require('node:process');
const { isFeishuConfigured, readFeishuConfig, writeFeishuConfig } = require('./feishu-config.cjs');
const { findProjectByAlias, readRuntimeConfig, writeRuntimeConfig } = require('./runtime-config.cjs');
const { createStore } = require('./store.cjs');

function usage() {
  console.log(`
可用命令：
  npm run doctor
  npm run projects
  npm run tasks -- [项目名]
  npm run owners
  npm run owner:allow -- <飞书 open_id>
  npm run demo -- <项目名> [摘要]
`);
}

function printTasks(tasks) {
  if (tasks.length === 0) {
    console.log('暂无任务。');
    return;
  }

  for (const task of tasks) {
    console.log(`T-${task.task_id} · ${task.project_name} · ${task.status}`);
    console.log(task.instruction);
    console.log('');
  }
}

function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const config = readRuntimeConfig();
  const store = createStore();

  try {
    if (command === 'doctor') {
      const dependencies = ['@larksuiteoapi/node-sdk'].map((dependency) => {
        try {
          require.resolve(dependency);
          return `${dependency}: 已安装`;
        } catch {
          return `${dependency}: 未安装`;
        }
      });

      console.log(`Node.js: ${process.version}`);
      console.log(`已配置项目: ${config.projects.map((project) => project.name).join('、') || '无'}`);
      const feishuConfig = readFeishuConfig();
      console.log(`飞书应用: ${isFeishuConfigured(feishuConfig) ? '已配置' : '待配置'}`);
      console.log(`已绑定飞书用户: ${feishuConfig.ownerOpenId ? 1 : 0}`);
      console.log(...dependencies);
      console.log(`待推送完成摘要: ${store.listQueuedCompletions(1000).length}`);
      return;
    }

    if (command === 'projects') {
      for (const project of config.projects) {
        console.log(`${project.name} (${project.id})`);
        console.log(`  别名：${project.aliases.join('、')}`);
        console.log(`  目录：${project.cwdPrefixes.join('；')}`);
      }
      return;
    }

    if (command === 'tasks') {
      const project = args[0] ? findProjectByAlias(args[0], config) : null;

      if (args[0] && !project) {
        throw new Error(`没有找到项目「${args[0]}」。`);
      }

      printTasks(store.listIncompleteThreadTasks(project?.id || null));
      return;
    }

    if (command === 'owners') {
      const candidates = store.listUnauthorizedUsers();

      if (candidates.length === 0) {
        console.log('还没有收到待授权飞书消息。请先在飞书中给机器人发任意一条文字。');
        return;
      }

      for (const candidate of candidates) {
        console.log(`${candidate.user_id} · 出现 ${candidate.request_count} 次 · 最近时间：${candidate.last_seen_at}`);
      }
      return;
    }

    if (command === 'owner:allow') {
      const userId = String(args[0] || '').trim();

      if (!userId) {
        throw new Error('请提供要授权的飞书 open_id。');
      }

      const feishuConfig = readFeishuConfig();

      if (!isFeishuConfigured(feishuConfig)) {
        throw new Error('请先在桌面控制台配置飞书 App ID 和 App Secret。');
      }

      writeFeishuConfig({ ...feishuConfig, ownerOpenId: userId, pairingCode: '' });
      console.log(`已绑定唯一飞书用户：${userId}`);
      return;
    }

    if (command === 'demo') {
      const project = findProjectByAlias(args[0], config);

      if (!project) {
        throw new Error('请提供已配置的项目名，例如：npm run demo -- BDS');
      }

      const result = store.recordCompletion({
        cwd: project.cwdPrefixes[0] || '',
        finalMessage: args.slice(1).join(' ') || '这是一条本地测试用的 Codex 最终交付摘要。',
        inputSummary: '本地测试',
        projectId: project.id,
        projectName: project.name,
        threadId: `demo-${Date.now()}`,
        turnId: `demo-${Date.now()}`,
      });
      console.log(`已写入测试完成摘要 C-${result.completion.completion_id}。`);
      return;
    }

    usage();
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`命令失败：${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
};
