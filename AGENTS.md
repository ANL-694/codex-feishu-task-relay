# Codex 协作说明

## 常用命令

- `npm test`：运行 Node 测试。
- `npm run control:status`：读取本机中继状态。
- `npm run install-hook`：安装 Codex 完成通知 Hook。
- `pwsh -File .\desktop-app\build.ps1`：构建 Windows 桌面控制台。

## 约束

- 公开源码中不得出现飞书凭据、绑定信息、`data/` 内容、真实项目路径或 Codex 会话数据。
- 飞书入站消息必须经过授权和任务路由，不得拼接为 Shell 命令执行。
- 修改中文文件后，以 UTF-8 校验并扫描乱码；修改 JSON 后执行解析校验。
