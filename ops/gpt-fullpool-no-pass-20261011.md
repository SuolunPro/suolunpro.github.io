# 九十刻度 · GPT 全池独立预测规则（2026-10-11 起）

状态：生产库新增未来期次写入约束；独立 GPT 预测仍为管理员影子研究，不得作为母模型预测或已上线自动生成服务对外描述。

## 核心规则

- **不允许 PASS**：竞彩在售比赛每场独立给出一个 `FT Top1`，只能是「主胜／平／客胜」。困难、冲突、低 DQ 不得用于回避记录。
- **Top2 与信心**：同时记录第二可能方向（与 Top1 不重复）、信心（高／中／低）及反方证据。数据不完整应降低信心并标注缺失项，不得杜撰赔率、战意、伤停、Elo 或概率。
- **独立研究**：GPT 应先基于合法赛前资料做自己的判断；九十刻度母模型仅用于*冻结之后*的对照评分，不得直接复制母模型 Top1 来补足赛前覆盖。
- **分市场结算**：普通 FT Top1 单独统计，不得将让球胜平负作为 FT Top1；如研究让球，须另行按其官方让球与独立快照记账，禁止混算。
- **全池审计**：每期登记应预测场数、实际合法赛前预测场数、未入库原因及覆盖率。没有合法赛前预测的场次应显示「未生成／未确认」，不能冒充已完成预测，也不能在开球后补录当作赛前预测。
- **严格赛前冻结**：`generated_at`、`source_snapshot_at` 均早于 `kickoff_at`；执行正式研究评分时仍须遵守 `soren_admin_gpt_scorecard_v1` 的更严格停售/截止时间规则。
- **历史不可回填**：2026-10-08—2026-10-10 的历史 PASS 原样保留，不据赛果倒灌或追改方向。新规则与旧实验样本分开统计。
- **不触碰客户正式线路**：GPT 系统管理员影子使用；不得因此修改客户 API、今日优选、冷门预警、母模型、客户冻结或赛果结算。

## 已执行的数据库约束

生产项目：`ttydbcejxqxdkcfoizkj`。

表：`public.soren_gpt_final_shadow_v1`。

约束：`soren_gpt_future_no_pass_ft_pick_ck`。

对 `pool_date >= '2026-10-11'` 强制 `selection_mode IN ('SINGLE','DOUBLE')`，至少一个有效方向，且 `picks` 只能由普通胜平负「主胜／平／客胜」构成。因此所有未来提交的 PASS 都会在写库时被拒绝；**该约束不会生成缺失的 GPT 预测**。影子预测的生成/写入仍需独立作业按本规范提交。

## 评价口径

报告同时给出：全池覆盖率、全部已合法冻结场次 FT Top1 命中率、Top2 覆盖率（与 Top1 分开）、按信心/DQ 分层的 Top1 命中率、与同期母模型 Top1 的公平逐场比较，以及 GPT 改对/改错。新规则后若覆盖未达到100%，应明确提示缺口，不得仅用已推荐样本宣传「全池准确率」。

## 2026-10-11 上线与验收状态

- 生产库前向约束已启用、已验证：2026-10-11 起拒收 PASS 及将让球代替普通FT的预测。
- 在本次管理员操作中，由 **ChatGPT GPT-6 依据赛前 William 已验证赔率/缺失声明所做的人工批次独立影子判断**，2026-10-11 在开球前存入 28/28 场：普通 FT Top1、rationale.top2、rationale.confidence_level 和证据出处。它不是经 OpenAI API 定时自动生成的批次，也未完成全部市场/海外证据校准，不得宣传为全量高质量综合研究。
- 单独部署的新 Edge Function: `soren-gpt-fullpool-shadow-v1` v2，仅使用与母模型隔离的只读赛前证据，并写入 GPT 专用影子表。入口使用既有 `soren_intel_authorized` 内部认证 RPC + Supabase JWT。
- 通过内部授权 `{"dry_run":true}` 已验证函数能够取到赛前数据、检查缺场，且 `writes=0`。
- 正式 OpenAI API 试运行**未通过配置闸门**：函数返回 `OPENAI_API_KEY_NOT_CONFIGURED`，因而没有谎称已自动预测。
- pg_cron `soren_gpt_fullpool_shadow_v1`（jobid 41）计划每 15 分钟执行，但 **active=false**；没有 API 密钥时不启用，避免无效调用与错误日志。
- 完成自动化还需要管理员在 Supabase 项目 Edge Function Secrets 中设置 `OPENAI_API_KEY`（实际 API 凭据，ChatGPT Plus 不等同于 API 使用额度）。默认 API 模型为 `gpt-5-mini`，若希望保持 GPT-6 版本一致，应提供有调用权限的 `OPENAI_MODEL_GPT_SHADOW` 并验证实际返回的模型。**不要在 GitHub 或前端中存储密钥。**
- 密钥设置后需先对函数执行一次真实受控调用，检查 API 成功响应和单条合法冻结记录，再经管理员决定启用 jobid 41：`select cron.alter_job(41, active := true);`。不得在本次无密钥时提前启用。
- 严禁把当前 10-11 人工批次与 API 自动批次混为同一模型版本的统计结论；在分析中以 `model_name` 与 `rationale.protocol` 分类展示。
