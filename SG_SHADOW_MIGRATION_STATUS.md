# 九十刻度新加坡 1:1 迁移：隔离影子分支进度（2026-10-18）

**分支**：`shadow/singapore-1to1-20261018`（不得合并到 main 或触发正式站发布，直到逐项验收）

## 已实施
- 从正式站 `main` 原样创建分支，继承 `index.html`、`assets/app-20261003.css`、全部原始静态资源/图片/模块入口、日期、详情、会员与手机布局。不是手写替代页面。
- 在分支修改原 `assets/app-20261003.js` 的 **配置连接**：生产 Supabase/Auth/澳客地址均改为新加坡 `zssourkgabcxibggwhqm`；区域改为 `ap-southeast-1`，增加 `SHADOW_MODE`，影子站禁用 VIP 开通申请，保留原 UI/行为结构。其它静态入口 `admin.html`、`review.html`、两个 admin JS 的旧数据库域名改为新加坡（功能本身仍待实现）。
- 新加坡 Supabase 部署独立 `soren-public-api-v1` v1 兼容适配层；后端调用 **本项目** `ninety_customer_payload` 与 `ninety_membership_status`，输出旧前端 `rows`、`view=today/archive/history/membership/cold-feed` 外壳。不读取两个旧 Supabase。
- 新加坡部署代码保存于**本分支** `supabase/functions/soren-public-api-v1/index.ts`，不可与旧生产主分支同名源文件混淆。
- 兼容层严格保留 `pregameVerified=false`、`analysisPending=true`，不将 `provisional` 伪装成正式赛前冻结；新加坡仅有 Top3 的比分/半全场不填充成生产的 Top4。
- 公开 `/health` 返回 200；未认证的 `?view=today` 返回 HTTP 401；旧 SG `ninety-public-api-v1` 仍可返回 `matches` 作为对照；生产未变更。

## 尚不满足 1:1 的阻塞项
1. **托管**：当前私有 `ninety-shadow-sg.primetetra9.chatgpt.site` 返回 401，现有可用工具**无法更新原 Site 项目** `appgprj_6ad47c01729c8191b7bc26742c701b81`。这个分支尚未部署到该网站，请勿把旧手写页当验收版。
2. **验证账号**：新加坡 `auth.users` / `ninety_core.memberships` 目前均为 0；不能完成已登录、VIP 权限、不同终端会话的真实端到端测试；只确认匿名安全拦截。
3. **真实模型**：`ninety_core.module_outputs` 目前均为 `provisional` 或 `pass`，尚无生产正式预测的校验与停售/开球前冻结链。七大模块的真实预测、历史评测、今日优选正式发布及冷门预警正式发布未通过验收。
4. **输出格式差异**：生产比分/半全场 Top4 的完整契约、详情 `view=report/market-trend/member-intel`、VIP 历史冷门记录及官方赛果核验尚无对应服务；兼容层的这些视图明确返回不可用或空的已发布清单，不补假记录。
5. **其余后端接口**：原站使用的 `soren-feedback-api-v1`、`soren-client-diag-v1`、`soren-cold-history-v2`、`soren-admin-final-identification-v1` 等未在新加坡部署，相关页面将不可用。除已承诺路由外，不得声称完成。
6. **采集与历史**：新加坡 `match_pool` 只包含 2026-10-17/18/19 的原始记录；15 天历史不全，且采集看板尚未按正式站入口接入；旧项目无运行时回退。
7. **上线与对照**：需在独立影子域名上做 iOS/Android/桌面视觉对照、菜单/详情/会员、真实 API、数据链 1:1 测试及异常回归。**未完成前禁止切正式域名、客户 VIP、旧任务或旧数据库**。

## 继续工作的正确顺序
先把此分支原网站文件（不是重写 UI）部署至 **原影子 Site 项目或新独立静态托管**；以新加坡的 `soren-public-api-v1` 为接口，接入真实独立身份与权益；再按缺口逐模块迁移生成/冻结/详情/历史/赛果/风控/采集状态；最后完成 1:1 实测及客户隔离审计。

旧正式源仓库 `main`、旧生产 `ttydbcejxqxdkcfoizkj`、旧澳客 `tqlibowvnwfkaseqqvvp` 均只读，禁止直接变更。