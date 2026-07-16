import json
import os
import site
import sys
import time
import traceback
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
site.addsitedir(str(SCRIPT_DIR / ".deps"))

from pywinauto import Application, Desktop


APP_PATH = Path(
    os.environ.get(
        "APP_PATH",
        str(SCRIPT_DIR.parent.parent / "程序" / "Codex飞书中继.exe"),
    )
).resolve()
ARTIFACT_DIR = SCRIPT_DIR / "artifacts"
WINDOW_TITLE = "Codex 飞书中继"


def control_text(specification):
    control = specification.wrapper_object()
    for accessor in ("get_value", "window_text"):
        try:
            value = getattr(control, accessor)()
            if value:
                return value
        except Exception:
            pass
    return ""


def wait_until(predicate, timeout=12, interval=0.25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if predicate():
                return
        except Exception:
            pass
        time.sleep(interval)
    raise TimeoutError("桌面状态未在限定时间内更新。")


def main():
    if not APP_PATH.is_file():
        raise FileNotFoundError(f"找不到桌面程序：{APP_PATH}")

    try:
        native_window = Desktop(backend="win32").window(title=WINDOW_TITLE)
        native_window.wait("exists visible", timeout=5)
        application = Application(backend="uia").connect(handle=native_window.handle, timeout=5)
        window = application.window(handle=native_window.handle)
        launched_here = False
    except Exception:
        application = Application(backend="uia").start(str(APP_PATH), timeout=15)
        window = application.window(title=WINDOW_TITLE)
        launched_here = True

    try:
        window.wait("visible", timeout=15)
        window.set_focus()

        controls = {
            "service": window.child_window(auto_id="serviceCardValue"),
            "hook": window.child_window(auto_id="hookCardValue"),
            "feishu": window.child_window(auto_id="feishuCardValue"),
            "executor": window.child_window(auto_id="executorCardValue"),
            "executor_detail": window.child_window(auto_id="executorCardDetail"),
            "queue": window.child_window(auto_id="queueCardValue"),
            "queue_detail": window.child_window(auto_id="queueCardDetail"),
            "refresh": window.child_window(auto_id="refreshButton", control_type="Button"),
            "start": window.child_window(auto_id="startButton", control_type="Button"),
            "stop": window.child_window(auto_id="stopButton", control_type="Button"),
            "log": window.child_window(auto_id="logTextBox", control_type="Edit"),
            "autostart": window.child_window(auto_id="autoStartCheckBox", control_type="CheckBox"),
            "footer": window.child_window(auto_id="footerStatus"),
        }

        for specification in controls.values():
            specification.wait("exists visible", timeout=10)

        assert control_text(controls["service"]) in {"运行中", "已停止"}
        assert control_text(controls["hook"]) in {"已连接", "未安装"}
        assert control_text(controls["feishu"]) in {"在线", "待绑定", "待配置"}
        assert control_text(controls["executor"]) in {
            "未启用",
            "待命",
            "执行中",
            "状态未知",
        }
        executor_detail = control_text(controls["executor_detail"])
        assert "当前：" in executor_detail
        assert "最近错误：" in executor_detail
        assert control_text(controls["queue"]) == "0 条待推送"
        assert "待办" in control_text(controls["queue_detail"])
        assert controls["start"].is_enabled() != controls["stop"].is_enabled()

        controls["refresh"].invoke()
        wait_until(lambda: "最近刷新" in control_text(controls["footer"]))

        controlled_worker = os.environ.get("E2E_CONTROL_WORKER") == "1"

        if controlled_worker:
            controls["stop"].invoke()
            wait_until(lambda: control_text(controls["service"]) == "已停止", timeout=25)
            wait_until(lambda: controls["start"].is_enabled(), timeout=10)
            controls["start"].invoke()
            wait_until(lambda: control_text(controls["service"]) == "运行中", timeout=25)
            wait_until(lambda: control_text(controls["feishu"]) == "在线", timeout=30)

        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        screenshot_path = ARTIFACT_DIR / "smoke.png"
        window.capture_as_image().save(screenshot_path)

        return {
            "app": str(APP_PATH),
            "controlledWorker": controlled_worker,
            "hook": control_text(controls["hook"]),
            "launchedHere": launched_here,
            "executor": control_text(controls["executor"]),
            "executorDetail": executor_detail,
            "queue": control_text(controls["queue"]),
            "screenshot": str(screenshot_path),
            "service": control_text(controls["service"]),
            "feishu": control_text(controls["feishu"]),
        }
    finally:
        try:
            window.close()
            application.wait_for_process_exit(timeout=5)
        except Exception:
            application.kill()


if __name__ == "__main__":
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    result_path = ARTIFACT_DIR / "result.log"

    try:
        result = main()
        payload = json.dumps(result, ensure_ascii=False)
        result_path.write_text(payload + "\n", encoding="utf-8")
        print(payload)
    except Exception:
        payload = traceback.format_exc()
        result_path.write_text(payload, encoding="utf-8")
        raise
