# 九十刻度 · LOTA数据采集助手 V1.0（验证版）

**当前状态：真实必发采集、公开分发权限、GitHub测试提交尚未验收。** 这是可运行的诊断程序，不是已完成的无人值守采集器。程序在取得可与页面逐项核对的成交数据前拒绝上传；不得将诊断截图或成功 HTTP 响应作为业务数据。

## Windows 11 构建和运行

在本仓库 GitHub Actions 的 **Build LOTA assistant Windows validation EXE** 手动运行，下载 `90scale-lota-assistant-windows-validation` 产物；或在 Windows 11 安装 Python 3.12、Chrome 后运行：

```powershell
cd tools/lota-assistant
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m unittest -v test_core
pyinstaller --noconfirm --clean --onefile --windowed --name 90scale-lota-assistant --hidden-import keyring.backends.Windows app.py
```

EXE 位于 `dist/90scale-lota-assistant.exe`。Chrome 必须已安装。首次点击“立即测试”会打开独立 Chrome 配置目录；用户只在 LOTA 正常登录页面自行登录普通账号。应用不导出会话或 Cookie。诊断结果（可见文本和截图）只保存在 `%LOCALAPPDATA%\90scale-lota-assistant`，不上传。

设置限定仓库的 fine-grained GitHub Token（Contents: Read and write），在界面保存。Token 存入 Windows 凭据管理器；其他配置写入本地 JSON。当前“测试连接”只验证仓库可访问，“测试上传”会拒绝，因为尚无可公开分发且逐项核对的真实业务数据。GitHub 写入函数仅接受 `data/lota/test/` 路径、有效结构和真实记录；相同内容不产生重复提交。正式预测 JSON、模型和网站前端均不读取本目录。

自动诊断默认 15 分钟一次，可停止；EXE 可选 HKCU 开机自启。关闭窗口会最小化（任务栏），本版尚未提供系统托盘图标。网络失败会在下一周期重试，并在本地写错误日志。程序不应作为真正的数据采集运行承诺。

## 后续验收门槛

1. 在实际普通账号中确认一场正式竞彩：LOTA 比赛 ID、主客队、联赛、开赛时间、胜平负成交量、交易比例、价格与更新时间；保存人工核对证据，确认各字段允许公开再分发。
2. 将经过验证的 Flutter 页面提取方式实现为独立采集适配器；逐场按照竞彩编号、球队、联赛、时间及 LOTA ID 确认匹配，异常保持缺失。
3. 用真实记录调用 `core.publishable_payload`，仅写测试目录；核对 GitHub 提交和重复采集不提交，再测网络重试、开机恢复、托盘行为。
4. 完成上述验收后，另行审查九十刻度测试读取接口；现有正式算法不接入未经验证的数据。

## 已知限制

- LOTA Flutter 页面当前在模型入口要求手机号登录。本构建不解密 `secure*` 请求，也不绕过登录或会员权限。
- 页面必发字段尚未实际核对，因此业务采集计数始终为零，上传禁用；无真实 GitHub 数据提交。
- 当前环境为 Linux，Windows EXE 需由上述 Windows Actions 工作流构建，产物尚未在真实 Windows 11 启动验收。
- 暂无系统托盘图标、页面业务解析和与九十刻度的正式读取对接。
