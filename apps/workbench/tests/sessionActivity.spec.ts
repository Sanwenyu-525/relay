import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { assistActivityLanded } from "../src/lib/sessionActivity";
import { bumpActiveConversationActivity, clearActiveConversation, publishActiveConversation,
  useActiveConversation, type ActiveConversation } from "../src/lib/activeConversation";
import type { RelayAssistMessage } from "../src/api/relayClient";

/**
 * 消息落地即排序收敛（2026-10-23 用户选定「立即发生」）的两半：
 * ① `assistActivityLanded`——权威投影末条消息的哪类变动对应服务端
 *    `last_message_at` 前进（insertMessage／settleGeneration，迁移 0111）；
 * ② `bumpActiveConversationActivity`——计数只递交给正在看的自由会话，
 *    左栏据此定向重读那一行。这里不碰 React 视图，判定与守卫单独可验。
 */

const message = (id: string, status: RelayAssistMessage["status"]): RelayAssistMessage =>
  ({ id, status }) as RelayAssistMessage;

afterEach(() => { clearActiveConversation(); });

it("落地判定：新消息与终态结算算落地，在途心跳与重复终态不算", () => {
  // 首读基线（切会话后第一次权威读取）与「一条消息都没有」都不递。
  expect(assistActivityLanded(null, message("m1", "COMPLETED"))).toBe(false);
  expect(assistActivityLanded(message("m1", "RUNNING"), null)).toBe(false);
  // 末条换了 id：新落地一条。发送后预插的 PENDING／RUNNING 回复行也是新消息。
  expect(assistActivityLanded(message("m0", "COMPLETED"), message("m1", "RUNNING"))).toBe(true);
  expect(assistActivityLanded(message("m0", "COMPLETED"), message("m1", "PENDING"))).toBe(true);
  // 同一条在途消息的状态翻转：只有转终态算落地——服务端在结算时刻才再推进一次。
  expect(assistActivityLanded(message("m1", "PENDING"), message("m1", "RUNNING"))).toBe(false);
  expect(assistActivityLanded(message("m1", "RUNNING"), message("m1", "COMPLETED"))).toBe(true);
  expect(assistActivityLanded(message("m1", "RUNNING"), message("m1", "FAILED"))).toBe(true);
  expect(assistActivityLanded(message("m1", "RUNNING"), message("m1", "CANCELLED"))).toBe(true);
  // 终态之后的刷新：同一条同状态，没有新事实。
  expect(assistActivityLanded(message("m1", "COMPLETED"), message("m1", "COMPLETED"))).toBe(false);
});

it("活动计数只递交给正在看的自由会话：切会话清零，任务聊天与迟到刷新不递", () => {
  const seen: ActiveConversation[] = [];
  function Probe() { seen.push(useActiveConversation()); return null; }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => { root.render(createElement(Probe)); });
  const latest = () => seen[seen.length - 1];

  act(() => { publishActiveConversation({ taskId: null, sessionId: "session-a" }); });
  expect(latest().activityEpoch).toBe(0);
  // 当前会话落地：递计数，左栏据此重读这一行。
  act(() => { bumpActiveConversationActivity("session-a"); });
  expect(latest().activityEpoch).toBe(1);
  act(() => { bumpActiveConversationActivity("session-b"); });
  expect(latest().activityEpoch).toBe(1);
  // 已经切走的会话迟到刷新不递：它在活动期间的那几次早就递过了。
  act(() => { bumpActiveConversationActivity("session-a"); });
  expect(latest().activityEpoch).toBe(2);

  // 任务聊天由任务行承担，左栏不参与它的排序，递了也不该有计数。
  act(() => { publishActiveConversation({ taskId: "task-1", sessionId: "session-a" }); });
  act(() => { bumpActiveConversationActivity("session-a"); });
  expect(latest().activityEpoch).toBe(0);

  // 切换会话身份即清零：新会话的落地从 0 开始计。
  act(() => { publishActiveConversation({ taskId: null, sessionId: "session-b" }); });
  expect(latest().activityEpoch).toBe(0);
  act(() => { bumpActiveConversationActivity("session-b"); });
  expect(latest().activityEpoch).toBe(1);

  act(() => { root.unmount(); });
  container.remove();
});
