using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace CodexFeishuRelayDesktop
{
    internal sealed class FeishuConfigDialog : Form
    {
        private readonly RelayBackend backend;
        private readonly TextBox appIdTextBox;
        private readonly TextBox appSecretTextBox;

        public FeishuConfigDialog(RelayBackend backend)
        {
            this.backend = backend;
            FeishuConfiguration configuration = backend.ReadFeishuConfiguration();

            Text = "配置飞书机器人";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(590, 390);
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.ColumnCount = 1;
            layout.RowCount = 7;
            layout.Padding = new Padding(22, 18, 22, 18);
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(layout);

            Label introduction = new Label();
            introduction.AutoSize = true;
            introduction.Text = "填写飞书企业自建应用的凭据";
            introduction.Font = new Font(Font.FontFamily, 13F, FontStyle.Bold);
            introduction.Margin = new Padding(0, 0, 0, 12);
            layout.Controls.Add(introduction, 0, 0);

            appIdTextBox = CreateInput(configuration.appId, false);
            layout.Controls.Add(CreateField("App ID", appIdTextBox), 0, 1);

            appSecretTextBox = CreateInput(string.Empty, true);
            layout.Controls.Add(CreateField("App Secret", appSecretTextBox), 0, 2);

            Label guide = new Label();
            guide.AutoSize = true;
            guide.MaximumSize = new Size(540, 0);
            guide.Text = "在飞书开放平台创建“企业自建应用”，添加“机器人”能力；事件订阅选择“使用长连接接收事件”，添加“接收消息 v2.0”；申请私聊收消息和机器人发消息权限，发布并把自己加入可用范围。已保存 App Secret 时，留空不会修改。";
            guide.ForeColor = Color.FromArgb(96, 112, 137);
            guide.Margin = new Padding(0, 14, 0, 5);
            layout.Controls.Add(guide, 0, 3);

            LinkLabel developerConsole = new LinkLabel();
            developerConsole.AutoSize = true;
            developerConsole.Text = "打开飞书开发者后台";
            developerConsole.Margin = new Padding(0, 0, 0, 12);
            developerConsole.LinkClicked += delegate
            {
                Process.Start(new ProcessStartInfo("https://open.feishu.cn/app") { UseShellExecute = true });
            };
            layout.Controls.Add(developerConsole, 0, 4);

            FlowLayoutPanel actions = new FlowLayoutPanel();
            actions.FlowDirection = FlowDirection.RightToLeft;
            actions.AutoSize = true;
            actions.Dock = DockStyle.Fill;

            Button cancelButton = new Button();
            cancelButton.Text = "取消";
            cancelButton.DialogResult = DialogResult.Cancel;
            cancelButton.AutoSize = true;
            cancelButton.Margin = new Padding(8, 0, 0, 0);

            Button saveButton = new Button();
            saveButton.Text = "保存配置";
            saveButton.AutoSize = true;
            saveButton.Click += SaveButtonClick;

            actions.Controls.Add(cancelButton);
            actions.Controls.Add(saveButton);
            layout.Controls.Add(actions, 0, 5);

            AcceptButton = saveButton;
            CancelButton = cancelButton;
        }

        private static TextBox CreateInput(string value, bool secret)
        {
            TextBox textBox = new TextBox();
            textBox.Dock = DockStyle.Top;
            textBox.Text = value ?? string.Empty;
            textBox.UseSystemPasswordChar = secret;
            textBox.Width = 540;
            return textBox;
        }

        private static Control CreateField(string labelText, Control input)
        {
            TableLayoutPanel field = new TableLayoutPanel();
            field.AutoSize = true;
            field.Dock = DockStyle.Top;
            field.ColumnCount = 1;
            field.RowCount = 2;
            field.Margin = new Padding(0, 0, 0, 10);

            Label label = new Label();
            label.AutoSize = true;
            label.Text = labelText;
            label.Margin = new Padding(0, 0, 0, 4);

            field.Controls.Add(label, 0, 0);
            field.Controls.Add(input, 0, 1);
            return field;
        }

        private void SaveButtonClick(object sender, EventArgs eventArguments)
        {
            try
            {
                backend.SaveFeishuConfiguration(appIdTextBox.Text, appSecretTextBox.Text);
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    error.Message,
                    "保存飞书配置失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }
    }
}
