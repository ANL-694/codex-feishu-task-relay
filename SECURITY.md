# 安全策略

请不要在公开 Issue、Pull Request、日志或截图中提交飞书 `App Secret`、绑定口令、`open_id`、项目路径、任务数据库或 Codex 配置。

发现凭据泄露、未授权任务执行或消息越权问题时，请使用 GitHub 的私密安全报告功能联系维护者；在修复发布前不要公开可复现的攻击细节。

本项目的本机敏感状态位于被 Git 忽略的 `data/` 和 `config/projects.json` 中。发布前请运行测试并复核 `git status --ignored` 与暂存文件清单。
