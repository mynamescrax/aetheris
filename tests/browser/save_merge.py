"""Compare real IndexedDB saves across repeat launches, including later additions."""
from pathlib import Path
from playwright.sync_api import sync_playwright

source = (Path(__file__).resolve().parents[2] / 'public/js/scramjet-init.js').read_text(encoding='utf8')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        page.route('**/*', lambda route: route.fulfill(content_type='text/html', body='<title>Save merge</title>'))
        page.goto('http://localhost/', wait_until='networkidle')
        page.add_script_tag(content=source[source.index('  function openexistingsave('):source.index('  function installlocalsaves(')])
        result = page.evaluate('''async () => {
          const req = q => new Promise((r,j) => {q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
          const done = tx => new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=j});
          const proxy = location.origin+'@/idbfs', name = '/idbfs';
          for (const n of [name, proxy]) {
            const q=indexedDB.open(n,1); q.onupgradeneeded=()=>q.result.createObjectStore('saves');
            const db=await req(q), tx=db.transaction('saves','readwrite'), store=tx.objectStore('saves');
            for (let i=0; i<1000; i++) if (n===proxy || i%100!==0) store.put(n===proxy?'proxied':'legacy', i);
            await done(tx); db.close();
          }
          let writes=0; const native=IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite')writes++;return native.apply(this,args)};
          async function launch(){ writes=0; await mergemissingsaves(name,proxy); return writes; }
          const first=await launch(), second=await launch();
          const src=await req(indexedDB.open(proxy)), tx=src.transaction('saves','readwrite');
          tx.objectStore('saves').put('after restore', 'later'); await done(tx); src.close();
          const third=await launch(), db=await req(indexedDB.open(name));
          const vals=await Promise.all([0,1,'later'].map(k => req(db.transaction('saves').objectStore('saves').get(k))));
          db.close(); return {first,second,third,vals};
        }''')
        assert 0 < result['first'] < 10 and result['second'] == 0 and result['third'] == 1, result
        assert result['vals'] == ['proxied','legacy','after restore'], result
        print('Save migration write transactions (first / repeat / later addition):', result['first'], result['second'], result['third'])
    finally:
        browser.close()
