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
  elif path.endswith('/member-code-members.json'):r.fulfill(json={'members':[{'code_sha256':hashlib.sha256(code.encode()).hexdigest(),'active':True,'expires_at':'2099-01-01T00:00:00Z'} for code in ('vip+layouttest','vip+877229723@qq.com')]})
  elif path.endswith('/sales/index.json'):r.fulfill(json={'days':['2026-11-21']})
  else:r.fulfill(status=404,body='')
 p.route('**/*',serve)
 for account in ['vip+layouttest','vip+877229723@qq.com']:
  p.goto('http://localhost/')
  p.locator('#vip-code').fill(account)
  p.locator('#vip-login').click()
  p.locator('#v4-app').wait_for()
  button=p.get_by_role('button',name='🎯 双平雷达')
  if account=='vip+layouttest':
   assert button.count()==0
   p.evaluate('localStorage.clear(); sessionStorage.clear()')
   continue
  button.click()
  p.locator('.triplet.pair .datum').first.wait_for()
  assert '首选' in p.locator('#matches').inner_text()
  assert '次选' in p.locator('#matches').inner_text()
  assert p.locator('#hit-rate-label').inner_text()=='当日双平命中率'
  for width in [320,390]:
   p.set_viewport_size({'width':width,'height':844})
   assert p.evaluate('document.documentElement.scrollWidth<=innerWidth')
  p.locator('.main').screenshot(path='double-draw-admin.png')
