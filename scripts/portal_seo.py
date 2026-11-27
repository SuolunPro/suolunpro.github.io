"""Check the public portal and notify IndexNow after published content changes."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

from build_growth import ORIGIN, PORTAL, NAV
from build_traffic import REPORT_SLUG, TOOLS

SLUGS = [slug for _, slug in NAV] + [slug for slug, *_ in TOOLS]
SLUGS.extend(f"reports/{file.parent.name}/" for file in sorted(Path("football/reports").glob("week-*/index.html"))
             if REPORT_SLUG.fullmatch(file.parent.name))
PAGES = {f"{PORTAL}{slug}": f"{PORTAL[1:]}{slug}index.html" for slug in SLUGS}
KEY_FILE = "0585570aa14c0953bd6d1cba0d9f8af9.txt"
GOOGLE_FILE = "google03e4dd0052f0e26e.html"
BING_FILE = "BingSiteAuth.xml"
ENDPOINT = "https://api.indexnow.org/indexnow"


def normalized(html):
    return re.sub(r">\s+<", "><", re.sub(r"\s+", " ", html)).strip()


def changed_pages(previous):
    prior_files = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", previous, "--", *PAGES.values()], text=True
    ).splitlines()
    return {
        url for url, file in PAGES.items()
        if file not in prior_files or normalized(Path(file).read_text(encoding="utf-8")) != normalized(
            subprocess.check_output(["git", "show", f"{previous}:{file}"], text=True, encoding="utf-8")
        )
    }


def read_live(path, version):
    with urlopen(f"{ORIGIN}{path}?seo={version}", timeout=8) as response:
        return response.read().decode("utf-8")


def inspect(changed, version):
    def check(path):
        live = read_live(path, version)
        if path in PAGES:
            canonical = f'<link rel="canonical" href="{ORIGIN}{path}">'
            if canonical not in live or "<title>" not in live or 'name="description"' not in live:
                raise ValueError("missing public page metadata")
            if path in changed and normalized(live) != normalized(Path(PAGES[path]).read_text(encoding="utf-8")):
                raise ValueError("published page has not reached the live site")
        elif path == "/sitemap.xml":
            locations = ET.fromstring(live).findall("{*}url/{*}loc")
            if len(locations) != len(PAGES) or {item.text for item in locations} != {ORIGIN + url for url in PAGES}:
                raise ValueError("unexpected Sitemap URLs")
        elif path == "/robots.txt":
            if {f"Sitemap: {ORIGIN}/sitemap.xml", "Disallow: /data/"} - set(live.splitlines()):
                raise ValueError("missing Sitemap or data crawl restriction")
        elif live.strip() != Path(path[1:]).read_text(encoding="utf-8").strip():
            raise ValueError("unexpected verification file")

    def result(path):
        try:
            check(path)
        except (OSError, ValueError, ET.ParseError) as error:
            return path, str(error)
        return path, ""

    paths = (*PAGES, "/robots.txt", "/sitemap.xml", f"/{GOOGLE_FILE}", f"/{BING_FILE}", f"/{KEY_FILE}")
    with ThreadPoolExecutor(max_workers=min(len(paths), 16)) as pool:
        return dict(pool.map(result, paths))


def notify(changed):
    key = Path(KEY_FILE).stem
    payload = {
        "host": ORIGIN.removeprefix("https://"),
        "key": key,
        "keyLocation": f"{ORIGIN}/{KEY_FILE}",
        "urlList": [ORIGIN + url for url in PAGES if url in changed],
    }
    request = Request(ENDPOINT, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=10) as response:
        print(f"IndexNow HTTP {response.status} for {payload['urlList']}", flush=True)
        return response.status in (200, 202)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", help="Git revision before publishing")
    args = parser.parse_args()
    changed = changed_pages(args.previous) if args.previous else set()
    if args.previous and not changed:
        print("Public page content unchanged. No IndexNow submission.")
        return 0

    version = time.time_ns()
    for attempt in range(5):
        checks = inspect(changed, f"{version}-{attempt}")
        if not any(checks.values()):
            break
        if attempt < 4:
            time.sleep(8)
    for path, error in checks.items():
        print(f"{path} {'FAILED ' + error if error else 'OK'}", flush=True)

    if changed and not checks[f"/{KEY_FILE}"] and not any(checks[url] for url in changed):
        if not notify(changed):
            return 1
    return int(any(checks.values()))


if __name__ == "__main__":
    raise SystemExit(main())
