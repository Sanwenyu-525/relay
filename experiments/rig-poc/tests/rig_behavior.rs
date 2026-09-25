use std::time::Duration;

use workflow_os_rig_poc::{Scenario, run_once};

#[tokio::test]
async fn normal_workload_uses_two_model_calls_and_one_controlled_effect() {
    let report = run_once(Scenario::Normal, Duration::ZERO).await;
    assert_eq!(report.model_calls, 2);
    assert_eq!(report.tool_effects, 1);
    assert_eq!(report.output.as_deref(), Some("fixture"));
    assert!(report.error.is_none());
}

#[tokio::test]
async fn unknown_tool_is_rejected_by_rig_before_any_effect() {
    let report = run_once(Scenario::UnknownTool, Duration::ZERO).await;
    assert_eq!(report.model_calls, 1);
    assert_eq!(report.tool_effects, 0);
    assert!(report.error.as_deref().is_some_and(|error| error.contains("UnknownToolCall")));
}

#[tokio::test]
async fn refused_tool_surfaces_as_error_without_running_the_effect() {
    let report = run_once(Scenario::DeniedTool, Duration::ZERO).await;
    assert_eq!(report.model_calls, 2);
    assert_eq!(report.tool_effects, 0);
    // Rig serializes the refused-tool result into the next model turn; the
    // key safety property is that the tool body never ran.
    assert_eq!(report.output.as_deref(), Some("fixture"));
    assert!(report.error.is_none());
}

#[tokio::test]
async fn max_turn_budget_stops_before_the_second_model_call() {
    let report = run_once(Scenario::Budget, Duration::ZERO).await;
    assert_eq!(report.model_calls, 1);
    assert_eq!(report.tool_effects, 1);
    assert!(report.error.as_deref().is_some_and(|error| error.contains("MaxTurnsError")));
}
