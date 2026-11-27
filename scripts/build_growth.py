"""Generate the public football portal from the website's existing sale-day archive."""

import argparse
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from html import escape
import json
from pathlib import Path
from xml.etree import ElementTree as ET

from build_traffic import traffic_pages, verified_score

ORIGIN = "https://suolunpro.github.io"
PORTAL = "/football/"
BRAND = "九十刻度"
BRAND_ALTERNATE = "90Scale"
BRAND_DESCRIPTION = "九十刻度（90Scale）是足球赛前分析与赛后复盘平台。"
BEIJING = timezone(timedelta(hours=8))
COVERAGE_MODULES = (
    ("胜平负分析", "胜平负Top2", 2),
    ("让球胜平负分析", "让球Top2", 2),
    ("动态比分分析", "比分Top4", 4),
    ("总进球分析", "总进球Top3", 3),
    ("半全场分析", "半全场Top3", 3),
)


def cells(values, tag="td"):
    return "<tr>" + "".join(f"<{tag}>{escape(str(value))}</{tag}>" for value in values) + "</tr>"


def table(headers, rows):
    return ("<table><thead>" + cells(headers, "th") + "</thead><tbody>"
            + "".join(cells(row) for row in rows) + "</tbody></table>")


def schedule(archive, today):
    sections = []
    for day in (today, today + timedelta(days=1)):
        rows = []
        for match in archive.get(day, ()):
            kickoff = datetime.fromisoformat(match["kickoff"].replace("Z", "+00:00"))
            if kickoff.tzinfo:
                kickoff = kickoff.astimezone(BEIJING)
            rows.append((str(match["match_no"]), match["league"], match["home"], match["away"],
                         kickoff.strftime("%m-%d %H:%M")))
        content = table(("编号", "联赛", "主队", "客队", "开球"), sorted(rows)) if rows else "<p>暂无已同步的赛事。</p>"
        sections.append(f"<section><h2>{day}</h2>{content}</section>")
    return "<p>按赛事归档日期分组，开球时间为北京时间。</p>" + "".join(sections)


def review(archive, today):
    dates = sorted(day for day in archive if day < today)
    counts, outcomes, goals, hit, total = (Counter() for _ in range(5))
    for day in dates:
        for match in archive[day]:
            counts["archived"] += 1
            settlement = match.get("settlement") or {}
            score = verified_score(match)
            if score is None:
                continue
            counts["verified"] += 1
            home, away = score
            outcomes["主胜" if home > away else "客胜" if away > home else "平局"] += 1
            goals[min(home + away, 7)] += 1
            for _, key, _ in COVERAGE_MODULES:
                value = (settlement.get("hits") or {}).get(key)
                if isinstance(value, bool):
                    total[key] += 1
                    hit[key] += value
    if not dates:
        return "<p>暂无可复盘的历史归档。</p>"
    missing = counts["archived"] - counts["verified"]
    rows = [(label, hit[key], total[key] - hit[key], total[key], counts["verified"] - total[key],
             f"{hit[key] / total[key]:.1%}" if total[key] else "—")
            for label, key, _ in COVERAGE_MODULES]
    candidate_counts = "、".join(f"{label} {count} 项" for label, _, count in COVERAGE_MODULES)
    return (
        f'<p>{dates[0]} 至 {dates[-1]} · {len(dates)} 个归档日 · {counts["archived"]} 场归档'
        f' · {counts["verified"]} 场已核验 · {missing} 场待核验或未达到统计条件。</p>'
        "<section><h2>九十刻度 4.0 历史结果覆盖率</h2>"
        "<p>下表为多候选结果覆盖率，非单选准确率。实际结果落入赛前候选范围即计为覆盖。</p>"
        + table(("模块", "覆盖场次", "未覆盖场次", "有效样本", "无评估", "覆盖率"), rows)
        + "<h3>统计口径</h3>"
        + f"<p>各模块纳入的赛前候选数量为{candidate_counts}。</p>"
        + "<p>统计上述区间内已核验的常规时间赛果。各模块以有明确评估记录的场次为分母，"
          "覆盖率为覆盖场次除以有效样本。缺少该模块评估记录的场次列为无评估。</p>"
        + "</section><section><h2>完赛数据分布</h2>"
        + table(("赛果", "场次"), [(name, outcomes[name]) for name in ("主胜", "平局", "客胜")])
        + table(("总进球", "场次"), [(i, goals[i]) for i in range(7)] + [("7+", goals[7])])
        + "</section>"
    )


NAV = (("九十刻度", ""), ("每日赛程", "fixtures/"), ("历史复盘", "review/"),
       ("模型研究", "research/"), ("免费工具", "tools/"), ("联赛统计", "stats/"),
       ("研究报告", "reports/"))

INTRO = f"""<div class="hero"><p>{BRAND}（{BRAND_ALTERNATE}）</p><h1>足球赛前分析与赛后复盘</h1>
<p>{BRAND_DESCRIPTION} 公开门户提供基础赛事赛程、常规时间赛果分布、模型历史覆盖率及复盘方法。</p>
<a class="button" href="/football/review/">查看历史成绩</a></div>
<div class="grid"><section><h2>每日赛程</h2><p>按归档日期查看联赛、对阵和北京时间。</p><a href="/football/fixtures/">查看赛程</a></section>
<section><h2>模型研究</h2><p>了解赛前冻结、赛果核验，以及怎样比较不同模型指标。</p><a href="/football/research/">阅读研究说明</a></section></div>
<div class="grid"><section><h2>免费足球工具</h2><p>欧赔去水和独立泊松计算。</p><a href="/football/tools/">打开工具中心</a></section>
<section><h2>足球数据研究</h2><p>使用已核验完赛样本查看联赛表现与每周统计。</p><a href="/football/stats/">查看联赛统计</a> · <a href="/football/reports/">阅读周报</a></section></div>
<section><h2>如何申请会员开户</h2><p>新用户可联系微信客服提交开户申请，由管理员核实后人工开通。本站暂未开放自助注册。已有会员可通过原有入口登录。</p><a href="/#vip-gate" data-portal-event="member_entry_click">会员登录及开户注册</a>
<details><summary data-portal-event="admin_contact_click">查看管理员联系方式</summary>
<p>客服微信 <strong id="portal-wechat">GoodLuck_H3</strong>
<button id="portal-copy-wechat" type="button" data-portal-event="admin_contact_copy">复制微信号</button>
<span id="portal-copy-status" role="status"></span></p></details></section>"""

RESEARCH = """<section><h2>九十刻度如何开展足球赛前分析与复盘</h2>
<p>九十刻度 4.0 结合历史球队强度、预期进球和进球分布做赛前分析。赛后将赛前冻结的候选结果与核验后的赛果比较。复盘按 90 分钟常规时间（含伤停补时）统计，加时赛和点球大战比分不计入。</p>
<h3>如何阅读历史结果覆盖率</h3><p>实际结果落入该模块的赛前候选范围即计为覆盖。公开成绩展示多候选结果覆盖率，非单选准确率。各模块的候选数量见历史复盘页的统计口径。</p>
<h3>什么时候能比较两组成绩</h3><p>比较时应使用同一批赛事和相同结算口径，同时核对候选数量、有效样本与无评估场次。</p>
<h3>怎样避免用赛后信息评价赛前判断</h3><p>记录冻结时间，在比赛结束后按相同口径核验。试验中的规则可在独立后续样本上验证，避免把用于挑选规则的比赛再次当作验证样本。</p>
<p><a href="/football/review/">查看整体成绩与样本覆盖</a></p></section>"""


ANALYTICS_NOTICE = """<details id="portal-analytics" class="portal-analytics">
<summary>隐私与访问统计</summary>
<p>经你同意，本站仅在公开门户使用 Microsoft Clarity 和统计 Cookie，了解访客数量、浏览量、访问来源、设备及大致地区，并记录会员入口、客服按钮、工具使用及报告访问。计算器输入值不用于统计。</p>
<p>Microsoft 会处理使用数据和经过遮罩的页面交互记录。你可以随时在这里关闭统计。<a href="https://privacy.microsoft.com/zh-cn/privacystatement">Microsoft 隐私声明</a></p>
<button type="button" id="portal-analytics-allow">允许统计</button>
<button type="button" id="portal-analytics-deny">关闭统计</button>
<span id="portal-analytics-status" role="status"></span>
</details>"""


def structured_data(url, label, description, page_type):
    website_url = ORIGIN + PORTAL
    brand_id = website_url + "#brand"
    website_id = website_url + "#website"
    graph = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "Brand", "@id": brand_id, "name": BRAND, "alternateName": BRAND_ALTERNATE,
             "url": website_url, "description": BRAND_DESCRIPTION},
            {"@type": "WebSite", "@id": website_id, "url": website_url, "name": BRAND,
             "alternateName": BRAND_ALTERNATE, "inLanguage": "zh-CN", "about": {"@id": brand_id}},
            {"@type": page_type, "@id": url + "#webpage", "url": url, "name": label,
             "description": description, "inLanguage": "zh-CN",
             "isPartOf": {"@id": website_id}, "about": {"@id": brand_id}},
        ],
    }
    return json.dumps(graph, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def render(slug, label, description, page_type, body, *, heading=True):
    nav = "".join(f'<a href="{PORTAL}{path}">{name}</a>' for name, path in NAV)
    title = f"{label}｜{BRAND}"
    url = ORIGIN + PORTAL + slug
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><meta name="description" content="{description}">
<link rel="canonical" href="{url}">
<script type="application/ld+json">{structured_data(url, label, description, page_type)}</script>
<link rel="stylesheet" href="{PORTAL}portal.css">
<script defer src="{PORTAL}analytics.js"></script></head>
<body data-clarity-mask="true"><header><nav aria-label="主导航">{nav}<a href="/#vip-gate" data-portal-event="member_entry_click">会员入口</a></nav></header>
{ANALYTICS_NOTICE}
<main>{f"<h1>{label}</h1>" if heading else ""}{body}</main>
<footer><a href="/legal.html">用户协议与隐私政策</a><span>九十刻度 · 足球数据与模型复盘</span></footer>
</body></html>
"""


def generate(source, output, today, history=Path("football/reports")):
    archive = {
        date.fromisoformat(path.stem): json.loads(path.read_text(encoding="utf-8"))["matches"]
        for path in sorted(source.glob("????-??-??.json"))
    }
    if not archive:
        raise ValueError("Sale-day archive is empty")
    pages = (
        ("", "足球数据与模型复盘", "九十刻度（90Scale）公开门户提供每日足球赛程、已核验历史成绩和模型研究。", "WebPage", INTRO),
        ("fixtures/", "每日足球赛程", "查看九十刻度已同步的足球联赛、对阵和北京时间。", "CollectionPage", schedule(archive, today)),
        ("review/", "历史模型成绩与足球统计", "查看九十刻度已核验赛果、模型多候选结果覆盖率及进球分布。", "CollectionPage", review(archive, today)),
        ("research/", "足球模型研究与复盘口径", "了解九十刻度的赛前冻结、常规时间赛果核验和历史成绩比较方法。", "WebPage", RESEARCH),
    )
    new_pages, archived_reports = traffic_pages(archive, today, history, COVERAGE_MODULES, table)
    report_pages = {page[0].split("/")[1]: page for page in new_pages if page[0].startswith("reports/week-")}
    pages += tuple(page for page in new_pages if not page[0].startswith("reports/week-"))
    report_keys = sorted(set(report_pages) | set(archived_reports), reverse=True)
    sitemap = ET.Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    llms = [f"# {BRAND}（{BRAND_ALTERNATE}）", "", f"> {BRAND_DESCRIPTION}", "", "## 公开页面", ""]
    for slug, label, description, page_type, body in pages:
        folder = output / "football" / slug
        folder.mkdir(parents=True, exist_ok=True)
        html = render(slug, label, description, page_type, body, heading=bool(slug))
        (folder / "index.html").write_text(html, encoding="utf-8")
        url = ORIGIN + PORTAL + slug
        ET.SubElement(ET.SubElement(sitemap, "url"), "loc").text = url
        llms.append(f"- [{label}]({url}): {description}")
    for key in report_keys:
        folder = output / "football/reports" / key
        folder.mkdir(parents=True, exist_ok=True)
        html = render(*report_pages[key]) if key in report_pages else archived_reports[key]
        (folder / "index.html").write_text(html, encoding="utf-8")
        url = f"{ORIGIN}{PORTAL}reports/{key}/"
        ET.SubElement(ET.SubElement(sitemap, "url"), "loc").text = url
        llms.append(f"- [足球数据周报 · {key[5:]}]({url})")
    ET.indent(sitemap)
    ET.ElementTree(sitemap).write(output / "sitemap.xml", encoding="utf-8", xml_declaration=True)
    (output / "llms.txt").write_text("\n".join(llms) + "\n", encoding="utf-8")

    robots = ["User-agent: *", "Disallow: /data/", ""]
    robots.extend(f"User-agent: {agent}" for agent in ("OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"))
    robots.extend(f"Allow: {PORTAL}{slug}$" for slug, *_ in pages)
    robots.extend(("Allow: /football/portal.css$", "Allow: /football/calculators.js$",
                   "Allow: /football/stats.js$"))
    robots.extend(f"Allow: {PORTAL}reports/{key}/$" for key in report_keys)
    robots.extend(("Allow: /sitemap.xml$", "Allow: /llms.txt$", "Disallow: /", ""))
    robots.extend(f"User-agent: {agent}" for agent in ("GPTBot", "ClaudeBot", "Google-Extended"))
    robots.extend(("Disallow: /", "", f"Sitemap: {ORIGIN}/sitemap.xml", ""))
    (output / "robots.txt").write_text("\n".join(robots), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("data/engine4/sales"))
    parser.add_argument("--output", type=Path, default=Path("."))
    parser.add_argument("--date", type=date.fromisoformat, default=datetime.now(BEIJING).date())
    parser.add_argument("--history", type=Path, default=Path("football/reports"))
    args = parser.parse_args()
    generate(args.source, args.output, args.date, args.history)
