"""九十刻度 · LOTA数据采集助手 V1.0 (validation build).

The collector is deliberately fail-closed until page data and redistribution
rights can be verified. No guessed network payload is treated as a record.
"""
from __future__ import annotations

import base64
import json
import os
import queue
import re
import sys
import threading
import time
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, ttk
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import keyring
import pystray
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
from rapidocr import RapidOCR

from core import CN, current_sale_day, official_matches, canonical_bytes

APP = "90scale-lota-assistant"
ROOT = Path(os.environ.get("LOCALAPPDATA", Path.home())) / APP
CONFIG = ROOT / "config.json"
LOG = ROOT / "events.log"
PROFILE = ROOT / "browser-profile"
URL = "https://hc.lota.tv/#/main"
DEFAULT = {"repo": "SuolunPro/suolunpro.github.io", "branch": "main", "directory": "data/lota/test",
           "interval": 15, "auto": False, "startup": False}


def log(message: str) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now(CN).isoformat()} {message}\n")


def api(url: str, token: str = "", method: str = "GET", data: bytes | None = None):
    headers = {"User-Agent": APP, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(url, headers=headers, method=method, data=data), timeout=25) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except HTTPError as e:
        # Never log response bodies: authentication headers or server diagnostics may be sensitive.
        raise RuntimeError(f"GitHub HTTP {e.code}") from None


def get_official(repo: str, branch: str):
    url = f"https://api.github.com/repos/{repo}/contents/data/engine4/latest.json?ref={quote(branch)}"
    info = api(url)
    payload = json.loads(base64.b64decode(info["content"]))
    # The sales day can span midnight in China; the engine's explicit sales day
    # remains authoritative while its scheduled fixtures are still relevant.
    day = payload["sale_day"]
    if abs((datetime.now(CN).date() - datetime.fromisoformat(day).date()).days) > 1:
        raise ValueError("正式竞彩销售日过期")
    return day, official_matches(payload, day)


def upload(repo: str, branch: str, directory: str, token: str, payload: dict):
    """Optimistic GitHub Contents update. Never replace a valid file with failure data."""
    if not token or payload.get("schema") != "lota-public-v1" or not payload.get("matches"):
        raise ValueError("缺少凭据或已验证数据")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("仓库格式错误")
    if not re.fullmatch(r"data/lota/test(?:/[A-Za-z0-9_.-]+)*", directory):
        raise ValueError("V1.0 仅可写入 data/lota/test 测试目录")
    path = f"{directory}/{payload['sale_day']}.json"
    endpoint = f"https://api.github.com/repos/{repo}/contents/{path}"
    existing = None
    try:
        existing = api(endpoint + "?ref=" + quote(branch), token)
    except RuntimeError as e:
        if str(e) != "GitHub HTTP 404":
            raise
    content = canonical_bytes(payload)
    if existing and base64.b64decode(existing["content"]) == content:
        return "未变化，跳过提交"
    body = {"message": f"data(lota): verified public snapshot {payload['sale_day']}",
            "content": base64.b64encode(content).decode(), "branch": branch}
    if existing:
        body["sha"] = existing["sha"]
    result = api(endpoint, token, "PUT", json.dumps(body).encode())
    return result["commit"]["html_url"]


def ocr_visible_screenshot(path: Path) -> list[dict]:
    result = RapidOCR()(str(path))
    tokens = []
    for box, value, score in zip(result.boxes if result.boxes is not None else [],
                                 result.txts if result.txts is not None else [],
                                 result.scores if result.scores is not None else []):
        x = round(sum(float(point[0]) for point in box) / 4)
        y = round(sum(float(point[1]) for point in box) / 4)
        if score >= 0.6:
            tokens.append({"text": value, "x": x, "y": y, "confidence": round(float(score), 3)})
    return tokens


def diagnostic_probe(officials: list[dict]) -> dict:
    """Open normal browser session; inspect visible Flutter semantics only.

    This probe does not decode secure APIs, infer canvas values, or manufacture
    business records. Screenshots stay on this PC for an authorized review.
    """
    ROOT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(str(PROFILE), channel="chrome", headless=False,
                                                       viewport={"width": 1366, "height": 900})
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(URL, wait_until="domcontentloaded", timeout=45000)
            page.locator("flt-semantics-placeholder").first.click(timeout=4000) if page.locator("flt-semantics-placeholder").count() else None
            page.wait_for_timeout(3500)
            screenshot = ROOT / "lota-local-review.png"
            page.screenshot(path=str(screenshot), full_page=False)
            tokens = ocr_visible_screenshot(screenshot)
            # Only visible screenshot text is retained. Flutter's hidden DOM can
            # contain login fields, so it must never be dumped into diagnostics.
            (ROOT / "lota-ocr-local.json").write_text(json.dumps(tokens, ensure_ascii=False, indent=2), encoding="utf-8")
            visible = " ".join(t["text"] for t in tokens)
            hits = [m["match_no"] for m in officials if m["home"] in visible and m["away"] in visible]
            return {"visible_matches": hits, "ocr_tokens": len(tokens), "url": page.url}
        finally:
            context.close()


def initial_login():
    """Allow a one-time ordinary login in the EXE's separate local profile."""
    ROOT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(str(PROFILE), channel="chrome", headless=False,
                                                       viewport={"width": 1366, "height": 900})
        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(URL, wait_until="domcontentloaded", timeout=45000)
            # The user performs login themselves. Never inspect credential DOM,
            # read cookies or export browser storage. Close this window to finish.
            page.wait_for_event("close", timeout=600000)
            return "本地 Chrome 登录窗口已关闭；会话保存在本机配置目录"
        finally:
            context.close()


def startup(enabled: bool):
    # HKCU Run requires no administrator rights. The installed EXE path is used.
    if sys.platform != "win32":
        return
    import winreg
    path = r"Software\Microsoft\Windows\CurrentVersion\Run"
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            if not getattr(sys, "frozen", False):
                raise ValueError("开机自启仅适用于安装后的 EXE")
            winreg.SetValueEx(key, APP, 0, winreg.REG_SZ, f'"{sys.executable}" --minimized')
        else:
            try:
                winreg.DeleteValue(key, APP)
            except FileNotFoundError:
                pass


class Window:
    def __init__(self):
        ROOT.mkdir(parents=True, exist_ok=True)
        config = DEFAULT | (json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {})
        self.root = tk.Tk()
        self.root.title("九十刻度 · LOTA数据采集助手 V1.0")
        self.root.geometry("730x530")
        self.vars = {k: tk.StringVar(value=str(config[k])) for k in ("repo", "branch", "directory", "interval")}
        self.auto = tk.BooleanVar(value=config["auto"])
        self.boot = tk.BooleanVar(value=config["startup"])
        self.token = tk.StringVar()
        self.status = tk.StringVar(value="待检查：真实必发数据尚未验证")
        self.counts = tk.StringVar(value="今日比赛 — | 采集 0 | 缺失 — | 匹配失败 —")
        self.times = tk.StringVar(value="最近采集 — | 最近上传 —")
        self.events = queue.Queue()
        self.stop = threading.Event()
        self.running = False
        self.last_upload = "—"
        self.interval_minutes = int(config["interval"])
        self.build()
        self.tray = self.make_tray()
        self.tray.run_detached()
        self.root.after(200, self.poll)
        if "--minimized" in sys.argv:
            self.root.withdraw()
        if self.auto.get():
            self.start()

    def build(self):
        frame = ttk.Frame(self.root, padding=18)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="九十刻度 · LOTA数据采集助手 V1.0", font=("Segoe UI", 16, "bold")).pack(anchor="w")
        for var in (self.status, self.counts, self.times):
            ttk.Label(frame, textvariable=var, wraplength=680).pack(anchor="w", pady=5)
        row = ttk.Frame(frame); row.pack(fill="x", pady=8)
        for label, fn in (("首次登录", lambda: self.worker(initial_login)),
                          ("开始采集", self.start), ("停止采集", self.halt), ("立即测试", self.once),
                          ("测试连接", self.test_connection), ("测试上传", self.test_upload)):
            ttk.Button(row, text=label, command=fn).pack(side="left", padx=3)
        settings = ttk.LabelFrame(frame, text="GitHub 连接设置（仅测试目录）", padding=10)
        settings.pack(fill="x")
        for label, key in (("仓库", "repo"), ("分支", "branch"), ("数据目录", "directory"), ("间隔（分钟）", "interval")):
            line = ttk.Frame(settings); line.pack(fill="x", pady=3)
            ttk.Label(line, text=label, width=16).pack(side="left")
            ttk.Entry(line, textvariable=self.vars[key]).pack(side="left", fill="x", expand=True)
        line = ttk.Frame(settings); line.pack(fill="x", pady=3)
        ttk.Label(line, text="GitHub Token", width=16).pack(side="left")
        ttk.Entry(line, textvariable=self.token, show="•").pack(side="left", fill="x", expand=True)
        ttk.Label(settings, text="留空保留 Windows 凭据管理器中的 Token；仅需目标仓库 Contents: Read and write。", wraplength=660).pack(anchor="w")
        options = ttk.Frame(frame); options.pack(fill="x", pady=7)
        ttk.Checkbutton(options, text="自动采集", variable=self.auto).pack(side="left")
        ttk.Checkbutton(options, text="开机自启", variable=self.boot).pack(side="left", padx=12)
        ttk.Button(options, text="保存配置", command=self.save).pack(side="left")
        ttk.Button(options, text="打开本地诊断目录", command=lambda: os.startfile(ROOT) if sys.platform == "win32" else None).pack(side="left", padx=8)
        ttk.Label(frame, text="当前为验证版：未取得并核对页面成交数据前，采集结果为缺失，上传将拒绝。", foreground="#a64b00", wraplength=680).pack(anchor="w", pady=8)
        self.root.protocol("WM_DELETE_WINDOW", self.root.withdraw)

    def make_tray(self):
        img = Image.new("RGB", (64, 64), "#102846")
        draw = ImageDraw.Draw(img)
        draw.ellipse((10, 10, 54, 54), outline="#d5af5a", width=6)
        draw.text((22, 21), "L", fill="white")
        return pystray.Icon(APP, img, "九十刻度 LOTA 助手", menu=pystray.Menu(
            pystray.MenuItem("显示窗口", lambda *_: self.root.after(0, self.root.deiconify)),
            pystray.MenuItem("立即测试", lambda *_: self.root.after(0, self.once)),
            pystray.MenuItem("退出", lambda *_: self.root.after(0, self.quit))))

    def quit(self):
        self.stop.set()
        self.tray.stop()
        self.root.destroy()

    def config(self):
        interval = int(self.vars["interval"].get())
        if not 1 <= interval <= 1440:
            raise ValueError("采集间隔需在 1–1440 分钟之间")
        return {k: self.vars[k].get().strip() for k in ("repo", "branch", "directory")} | {
            "interval": interval, "auto": self.auto.get(), "startup": self.boot.get()}

    def save(self):
        try:
            cfg = self.config()
            self.interval_minutes = cfg["interval"]
            startup(cfg["startup"])
            if self.token.get():
                keyring.set_password(APP, cfg["repo"], self.token.get())
                self.token.set("")
            CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
            self.status.set("配置已保存；Token 不在配置文件中")
        except Exception as e:
            messagebox.showerror("保存失败", str(e))

    def worker(self, operation):
        def run():
            try:
                self.events.put(("ok", operation()))
            except Exception as e:
                log(f"操作失败：{type(e).__name__}: {str(e)[:200] if 'Token' not in str(e) else '凭据错误'}")
                self.events.put(("error", str(e) if "Token" not in str(e) else "凭据错误"))
        threading.Thread(target=run, daemon=True).start()

    def test_connection(self):
        cfg = self.config()
        token = self.token.get() or keyring.get_password(APP, cfg["repo"]) or ""
        self.worker(lambda: "GitHub 连接成功：" + api(f"https://api.github.com/repos/{cfg['repo']}", token)["full_name"])

    def test_upload(self):
        self.status.set("测试上传拒绝：尚无公开分发权限已证实、与页面核对一致的真实数据")

    def once(self):
        if self.running:
            return
        self.running = True
        cfg = self.config()
        def operation():
            day, officials = get_official(cfg["repo"], cfg["branch"])
            probe = diagnostic_probe(officials)
            self.events.put(("counts", f"{day} 比赛 {len(officials)} | 业务采集 0 | 缺失 {len(officials)} | 待核对 {len(officials)-len(probe['visible_matches'])}"))
            self.events.put(("time", datetime.now(CN).strftime("%Y-%m-%d %H:%M:%S")))
            return f"诊断完成：列表可见 {len(probe['visible_matches'])} 场；必发成交字段尚未核对，未上传"
        def run():
            try:
                self.events.put(("ok", operation()))
            except Exception as e:
                log(f"采集诊断失败：{type(e).__name__}: {str(e)[:180]}")
                self.events.put(("error", str(e)))
            finally:
                self.events.put(("done", None))
        threading.Thread(target=run, daemon=True).start()

    def start(self):
        self.stop.clear()
        if getattr(self, "scheduler", None) and self.scheduler.is_alive():
            return
        def loop():
            while not self.stop.is_set():
                self.events.put(("run", None))
                if self.stop.wait(self.interval_minutes * 60):
                    break
        self.scheduler = threading.Thread(target=loop, daemon=True)
        self.scheduler.start()
        self.status.set("自动诊断已启动；未通过验收前不会上传")

    def halt(self):
        self.stop.set()
        self.status.set("自动诊断已停止")

    def poll(self):
        while not self.events.empty():
            kind, value = self.events.get_nowait()
            if kind == "run": self.once()
            elif kind == "counts": self.counts.set(value)
            elif kind == "time": self.times.set(f"最近采集 {value} | 最近上传 {self.last_upload}")
            elif kind == "done": self.running = False
            elif kind == "error": self.status.set("失败：" + value[:180])
            elif kind == "ok": self.status.set(value)
        self.root.after(200, self.poll)

    def main(self):
        self.root.mainloop()


if __name__ == "__main__":
    Window().main()
