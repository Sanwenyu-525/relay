import { createElement } from "react";
import { expect, it } from "vitest";
import TaskAcceptanceEditPanel from "../../src/components/TaskAcceptanceEditPanel";
import { RelayApiError, type RelayApiClient, type RelayTaskAcceptanceRevisionInput } from "../../src/api/relayClient";
import { flush, mountReact } from "../../tests/mountApp";
import { prepareTaskAcceptanceRevision } from "../../../api/src/application/task-contract-commands";

it("supplementing a valid existing c2 criterion must not synthesize another c2", async () => {
  let submitted: RelayTaskAcceptanceRevisionInput | undefined;
  let validationError: unknown = null;
  const client = { reviseTaskAcceptance: async (input: RelayTaskAcceptanceRevisionInput) => {
    submitted = input;
    try { prepareTaskAcceptanceRevision(input); } catch (caught) { validationError = caught; }
    throw new RelayApiError({ status: 422, code: "VALIDATION_FAILED", detail: "diagnostic response", retryable: false,
      retryAction: "NONE", fieldErrors: [], expectedRevision: null, actualRevision: null });
  } } as unknown as RelayApiClient;
  const view = await mountReact(createElement(TaskAcceptanceEditPanel, { client,
    taskId: "33333333-3333-4333-8333-333333333333", taskRevision: "2", blockedReason: null, onSaved: async () => undefined,
    acceptance: { acceptanceRevision: "1", objective: "keep valid stable identity", source: "CREATE", expectedOutputs: {},
      createdAt: "2026-10-22T00:00:00.000Z", criteria: [{ criterionId: "c2", statement: "existing required condition", required: true, method: "HUMAN", targetSpec: {} }] }
  }));
  try {
    await view.wrapper.get('[data-testid="task-acceptance-edit-open"]').trigger("click");
    await view.wrapper.get('[data-testid="task-acceptance-additions"]').setValue("new independent condition");
    await view.wrapper.get('[data-testid="task-acceptance-save"]').trigger("click"); await flush(25);
    expect(submitted).toBeDefined();
    console.log("TRIAGE_ACCEPTANCE_ID_COLLISION", JSON.stringify({ criteria: submitted?.criteria,
      validationError: validationError instanceof Error ? validationError.message : validationError }));
    expect(validationError, "valid existing ID plus UI-generated new condition must normalize without collision").toBeNull();
  } finally { view.unmount(); }
});
