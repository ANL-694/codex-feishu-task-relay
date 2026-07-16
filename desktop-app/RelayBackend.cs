using Microsoft.Win32;
using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CodexFeishuRelayDesktop
{
    internal sealed class WorkerStatus
    {
        public bool running { get; set; }
        public int? pid { get; set; }
        public string startedAt { get; set; }
    }

    internal sealed class HookStatus
    {
        public bool installed { get; set; }
    }

    internal sealed class FeishuStatus
    {
        public bool configured { get; set; }
        public bool configValid { get; set; }
        public bool online { get; set; }
        public bool ownerConfigured { get; set; }
        public string pairingCode { get; set; }
        public string state { get; set; }
        public string statusUpdatedAt { get; set; }
    }

    internal sealed class FeishuConfiguration
    {
        public string appId { get; set; }
        public string appSecret { get; set; }
        public string ownerOpenId { get; set; }
        public string pairingCode { get; set; }
    }

    internal sealed class QueueStatus
    {
        public int queuedCompletions { get; set; }
        public int pendingTasks { get; set; }
        public int runningTasks { get; set; }
        public int failedTasks { get; set; }
    }

    internal sealed class ExecutorTaskStatus
    {
        public int? taskId { get; set; }
        public string projectName { get; set; }
        public string instruction { get; set; }
        public string startedAt { get; set; }
    }

    internal sealed class ExecutorErrorStatus
    {
        public int? taskId { get; set; }
        public string projectName { get; set; }
        public string message { get; set; }
        public string at { get; set; }
    }

    internal sealed class ExecutorStatus
    {
        public bool enabled { get; set; }
        public ExecutorTaskStatus runningTask { get; set; }
        public ExecutorErrorStatus lastError { get; set; }
    }

    internal sealed class RelayPaths
    {
        public string root { get; set; }
        public string data { get; set; }
        public string stderrLog { get; set; }
        public string stdoutLog { get; set; }
        public string qrImage { get; set; }
    }

    internal sealed class RelayStatus
    {
        public WorkerStatus worker { get; set; }
        public HookStatus hook { get; set; }
        public FeishuStatus feishu { get; set; }
        public QueueStatus queues { get; set; }
        public ExecutorStatus executor { get; set; }
        public RelayPaths paths { get; set; }
    }

    internal sealed class NodeCommandResult
    {
        public int ExitCode { get; set; }
        public string StandardOutput { get; set; }
        public string StandardError { get; set; }
    }

    internal sealed class RelayBackend
    {
        private const string AutoStartRegistryPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        private const string AutoStartValueName = "CodexFeishuRelay";
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();

        public RelayBackend(string applicationDirectory)
        {
            ProjectRoot = FindProjectRoot(applicationDirectory);
            NodePath = FindNodePath();
        }

        public string ProjectRoot { get; private set; }
        public string NodePath { get; private set; }

        public async Task<RelayStatus> GetStatusAsync()
        {
            NodeCommandResult result = await RunNodeAsync("src\\control.cjs", "status", 12000);
            EnsureSuccess(result, "读取中继状态");

            try
            {
                RelayStatus status = serializer.Deserialize<RelayStatus>(result.StandardOutput.Trim());

                if (status == null || status.worker == null)
                {
                    throw new InvalidOperationException("状态 JSON 缺少 worker 字段。");
                }

                return status;
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(
                    "无法解析中继状态：" + error.Message + Environment.NewLine + result.StandardOutput,
                    error);
            }
        }

        public async Task<RelayStatus> StartWorkerAsync()
        {
            NodeCommandResult result = await RunNodeAsync("src\\control.cjs", "start", 18000);
            EnsureSuccess(result, "启动飞书中继");
            return await GetStatusAsync();
        }

        public async Task<RelayStatus> StopWorkerAsync()
        {
            NodeCommandResult result = await RunNodeAsync("src\\control.cjs", "stop", 15000);
            EnsureSuccess(result, "停止飞书中继");
            return await GetStatusAsync();
        }

        public async Task<RelayStatus> RestartWorkerAsync()
        {
            await StopWorkerAsync();
            return await StartWorkerAsync();
        }

        public async Task<string> InstallHookAsync()
        {
            NodeCommandResult result = await RunNodeAsync("scripts\\configure-notify.cjs", "install", 15000);
            EnsureSuccess(result, "安装 Codex 通知 Hook");
            return CombineOutput(result);
        }

        public FeishuConfiguration ReadFeishuConfiguration()
        {
            string configPath = Path.Combine(ProjectRoot, "data", "feishu-config.json");

            if (!File.Exists(configPath))
            {
                return new FeishuConfiguration();
            }

            try
            {
                FeishuConfiguration configuration = serializer.Deserialize<FeishuConfiguration>(
                    File.ReadAllText(configPath, new UTF8Encoding(false)));
                return NormalizeFeishuConfiguration(configuration);
            }
            catch (Exception error)
            {
                throw new InvalidOperationException("无法读取飞书配置：" + error.Message, error);
            }
        }

        public void SaveFeishuConfiguration(string appId, string appSecret)
        {
            FeishuConfiguration existing = ReadFeishuConfiguration();
            string normalizedAppId = (appId ?? string.Empty).Trim();
            string normalizedAppSecret = (appSecret ?? string.Empty).Trim();
            bool applicationChanged = !string.Equals(
                existing.appId ?? string.Empty,
                normalizedAppId,
                StringComparison.Ordinal);

            if (!Regex.IsMatch(normalizedAppId, "^cli_[0-9a-fA-F]{16}$"))
            {
                throw new InvalidOperationException("App ID 格式无效，应为以 cli_ 开头的飞书企业自建应用 ID。" );
            }

            if (normalizedAppSecret.Length == 0)
            {
                if (applicationChanged && (existing.appId ?? string.Empty).Length > 0)
                {
                    throw new InvalidOperationException("更换 App ID 时必须同时填写对应的 App Secret。" );
                }

                normalizedAppSecret = existing.appSecret ?? string.Empty;
            }

            if (normalizedAppSecret.Length == 0)
            {
                throw new InvalidOperationException("请填写 App Secret。" );
            }

            FeishuConfiguration updated = new FeishuConfiguration
            {
                appId = normalizedAppId,
                appSecret = normalizedAppSecret,
                ownerOpenId = applicationChanged ? string.Empty : (existing.ownerOpenId ?? string.Empty),
                pairingCode = applicationChanged ? string.Empty : (existing.pairingCode ?? string.Empty),
            };

            if (updated.ownerOpenId.Length == 0 && updated.pairingCode.Length == 0)
            {
                updated.pairingCode = GeneratePairingCode();
            }

            string configPath = Path.Combine(ProjectRoot, "data", "feishu-config.json");
            WriteTextAtomically(configPath, serializer.Serialize(updated) + Environment.NewLine);
        }

        public void OpenDataDirectory()
        {
            string dataDirectory = Path.Combine(ProjectRoot, "data");
            Directory.CreateDirectory(dataDirectory);
            Process.Start(new ProcessStartInfo(dataDirectory) { UseShellExecute = true });
        }

        public string ReadRecentLogs(int maximumCharacters)
        {
            string stdoutPath = Path.Combine(ProjectRoot, "data", "relay-worker.stdout.log");
            string stderrPath = Path.Combine(ProjectRoot, "data", "relay-worker.stderr.log");
            string stderr = NormalizeLineEndings(SanitizeLog(ReadSharedText(stderrPath)));
            string stdout = NormalizeLineEndings(SanitizeLog(ReadSharedText(stdoutPath)));
            StringBuilder combined = new StringBuilder();

            if (!string.IsNullOrWhiteSpace(stderr))
            {
                combined.AppendLine("[连接与错误]");
                combined.AppendLine(stderr.TrimEnd());
            }

            if (!string.IsNullOrWhiteSpace(stdout))
            {
                if (combined.Length > 0)
                {
                    combined.AppendLine();
                }

                combined.AppendLine("[运行输出]");
                combined.AppendLine(stdout.TrimEnd());
            }

            if (combined.Length == 0)
            {
                return "暂无 worker 日志。";
            }

            string value = combined.ToString();

            if (value.Length > maximumCharacters)
            {
                return "……仅显示最近日志……" + Environment.NewLine + value.Substring(value.Length - maximumCharacters);
            }

            return value;
        }

        public bool IsAutoStartEnabled()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(AutoStartRegistryPath, false))
            {
                string current = key == null ? null : key.GetValue(AutoStartValueName) as string;
                return string.Equals(current, BuildAutoStartCommand(), StringComparison.OrdinalIgnoreCase);
            }
        }

        public void SetAutoStartEnabled(bool enabled)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(AutoStartRegistryPath))
            {
                if (key == null)
                {
                    throw new InvalidOperationException("无法打开当前用户的开机启动配置。" );
                }

                if (enabled)
                {
                    key.SetValue(AutoStartValueName, BuildAutoStartCommand(), RegistryValueKind.String);
                }
                else
                {
                    key.DeleteValue(AutoStartValueName, false);
                }
            }
        }

        public void AppendDesktopError(string message)
        {
            string logPath = Path.Combine(ProjectRoot, "data", "desktop-control.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
            File.AppendAllText(
                logPath,
                DateTimeOffset.Now.ToString("o") + " " + message + Environment.NewLine,
                new UTF8Encoding(false));
        }

        private async Task<NodeCommandResult> RunNodeAsync(string relativeScript, string arguments, int timeoutMilliseconds)
        {
            return await Task.Run(delegate
            {
                string scriptPath = Path.Combine(ProjectRoot, relativeScript);

                if (!File.Exists(scriptPath))
                {
                    throw new FileNotFoundException("缺少程序脚本。", scriptPath);
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = NodePath;
                startInfo.Arguments = "--no-warnings " + QuoteArgument(scriptPath) +
                    (string.IsNullOrWhiteSpace(arguments) ? string.Empty : " " + arguments);
                startInfo.WorkingDirectory = ProjectRoot;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                startInfo.StandardOutputEncoding = new UTF8Encoding(false);
                startInfo.StandardErrorEncoding = new UTF8Encoding(false);

                using (Process process = new Process())
                {
                    process.StartInfo = startInfo;
                    process.Start();
                    string standardOutput = process.StandardOutput.ReadToEnd();
                    string standardError = process.StandardError.ReadToEnd();

                    if (!process.WaitForExit(timeoutMilliseconds))
                    {
                        process.Kill();
                        throw new TimeoutException("Node 控制命令执行超时。" );
                    }

                    return new NodeCommandResult
                    {
                        ExitCode = process.ExitCode,
                        StandardOutput = standardOutput,
                        StandardError = standardError,
                    };
                }
            });
        }

        private static void EnsureSuccess(NodeCommandResult result, string operation)
        {
            if (result.ExitCode == 0)
            {
                return;
            }

            string output = CombineOutput(result);
            throw new InvalidOperationException(operation + "失败：" + (string.IsNullOrWhiteSpace(output) ? "未知错误" : output));
        }

        private static string CombineOutput(NodeCommandResult result)
        {
            string value = (result.StandardOutput + Environment.NewLine + result.StandardError).Trim();
            return value;
        }

        private static FeishuConfiguration NormalizeFeishuConfiguration(FeishuConfiguration configuration)
        {
            FeishuConfiguration value = configuration ?? new FeishuConfiguration();
            value.appId = (value.appId ?? string.Empty).Trim();
            value.appSecret = (value.appSecret ?? string.Empty).Trim();
            value.ownerOpenId = (value.ownerOpenId ?? string.Empty).Trim();
            value.pairingCode = (value.pairingCode ?? string.Empty).Trim();
            return value;
        }

        private static string GeneratePairingCode()
        {
            byte[] bytes = new byte[12];

            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }

            return "relay-" + Convert.ToBase64String(bytes)
                .TrimEnd('=')
                .Replace('+', '-')
                .Replace('/', '_');
        }

        private static void WriteTextAtomically(string targetPath, string content)
        {
            string directory = Path.GetDirectoryName(targetPath);
            string temporaryPath = Path.Combine(
                directory,
                "." + Path.GetFileName(targetPath) + "." + Process.GetCurrentProcess().Id + ".tmp");

            Directory.CreateDirectory(directory);
            File.WriteAllText(temporaryPath, content, new UTF8Encoding(false));

            try
            {
                if (File.Exists(targetPath))
                {
                    File.Replace(temporaryPath, targetPath, null);
                }
                else
                {
                    File.Move(temporaryPath, targetPath);
                }
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }

        private static string ReadSharedText(string path)
        {
            if (!File.Exists(path))
            {
                return string.Empty;
            }

            try
            {
                using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (StreamReader reader = new StreamReader(stream, new UTF8Encoding(false), true))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (IOException)
            {
                return string.Empty;
            }
        }

        private string BuildAutoStartCommand()
        {
            return QuoteArgument(System.Reflection.Assembly.GetEntryAssembly().Location) + " --background";
        }

        private static string SanitizeLog(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return value;
            }

            string sanitized = Regex.Replace(
                value,
                "\\\"userId\\\"\\s*:\\s*\\\"[^\\\"]+\\\"",
                "\"userId\":\"已隐藏\"",
                RegexOptions.IgnoreCase);
            sanitized = Regex.Replace(
                sanitized,
                "\\\"(?:appSecret|app_secret)\\\"\\s*:\\s*\\\"[^\\\"]+\\\"",
                "\"appSecret\":\"已隐藏\"",
                RegexOptions.IgnoreCase);
            sanitized = Regex.Replace(
                sanitized,
                "(?im)(登录链接：)\\s*\\S+",
                "$1[已隐藏]");
            sanitized = Regex.Replace(
                sanitized,
                "(?i)https?://\\S*(?:app_secret|token)\\S*",
                "[敏感链接已隐藏]");
            return sanitized;
        }

        private static string NormalizeLineEndings(string value)
        {
            return value
                .Replace("\r\n", "\n")
                .Replace("\r", "\n")
                .Replace("\n", Environment.NewLine);
        }

        private static string FindProjectRoot(string applicationDirectory)
        {
            string explicitRoot = Environment.GetEnvironmentVariable("CODEX_FEISHU_ROOT");

            if (IsProjectRoot(explicitRoot))
            {
                return Path.GetFullPath(explicitRoot);
            }

            string[] startingPoints = { applicationDirectory, Environment.CurrentDirectory };

            foreach (string startingPoint in startingPoints)
            {
                DirectoryInfo directory = new DirectoryInfo(Path.GetFullPath(startingPoint));

                for (int depth = 0; directory != null && depth < 10; depth += 1)
                {
                    if (IsProjectRoot(directory.FullName))
                    {
                        return directory.FullName;
                    }

                    directory = directory.Parent;
                }
            }

            throw new DirectoryNotFoundException(
                "没有找到中继脚本。请把本程序放在项目的“程序”目录中。" );
        }

        private static bool IsProjectRoot(string directory)
        {
            return !string.IsNullOrWhiteSpace(directory) &&
                File.Exists(Path.Combine(directory, "package.json")) &&
                File.Exists(Path.Combine(directory, "src", "worker.cjs"));
        }

        private static string FindNodePath()
        {
            string explicitNode = Environment.GetEnvironmentVariable("CODEX_FEISHU_NODE_PATH");

            if (!string.IsNullOrWhiteSpace(explicitNode) && File.Exists(explicitNode))
            {
                return explicitNode;
            }

            string[] fixedCandidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            };

            foreach (string candidate in fixedCandidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;

            foreach (string pathEntry in pathValue.Split(Path.PathSeparator))
            {
                string normalized = pathEntry.Trim().Trim('"');

                if (normalized.Length == 0)
                {
                    continue;
                }

                string candidate = Path.Combine(normalized, "node.exe");

                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            throw new FileNotFoundException("没有找到 Node.js。当前中继需要 Node.js 22 或更高版本。" );
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
