# 豪智AI v0.1 — 独立预测计算核心

此目录与九十刻度网站业务代码隔离。当前仅为可运行的**数学基线**，不是完整自动采集或经过历史校准的预测系统。

## 使用

Python 3（仅标准库）：

```bash
python haozhi-ai/engine.py fixtures.json
python -m unittest discover -s haozhi-ai/tests
```

fixtures.json 为数组，每条包含 fixture_id、home、away、kickoff、collected_at（带时区 ISO8601）、source、home_xg、away_xg、official_handicap；可选 first_half_goal_share。

**数据约束**：进球期望、半场比例及官方让球必须来自可核验赛前来源，不允许从赛果反推。官方让球仅用于数学映射；当前不包含官方SP核验、市场赔率、Elo、必发资金及真实赛程抓取。缺失字段输出未完成。赛前冻结需要后续添加不可变快照存储。

## 当前边界

①胜平负、②让球、③总进球、④比分：给定合法赛前输入后可计算基线概率。⑤半全场：仅当提供独立可核验的半场比例才计算。⑥冷门预警：未确认，不冒充完成。⑦今日优选：风险审计未完成时全部拒绝晋级。

这不是已验证的盈利策略；未做真实竞彩全池覆盖率、历史回测或概率校准。严禁使用污染的2655场样本。
