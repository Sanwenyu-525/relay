//! Minimal, credential-free Rig 0.42 experiment.
//!
//! The workload deliberately uses Rig's published agent runner rather than a
//! hand-written loop: two scripted completion turns surround one controlled
//! tool call. The tool is the only simulated external effect.

use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use std::time::Duration;

use rig_agent::{AgentBuilder, completion::{Message, PromptError}, test_utils::{MockCompletionModel, MockDeniedTool, MockTurn}, tool::{Tool, ToolContext}};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, thiserror::Error)]
#[error("controlled tool failed")]
pub struct ControlledToolError;

#[derive(Debug, Deserialize)]
pub struct ControlledToolArgs {
    pub text: String,
}

/// A deterministic tool whose invocation count is observable by tests.
#[derive(Clone)]
pub struct ControlledTool {
    effects: Arc<AtomicUsize>,
    delay: Duration,
}

impl ControlledTool {
    pub fn new(delay: Duration) -> Self {
        Self { effects: Arc::new(AtomicUsize::new(0)), delay }
    }

    pub fn effects(&self) -> usize {
        self.effects.load(Ordering::SeqCst)
    }
}

impl Tool for ControlledTool {
    const NAME: &'static str = "controlled_gateway";
    type Error = ControlledToolError;
    type Args = ControlledToolArgs;
    type Output = String;

    fn description(&self) -> String {
        "Credential-free controlled gateway fixture".to_owned()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"]
        })
    }

    async fn call(
        &self,
        _context: &mut ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        self.effects.fetch_add(1, Ordering::SeqCst);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        Ok(format!("fixture:{}", args.text))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    Normal,
    UnknownTool,
    DeniedTool,
    Budget,
}

#[derive(Debug)]
pub struct RunReport {
    pub scenario: Scenario,
    pub model_calls: usize,
    pub tool_effects: usize,
    pub output: Option<String>,
    pub error: Option<String>,
}

fn scripted_model(scenario: Scenario) -> MockCompletionModel {
    let tool_name = if scenario == Scenario::UnknownTool {
        "unknown_gateway"
    } else if scenario == Scenario::DeniedTool {
        MockDeniedTool::NAME
    } else {
        ControlledTool::NAME
    };
    MockCompletionModel::from_turns([
        MockTurn::tool_call("call-1", tool_name, json!({"text": "fixture"})),
        MockTurn::text("fixture"),
    ])
}

/// Run one controlled Rig agent invocation.
pub async fn run_once(scenario: Scenario, delay: Duration) -> RunReport {
    let model = scripted_model(scenario);
    let model_observer = model.clone();
    let tool = ControlledTool::new(delay);
    let tool_observer = tool.clone();
    let builder = AgentBuilder::new(model);

    if scenario == Scenario::DeniedTool {
        // The published test utility exercises Rig's normal refused-tool path.
        // It is deliberately separate from the benchmark's controlled tool.
        let denied = MockDeniedTool;
        let result = builder.tool(denied).build()
            .runner(Message::user("fixture"))
            .without_memory()
            .max_turns(2)
            .run().await;
        return report(scenario, model_observer.request_count(), 0, result);
    }

    let mut runner = builder.tool(tool).build().runner(Message::user("fixture")).without_memory().max_turns(2);
    if scenario == Scenario::Budget {
        runner = runner.max_turns(1);
    }
    let result = runner.run().await;
    report(scenario, model_observer.request_count(), tool_observer.effects(), result)
}

fn report(
    scenario: Scenario,
    model_calls: usize,
    tool_effects: usize,
    result: Result<rig_agent::agent::PromptResponse, PromptError>,
) -> RunReport {
    match result {
        Ok(response) => RunReport {
            scenario, model_calls, tool_effects,
            output: Some(response.output), error: None,
        },
        Err(error) => RunReport {
            scenario, model_calls, tool_effects,
            output: None, error: Some(error.to_string()),
        },
    }
}

pub async fn run_benchmark(
    sequential_iterations: usize,
    concurrent_batches: usize,
    concurrency: usize,
    delay: Duration,
) -> Value {
    for _ in 0..20 {
        let report = run_once(Scenario::Normal, Duration::ZERO).await;
        assert_eq!((report.model_calls, report.tool_effects), (2, 1));
    }
    let mut sequential = Vec::with_capacity(sequential_iterations);
    for _ in 0..sequential_iterations {
        let start = std::time::Instant::now();
        let report = run_once(Scenario::Normal, Duration::ZERO).await;
        assert_eq!((report.model_calls, report.tool_effects), (2, 1));
        sequential.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let started = std::time::Instant::now();
    for _ in 0..concurrent_batches {
        let mut jobs = Vec::with_capacity(concurrency);
        for _ in 0..concurrency {
            jobs.push(tokio::spawn(run_once(Scenario::Normal, delay)));
        }
        for job in jobs {
            let report = job.await.expect("benchmark task must finish");
            assert_eq!((report.model_calls, report.tool_effects), (2, 1));
        }
    }
    sequential.sort_by(f64::total_cmp);
    let percentile = |p: f64| -> f64 {
        let index = ((sequential.len() as f64 * p).ceil() as usize).saturating_sub(1);
        sequential[index]
    };
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    json!({
        "runtime": "rig-agent",
        "rig_agent": "0.42.0",
        "mode": "buffered_blocking",
        "persistence": "none",
        "simulated_io_ms": delay.as_secs_f64() * 1000.0,
        "sequential_iterations": sequential_iterations,
        "sequential_p50_ms": percentile(0.50),
        "sequential_p95_ms": percentile(0.95),
        "concurrency": concurrency,
        "concurrent_runs": concurrent_batches * concurrency,
        "concurrent_runs_per_second": (concurrent_batches * concurrency) as f64 / (elapsed_ms / 1000.0),
        "rss_bytes": process_rss_bytes(),
    })
}

#[cfg(windows)]
fn process_rss_bytes() -> u64 {
    // Keep the experiment dependency-light. Windows exposes this through the
    // process API, but querying it portably would add a platform dependency.
    0
}

#[cfg(not(windows))]
fn process_rss_bytes() -> u64 {
    0
}
