"""Read-only connectivity diagnostic for public football sources. No predictions are fabricated."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SOURCES = {
    "okooo": "https://www.okooo.com/",
    "sporttery": "https://www.sporttery.cn/",
}
def probe(name, url):
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; 90scale-source-probe/0.1)"})
    try:
        with urlopen(req, timeout=15) as response:
            sample = response.read(4096)
            return {"source": name, "http_status": response.status, "sample_bytes": len(sample),
                    "reachable": 200 <= response.status < 400,
                    "note": "Connectivity only; match pool and odds NOT verified"}
    except HTTPError as exc:
        return {"source": name, "http_status": exc.code, "reachable": False, "error": str(exc)}
    except (URLError, TimeoutError, OSError) as exc:
        return {"source": name, "reachable": False, "error": str(exc)}
def main():
    report = {"checked_at_utc": datetime.now(timezone.utc).isoformat(),
              "purpose": "Connectivity diagnostic, not a football prediction",
              "sources": [probe(name, url) for name, url in SOURCES.items()]}
    out = Path(os.environ.get("PROBE_OUTPUT", "reports/source_probe.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
if __name__ == "__main__":
    main()
