#!/usr/bin/env python3
"""Read-only 澳客竞彩足球 source probe; adapted from old 豪竞 parsing logic.
Never assumes the scraped page equals the official sale pool."""
import datetime as dt
import html
import json
import pathlib
import re
import time
import urllib.request

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/"data"/"okooo-validation-latest.json"
BASE="https://www.okooo.com"
def clean(s):
    return re.sub(r"\s+"," ",html.unescape(re.sub(r"<[^>]*>"," ",s))).strip()
def decode(data):
    candidates=[]
    for encoding in ("gb18030","utf-8"):
        try:
            value=data.decode(encoding)
            candidates.append((sum(value.count(w) for w in ("竞彩","比赛时间","胜平负","touzhu_1")),value,encoding))
        except UnicodeError: pass
    if not candidates: raise ValueError("页面无法解码")
    _,value,encoding=max(candidates,key=lambda x:x[0])
    return value,encoding
def parse(text,url):
    matches=[]
    for raw in text.split('<div class="touzhu_1"')[1:]:
        number=re.search(r'<span class="xulie"[^>]*>([0-9]{3})</span>',raw)
        if not number: continue
        teams=[(clean(a) or clean(b)) for a,b in re.findall(r'class="zhum[^"]*"[^>]*title="([^"]*)"[^>]*>([^<]+)</div>',raw)]
        prices=[]
        for part in re.findall(r'class="peilv[^"]*"[^>]*>([\s\S]*?)</div>',raw):
            try:
                v=float(clean(part))
                if 0<v<100: prices.append(v)
            except ValueError: pass
        if len(teams)<2 or len(prices)<3: continue
        match_id=re.search(r'id="match_([0-9]+)"',raw)
        line=re.search(r'data-rq="([^"]+)"',raw)
        kickoff=re.search(r'title="比赛时间:([^"]+)"',raw)
        matches.append(dict(match_no=number.group(1),home=teams[0],away=teams[-1],
            source_match_id=match_id.group(1) if match_id else None,
            handicap=line.group(1) if line else None,
            kickoff=kickoff.group(1) if kickoff else None,
            spf=prices[:3],rqspf=prices[3:6] if len(prices)>=6 else None,
            source_url=url,data_quality="UNVERIFIED_SOURCE_PAGE"))
    return matches
def main():
    today=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).strftime("%Y-%m-%d")
    urls=[BASE+"/jingcai/",BASE+"/jingcai/shuju/",BASE+"/jingcai/"+today+"/"]
    reports=[];combined={};errors=[]
    for url in urls:
        try:
            req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36","Accept-Language":"zh-CN,zh;q=0.9","Referer":BASE+"/jingcai/"})
            with urllib.request.urlopen(req,timeout=18) as response:
                data=response.read(3_000_000)
                status=response.status
            text,encoding=decode(data)
            rows=parse(text,url)
            reports.append(dict(url=url,http_status=status,bytes=len(data),encoding=encoding,parsed_matches=len(rows)))
            for m in rows:
                key=(m["match_no"],m["home"],m["away"],m["kickoff"])
                combined[key]=m
        except Exception as e:
            errors.append(dict(url=url,error=str(e)[:250]))
        time.sleep(.5)
    matches=sorted(combined.values(),key=lambda x:(x["match_no"],x["home"]))
    result=dict(source="澳客公开网页（非体彩官方认证）",sale_date_beijing=today,
        captured_at_utc=dt.datetime.now(dt.timezone.utc).isoformat(),status="SCRAPED_UNVERIFIED" if matches else "NO_VERIFIED_MATCHES",
        pool_completeness="UNVERIFIED_NEEDS_OFFICIAL_CROSSCHECK",matches=matches,pages=reports,errors=errors)
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"status":result["status"],"matches":len(matches),"pages":reports,"errors":errors},ensure_ascii=False))
    if not matches: raise SystemExit("未解析到真实赛事；保留失败报告，不伪造数据")
if __name__=="__main__": main()
