using System;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Codex 飞书中继")]
[assembly: AssemblyDescription("Codex Desktop 与飞书之间的轻量任务中继控制台")]
[assembly: AssemblyCompany("Local")]
[assembly: AssemblyProduct("Codex 飞书中继")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace CodexFeishuRelayDesktop
{
    internal static class Program
    {
        private const string SingleInstanceMutexName = "Local\\CodexFeishuRelayDesktop";

        [STAThread]
        private static void Main(string[] arguments)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            RelayBackend backend;

            try
            {
                backend = new RelayBackend(AppDomain.CurrentDomain.BaseDirectory);
                TraceStartup(backend, "backend-ready");
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    error.Message,
                    "Codex 飞书中继",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            if (HasArgument(arguments, "--background"))
            {
                RunBackgroundStart(backend);
                return;
            }

            bool createdNew;

            using (Mutex mutex = new Mutex(true, SingleInstanceMutexName, out createdNew))
            {
                TraceStartup(backend, "mutex-created=" + createdNew);

                if (!createdNew)
                {
                    MessageBox.Show(
                        "控制台已经打开。后台中继本身始终只会运行一个实例。",
                        "Codex 飞书中继",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return;
                }

                Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs eventArguments)
                {
                    MessageBox.Show(
                        eventArguments.Exception.Message,
                        "程序发生错误",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                };

                try
                {
                    MainForm form = new MainForm(backend);
                    TraceStartup(backend, "form-created");
                    Application.Run(form);
                    TraceStartup(backend, "message-loop-ended");
                }
                catch (Exception error)
                {
                    backend.AppendDesktopError("桌面窗口启动失败：" + error);
                    MessageBox.Show(
                        error.Message,
                        "Codex 飞书中继启动失败",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }

                GC.KeepAlive(mutex);
            }
        }

        private static bool HasArgument(string[] arguments, string expected)
        {
            foreach (string argument in arguments)
            {
                if (string.Equals(argument, expected, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static void RunBackgroundStart(RelayBackend backend)
        {
            try
            {
                backend.StartWorkerAsync().GetAwaiter().GetResult();
            }
            catch (Exception error)
            {
                try
                {
                    backend.AppendDesktopError("开机启动失败：" + error.Message);
                }
                catch
                {
                }
            }
        }

        private static void TraceStartup(RelayBackend backend, string stage)
        {
            if (string.Equals(
                Environment.GetEnvironmentVariable("CODEX_FEISHU_DESKTOP_TRACE"),
                "1",
                StringComparison.Ordinal))
            {
                backend.AppendDesktopError("桌面启动跟踪：" + stage);
            }
        }
    }
}
