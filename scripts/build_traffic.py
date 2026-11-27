"""Render public calculators and analyze verified regular-time results."""

from collections import Counter, defaultdict
from datetime import timedelta
from html import escape
import re

REPORT_SLUG = re.compile(r"week-\d{4}-\d{2}-\d{2}")
MIN_WEEK = 20
MIN_LEAGUE = 10
OUTCOMES = ("主胜", "平局", "客胜")
SCOPE = "样本来自九十刻度已归档、已核验的部分竞彩赛事，仅统计常规时间（含伤停补时）。样本受竞彩选场与归档覆盖影响，不能代表联赛完整赛季。日期按北京时间竞彩销售日。"

TOOLS = (
    ("tools/probability/", "足球欧赔概率计算器", "输入主胜、平局和客胜的十进制欧赔，计算隐含概率、去水概率、理论返还率和公平赔率。"),
    ("tools/poisson/", "足球泊松分布计算器", "输入两队预计进球，用标准独立泊松公式计算胜平负、比分和进球分布。"),
)


def verified_score(match):
    settlement = match.get("settlement") or {}
    if ((match.get("result_verification") or {}).get("status") == "VERIFIED"
            and settlement.get("scope") == "90min_regular_ft"
            and re.fullmatch(r"[0-9]+:[0-9]+", settlement.get("ft") or "")):
        return tuple(map(int, settlement["ft"].split(":")))
    return None


def calculator(kind):
    if kind == "probability":
        fields = ("主胜赔率", "平局赔率", "客胜赔率")
        limits = 'min="1"'
        method = "原始隐含概率为赔率倒数。各项倒数除以倒数之和得到按比例去水的概率。返还率为倒数之和的倒数，公平赔率为去水概率的倒数。市场隐含概率不等于实际赛果概率。"
    else:
        fields = ("主队预计进球", "客队预计进球")
        limits = 'min="0" max="20"'
        method = "支持每队 0–20 个预计进球。主客进球分别服从参数为各自预计进球的独立泊松分布，比分概率为两个进球概率相乘。此工具采用访客输入和标准公式。"
    inputs = "".join(f'<label>{name}<input required type="number" inputmode="decimal" autocomplete="off" step="any" {limits}></label>' for name in fields)
    return (
        f'<section data-clarity-mask="true"><p>{method}</p>'
        f'<form id="traffic-calculator" data-kind="{kind}" autocomplete="off">'
        f'<div class="traffic-fields">{inputs}</div><button type="submit">计算</button></form>'
        '<p id="traffic-status" role="status"></p><div id="traffic-output"></div>'
        '<noscript>请启用 JavaScript 使用计算器。</noscript></section>'
        '<script defer src="/football/calculators.js"></script>'
    )


def score_summary(scores):
    size = len(scores)
    outcomes = Counter("主胜" if h > a else "客胜" if a > h else "平局" for h, a in scores)
    totals = Counter(min(h + a, 7) for h, a in scores)
    common = sorted(Counter(scores).items(), key=lambda item: (-item[1], item[0]))[:3]
    home = sum(h for h, _ in scores) / size
    away = sum(a for _, a in scores) / size
    return (size, *(f"{outcomes[result] / size:.1%}" for result in OUTCOMES),
            f"{home + away:.2f}", f"{home:.2f}", f"{away:.2f}", f"{home - away:+.2f}",
            "、".join(f"{h}:{a}（{n}）" for (h, a), n in common),
            "、".join(f"{i if i < 7 else '7+'}球 {totals[i]}" for i in range(8)))


def stats_page(records, today, table):
    windows = (("all", "全部历史", None), ("30", "最近30天", 30), ("7", "最近7天", 7))
    options = "".join(f'<option value="{key}">{label}</option>' for key, label, _ in windows)
    body = [f'<p>{SCOPE}</p><label>统计范围 <select id="traffic-period">{options}</select></label>']
    headers = ("联赛", "样本", *OUTCOMES, "场均总进球", "主场均进球", "客场均进球",
               "主−客场均进球", "常见比分（场次）", "总进球分布（场次）")
    for key, label, days in windows:
        start = today - timedelta(days=days) if days else None
        sample = [record for record in records if start is None or record[0] >= start]
        leagues = defaultdict(list)
        for _, league, score, _ in sample:
            leagues[league].append(score)
        rows = [(league, *score_summary(scores))
                for league, scores in sorted(leagues.items(), key=lambda item: (-len(item[1]), item[0]))]
        scope = f"{start or sample[0][0]} 至 {today - timedelta(days=1)}" if sample else ""
        content = f"<p>{scope} · {len(sample)} 场</p>" + table(headers, rows) if rows else "<p>该区间暂无符合口径的样本。</p>"
        body.append(f'<section data-period="{key}"><h2>{label}</h2>{content}</section>')
    return "".join(body) + '<script defer src="/football/stats.js"></script>'


def weekly_report(records, start, end, modules, table):
    scores = [score for _, _, score, _ in records]
    leagues = defaultdict(list)
    for _, league, score, _ in records:
        leagues[league].append(score)
    counts = Counter(scores)
    totals = Counter(h + a for h, a in scores)
    summary = score_summary(scores)
    league_rows = []
    for league, games in sorted(leagues.items()):
        if len(games) >= MIN_LEAGUE:
            league_rows.append((league, len(games), sum(h == a for h, a in games),
                                f"{sum(h == a for h, a in games) / len(games):.1%}"))
    coverage = []
    for label, key, candidates in modules:
        values = [hits.get(key) for _, _, _, hits in records]
        evaluated = [value for value in values if isinstance(value, bool)]
        rate = f"{sum(evaluated) / len(evaluated):.1%}" if len(evaluated) >= MIN_WEEK else "样本不足"
        coverage.append((label, candidates, sum(evaluated), len(evaluated), len(scores) - len(evaluated), rate))
    return (
        f"<p>统计日期 {start} 至 {end} · 共 {len(scores)} 场。</p><p>{SCOPE}</p>"
        f"<section><h2>比分与进球分布</h2><p>样本场均进球 {summary[4]}，最常见比分为 {summary[8]}。</p>"
        + table(("比分", "场次", "占比"), [(f"{h}:{a}", n, f"{n / len(scores):.1%}")
                for (h, a), n in sorted(counts.items(), key=lambda item: (-item[1], item[0]))])
        + table(("总进球", "场次", "占比"), [(g, totals[g], f"{totals[g] / len(scores):.1%}")
                for g in range(max(totals) + 1)]) + "</section>"
        f"<section><h2>联赛平局率</h2><p>仅分列达到 {MIN_LEAGUE} 场的联赛样本。</p>"
        + (table(("联赛", "有效样本", "平局场次", "平局率"), league_rows)
           if league_rows else "<p>本周各联赛样本均未达到门槛。</p>") + "</section>"
        f"<section><h2>主场优势</h2><p>主胜 {summary[1]}，平局 {summary[2]}，客胜 {summary[3]}。"
        f"主队场均 {summary[5]} 球，客队 {summary[6]} 球，主减客 {summary[7]} 球。"
        "这是归档样本的描述，未控制赛程、球队实力或中立场地。</p></section>"
        "<section><h2>历史模型多候选覆盖率</h2>"
        f"<p>实际结果落入赛前候选范围即计为覆盖。分母为该模块有明确评估的场次，至少 {MIN_WEEK} 场才展示覆盖率。此指标用于多候选复盘。</p>"
        + table(("模块", "候选数", "覆盖", "有效样本", "无评估", "覆盖率"), coverage) + "</section>"
    )


def traffic_pages(archive, today, history, modules, table):
    records = []
    for day in sorted(archive):
        if day >= today:
            break
        for match in archive[day]:
            score = verified_score(match)
            if score is not None:
                records.append((day, match.get("league") or "未标注联赛", score,
                                match["settlement"].get("hits") or {}))

    monday = today - timedelta(days=today.weekday())
    start = monday - timedelta(days=7)
    end = monday - timedelta(days=1)
    slug = f"week-{start}"
    reports = {path.parent.name: path.read_text(encoding="utf-8")
               for path in history.glob("week-*/index.html") if REPORT_SLUG.fullmatch(path.parent.name)}
    sample = [row for row in records if start <= row[0] <= end]
    generated = []
    if slug not in reports and len(sample) >= MIN_WEEK:
        generated.append((f"reports/{slug}/", f"足球数据周报｜{start}",
                          f"基于 {start} 至 {end} 已核验完赛样本的比分、平局率、主场表现和覆盖率研究。",
                          "Article", weekly_report(sample, start, end, modules, table)))
    keys = sorted(set(reports) | ({slug} if generated else set()), reverse=True)
    links = "".join(f'<li><a href="/football/reports/{key}/">足球数据周报 · {key[5:]}</a></li>' for key in keys)
    pending = (f"<p>{start} 至 {end} 已核验 {len(sample)} 场。达到 {MIN_WEEK} 场后生成该周报告。</p>"
               if slug not in keys else "")
    report_index = (f"<p>按北京时间整理完整自然周，每周一期，保留已发布报告。</p><p>{SCOPE}</p>"
                    + pending + (f"<ul>{links}</ul>" if links else "<p>暂无已发布周报。</p>"))
    cards = "".join(f'<section><h2><a href="/football/{path}">{label}</a></h2><p>{desc}</p></section>'
                    for path, label, desc in TOOLS)
    pages = [
        ("tools/", "免费足球工具中心", "在浏览器内使用足球欧赔去水与独立泊松计算器。", "CollectionPage", f'<div class="grid">{cards}</div>'),
        *((path, label, desc, "WebPage", calculator(path.split("/")[1])) for path, label, desc in TOOLS),
        ("stats/", "足球联赛数据统计中心", "查询部分竞彩已核验完赛样本的联赛赛果、比分和进球统计。", "CollectionPage", stats_page(records, today, table)),
        ("reports/", "足球数据研究报告", "九十刻度基于真实完赛样本的每周原创统计研究。", "CollectionPage", report_index),
        *generated,
    ]
    return pages, reports
