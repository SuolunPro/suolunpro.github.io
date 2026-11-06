"""Aggregate only settled unique fixtures; never count a fixture twice across snapshots."""
import json
from pathlib import Path

LATEST=Path('data/engine4/latest.json')
if LATEST.exists():
    report=json.loads(LATEST.read_text(encoding='utf-8'))
    settled={}
    for path in sorted(Path('data/engine4/history').glob('*.json')):
        historical=json.loads(path.read_text(encoding='utf-8'))
        for match in historical.get('matches',[]):
            if match.get('settlement'):
                settled[str(match['source_id'])]=match
    for match in report.get('matches',[]):
        if str(match['source_id']) in settled:
            match['settlement']=settled[str(match['source_id'])]['settlement']
    hits=[m['settlement']['hits'] for m in settled.values()]
    keys=sorted({key for hit in hits for key in hit})
    report['metrics']={'settled':len(hits),
        'top1_hit_rate':round(sum(x['胜平负Top1'] for x in hits)/len(hits),4) if hits else None,
        'module_hits':{key:{'hit':sum(x.get(key) is True for x in hits),
          'total':sum(x.get(key) is not None for x in hits)} for key in keys}}
    LATEST.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report['metrics'],ensure_ascii=False))
