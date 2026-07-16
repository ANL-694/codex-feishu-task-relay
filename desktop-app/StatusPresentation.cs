using System;

namespace CodexFeishuRelayDesktop
{
    internal sealed class ExecutorDisplay
    {
        public ExecutorDisplay(
            string value,
            string detail,
            bool available,
            bool enabled,
            bool running,
            bool hasError)
        {
            Value = value;
            Detail = detail;
            Available = available;
            Enabled = enabled;
            Running = running;
            HasError = hasError;
        }

        public string Value { get; private set; }
        public string Detail { get; private set; }
        public bool Available { get; private set; }
        public bool Enabled { get; private set; }
        public bool Running { get; private set; }
        public bool HasError { get; private set; }
    }

    internal static class StatusPresentation
    {
        public static ExecutorDisplay BuildExecutor(ExecutorStatus status)
        {
            if (status == null)
            {
                return new ExecutorDisplay(
                    "状态未知",
                    "当前：旧版状态未提供执行器信息" + Environment.NewLine +
                        "最近错误：不可用",
                    false,
                    false,
                    false,
                    false);
            }

            bool running = status.runningTask != null;
            bool hasError = status.lastError != null &&
                !string.IsNullOrWhiteSpace(status.lastError.message);
            string value = !status.enabled ? "未启用" : (running ? "执行中" : "待命");
            string detail = BuildCurrentTask(status.runningTask) + Environment.NewLine +
                BuildLastError(status.lastError);

            return new ExecutorDisplay(
                value,
                detail,
                true,
                status.enabled,
                running,
                hasError);
        }

        public static string BuildQueueDetail(QueueStatus queues)
        {
            QueueStatus normalized = queues ?? new QueueStatus();
            return "待办 " + normalized.pendingTasks + " · 执行 " +
                normalized.runningTasks + " · 失败 " + normalized.failedTasks;
        }

        private static string BuildCurrentTask(ExecutorTaskStatus task)
        {
            if (task == null)
            {
                return "当前：无执行任务";
            }

            return "当前：" + BuildTaskIdentity(task.projectName, task.taskId);
        }

        private static string BuildLastError(ExecutorErrorStatus error)
        {
            if (error == null || string.IsNullOrWhiteSpace(error.message))
            {
                return "最近错误：无";
            }

            string identity = BuildTaskIdentity(error.projectName, error.taskId);
            return "最近错误：" + identity + " · " + error.message.Trim();
        }

        private static string BuildTaskIdentity(string projectName, int? taskId)
        {
            string name = string.IsNullOrWhiteSpace(projectName) ? "未命名线程" : projectName.Trim();
            string taskNumber = taskId.HasValue && taskId.Value > 0
                ? "T-" + taskId.Value
                : "T-?";
            return name + " · " + taskNumber;
        }
    }
}
