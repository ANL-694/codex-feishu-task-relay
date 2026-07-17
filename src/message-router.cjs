'use strict';

const { formatTaskList } = require('./formatters.cjs');
const { createTaskWorkspace } = require('./task-workspace.cjs');
const { findLatestThreadsByTitle } = require('./thread-registry.cjs');

const DESKTOP_VISIBILITY_NOTICE =
  '已打开的 Codex Desktop 可用时，任务会优先显示在对应线程；桌面不可用时才改为后台 CLI，结果仍会回传到机器人。';

function helpText() {
  return [
    '请按完成通知中的线程名字回复：',
    '线程名字：根据这次结果继续……',
    '',
    '新任务：/新建 <任务名字>：<第一步指令>',
    '命令：/任务 [线程名字]、/完成 T-编号、/帮助',
    '机器人消息会优先进入原 Codex Desktop 线程执行。',
    DESKTOP_VISIBILITY_NOTICE,
  ].join('\n');
}

function parseNewTaskCommand(text) {
  const match = String(text || '').match(
    /^\s*\/(?:新建|new)\s+([^：:\n]{1,120}?)\s*[:：]\s*([\s\S]*?\S)\s*$/i,
  );

  if (!match) {
    return null;
  }

  return {
    instruction: match[2].trim(),
    projectName: match[1].replace(/\s+/g, ' ').trim(),
  };
}

function isNewTaskCommand(text) {
  return /^\s*\/(?:新建|new)(?=\s|$)/i.test(String(text || ''));
}

function completionTarget(completion) {
  return {
    completionId: completion.completion_id,
    cwd: completion.cwd || null,
    projectId: `thread:${completion.thread_id}`,
    projectName: completion.project_name,
    threadId: completion.thread_id,
  };
}

function findThreadTargets(store, threadTitle, sessionIndexPath, sessionsDirectory) {
  const completions = store.findLatestCompletionsByThreadTitle(threadTitle);

  if (completions.length > 0) {
    return completions.map(completionTarget);
  }

  return findLatestThreadsByTitle(threadTitle, sessionIndexPath, sessionsDirectory);
}

function handleIncomingText({
  config,
  createWorkspace = createTaskWorkspace,
  message,
  newTaskRoot,
  sessionIndexPath,
  sessionsDirectory,
  store,
}) {
  const userId = String(message?.userId || '').trim();
  const text = String(message?.text || '').trim();

  if (!userId || !text) {
    return { reply: null };
  }

  if (!config.ownerUserIds.includes(userId)) {
    store.recordUnauthorizedUser(userId);
    return { reply: '当前飞书机器人未授权。' };
  }

  if (/^\s*\/(?:帮助|help)\s*$/i.test(text)) {
    return { reply: helpText() };
  }

  if (isNewTaskCommand(text)) {
    const command = parseNewTaskCommand(text);

    if (!command) {
      return { reply: '格式：/新建 <任务名字>：<第一步指令>' };
    }

    try {
      const workspace = createWorkspace({ rootDirectory: newTaskRoot });
      const task = store.createTask({
        cwd: workspace.workspace,
        executionMode: 'new',
        instruction: command.instruction,
        projectId: `new:${workspace.id}`,
        projectName: command.projectName,
        sourceUserId: userId,
      });

      return {
        reply: [
          `已新建 T-${task.task_id}「${command.projectName}」。`,
          '已在独立目录进入 Codex 执行队列。',
          DESKTOP_VISIBILITY_NOTICE,
          `首次完成后可用「${command.projectName}：<下一步>」继续。`,
        ].join('\n'),
        task,
      };
    } catch {
      return { reply: '新建任务失败，请检查隔离目录权限、磁盘空间和本机日志。' };
    }
  }

  const taskListMatch = text.match(/^\s*\/(?:任务|tasks?)(?:\s+(.+?))?\s*$/i);

  if (taskListMatch) {
    if (!taskListMatch[1]) {
      return { reply: formatTaskList(store.listIncompleteThreadTasks()) };
    }

    const matches = findThreadTargets(
      store,
      taskListMatch[1],
      sessionIndexPath,
      sessionsDirectory,
    );

    if (matches.length !== 1) {
      return { reply: `没有找到唯一线程「${taskListMatch[1]}」。\n\n${helpText()}` };
    }

    return {
      reply: formatTaskList(
        store.listIncompleteThreadTasks(matches[0].projectId),
        matches[0].projectName,
      ),
    };
  }

  const completeTaskMatch = text.match(/^\s*\/(?:完成|done)\s+T?-(\d+)\s*$/i);

  if (completeTaskMatch) {
    const task = store.markTaskDone(Number(completeTaskMatch[1]));
    return {
      reply: task ? `已将 T-${task.task_id} 标为完成。` : `没有找到 T-${completeTaskMatch[1]}。`,
    };
  }

  const projectTaskMatch = text.match(/^\s*([^：:\n]{1,240}?)\s*[:：]\s*([\s\S]+?)\s*$/i);

  if (!projectTaskMatch) {
    return { reply: helpText() };
  }

  const threadTitle = projectTaskMatch[1].trim();
  const matches = findThreadTargets(store, threadTitle, sessionIndexPath, sessionsDirectory);

  if (matches.length === 0) {
    return { reply: `没有找到侧栏线程「${threadTitle}」。\n请复制 Codex 侧栏中的线程名字。` };
  }

  if (matches.length > 1) {
    return { reply: `有多个同名线程「${threadTitle}」。请先在 Codex 中改成不同的线程名字后再回复。` };
  }

  const target = matches[0];

  const task = store.createTask({
    completionId: target.completionId || null,
    cwd: target.cwd,
    instruction: projectTaskMatch[2],
    projectId: target.projectId,
    projectName: target.projectName,
    sourceUserId: userId,
    threadId: target.threadId,
  });

  return {
    reply: [
      `已收录 T-${task.task_id} 到「${target.projectName}」。`,
      '已进入 Codex 执行队列。',
      DESKTOP_VISIBILITY_NOTICE,
    ].join('\n'),
    task,
  };
}

module.exports = {
  handleIncomingText,
  helpText,
  isNewTaskCommand,
  parseNewTaskCommand,
};
