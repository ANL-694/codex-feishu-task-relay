# Codex 飞书任务中继

这是一个不依赖 OpenClaw 的本地 Node 中继：把 Codex Desktop 每个任务回合的最终交付摘要主动推送到飞书，并让你在飞书里按线程名字派发下一步。

它不镜像实时输出、不开放公网端口，也不会把飞书文字直接拼成 Shell 命令。已打开的 Codex Desktop 可用时，入站指令会优先投递到对应桌面线程。

## 能做什么

1. 所有 Codex Desktop 对话线程结束一回合后，向飞书私聊发送最终摘要。
2. 在飞书按真实线程名继续任务，例如 `anl api：查看当前版本`。
3. 中继优先在已打开的 Codex Desktop 原线程执行，桌面不可用时才通过本机 Codex CLI 恢复原线程；完成后再把最终答复主动推回飞书。
4. 在飞书发送 `/新建 任务名字：第一步`，创建隔离目录和持久 Codex 任务。

```text
Codex notify / Stop
  -> SQLite 完成摘要队列
  -> 飞书自建应用机器人
  -> 飞书私聊最终摘要

飞书“线程名字：下一步”
  -> 飞书长连接事件
  -> SQLite 任务队列
  -> 已打开的 Codex Desktop 原线程
  -> 桌面不可用时：codex exec resume <线程 UUID>
  -> 飞书私聊最终摘要
```

入站任务会优先作为普通 Desktop turn 出现在对应的 Codex 对话中。中继会保存该 turn 标识，从本机 Codex 会话记录读取同一轮的完成结果并写入推送队列；只有找不到或无法连接 Desktop 时，才降级为后台 CLI 执行。

飞书使用官方 Node SDK 的长连接模式：本机只需能访问公网，不需要公网 IP、域名或内网穿透；完成通知不依赖“最近一条上行消息”的上下文 token。

## 首次配置

### 1. 安装并安装 Hook

```powershell
npm install
npm run install-hook
```

首次克隆项目还需要先创建本机项目配置；示例文件不含真实路径、账号或凭据：

```powershell
Copy-Item .\config\projects.example.json .\config\projects.json
```

Windows 用户只需安装并登录 Codex Desktop。中继会自动定位 Desktop 附带的 `codex.exe`；如果 `npm run doctor` 找不到 CLI，请更新或重新打开 Codex Desktop。

### 2. 创建飞书企业自建应用

在 [飞书开发者后台](https://open.feishu.cn/app) 新建“企业自建应用”，然后：

1. 添加“机器人”应用能力。
2. 在权限管理中添加私聊收消息权限 `im:message.p2p_msg:readonly`。
3. 添加机器人发消息权限 `im:message:send_as_bot`；也可使用 `im:message`，二选一即可。
4. 在“事件与回调”中选择“使用长连接接收事件”，添加“接收消息 v2.0”事件 `im.message.receive_v1`。
5. 在可用范围中加入你自己的飞书账号，创建并发布应用版本。

本中继只处理与机器人的私聊，不需要申请群内全部消息权限。

### 3. 在桌面控制台填写凭据并绑定

运行：

```text
<项目目录>\程序\Codex飞书中继.exe
```

点击“配置飞书”，填写开发者后台的 App ID 和 App Secret；它们只写入本机被忽略的 `data/feishu-config.json`，不会写进 README、任务数据库或公开仓库。

保存后重启中继。控制台会显示类似下面的绑定口令：

```text
飞书发送：/绑定 relay-xxxxxxxxxxxxxxxx
```

在飞书里给机器人发送这条命令即可完成绑定。中继从事件中自动记录你的 `open_id`，无需手工复制 ID。绑定后，未授权账号只能收到拒绝提示，不能创建或继续 Codex 任务。

## 飞书指令

```text
anl api：查看当前版本
/新建 新项目想法：先调研可行性并给出最小方案
/任务
/完成 T-3
/帮助
```

完成通知会显示 Codex 侧栏中的线程名字；没有侧栏条目的子代理会显示为 `父任务名字 / 子任务·短标识`。回复完整名字即可继续对应子线程。

## 可靠性

- 每条入站飞书消息按官方 `message_id` 去重，避免事件重推造成重复派发。
- 每个完成摘要分片使用稳定 `uuid`；飞书在一小时内对相同 `uuid` 只成功发送一次，网络重试不会重复通知。
- API 暂时失败时，完成摘要保留在 SQLite 队列中并自动重试；不会因为一条聊天上下文过期而卡死。
- 飞书消息成功送达后，手机是否弹出系统横幅仍由飞书和 Android/iOS 的通知、免打扰设置控制；请确认飞书通知未被静音。

## 桌面程序与命令行

桌面程序提供飞书凭据配置、绑定口令、服务启停、Hook 状态、执行器状态、队列和最近日志。最小化或关闭窗口会隐藏到系统托盘，后台中继继续运行；双击托盘图标可恢复窗口，也可在托盘菜单启动、停止或退出控制台。启用“随 Windows 启动”后，控制台会直接常驻通知区域并自动启动中继。

```powershell
npm run doctor
npm run control:status
npm run control:start
npm run control:stop
npm run tasks
npm run demo -- BDS
npm test
```

`npm run demo -- BDS` 会写入一条测试完成摘要；飞书中继在线且已绑定后会主动发到飞书。

## 回滚

```powershell
npm run remove-hook
```

这只恢复本中继接管的 Codex `notify` 行，并在恢复前再次备份 Codex 配置。

## 官方参考

- [使用长连接接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case)
- [接收消息 `im.message.receive_v1`](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [飞书 Node SDK](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/invoke-server-api)
- [Codex hooks](https://developers.openai.com/codex/hooks)
