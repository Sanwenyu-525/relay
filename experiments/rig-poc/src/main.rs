use std::io::{self, BufRead, Write};
use std::time::Duration;

use serde_json::json;
use workflow_os_rig_poc::{Scenario, run_benchmark, run_once};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("scenario") => {
            let scenario = match args.next().as_deref() {
                Some("normal") => Scenario::Normal,
                Some("unknown") => Scenario::UnknownTool,
                Some("denied") => Scenario::DeniedTool,
                Some("budget") => Scenario::Budget,
                _ => {
                    eprintln!("scenario must be normal|unknown|denied|budget");
                    std::process::exit(2);
                }
            };
            let report = run_once(scenario, Duration::ZERO).await;
            println!("{}", json!({
                "scenario": format!("{:?}", report.scenario),
                "model_calls": report.model_calls,
                "tool_effects": report.tool_effects,
                "output": report.output,
                "error": report.error,
            }));
        }
        Some("bench") => {
            let report = run_benchmark(200, 10, 16, Duration::from_millis(5)).await;
            println!("{report}");
        }
        _ => {
            println!("{}", json!({"ready": true, "runtime": "rig-agent", "version": "0.42.0", "pid": std::process::id()}));
            let _ = io::stdout().flush();
            let stdin = io::stdin();
            let mut line = String::new();
            if stdin.lock().read_line(&mut line).is_ok() && line.trim() == "run" {
                let report = run_benchmark(200, 10, 16, Duration::from_millis(5)).await;
                println!("{report}");
            }
        }
    }
}

