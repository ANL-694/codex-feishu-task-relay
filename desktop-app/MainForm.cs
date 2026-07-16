using System;
using System.Drawing;
using System.Globalization;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CodexFeishuRelayDesktop
{
    internal sealed class MainForm : Form
    {
        private static readonly Color WindowBackground = Color.FromArgb(244, 247, 251);
        private static readonly Color CardBackground = Color.White;
        private static readonly Color Primary = Color.FromArgb(31, 111, 235);
        private static readonly Color Positive = Color.FromArgb(31, 157, 104);
        private static readonly Color Warning = Color.FromArgb(217, 119, 6);
        private static readonly Color Negative = Color.FromArgb(220, 38, 38);
        private static readonly Color MainText = Color.FromArgb(24, 35, 52);
        private static readonly Color MutedText = Color.FromArgb(96, 112, 137);

        private readonly RelayBackend backend;
        private readonly Timer refreshTimer;
        private Label serviceValue;
        private Label serviceDetail;
        private Label hookValue;
        private Label hookDetail;
        private Label feishuValue;
        private Label feishuDetail;
        private Label queueValue;
        private Label queueDetail;
        private Label executorValue;
        private Label executorDetail;
        private Label footerStatus;
        private TextBox logTextBox;
        private Button startButton;
        private Button restartButton;
        private Button stopButton;
        private Button installHookButton;
        private Button feishuConfigButton;
        private Button refreshButton;
        private CheckBox autoStartCheckBox;
        private bool refreshInProgress;
        private bool updatingAutoStart;

        public MainForm(RelayBackend backend)
        {
            this.backend = backend;
            refreshTimer = new Timer();
            refreshTimer.Interval = 3000;
            refreshTimer.Tick += async delegate { await RefreshStatusAsync(false); };

            Text = "Codex 飞书中继";
            Name = "mainWindow";
            AccessibleName = "Codex 飞书中继";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(860, 620);
            Size = new Size(980, 700);
            BackColor = WindowBackground;
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            BuildInterface();

            Load += async delegate
            {
                LoadAutoStartState();
                await RefreshStatusAsync(true);
                refreshTimer.Start();
            };

            FormClosed += delegate { refreshTimer.Stop(); };
        }

        private void BuildInterface()
        {
            TableLayoutPanel root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.ColumnCount = 1;
            root.RowCount = 5;
            root.Padding = new Padding(24, 20, 24, 18);
            root.BackColor = WindowBackground;
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 82F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 132F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 62F));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 36F));
            Controls.Add(root);

            root.Controls.Add(BuildHeader(), 0, 0);
            root.Controls.Add(BuildStatusCards(), 0, 1);
            root.Controls.Add(BuildActions(), 0, 2);
            root.Controls.Add(BuildLogPanel(), 0, 3);
            root.Controls.Add(BuildFooter(), 0, 4);
        }

        private Control BuildHeader()
        {
            Panel panel = new Panel();
            panel.Dock = DockStyle.Fill;
            panel.BackColor = WindowBackground;

            Label title = new Label();
            title.AutoSize = true;
            title.Text = "Codex 飞书中继";
            title.ForeColor = MainText;
            title.Font = new Font(Font.FontFamily, 21F, FontStyle.Bold);
            title.Location = new Point(0, 4);

            Label subtitle = new Label();
            subtitle.AutoSize = true;
            subtitle.Text = "按真实线程名推送完成摘要，并接收飞书里的下一步指派";
            subtitle.ForeColor = MutedText;
            subtitle.Font = new Font(Font.FontFamily, 9.5F, FontStyle.Regular);
            subtitle.Location = new Point(2, 48);

            Label location = new Label();
            location.AutoSize = false;
            location.TextAlign = ContentAlignment.MiddleRight;
            location.Text = backend.ProjectRoot;
            location.ForeColor = MutedText;
            location.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            location.Location = new Point(560, 18);
            location.Size = new Size(350, 30);

            panel.Controls.Add(title);
            panel.Controls.Add(subtitle);
            panel.Controls.Add(location);
            panel.Resize += delegate { location.Left = Math.Max(0, panel.ClientSize.Width - location.Width); };
            return panel;
        }

        private Control BuildStatusCards()
        {
            TableLayoutPanel cards = new TableLayoutPanel();
            cards.Dock = DockStyle.Fill;
            cards.ColumnCount = 5;
            cards.RowCount = 1;
            cards.Padding = new Padding(0, 4, 0, 8);

            for (int index = 0; index < 5; index += 1)
            {
                cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20F));
            }

            cards.Controls.Add(CreateStatusCard("中继服务", "serviceCard", out serviceValue, out serviceDetail), 0, 0);
            cards.Controls.Add(CreateStatusCard("Codex Hook", "hookCard", out hookValue, out hookDetail), 1, 0);
            cards.Controls.Add(CreateStatusCard("飞书机器人", "feishuCard", out feishuValue, out feishuDetail), 2, 0);
            cards.Controls.Add(CreateStatusCard("Codex 执行器", "executorCard", out executorValue, out executorDetail), 3, 0);
            cards.Controls.Add(CreateStatusCard("消息队列", "queueCard", out queueValue, out queueDetail), 4, 0);
            return cards;
        }

        private Control CreateStatusCard(
            string titleText,
            string accessibleName,
            out Label valueLabel,
            out Label detailLabel)
        {
            Panel card = new Panel();
            card.Dock = DockStyle.Fill;
            card.Margin = new Padding(0, 0, 12, 0);
            card.Padding = new Padding(16, 13, 16, 12);
            card.BackColor = CardBackground;
            card.BorderStyle = BorderStyle.FixedSingle;
            card.Name = accessibleName;
            card.AccessibleName = titleText;

            Label title = new Label();
            title.Dock = DockStyle.Top;
            title.Height = 23;
            title.Text = titleText;
            title.ForeColor = MutedText;
            title.Font = new Font(Font.FontFamily, 9F, FontStyle.Regular);

            valueLabel = new Label();
            valueLabel.Dock = DockStyle.Top;
            valueLabel.Height = 38;
            valueLabel.Text = "检查中";
            valueLabel.ForeColor = Primary;
            valueLabel.Font = new Font(Font.FontFamily, 16F, FontStyle.Bold);
            valueLabel.Name = accessibleName + "Value";

            detailLabel = new Label();
            detailLabel.Dock = DockStyle.Fill;
            detailLabel.Text = "正在读取本机状态……";
            detailLabel.ForeColor = MutedText;
            detailLabel.Font = new Font(Font.FontFamily, 8.5F, FontStyle.Regular);
            detailLabel.AutoEllipsis = true;
            detailLabel.Name = accessibleName + "Detail";

            card.Controls.Add(detailLabel);
            card.Controls.Add(valueLabel);
            card.Controls.Add(title);
            return card;
        }

        private Control BuildActions()
        {
            FlowLayoutPanel actions = new FlowLayoutPanel();
            actions.Dock = DockStyle.Fill;
            actions.FlowDirection = FlowDirection.LeftToRight;
            actions.WrapContents = false;
            actions.Padding = new Padding(0, 8, 0, 6);
            actions.BackColor = WindowBackground;

            startButton = CreateButton("启动中继", "startButton", Primary, Color.White);
            restartButton = CreateButton("重启", "restartButton", Color.White, MainText);
            stopButton = CreateButton("停止", "stopButton", Color.White, Negative);
            installHookButton = CreateButton("修复 Hook", "installHookButton", Color.White, MainText);
            feishuConfigButton = CreateButton("配置飞书", "feishuConfigButton", Color.White, MainText);
            Button dataButton = CreateButton("打开数据目录", "dataButton", Color.White, MainText);
            refreshButton = CreateButton("刷新", "refreshButton", Color.White, MainText);

            startButton.Click += async delegate { await RunActionAsync("启动中继", async delegate { await backend.StartWorkerAsync(); }); };
            restartButton.Click += async delegate { await RunActionAsync("重启中继", async delegate { await backend.RestartWorkerAsync(); }); };
            stopButton.Click += async delegate { await RunActionAsync("停止中继", async delegate { await backend.StopWorkerAsync(); }); };
            installHookButton.Click += async delegate
            {
                await RunActionAsync("修复 Hook", async delegate
                {
                    string output = await backend.InstallHookAsync();
                    SetFooter(string.IsNullOrWhiteSpace(output) ? "Hook 已检查。" : output, Positive);
                });
            };
            feishuConfigButton.Click += async delegate
            {
                try
                {
                    using (FeishuConfigDialog dialog = new FeishuConfigDialog(backend))
                    {
                        if (dialog.ShowDialog(this) == DialogResult.OK)
                        {
                            SetFooter("飞书配置已保存。请重启中继，并按界面的绑定口令发送飞书消息。", Positive);
                            await RefreshStatusAsync(false);
                        }
                    }
                }
                catch (Exception error)
                {
                    ShowOperationError("配置飞书", error);
                }
            };
            dataButton.Click += delegate
            {
                try
                {
                    backend.OpenDataDirectory();
                    SetFooter("已打开数据目录。", Positive);
                }
                catch (Exception error)
                {
                    ShowOperationError("打开数据目录", error);
                }
            };
            refreshButton.Click += async delegate { await RefreshStatusAsync(true); };

            autoStartCheckBox = new CheckBox();
            autoStartCheckBox.Name = "autoStartCheckBox";
            autoStartCheckBox.Text = "随 Windows 启动";
            autoStartCheckBox.AccessibleName = autoStartCheckBox.Text;
            autoStartCheckBox.AutoSize = true;
            autoStartCheckBox.Margin = new Padding(12, 9, 0, 0);
            autoStartCheckBox.ForeColor = MainText;
            autoStartCheckBox.CheckedChanged += AutoStartCheckBoxChanged;

            actions.Controls.Add(startButton);
            actions.Controls.Add(restartButton);
            actions.Controls.Add(stopButton);
            actions.Controls.Add(installHookButton);
            actions.Controls.Add(feishuConfigButton);
            actions.Controls.Add(dataButton);
            actions.Controls.Add(refreshButton);
            actions.Controls.Add(autoStartCheckBox);
            return actions;
        }

        private Button CreateButton(string text, string accessibleName, Color backColor, Color foreColor)
        {
            Button button = new Button();
            button.Name = accessibleName;
            button.Text = text;
            button.AccessibleName = text;
            button.AutoSize = true;
            button.Height = 36;
            button.MinimumSize = new Size(88, 36);
            button.Margin = new Padding(0, 0, 8, 0);
            button.Padding = new Padding(10, 0, 10, 0);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderColor = backColor == Color.White ? Color.FromArgb(214, 221, 232) : backColor;
            button.FlatAppearance.MouseOverBackColor = backColor == Color.White ? Color.FromArgb(240, 244, 250) : Color.FromArgb(25, 96, 205);
            button.BackColor = backColor;
            button.ForeColor = foreColor;
            button.Cursor = Cursors.Hand;
            return button;
        }

        private Control BuildLogPanel()
        {
            Panel panel = new Panel();
            panel.Dock = DockStyle.Fill;
            panel.Padding = new Padding(16, 14, 16, 14);
            panel.BackColor = CardBackground;
            panel.BorderStyle = BorderStyle.FixedSingle;

            Label heading = new Label();
            heading.Dock = DockStyle.Top;
            heading.Height = 30;
            heading.Text = "最近日志";
            heading.ForeColor = MainText;
            heading.Font = new Font(Font.FontFamily, 11F, FontStyle.Bold);

            logTextBox = new TextBox();
            logTextBox.Name = "logTextBox";
            logTextBox.AccessibleName = "最近日志";
            logTextBox.Dock = DockStyle.Fill;
            logTextBox.Multiline = true;
            logTextBox.ReadOnly = true;
            logTextBox.ScrollBars = ScrollBars.Vertical;
            logTextBox.WordWrap = false;
            logTextBox.BackColor = Color.FromArgb(249, 251, 254);
            logTextBox.ForeColor = Color.FromArgb(47, 61, 82);
            logTextBox.BorderStyle = BorderStyle.FixedSingle;
            logTextBox.Font = new Font("Consolas", 9F, FontStyle.Regular);
            logTextBox.Text = "正在读取日志……";

            Label hint = new Label();
            hint.Dock = DockStyle.Bottom;
            hint.Height = 28;
            hint.Text = "关闭本窗口不会停止后台中继；需要停服时请点击“停止”。";
            hint.ForeColor = MutedText;
            hint.TextAlign = ContentAlignment.BottomLeft;

            panel.Controls.Add(logTextBox);
            panel.Controls.Add(hint);
            panel.Controls.Add(heading);
            return panel;
        }

        private Control BuildFooter()
        {
            footerStatus = new Label();
            footerStatus.Name = "footerStatus";
            footerStatus.Dock = DockStyle.Fill;
            footerStatus.TextAlign = ContentAlignment.MiddleLeft;
            footerStatus.ForeColor = MutedText;
            footerStatus.Text = "准备就绪";
            return footerStatus;
        }

        private async Task RefreshStatusAsync(bool userInitiated)
        {
            if (refreshInProgress)
            {
                return;
            }

            refreshInProgress = true;

            try
            {
                RelayStatus status = await backend.GetStatusAsync();
                ApplyStatus(status);
                logTextBox.Text = backend.ReadRecentLogs(18000);
                SetFooter(
                    "最近刷新：" + DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture),
                    MutedText);
            }
            catch (Exception error)
            {
                SetFooter("状态读取失败：" + error.Message, Negative);

                if (userInitiated)
                {
                    ShowOperationError("刷新状态", error);
                }
            }
            finally
            {
                refreshInProgress = false;
            }
        }

        private void ApplyStatus(RelayStatus status)
        {
            WorkerStatus worker = status.worker ?? new WorkerStatus();
            HookStatus hook = status.hook ?? new HookStatus();
            FeishuStatus feishu = status.feishu ?? new FeishuStatus();
            QueueStatus queues = status.queues ?? new QueueStatus();
            ExecutorDisplay executor = StatusPresentation.BuildExecutor(status.executor);

            serviceValue.Text = worker.running ? "运行中" : "已停止";
            serviceValue.AccessibleName = serviceValue.Text;
            serviceValue.ForeColor = worker.running ? Positive : Negative;
            serviceDetail.Text = worker.running
                ? "PID " + worker.pid.GetValueOrDefault() + " · 飞书长连接"
                : "点击“启动中继”恢复服务";

            hookValue.Text = hook.installed ? "已连接" : "未安装";
            hookValue.AccessibleName = hookValue.Text;
            hookValue.ForeColor = hook.installed ? Positive : Warning;
            hookDetail.Text = hook.installed
                ? "所有侧栏用户线程均接入"
                : "点击“修复 Hook”接入 Codex";

            bool feishuReady = feishu.online && feishu.ownerConfigured;
            feishuValue.Text = feishuReady ? "在线" : (feishu.configured ? "待绑定" : "待配置");
            feishuValue.AccessibleName = feishuValue.Text;
            feishuValue.ForeColor = feishuReady ? Positive : Warning;
            feishuDetail.Text = BuildFeishuDetail(feishu);

            executorValue.Text = executor.Value;
            executorValue.AccessibleName = executor.Value;
            executorValue.ForeColor = !executor.Available || !executor.Enabled
                ? Warning
                : (executor.Running ? Primary : (executor.HasError ? Warning : Positive));
            executorDetail.Text = executor.Detail;
            executorDetail.AccessibleName = executor.Detail;

            queueValue.Text = queues.queuedCompletions + " 条待推送";
            queueValue.AccessibleName = queueValue.Text;
            queueValue.ForeColor = queues.queuedCompletions == 0 ? Positive : Warning;
            queueDetail.Text = StatusPresentation.BuildQueueDetail(queues);
            queueDetail.AccessibleName = queueDetail.Text;

            startButton.Enabled = !worker.running;
            startButton.BackColor = worker.running ? Color.FromArgb(225, 231, 240) : Primary;
            startButton.ForeColor = worker.running ? MutedText : Color.White;
            startButton.FlatAppearance.BorderColor = worker.running ? Color.FromArgb(214, 221, 232) : Primary;
            restartButton.Enabled = worker.running;
            stopButton.Enabled = worker.running;
            installHookButton.Text = hook.installed ? "检查 Hook" : "修复 Hook";
        }

        private static string BuildFeishuDetail(FeishuStatus status)
        {
            if (!status.configValid)
            {
                return "飞书配置文件异常，点击“配置飞书”修复";
            }

            if (!status.configured)
            {
                return "点击“配置飞书”填写 App ID 和 App Secret";
            }

            if (!status.ownerConfigured)
            {
                return string.IsNullOrWhiteSpace(status.pairingCode)
                    ? "等待生成绑定口令"
                    : "飞书发送：/绑定 " + status.pairingCode;
            }

            if (!status.online)
            {
                return "长连接状态：" + (string.IsNullOrWhiteSpace(status.state) ? "连接中" : status.state);
            }

            return "机器人已绑定 · 可主动推送完成摘要";
        }

        private async Task RunActionAsync(string actionName, Func<Task> action)
        {
            SetBusy(true);
            SetFooter(actionName + "处理中……", Primary);

            try
            {
                await action();
                await RefreshStatusAsync(false);
                SetFooter(actionName + "完成。", Positive);
            }
            catch (Exception error)
            {
                ShowOperationError(actionName, error);
            }
            finally
            {
                SetBusy(false);
            }
        }

        private void SetBusy(bool busy)
        {
            UseWaitCursor = busy;
            refreshButton.Enabled = !busy;
            installHookButton.Enabled = !busy;
            feishuConfigButton.Enabled = !busy;

            if (busy)
            {
                startButton.Enabled = false;
                restartButton.Enabled = false;
                stopButton.Enabled = false;
            }
        }

        private void LoadAutoStartState()
        {
            updatingAutoStart = true;

            try
            {
                autoStartCheckBox.Checked = backend.IsAutoStartEnabled();
            }
            catch (Exception error)
            {
                SetFooter("无法读取开机启动状态：" + error.Message, Warning);
            }
            finally
            {
                updatingAutoStart = false;
            }
        }

        private void AutoStartCheckBoxChanged(object sender, EventArgs eventArguments)
        {
            if (updatingAutoStart)
            {
                return;
            }

            try
            {
                backend.SetAutoStartEnabled(autoStartCheckBox.Checked);
                SetFooter(autoStartCheckBox.Checked ? "已启用随 Windows 启动。" : "已关闭随 Windows 启动。", Positive);
            }
            catch (Exception error)
            {
                updatingAutoStart = true;
                autoStartCheckBox.Checked = !autoStartCheckBox.Checked;
                updatingAutoStart = false;
                ShowOperationError("修改开机启动", error);
            }
        }

        private void ShowOperationError(string operation, Exception error)
        {
            SetFooter(operation + "失败：" + error.Message, Negative);
            MessageBox.Show(
                error.Message,
                operation + "失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }

        private void SetFooter(string text, Color color)
        {
            footerStatus.Text = text.Replace("\r", " ").Replace("\n", " ");
            footerStatus.AccessibleName = footerStatus.Text;
            footerStatus.ForeColor = color;
        }
    }
}
