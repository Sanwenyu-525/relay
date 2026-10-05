"""Real Chromium clicks with synthetic API responses; no database or Provider calls."""
import json
from urllib.parse import urlparse
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ORIGIN = "http://127.0.0.1:4189"
API = "http://127.0.0.1:8787"
WORKSPACE = "11111111-1111-4111-8111-111111111111"
TASK = "33333333-3333-4333-8333-333333333333"
ROOT = f"/api/v1/workspaces/{WORKSPACE}"
TASK_PATH = f"{ROOT}/tasks/{TASK}"
HEADERS = {"access-control-allow-origin": ORIGIN,
           "access-control-allow-headers": "Authorization, Content-Type"}


def task(criteria=None, revision="2", acceptance="1"):
    return dict(id=TASK, project_id=None, title="浏览器验收条件核对", status="INBOX", mode="ME",
                revision=revision, acceptance_revision=acceptance,
                executor=dict(kind="HUMAN", run_id=None, ownership_epoch="0"),
                current_completion_id=None, waiting_reason=None, blocking_task_ids=[], unresolved_blocker_ids=[],
                allowed_actions=[], created_at="2026-10-05T00:00:00Z", updated_at="2026-10-05T00:00:00Z",
                acceptance=dict(acceptance_revision=acceptance, objective="保留原目标", expected_outputs={},
                                source="CREATE", created_at="2026-10-05T00:00:00Z", criteria=criteria or []),
                goal_alignment=dict(mode="INHERIT", goal_ids=[], effective_goal_ids=[]), dependencies=[])


def scenario(browser, lost_response=False):
    context = browser.new_context(viewport=dict(width=1280, height=800))
    page = context.new_page()
    posts, receipts, page_errors = [], {}, []
    current = task()
    page.on("pageerror", lambda error: page_errors.append(str(error)))

    def handle(route):
        nonlocal current
        request = route.request
        path = urlparse(request.url).path
        if request.method == "OPTIONS":
            route.fulfill(status=204, headers=HEADERS)
            return
        body, status = dict(items=[], next_cursor=None), 200
        if request.method == "POST":
            payload = request.post_data_json
            posts.append((path, payload))
            assert path == f"{TASK_PATH}/acceptance", f"unexpected mutation: {path}"
            criteria = [dict(criterion_id=f"human-{i}", **criterion) for i, criterion in enumerate(payload["criteria"])]
            result = dict(task_id=TASK, status="INBOX", revision="3", previous_acceptance_revision="1",
                          acceptance_revision="2", objective="保留原目标", required_output_spec={},
                          criteria=criteria, added_criterion_ids=["human-0"])
            current = task(criteria, "3", "2")
            body = dict(command_id=payload["command_id"], committed_at="2026-10-05T00:00:00Z", result=result)
            receipts[payload["command_id"]] = dict(body, command_type="ReviseTaskAcceptance")
            if lost_response:
                route.abort("failed")
                return
        elif path == "/health/ready":
            body = dict(status="ready")
        elif path == TASK_PATH:
            body = current
        elif path.startswith(f"{ROOT}/commands/"):
            body = receipts[path.split("/")[-1]]
        elif path.endswith("/artifacts"):
            body = dict(items=[], current_accepted_version_ids=[])
        route.fulfill(status=status, headers=HEADERS, content_type="application/json", body=json.dumps(body))

    page.route(f"{API}/**", handle)
    page.goto(f"{ORIGIN}/tasks/{TASK}")
    page.wait_for_load_state("networkidle")
    # Inspect rendered control names before acting.
    assert "连接本机 API" in page.locator("button").all_text_contents() or page.get_by_test_id("relay-connection-open").count() == 1
    page.get_by_test_id("relay-connection-open").click()
    page.locator('input[name="relay-base-url"]').fill(API)
    page.locator('input[name="relay-workspace-id"]').fill(WORKSPACE)
    page.locator('input[name="relay-bearer-token"]').fill("synthetic-browser-token")
    page.get_by_test_id("relay-connect").click()
    expect(page.get_by_test_id("relay-connection-state")).to_contain_text("已连接")
    page.keyboard.press("Escape")
    expect(page.get_by_test_id("task-acceptance-edit-open")).to_be_visible()
    assert not posts, "opening a task must not send a command"
    page.get_by_test_id("task-acceptance-edit-open").click()
    page.get_by_test_id("task-acceptance-additions").fill("测试结果可以复现\n保存检查依据")
    page.get_by_test_id("task-detail-tab-runs").click()
    page.get_by_test_id("task-detail-tab-overview").click()
    expect(page.get_by_test_id("task-acceptance-additions")).to_have_value("测试结果可以复现\n保存检查依据")
    page.get_by_test_id("task-acceptance-save").click()
    expect(page.get_by_test_id("task-acceptance-saved")).to_contain_text("v2")
    expect(page.locator(".task-criteria-panel")).to_contain_text("保存检查依据")
    assert len(posts) == 1
    payload = posts[0][1]
    assert payload["expected_revision"] == "2" and payload["expected_acceptance_revision"] == "1"
    assert all(c["required"] and c["method"] == "HUMAN" for c in payload["criteria"])
    assert not page_errors, page_errors
    if not lost_response:
        page.screenshot(path=str(Path(__file__).with_suffix(".png")), full_page=True)
    context.close()
    return dict(scenario="lost-response-receipt" if lost_response else "save-and-tab-preservation",
                passed=True, commands=len(posts), page_errors=page_errors)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        print(json.dumps([scenario(browser), scenario(browser, True)], ensure_ascii=False))
    finally:
        browser.close()
