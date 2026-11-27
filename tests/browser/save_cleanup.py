"""Regression: export and download cleanup preserve mixed/unknown IndexedDBs."""
from pathlib import Path
from playwright.sync_api import sync_playwright

PUBLIC = Path(__file__).resolve().parents[2] / "public"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        page.route("**/*", lambda route: route.fulfill(content_type="text/html", body="<title>Save fixture</title>"))
        page.goto("http://localhost/save-fixture", wait_until="networkidle")
        for script in ["cache-reset.js", "data-transfer.js"]:
            page.add_script_tag(path=PUBLIC / "js" / script)
        result = page.evaluate("""async () => {
          const req = q => new Promise((ok, no) => { q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); });
          const complete = tx => new Promise((ok, no) => { tx.oncomplete = ok; tx.onabort = () => no(tx.error); });
          for (const name of ['/idbfs', 'WorldCacheSaves', 'UnityCache']) {
            const open = indexedDB.open(name, 1);
            open.onupgradeneeded = () => open.result.createObjectStore('files');
            const db = await req(open);
            const tx = db.transaction('files', 'readwrite');
            tx.objectStore('files').put('small', 'prefs.save');
            if (name === '/idbfs') {
              const save = new Uint8Array(17 * 1024 * 1024);
              save[save.length - 1] = 123;
              tx.objectStore('files').put(save, 'world.save');
            }
            await complete(tx); db.close();
          }
          const dump = await AetherisBackup.dump('/idbfs');
          function check(bytes) { return bytes.length === 17 * 1024 * 1024 && bytes.at(-1) === 123; }
          const world = dump.stores.files.keys.indexOf('world.save');
          const exported = world >= 0 && check(AetherisBackup.decode(dump.stores.files.values[world]));
          const cleanup = await AetherisCache.resetDownloadedGames();
          const db = await req(indexedDB.open('/idbfs'));
          const kept = await req(db.transaction('files').objectStore('files').get('world.save'));
          db.close();
          return { exported, retained: !!kept && check(kept), cleared: cleanup.databases,
            databases: (await indexedDB.databases()).map(x => x.name).sort() };
        }""")
        assert result == {"exported": True, "retained": True, "cleared": 1, "databases": ["/idbfs", "WorldCacheSaves"]}, result
        print("17 MiB save exported intact and retained; only the known download database was removed.")
    finally:
        browser.close()
