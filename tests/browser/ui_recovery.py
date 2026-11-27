"""Exercise the shipped pages against local fixtures; no providers or accounts required."""
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

PUBLIC = Path(__file__).resolve().parents[2] / "public"
SCRIPTS = {"site.js", "dm-shared.js", "dm-ui.js", "chat.js", "chat-notifications.js", "movie-sources.js", "movies-ui.js", "ai.js"}


def open_page(browser, name, api, setup="", fragment=""):
    page = browser.new_page(service_workers="block")
    if setup:
        page.add_init_script(setup)

    def serve(route):
        path = urlsplit(route.request.url).path
        if path.startswith("/api/"):
            status, data = api(path, route.request)
            return route.fulfill(status=status, json=data)
        if path in {"/" + name + ".html", "/load.html", "/minichat.html", "/chat.html"}:
            return route.fulfill(path=PUBLIC / path[1:], content_type="text/html")
        if path.startswith("/js/") and path[4:] in SCRIPTS:
            return route.fulfill(path=PUBLIC / path[1:], content_type="text/javascript")
        return route.fulfill(body="", content_type="text/javascript" if path.endswith(".js") else "text/plain")

    page.route("**/*", serve)
    page.goto("http://localhost/" + name + ".html" + fragment, wait_until="networkidle")
    return page


def chat(browser):
    statuses = iter([503, 200, 401])

    def api(path, _request):
        if path == "/api/accounts/me":
            status = next(statuses)
            return status, {"ok": status == 200, "username": "Alice"}
        return 200, {"ok": True, "conversations": []}

    page = open_page(browser, "chat", api, "localStorage.dmToken=sessionStorage.dmToken='fixture'")
    expect(page.locator("#auth-resume")).to_be_visible()
    assert page.evaluate("[localStorage.dmToken,sessionStorage.dmToken]") == ["fixture", "fixture"]
    page.locator("#auth-resume").click()
    expect(page.locator("#my-name")).to_have_text("Alice")
    page.reload(wait_until="networkidle")
    expect(page.locator("#auth-err")).to_contain_text("expired")
    assert page.evaluate("[localStorage.dmToken,sessionStorage.dmToken]") == [None, None]
    page.close()


def movies(browser):
    responses = iter([(502, {"error": "Movie search unavailable"}),
                      (200, {"results": [{"id": 123, "title": "Fixture"}], "total_pages": 1})])
    page = open_page(browser, "movies", lambda path, req: next(responses) if path.startswith("/api/tmdb/") else (200, {}),
                     "localStorage.movieSourceVersion='old'; localStorage.movieSourceIdx='1'; localStorage.movieSourceId='2embed'")
    expect(page.locator("#movies-retry")).to_be_visible()
    page.locator("#movies-retry").click()
    for _ in range(2):
        page.locator("#grid button").click()
        assert page.evaluate("MOVIES_SOURCES[document.querySelector('#sourceSel').value].id") == "vidrock"
        page.locator("#modalClose").click()
    page.close()


def mini_chat(browser):
    polls, receipts, messages = [], [], []

    def api(path, request):
        if path == '/api/dm/friend':
            return 200, messages
        if path == '/api/dm-inbox/read/friend':
            receipts.append(request.post_data_json['through'])
        if path == '/api/dm-inbox':
            polls.append(urlsplit(request.frame.url).path)
        return 200, {'ok': True, 'username': 'Fixture', 'conversations': []}

    page = open_page(browser, 'index', api, "localStorage.dmToken='fixture'", '#load?game=fixture')
    player = page.frame(url='**/load.html?*')
    player.evaluate('togglechat()')
    mini = page.frame_locator('#mainframe').frame_locator('#chat-iframe')
    expect(mini.locator('#app')).to_be_visible()
    frame = page.frame(url='**/minichat.html')
    frame.evaluate("openconvo('friend','Friend')")
    frame.wait_for_function("!messagesLoadingFor")
    player.evaluate('togglechat()')
    messages.append({'from': 'friend', 'message': 'After closing', 'time': 1234})
    polls.clear()
    with page.expect_response('**/api/dm-inbox', timeout=10000):
        pass
    assert polls == ['/minichat.html'] and not receipts, (polls, receipts)
    with page.expect_response('**/api/dm-inbox/read/friend'):
        player.evaluate('togglechat()')
    assert receipts == [1234], receipts
    page.close()


def tv_resume(browser):
    def api(path, _request):
        if path == '/api/tmdb/tv/123':
            return 200, {'seasons': [{'season_number': 1}, {'season_number': 2}]}
        if '/season/' in path:
            return 200, {'episodes': [{'episode_number': 1}, {'episode_number': 4}]}
        return 200, {'results': [{'id': 123, 'name': 'TV Fixture', 'media_type': 'tv'}], 'total_pages': 1}

    page = open_page(browser, 'movies', api)
    page.locator('#grid button').click()
    page.locator('#seasonSel').select_option('2')
    page.get_by_role('button', name='Episode 4: Episode 4').click()
    assert page.evaluate("!JSON.parse(localStorage.moviesRecent)[0].resume")
    page.frame_locator('#player').locator('html').evaluate("() => parent.postMessage({type:'aetheris-movie-playback',state:'playing'}, location.origin)")
    page.wait_for_function("JSON.parse(localStorage.moviesRecent)[0].resume?.episode === 4")
    page.locator('#modalClose').click()
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name='TV Fixture: Resume S2 E4').click()
    expect(page.locator('#seasonSel')).to_have_value('2')
    expect(page.get_by_role('button', name='Episode 4: Episode 4')).to_have_attribute('aria-pressed', 'true')
    page.close()


def ai(browser):
    # Capture the actual request body after 100 completed exchanges and then
    # force the text budget to drop those earlier exchanges on the next turn.
    requests = []

    def api(path, request):
        if path == "/api/ai/models":
            return 200, {"ok": True, "data": [{"id": "fixture"}], "default_model": "fixture"}
        messages = request.post_data_json["messages"]
        requests.append(messages)
        return 200, {"choices": [{"message": {"content": "reply"}}]}

    page = open_page(browser, "ai", api)
    page.evaluate('''async () => {
        const input = document.getElementById('ai-inp'), send = document.getElementById('ai-send');
        for (let n = 0; n < 102; n++) {
          input.value = n === 101 ? 'a'.repeat(200000) : 'message-' + n;
          input.dispatchEvent(new Event('input'));
          send.click();
          const deadline = Date.now() + 5000;
          while (document.querySelectorAll('.ai-msg.assistant .ai-bubble').length < n + 1) {
            if (Date.now() > deadline) throw Error('No reply on turn ' + n);
            await new Promise(r => setTimeout(r, 5));
          }
        }
    }''')
    assert len(requests[100]) == 199 and requests[100][0]["content"] == "message-1"
    assert requests[100][-1]["content"] == "message-100"
    assert len(requests[101]) == 1 and len(requests[101][0]["content"]) == 200000
    expect(page.locator(".ai-msg.user")).to_have_count(102)
    page.close()


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        chat(browser)
        movies(browser)
        mini_chat(browser)
        tv_resume(browser)
        ai(browser)
        print("Chat session retry, movie retry/provider migration, and long AI conversation passed.")
    finally:
        browser.close()
