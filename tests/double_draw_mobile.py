import hashlib,json,os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
 b=pw.chromium.launch(args=['--no-sandbox'])
 p=b.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
 def serve(r):
  path=urlsplit(r.request.url).path
  files={'/':('index.html','text/html'),'/assets/app-20261003.css':('assets/app-20261003.css','text/css'),'/assets/double-draw-20261106-21.json':('assets/double-draw-20261106-21.json','application/json'),'/data/engine4/latest.json':('data/engine4/sales/2026-11-21.json','application/json')}
  if path in files:
   name,mime=files[path];r.fulfill(path=name,content_type=mime)
  elif path.endswith('/member-code-members.json'):r.fulfill(json={'members':[{'code_sha256':hashlib.sha256(b'vip+layouttest').hexdigest(),'active':True,'expires_at':'2027-01-01T00:00:00Z'}]})
  elif path.endswith('/sales/index.json'):r.fulfill(json={'days':['2026-11-21']})
  else:r.fulfill(status=404,body='')
 p.route('**/*',serve)
 p.goto('http://localhost/#double-draw')
 p.locator('#vip-code').fill('vip+layouttest');p.locator('#vip-login').click()
 p.locator('.rd-sheet').first.wait_for(timeout=12000)
 for width in (320,390):
  p.set_viewport_size({'width':width,'height':844})
  assert p.evaluate('document.documentElement.scrollWidth<=innerWidth')
 p.locator('.content').screenshot(path='double-draw-day.png')
 p.locator('.rd-tabs a').last.click()
 p.locator('.rd-table').wait_for()
 assert '69.7%' in p.locator('.rd-table').inner_text()
 p.locator('.rd-ledger summary').first.click()
 assert p.locator('details[open] .rd-fixture').count()>0
 p.locator('#matches').screenshot(path='double-draw-history.png')
 print('mobile layout, history navigation, daily expansion, tier totals passed')
