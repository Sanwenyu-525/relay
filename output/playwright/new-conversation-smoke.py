"""Chromium UI checks with synthetic API replies; no database or Provider calls."""
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ORIGIN = "http://127.0.0.1:4173"
API = "http://127.0.0.1:8787"
WORKSPACE = "11111111-1111-4111-8111-111111111111"
SESSION = "66666666-6666-4666-8666-666666666666"
PREFIX = f"/api/v1/workspaces/{WORKSPACE}"
OUTPUT = Path(__file__).parent


def scenario(browser, width, height, interact=False):
    page = browser.new_page(viewport={"width": max(width, 1280), "height": height})
    posts, messages, errors = [], [], []
    session = {"id": SESSION, "workspace_id": WORKSPACE, "project_id": None, "task_id": None,
               "title": "已有普通讨论", "status": "ACTIVE", "revision": "1",
               "created_at": "2026-10-05T00:00:00Z", "updated_at": "2026-10-05T00:00:00Z"}
    page.on("pageerror", lambda error: errors.append(str(error)))

    def handle(route):
        request = route.request
        path = urlparse(request.url).path
        headers = {"access-control-allow-origin": ORIGIN,
                   "access-control-allow-headers": "Authorization, Content-Type",
                   "access-control-allow-methods": "GET, POST, OPTIONS"}

        def reply(value, status=200):
            route.fulfill(status=status, headers=headers, content_type="application/json", body=json.dumps(value))

        if request.method == "OPTIONS":
            route.fulfill(status=204, headers=headers)
            return
        if request.method == "POST":
            body = request.post_data_json
            posts.append({"path": path, "body": body})
            if path == f"{PREFIX}/assist-sessions":
                reply({"command_id": body["command_id"], "committed_at": "2026-10-05T00:00:00Z",
                       "result": {"session_id": SESSION, **session}}, 201)
                return
            if path == f"{PREFIX}/assist-sessions/{SESSION}/messages":
                index = len(messages) // 2 + 1
                for role, content, identity in [("USER", body["content"], f"u{index}"),
                                                ("ASSISTANT", f"第 {index} 条回复：可以继续讨论。", f"a{index}")]:
                    messages.append({"id": identity, "session_id": SESSION, "seq": str(len(messages) + 1),
                                     "role": role, "status": "COMPLETED", "intent": "DISCUSS", "content": content,
                                     "error_code": None, "sources": [], "usage": {"input_tokens": 10, "output_tokens": 5},
                                     "cancel_requested": False})
                reply({"command_id": body["command_id"], "committed_at": "2026-10-05T00:00:00Z",
                       "result": {"session_id": SESSION, "user_message_id": f"u{index}", "assistant_message_id": f"a{index}"}}, 202)
                return
            reply({"code": "NOT_FOUND", "detail": path}, 404)
            return
        if path == "/health/ready":
            reply({"status": "ready"})
        elif path == f"{PREFIX}/assist-sessions":
            reply({"items": [session]})
        elif path == f"{PREFIX}/assist-sessions/{SESSION}/messages":
            reply({"items": messages})
        elif path == f"{PREFIX}/model-port":
            reply({"provider": "fake", "configured": False, "model": None, "base_url": None, "max_call_tokens": None})
        else:
            reply({"items": [], "next_cursor": None})

    page.route(f"{API}/**", handle)
    page.goto(f"{ORIGIN}/agent?new=browser-check")
    page.wait_for_load_state("networkidle")
    page.get_by_test_id("relay-connection-open").click()
    page.locator('input[name="relay-base-url"]').fill(API)
    page.locator('input[name="relay-workspace-id"]').fill(WORKSPACE)
    page.locator('input[name="relay-bearer-token"]').fill("synthetic-browser-token")
    page.get_by_test_id("relay-connect").click()
    expect(page.get_by_test_id("relay-connection-state")).to_contain_text("已连接")
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": width, "height": height})
    draft = page.get_by_test_id("assist-first-draft")
    expect(draft).to_be_visible()
    expect(page.get_by_test_id("assist-session")).to_have_count(0)
    expect(page.get_by_test_id("collab-side-empty")).to_have_count(0)
    expect(page.get_by_test_id("folder-scope-bar")).not_to_have_attribute("open", "")
    expect(page.get_by_test_id("collab-existing-work")).not_to_have_attribute("open", "")
    expect(page.get_by_test_id("folder-manual-root")).not_to_be_visible()
    assert posts == []
    geometry = draft.evaluate("""node => {
      const box = node.getBoundingClientRect();
      return {top: box.top, bottom: box.bottom, width: box.width,
        viewport: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth};
    }""")
    assert geometry["width"] > 100 and 0 <= geometry["top"] < geometry["bottom"] <= height
    assert geometry["overflow"] <= 1
    page.screenshot(path=str(OUTPUT / f"new-conversation-{width}.png"))

    if interact:
        draft.fill("还没发送的想法")
        page.get_by_test_id("context-new-conversation").click()
        expect(page.get_by_role("dialog")).to_contain_text("未保存")
        page.get_by_role("button", name="保留并继续编辑").click()
        expect(draft).to_have_value("还没发送的想法")
        draft.dispatch_event("keydown", {"key": "Enter", "code": "Enter", "isComposing": True})
        assert posts == []
        draft.fill("先帮我想清楚下一步")
        draft.press("Enter")
        expect(page.get_by_test_id("assist-transcript")).to_contain_text("第 1 条回复")
        expect(page.get_by_test_id("assist-first-pending")).to_have_count(0)
        page.get_by_test_id("assist-draft").fill("接着讨论这个想法")
        page.get_by_test_id("assist-draft").press("Enter")
        expect(page.get_by_test_id("assist-transcript")).to_contain_text("第 2 条回复")
        assert [post["path"] for post in posts] == [f"{PREFIX}/assist-sessions",
            f"{PREFIX}/assist-sessions/{SESSION}/messages", f"{PREFIX}/assist-sessions/{SESSION}/messages"]
        assert posts[0]["body"]["project_id"] is None and posts[0]["body"]["task_id"] is None
        assert all(post["body"]["intent"] == "DISCUSS" for post in posts[1:])
        page.get_by_test_id("context-new-conversation").click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(page.get_by_test_id("assist-first-draft")).to_have_value("")
        assert len(posts) == 3
        page.get_by_test_id("folder-scope-bar").locator("summary").click()
        expect(page.get_by_test_id("folder-manual-root")).to_be_visible()
    assert errors == [], errors
    page.close()
    return {"viewport": f"{width}x{height}", "geometry": geometry, "posts": len(posts), "runtime_errors": errors}


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    results = [scenario(browser, 1280, 720, True), scenario(browser, 960, 720), scenario(browser, 390, 844)]
    browser.close()
    print(json.dumps({"status": "PASSED", "evidence": "Chromium with synthetic API", "results": results}, ensure_ascii=False))
