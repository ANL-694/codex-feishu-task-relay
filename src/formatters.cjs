'use strict';

function toShanghaiTime(iso) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function formatCompletion(completion) {
  return [
    `✅ ${completion.project_name} · 已处理`,
    `时间：${toShanghaiTime(completion.created_at)}`,
    `目录：${completion.cwd}`,
    '',
    completion.final_message,
    '',
    '回复下一步：',
    `${completion.project_name}：<下一步>`,
    '查看队列：/任务',
  ].join('\n');
}

function formatTaskList(tasks, projectName = null) {
  if (tasks.length === 0) {
    return projectName ? `${projectName} 暂无待处理任务。` : '当前暂无待处理任务。';
  }

  const title = projectName ? `${projectName} 任务队列` : '全部任务队列';
  const lines = tasks.map((task) => {
    const instruction = task.instruction.replace(/\s+/g, ' ').slice(0, 160);
    return `T-${task.task_id} · ${task.project_name} · ${task.status}\n${instruction}`;
  });

  return [title, '', ...lines, '', '完成一项：/完成 T-<编号>'].join('\n');
}

function splitMessage(message, maximumLength) {
  const chunks = [];
  let current = '';

  for (const character of String(message)) {
    if (current.length + character.length > maximumLength && current) {
      chunks.push(current);
      current = '';
    }

    current += character;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

module.exports = {
  formatCompletion,
  formatTaskList,
  splitMessage,
};
