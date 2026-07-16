using System;
using System.Web.Script.Serialization;

namespace CodexFeishuRelayDesktop.Tests
{
    internal static class StatusPresentationTests
    {
        private static int Main()
        {
            try
            {
                OldStatusRemainsCompatible();
                RunningTaskAndLastErrorAreVisible();
                DisabledExecutorIsExplicit();
                QueueCountsIncludeExecutionStates();
                Console.WriteLine("桌面执行器状态测试通过。");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
        }

        private static void OldStatusRemainsCompatible()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            RelayStatus status = serializer.Deserialize<RelayStatus>(
                "{\"worker\":{\"running\":true},\"queues\":{\"pendingTasks\":2,\"queuedCompletions\":1}}");
            ExecutorDisplay display = StatusPresentation.BuildExecutor(status.executor);

            AssertEqual("状态未知", display.Value, "旧状态的执行器主状态");
            AssertContains(display.Detail, "旧版状态未提供执行器信息", "旧状态的兼容提示");
            AssertEqual(0, status.queues.runningTasks, "旧状态的运行任务默认值");
            AssertEqual(0, status.queues.failedTasks, "旧状态的失败任务默认值");
        }

        private static void RunningTaskAndLastErrorAreVisible()
        {
            ExecutorDisplay display = StatusPresentation.BuildExecutor(new ExecutorStatus
            {
                enabled = true,
                runningTask = new ExecutorTaskStatus
                {
                    taskId = 27,
                    projectName = "anl api",
                    instruction = "查看当前版本",
                    startedAt = "2026-07-16T10:00:00.000Z",
                },
                lastError = new ExecutorErrorStatus
                {
                    taskId = 18,
                    projectName = "bds",
                    message = "网络暂时不可用",
                    at = "2026-07-16T09:00:00.000Z",
                },
            });

            AssertEqual("执行中", display.Value, "运行中的主状态");
            AssertContains(display.Detail, "当前：anl api · T-27", "当前任务");
            AssertContains(display.Detail, "最近错误：bds · T-18 · 网络暂时不可用", "最近错误");
            AssertTrue(display.Running, "运行标记");
            AssertTrue(display.HasError, "错误标记");
        }

        private static void DisabledExecutorIsExplicit()
        {
            ExecutorDisplay display = StatusPresentation.BuildExecutor(new ExecutorStatus());

            AssertEqual("未启用", display.Value, "未启用状态");
            AssertContains(display.Detail, "当前：无执行任务", "未启用当前任务");
            AssertContains(display.Detail, "最近错误：无", "未启用最近错误");
        }

        private static void QueueCountsIncludeExecutionStates()
        {
            string detail = StatusPresentation.BuildQueueDetail(new QueueStatus
            {
                pendingTasks = 3,
                runningTasks = 1,
                failedTasks = 2,
            });

            AssertEqual("待办 3 · 执行 1 · 失败 2", detail, "队列详情");
        }

        private static void AssertContains(string actual, string expected, string label)
        {
            if (actual == null || actual.IndexOf(expected, StringComparison.Ordinal) < 0)
            {
                throw new InvalidOperationException(label + " 缺少：" + expected + "；实际：" + actual);
            }
        }

        private static void AssertEqual<T>(T expected, T actual, string label)
        {
            if (!object.Equals(expected, actual))
            {
                throw new InvalidOperationException(
                    label + " 不一致；期望：" + expected + "；实际：" + actual);
            }
        }

        private static void AssertTrue(bool value, string label)
        {
            if (!value)
            {
                throw new InvalidOperationException(label + " 应为 true。");
            }
        }
    }
}
