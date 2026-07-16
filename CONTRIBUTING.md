# 贡献指南

欢迎提交 Issue 和 Pull Request。

## 本地开发

1. 使用 Node.js 22 或更高版本。
2. 执行 `npm install`。
3. 复制 `config/projects.example.json` 为本机的 `config/projects.json`，按需要填写项目目录。
4. 执行 `npm test`。

## 安全边界

- 不要提交 `data/`、`config/projects.json`、飞书 App Secret、绑定信息、SQLite 数据库、日志或编译出的程序。
- 不要把飞书消息内容直接执行为 Shell 命令。
- 涉及 Codex Hook、任务恢复或消息权限的改动，请补充相应测试和 README 说明。

## 提交建议

- 保持改动聚焦，并说明用户可见行为。
- 提交前运行 `npm test`。
- 中文文档使用 UTF-8；不要修改示例中的转义符、反斜杠或 JSON 结构。
