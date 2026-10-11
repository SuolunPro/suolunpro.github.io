# 九十刻度：客户只读 / 赛前快照读写分离影子方案（2026-10-11）

状态：**仅 GitHub 隔离分支、未部署、未连接客户流量**。不要直接将本分支合并或将 Edge Function 配置为公开路由。

## 故障证据与设计约束
- 12:42–12:53（北京时间）生产曾返回 HTTP 500/502/504/546；SQLSTATE 57014 `statement timeout`。
- 主接口 `soren-public-api-v1` 的普通 GET 分支会通过 `applySaleFreeze(..., false)` 运行 `soren_capture_prematch_updates_v1` 和 `soren_capture_sale_snapshots_v1`，末段还同步 `soren_publish_htft_top4_v1` 与 `syncUpsetWarnings`。后台写入阻塞读取是已经定位的架构风险，但原始性能触发源尚需 EXPLAIN 和定时任务追踪。
- 定时 `sync_upset=1`（cron job 10）已有独立写入链路，每 10 分钟更新当天和次日；这**不足以直接承诺客户所需的赛前及时性**，先测试写入覆盖/延迟再规划更高频生产者。
- `soren_publish_htft_top4_v1` 独立 cron job 29 当前为停用状态，因此若主接口改为只读，必须为半全场补齐可靠的独立发布途径。
- 2026-10-11 已核验源纪录：当前（检查时）`soren_matches` 28 场，其中 024 尚未发现冻结及赛前归档。故不能宣称 28/28 已具备读写分离资格，更不能倒填无来源的预测。

## 影子构建
`soren-readonly-shadow-v1/index.ts`：独立 Edge Function 设计稿，仅能在配置至少 32 字符的 `SOREN_SHADOW_READ_KEY` 后，用对应请求头 `x-soren-shadow-key` 查询指定的 `date`。未配置、未授权均拒绝。固定从 `soren_matches`、`soren_prematch_updates_v1`、`soren_sale_freezes_v1` 读取，不调用 RPC、写 SQL 或计时任务，不读取用户会话/会员资料，不接入现有前端。**尚未部署**。

`picker.js` 是纯函数，验证球队、比赛日期、来源与采集时间都早于开球、概率合法、无赛果字段，再挑选赛前最新版本；开球后必须存在真实锁定并且不能与更新的合法赛前归档冲突。缺失/冲突时 `safe=false`，不能使用候选值代替正式预测。

## 验证命令（离线，无用户流量）
`cd supabase/functions/soren-readonly-shadow-v1 && node --test picker.test.mjs`

## 后续的正式切换门槛（现在不满足）
1. 抽取至少当天和前一天的**全池真实赛前版本**，逐场比较影子与生产的日期、比赛编号、Top1/Top2、概率、让球首选、比分、半全场、冷门预警、VIP可见性与赛果；对任何差异给出来源，严禁赛果倒灌。
2. 修复 024 数据缺口（或由官方确认属于无需预测的场次），并验证活跃比赛的合法版本持续按来源更新时间刷新；要覆盖提前停售、晚点开球、比赛中断等情况。
3. 用独立计划任务发布完整预测、停售记录、半全场和冷门预警。必须有版本幂等、单日去重、失败重试、并发/锁限制，不得让客户 GET 补写数据。每次发布后读回校验。
4. 灰度在**独立影子函数或测试环境**运行；由于独立 Edge 部署本身也会增加生产共享资源压力，先评估安全额度和限流，禁止直接替换 `soren-public-api-v1`。
5. 测量真实的 P50/P95/P99、无锁死、无 5xx、冻结完整性、预测时效和权限正确后方可提交正式切换评审；任何不合格立刻暂停，不可宣称已完成优化。

## 操作纪律
- 本提交**没有执行任何 Supabase 写操作**，也不包含 `cron.schedule`、`deploy_edge_function`、`update_file(main)`、前端 URL 改动。
- 当前客户流量仍走 main/生产现有 `soren-public-api-v1`，冷门预警和赛前冻结原逻辑仍在运行。
- 不增加数据库索引，先以 `pg_stat_statements` 和只读 `EXPLAIN` 识别瓶颈；当前读到历史索引已存在，盲目新增索引可能增加写入压力。
