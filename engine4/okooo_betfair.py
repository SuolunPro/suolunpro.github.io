"""Read public Okooo Betfair tables. Research-only: never backfill post-kickoff data into pre-match predictions."""
import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.request import Request, urlopen
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor

URL = "https://www.okooo.com/jingcai/{sale_day}/"
BJT = timezone(timedelta(hours=8))
from urllib.parse import urljoin

def fetch_page(url):
    req=Request(url,headers={
        "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":"zh-CN,zh;q=0.9",
        "Referer":"https://www.okooo.com/jingcai/"})
    with urlopen(req,timeout=18) as resp:
        raw=resp.read(3000000)
        charset=resp.headers.get_content_charset()
        if charset in ("gbk","gb2312"):charset="gb18030"
        if charset not in ("utf-8","gb18030"):charset="utf-8"
        html=raw.decode(charset,"replace")
        if html.count("�")>3:html=raw.decode("gb18030","replace")
        return html,resp.status

def old_schedule_matches(html):
    matches=[]
    for raw in html.split('<div class="touzhu_1"')[1:]:
        no=re.search(r'<span class="xulie"[^>]*>([0-9]{3})</span>',raw)
        oid=re.search(r'id=["\\\']match_([0-9]+)["\\\']',raw)
        if not oid:oid=re.search(r'/soccer/match/([0-9]+)/',raw)
        if no and oid:matches.append({"match_no":no.group(1),"okooo_id":oid.group(1)})
    return matches

class Reader(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_p = self.in_b = self.in_table = self.in_tr = self.in_td = False
        self.paragraphs=[]; self.tables=[]; self.rows=[]; self.cells=[]
        self.pbuf=[]; self.cellbuf=[]
    def handle_starttag(self, tag, attrs):
        if tag=="p": self.in_p=True; self.pbuf=[]
        if tag=="table": self.in_table=True; self.rows=[]
        if tag=="tr" and self.in_table: self.in_tr=True; self.cells=[]
        if tag in ("td","th") and self.in_tr: self.in_td=True; self.cellbuf=[]
    def handle_data(self, data):
        if self.in_p: self.pbuf.append(data)
        if self.in_td: self.cellbuf.append(data)
    def handle_endtag(self, tag):
        if tag=="p" and self.in_p:
            p=" ".join("".join(self.pbuf).split())
            if re.search(r"周[一二三四五六日]\d{3}",p): self.paragraphs.append(p)
            self.in_p=False
        if tag in ("td","th") and self.in_td:
            self.cells.append("".join(self.cellbuf).strip()); self.in_td=False
        if tag=="tr" and self.in_tr:
            if self.cells: self.rows.append(self.cells)
            self.in_tr=False
        if tag=="table" and self.in_table:
            if self.rows: self.tables.append(self.rows)
            self.in_table=False

def extract(html):
    parser=Reader();parser.feed(html)
    # Only accept tables with the exact Betfair column schema.
    tables=[]
    for rows in parser.tables:
        header=rows[0]
        if "总成交额(明细)" not in header or "必发比例" not in header: continue
        if not all(len(row)>=12 for row in rows[1:4]): continue
        columns={v:i for i,v in enumerate(header) if v not in ("99家平均",)}
        def get(row,key):
            i=columns.get(key)
            return row[i] if i is not None and i<len(row) else ""
        picks={}
        for row in rows[1:]:
            if row[0] not in ("主胜","平局","客胜"): continue
            picks[row[0]]={"volume":get(row,"总成交额(明细)"),"hot_cold":get(row,"冷热指数"),
                "market_index":get(row,"市场指数"),"betfair_odds":get(row,"必发赔率"),
                "betfair_share":get(row,"必发比例"),
                "avg99_odds":row[header.index("99家平均")] if "99家平均" in header else "",
                "avg99_probability":row[header.index("99家平均")+1] if "99家平均" in header else ""}
        if len(picks)==3: tables.append(picks)
    # Header and table count can differ; never silently zip misaligned records.
    if len(parser.paragraphs)!=len(tables):
        return {"error":"header_table_count_mismatch","headers":len(parser.paragraphs),"tables":len(tables),"records":[]}
    records=[]
    for header,picks in zip(parser.paragraphs,tables):
        match=re.search(r"(周[一二三四五六日])(\d{3}).*?(\d{2}-\d{2}\s+\d{2}:\d{2})",header)
        if not match: continue
        records.append({"weekday":match.group(1),"match_no":match.group(2),"kickoff_label":match.group(3),
            "raw_header":header,"outcomes":picks,
            "has_betfair":all(picks[k]["volume"] and picks[k]["betfair_share"] for k in ("主胜","平局","客胜"))})
    return {"records":records,"headers":len(parser.paragraphs),"tables":len(tables)}


def numeric(value):
    value=str(value or "").replace(",","").replace("%","").strip()
    if not value or value=="-":return None
    try:return float(value)
    except ValueError:return None

def parse_legacy_exchange(html):
    """Port of old soren-market-behavior-collector-v1 table positions."""
    p=Reader()
    p.feed(html)
    tx=next((t for t in p.tables if "必发成交数据" in str(t) and "竞彩数据" in str(t) and "做单人气比例" in str(t)),None)
    idx=next((t for t in p.tables if "99家平均" in str(t) and "交易量比例" in str(t) and "交易冷热指数" in str(t) and "庄家盈亏指数" in str(t)),None)
    if not tx or not idx:return {"status":"schema_missing"}
    def candidates(table,min_columns):
        return [r for r in table if len(r)>=min_columns and r[0] not in ("","平","平局") and not any(x in r[0] for x in ("必发成交","99家平均","交易量比例","交易冷热"))]
    def three(table,min_columns):
        rows=[r for r in table if len(r)>=min_columns]
        draw=[r for r in rows if r[0] in ("平","平局")]
        if len(draw)!=1:return None
        d=rows.index(draw[0])
        if d==0 or d==len(rows)-1:return None
        return [rows[d-1],draw[0],rows[d+1]]
    a,b=three(tx,13),three(idx,12)
    if not a or not b:return {"status":"role_rows_missing"}
    if any(a[i][0].strip()!=b[i][0].strip() for i in (0,2)):
        return {"status":"table_team_mismatch"}
    trans=[]
    index=[]
    for i in range(3):
        r=a[i];q=b[i]
        trans.append({"team":r[0],"bfOdds":numeric(r[5]),"bfVolume":numeric(r[6]),
          "bfProfitLoss":numeric(r[7]),"jcOdds":numeric(r[8]),
          "jcSavedVolume":numeric(r[9]),"jcProfitLoss":numeric(r[10]),
          "savedPopularity":numeric(r[11]),"doerPct":numeric(r[12])})
        index.append({"team":q[0],"avgOdds":numeric(q[1]),"avgProb":numeric(q[2]),
          "bfShare":numeric(q[3]),"jcSavedShare":numeric(q[4]),
          "northShare":numeric(q[5]),"bfHotCold":numeric(q[6]),
          "jcHotCold":numeric(q[7]),"bfMarketIndex":numeric(q[8]),
          "jcMarketIndex":numeric(q[9]),"bfProfitIndex":numeric(q[10]),
          "jcProfitIndex":numeric(q[11])})
    # Distinguish unavailable market values from truly inconsistent percentages.
    # Some Okooo 99-index tables have 15 cells but blank bfShare fields.
    if all(v is None for v in (r["bfShare"] for r in index)):
        return {"status":"market_data_pending_or_unavailable","index_team_labels":[r[0] for r in b],
                "index_row_lengths":[len(r) for r in b],
                "transaction_rows":trans,"index_rows":index}
    shares=[r["bfShare"] for r in index]
    # Site may express shares as fractions or percentages. Reject mixed/invalid units.
    if all(v is not None and 0<=v<=1 for v in shares) and abs(sum(shares)-1)<0.015:
        for r in index:
            r["bfShare"]=round(r["bfShare"]*100,4)
        shares=[r["bfShare"] for r in index]
    if any(v is None or v<0 or v>100 for v in shares) or abs(sum(shares)-100)>1.5:
        return {"status":"invalid_share","share_values":shares,
                "share_total":round(sum(v for v in shares if v is not None),3),
                "index_team_labels":[r[0] for r in b],
                "transaction_team_labels":[r[0] for r in a],
                "index_row_lengths":[len(r) for r in b]}
    if any(r["bfVolume"] is None or r["bfVolume"]<0 for r in trans):
        return {"status":"invalid_volume","volume_values":[r["bfVolume"] for r in trans]}
    scale=re.search(r'必发交易规模\s*(?:为|[:：])?\s*(较大|适中|较小)',
                    re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',html)))
    return {"status":"parsed_unverified","transaction_rows":trans,"index_rows":index,
            "exchange_scale":scale.group(1) if scale else None}

def main():
    sale_day=sys.argv[1] if len(sys.argv)>1 else datetime.now(BJT).strftime("%Y-%m-%d")
    now=datetime.now(timezone.utc)
    result={"sale_day":sale_day,"retrieved_at":now.isoformat(),"url":URL,
            "purpose":"research_only_not_prematch","records":[]}
    try:
        # Legacy collector uses dated fixture listing and per-match exchanges pages,
        # NOT the blocked /jingcai/shuju/betfa/ aggregate endpoint.
        schedule_url="https://www.okooo.com/jingcai/"+sale_day+"/"
        result["url"]=schedule_url
        result["schedule_url"]=schedule_url
        schedule,status=fetch_page(schedule_url)
        result["schedule_http_status"]=status
        fixtures=old_schedule_matches(schedule)
        result["schedule_fixture_count_raw"]=len(fixtures)
        result["schedule_match_count"]=len(fixtures)
        result["schedule_has_legacy_marker"]="touzhu_1" in schedule
        result["schedule_title"]=(re.search(r"<title[^>]*>(.*?)</title>",schedule,re.I|re.S).group(1)[:120] if re.search(r"<title[^>]*>(.*?)</title>",schedule,re.I|re.S) else "")
        # Dated public pages may contain multiple competitions and duplicate IDs.
        # Retain all fixtures for audit; do not silently truncate after 40.
        fixtures=list({(m["match_no"],m["okooo_id"]):m for m in fixtures}.values())
        def collect(match):
            url="https://www.okooo.com/soccer/match/"+match["okooo_id"]+"/exchanges/"
            item={**match,"source_url":url}
            try:
                html,status=fetch_page(url)
                item["http_status"]=status
                item["has_transaction_table"]="必发成交数据" in html and "做单人气比例" in html
                item["has_index_table"]="99家平均" in html and "交易冷热指数" in html
                item["has_betfair"]=item["has_transaction_table"] and item["has_index_table"]
                parsed=parse_legacy_exchange(html)
                item.update(parsed)
                item["market_data_state"]=("available_unverified" if parsed.get("status")=="parsed_unverified"
                    else "pending_or_missing" if parsed.get("status") in ("market_data_pending_or_unavailable","schema_missing")
                    else "parse_review_required")
                # This timestamp describes the actual HTTP fetch, not a historical quote.
                # Fixture identity and kickoff cutoff are checked separately in market_bridge.
                item["source_captured_at"]=datetime.now(timezone.utc).isoformat()
                item["source_timestamp_verified"]=parsed.get("status")=="parsed_unverified"
                # No unverified data enters formal predictions.
            except Exception as exc:
                item["error"]=str(exc)[:160]
            return item
        # Independent fixture pages can be fetched concurrently while preserving
        # each response's real capture time and original fixture identity.
        with ThreadPoolExecutor(max_workers=5) as workers:
            records=list(workers.map(collect,fixtures))
        # Keep earlier captured snapshots: a post-kickoff refresh must not erase
        # the last verified pre-match market or its timestamp.
        path=Path("data/engine4/okooo_research")/(sale_day+".json")
        try:
            old=json.loads(path.read_text(encoding="utf-8"))
            historical=old.get("records",[]) if old.get("sale_day")==sale_day else []
        except (OSError,ValueError,TypeError):
            historical=[]
        by_id={}
        for item in historical+records:
            by_id.setdefault(str(item.get("okooo_id")),[]).append(item)
        result["records"]=[]
        for snapshots in by_id.values():
            unique={str(x.get("source_captured_at") or "legacy")+":"+str(x.get("status")):x for x in snapshots}
            ordered=sorted(unique.values(),key=lambda x:str(x.get("source_captured_at") or ""))
            result["records"].extend((ordered[:4]+ordered[-8:]) if len(ordered)>12 else ordered)
        result["unique_okooo_ids"]=len({x["okooo_id"] for x in records})
        result["parse_status_counts"]={k:sum(x.get("status")==k for x in records) for k in sorted(set(x.get("status","not_parsed") for x in records))}
        result["pending_or_missing_count"]=sum(x.get("market_data_state")=="pending_or_missing" for x in records)
        result["parsed_count"]=sum(x.get("status")=="parsed_unverified" for x in records)
        result["failed_count"]=sum(bool(x.get("error")) for x in records)
        result["all_fixtures_checked"]=len(records)==len(fixtures)
        result["betfair_count"]=sum(x.get("has_betfair",False) for x in records)
        result["avg99_count"]=sum(x.get("has_index_table",False) for x in records)
        result["warning"]="Only timestamped, identity-matched snapshots before kickoff may enter formal predictions."
    except Exception as exc:
        result["error"]=str(exc)[:300]
    path=Path("data/engine4/okooo_research")/(sale_day+".json")
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"path":str(path),"records":len(result["records"]),"betfair_count":result.get("betfair_count",0),"error":result.get("error"),"warning":result.get("warning")},ensure_ascii=False))

if __name__=="__main__":main()

