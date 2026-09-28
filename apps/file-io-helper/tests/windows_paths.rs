#![cfg(windows)]

use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static NEXT: AtomicU64 = AtomicU64::new(0);
const VERSION: &str = "relay-file-io-v1";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "relay-file-io-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn root(&self) -> String {
        self.0.to_str().unwrap().to_owned()
    }
    fn invoke(&self, value: Value) -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_relay-file-io-helper"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        writeln!(stdin, "{}", value).unwrap();
        drop(stdin);
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn inspect(&self) -> String {
        let response =
            self.invoke(json!({"version":VERSION,"op":"inspect-root","root_path":self.root()}));
        assert_eq!(response["ok"], true, "{response}");
        response["root_id"].as_str().unwrap().to_owned()
    }
    fn capture(&self, root_id: &str, path: &str, action: &str) -> Value {
        self.invoke(
            json!({"version":VERSION,"op":"capture","root_path":self.root(),
            "expected_root_id":root_id,"changes":[{"path":path,"action":action}]}),
        )
    }
    fn inspect_residuals(&self, root_id: &str, files: Value) -> Value {
        self.invoke(
            json!({"version":VERSION,"op":"inspect-residuals","root_path":self.root(),
            "expected_root_id":root_id,"files":files}),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Every fixture is made directly below temp with a fixed owned prefix.
        assert!(self.0.starts_with(std::env::temp_dir()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("relay-file-io-test-")
        );
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn latched(f: &Fixture, request: Value, stage: &str, attack: impl FnOnce()) -> Value {
    let ready = f.path().join(format!("{stage}.ready"));
    let release = f.path().join(format!("{stage}.release"));
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-file-io-helper"))
        .env("RELAY_FILE_IO_TEST_STAGE", stage)
        .env("RELAY_FILE_IO_TEST_READY", &ready)
        .env("RELAY_FILE_IO_TEST_RELEASE", &release)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{request}").unwrap();
    for _ in 0..1000 {
        if ready.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(ready.exists(), "helper did not reach {stage} latch");
    let attack_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(attack));
    fs::write(release, b"go").unwrap();
    let output = child.wait_with_output().unwrap();
    if let Err(panic) = attack_result {
        std::panic::resume_unwind(panic);
    }
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn create_modify_delete_and_reconcile_use_identity_chain() {
    let f = Fixture::new();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "nested/a.txt", "CREATE");
    assert_eq!(captured["files"][0]["target_id"], Value::Null);
    let created = f.invoke(
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"nested/a.txt","action":"CREATE",
        "expected_parent_chain":captured["files"][0]["parent_chain"],
        "expected_target_id":null,"content":"before"}]}),
    );
    assert_eq!(created["files"][0]["status"], "APPLIED", "{created}");
    assert_eq!(
        created["files"][0]["parent_chain"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let baseline = f.capture(&root_id, "nested/a.txt", "MODIFY");
    assert_eq!(baseline["files"][0]["text"], "before");
    let modified = f.invoke(
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"nested/a.txt","action":"MODIFY",
        "expected_parent_chain":baseline["files"][0]["parent_chain"],
        "expected_target_id":baseline["files"][0]["target_id"],
        "baseline_sha256":baseline["files"][0]["sha256"],"content":"after"}]}),
    );
    assert_eq!(modified["files"][0]["status"], "APPLIED", "{modified}");
    assert_eq!(
        fs::read_to_string(f.path().join("nested/a.txt")).unwrap(),
        "after"
    );
    let checked = f.invoke(
        json!({"version":VERSION,"op":"reconcile","root_path":f.root(),
        "expected_root_id":root_id,"files":[{"path":"nested/a.txt",
        "expected_parent_chain":modified["files"][0]["parent_chain"],
        "expected_target_id":modified["files"][0]["target_id"],
        "expected_sha256":modified["files"][0]["actual_sha256"]}]}),
    );
    assert_eq!(checked["files"][0]["matches"], true, "{checked}");
    let deleted = f.invoke(
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"nested/a.txt","action":"DELETE",
        "expected_parent_chain":modified["files"][0]["parent_chain"],
        "expected_target_id":modified["files"][0]["target_id"],
        "baseline_sha256":modified["files"][0]["actual_sha256"]}]}),
    );
    assert_eq!(deleted["files"][0]["status"], "APPLIED", "{deleted}");
    assert!(!f.path().join("nested/a.txt").exists());
    let checked = f.invoke(
        json!({"version":VERSION,"op":"reconcile","root_path":f.root(),
        "expected_root_id":root_id,"files":[{"path":"nested/a.txt",
        "expected_parent_chain":deleted["files"][0]["parent_chain"],
        "expected_target_id":null,"expected_sha256":null}]}),
    );
    assert_eq!(checked["files"][0]["matches"], true, "{checked}");
}

#[test]
fn replacing_parent_or_target_with_same_bytes_conflicts() {
    let f = Fixture::new();
    fs::create_dir(f.path().join("folder")).unwrap();
    fs::write(f.path().join("folder/a.txt"), "same").unwrap();
    let root_id = f.inspect();
    let baseline = f.capture(&root_id, "folder/a.txt", "MODIFY");
    fs::rename(f.path().join("folder"), f.path().join("old-folder")).unwrap();
    fs::create_dir(f.path().join("folder")).unwrap();
    fs::write(f.path().join("folder/a.txt"), "same").unwrap();
    let attempt = f.invoke(
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"folder/a.txt","action":"MODIFY",
        "expected_parent_chain":baseline["files"][0]["parent_chain"],
        "expected_target_id":baseline["files"][0]["target_id"],
        "baseline_sha256":baseline["files"][0]["sha256"],"content":"new"}]}),
    );
    assert_eq!(attempt["files"][0]["status"], "CONFLICT", "{attempt}");
    assert_eq!(
        fs::read_to_string(f.path().join("folder/a.txt")).unwrap(),
        "same"
    );
    let fresh = f.capture(&root_id, "folder/a.txt", "MODIFY");
    fs::remove_file(f.path().join("folder/a.txt")).unwrap();
    fs::write(f.path().join("folder/a.txt"), "same").unwrap();
    let attempt = f.invoke(
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"folder/a.txt","action":"MODIFY",
        "expected_parent_chain":fresh["files"][0]["parent_chain"],
        "expected_target_id":fresh["files"][0]["target_id"],
        "baseline_sha256":fresh["files"][0]["sha256"],"content":"new"}]}),
    );
    assert_eq!(attempt["files"][0]["status"], "CONFLICT", "{attempt}");
    assert_eq!(
        fs::read_to_string(f.path().join("folder/a.txt")).unwrap(),
        "same"
    );
}

#[test]
fn hard_link_ads_and_junction_cannot_write_outside_root() {
    let f = Fixture::new();
    let outside = Fixture::new();
    fs::write(outside.path().join("keep.txt"), "outside").unwrap();
    fs::hard_link(outside.path().join("keep.txt"), f.path().join("linked.txt")).unwrap();
    let root_id = f.inspect();
    let capture = f.capture(&root_id, "linked.txt", "MODIFY");
    assert_eq!(capture["files"][0]["error"], "HARD_LINK", "{capture}");
    let ads = f.capture(&root_id, "linked.txt:stream", "CREATE");
    assert_eq!(ads["ok"], false, "{ads}");
    let junction = f.path().join("junction");
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            junction.to_str().unwrap(),
            outside.path().to_str().unwrap(),
        ])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let capture = f.capture(&root_id, "junction/keep.txt", "MODIFY");
    assert_eq!(capture["files"][0]["error"], "UNSAFE_ENTRY", "{capture}");
    assert_eq!(
        fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
        "outside"
    );
}

#[test]
fn replacing_the_root_rejects_the_whole_operation() {
    let f = Fixture::new();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "a.txt", "CREATE");
    let old_path = f.path().with_extension("old");
    fs::rename(f.path(), &old_path).unwrap();
    fs::create_dir(f.path()).unwrap();
    let response = f.invoke(
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"a.txt","action":"CREATE",
        "expected_parent_chain":captured["files"][0]["parent_chain"],
        "expected_target_id":null,"content":"wrong-root"}]}),
    );
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "ROOT_CHANGED");
    assert!(!f.path().join("a.txt").exists());
    fs::remove_dir_all(old_path).unwrap();
}

#[test]
fn held_parent_and_target_handles_block_latched_replacement() {
    let f = Fixture::new();
    let outside = Fixture::new();
    fs::create_dir(f.path().join("parent")).unwrap();
    fs::write(outside.path().join("sentinel.txt"), "untouched").unwrap();
    let root_id = f.inspect();
    let create_capture = f.capture(&root_id, "parent/new.txt", "CREATE");
    let create = latched(
        &f,
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"parent/new.txt","action":"CREATE",
        "expected_parent_chain":create_capture["files"][0]["parent_chain"],
        "expected_target_id":null,"content":"safe"}]}),
        "parent",
        || {
            assert!(
                fs::rename(f.path(), f.path().with_extension("moved")).is_err(),
                "held root unexpectedly allowed rename"
            );
            assert!(
                fs::rename(f.path().join("parent"), f.path().join("moved")).is_err(),
                "held parent unexpectedly allowed rename"
            );
        },
    );
    assert_eq!(create["files"][0]["status"], "APPLIED", "{create}");
    assert_eq!(
        fs::read_to_string(f.path().join("parent/new.txt")).unwrap(),
        "safe"
    );
    let modify_capture = f.capture(&root_id, "parent/new.txt", "MODIFY");
    let modify = latched(
        &f,
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"parent/new.txt","action":"MODIFY",
        "expected_parent_chain":modify_capture["files"][0]["parent_chain"],
        "expected_target_id":modify_capture["files"][0]["target_id"],
        "baseline_sha256":modify_capture["files"][0]["sha256"],"content":"changed"}]}),
        "target",
        || {
            assert!(
                fs::rename(f.path().join("parent/new.txt"), f.path().join("moved.txt")).is_err(),
                "held target unexpectedly allowed rename"
            );
            fs::hard_link(
                f.path().join("parent/new.txt"),
                outside.path().join("new-hardlink.txt"),
            )
            .unwrap();
        },
    );
    assert_eq!(modify["files"][0]["status"], "FAILED", "{modify}");
    assert_eq!(modify["files"][0]["error"], "HARD_LINK");
    assert_eq!(modify["files"][0]["effect_uncertain"], false);
    assert_eq!(
        fs::read_to_string(f.path().join("parent/new.txt")).unwrap(),
        "safe"
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("new-hardlink.txt")).unwrap(),
        "safe"
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("sentinel.txt")).unwrap(),
        "untouched"
    );
}

#[test]
fn root_ancestor_junction_back_to_same_object_is_rejected() {
    let f = Fixture::new();
    let parent = f.path().join("parent");
    let managed = parent.join("managed");
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&managed).unwrap();
    let registered = managed.to_str().unwrap();
    let inspect = f.invoke(json!({"version":VERSION,"op":"inspect-root","root_path":registered}));
    assert_eq!(inspect["ok"], true, "{inspect}");
    let moved = f.path().join("moved-parent");
    fs::rename(&parent, &moved).unwrap();
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            parent.to_str().unwrap(),
            moved.to_str().unwrap(),
        ])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let response = f.invoke(
        json!({"version":VERSION,"op":"capture","root_path":registered,
        "expected_root_id":inspect["root_id"],
        "changes":[{"path":"new.txt","action":"CREATE"}]}),
    );
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "UNSAFE_ENTRY", "{response}");
    assert!(!moved.join("managed/new.txt").exists());
}

#[test]
fn missing_or_existing_target_is_per_file_conflict_and_later_file_runs() {
    let f = Fixture::new();
    let root_id = f.inspect();
    fs::write(f.path().join("exists.txt"), "old").unwrap();
    let missing = f.capture(&root_id, "absent/a.txt", "MODIFY");
    assert_eq!(missing["files"][0]["target_id"], Value::Null);
    assert!(missing["files"][0].get("error").is_none(), "{missing}");
    let existing = f.capture(&root_id, "exists.txt", "CREATE");
    let response = f.invoke(
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[
        {"path":"absent/a.txt","action":"MODIFY",
         "expected_parent_chain":missing["files"][0]["parent_chain"],
         "expected_target_id":null,"baseline_sha256":"00".repeat(32),"content":"new"},
        {"path":"exists.txt","action":"CREATE",
         "expected_parent_chain":existing["files"][0]["parent_chain"],
         "expected_target_id":existing["files"][0]["target_id"],"content":"overwrite"},
        {"path":"good.txt","action":"CREATE","expected_parent_chain":[],
         "expected_target_id":null,"content":"applied"}]}),
    );
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["outcome"], "FAILED");
    assert_eq!(response["files"][0]["status"], "CONFLICT", "{response}");
    assert_eq!(response["files"][1]["status"], "CONFLICT", "{response}");
    assert_eq!(response["files"][2]["status"], "APPLIED", "{response}");
    assert_eq!(
        fs::read_to_string(f.path().join("exists.txt")).unwrap(),
        "old"
    );
    assert_eq!(
        fs::read_to_string(f.path().join("good.txt")).unwrap(),
        "applied"
    );
    assert!(!f.path().join("absent").exists());
}

#[test]
fn capture_large_text_keeps_identity_and_hash() {
    let f = Fixture::new();
    fs::write(f.path().join("large.txt"), vec![b'x'; 70 * 1024]).unwrap();
    let root_id = f.inspect();
    let capture = f.capture(&root_id, "large.txt", "MODIFY");
    assert_eq!(capture["ok"], true, "{capture}");
    assert!(capture["files"][0]["target_id"].is_string());
    assert!(capture["files"][0]["sha256"].is_string());
    assert_eq!(capture["files"][0]["text"], Value::Null);
    assert_eq!(
        capture["files"][0]["text_unavailable_reason"],
        "TEXT_TOO_LARGE"
    );
}

#[test]
fn create_never_overwrites_a_file_that_appeared_after_capture() {
    let f = Fixture::new();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "new.txt", "CREATE");
    fs::write(f.path().join("new.txt"), "external").unwrap();
    let response = f.invoke(
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"new.txt","action":"CREATE",
        "expected_parent_chain":captured["files"][0]["parent_chain"],
        "expected_target_id":null,"content":"overwrite"}]}),
    );
    assert_eq!(response["files"][0]["status"], "CONFLICT", "{response}");
    assert!(response["files"][0]["target_id"].is_string());
    assert!(response["files"][0]["actual_sha256"].is_string());
    assert_eq!(
        fs::read_to_string(f.path().join("new.txt")).unwrap(),
        "external"
    );
}

#[test]
fn staged_create_blocks_a_new_hard_link_during_write() {
    let f = Fixture::new();
    let outside = Fixture::new();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "created.txt", "CREATE");
    let response = latched(
        &f,
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"created.txt","action":"CREATE",
        "expected_parent_chain":captured["files"][0]["parent_chain"],
        "expected_target_id":null,"content":"payload"}]}),
        "stage",
        || {
            let name = fs::read_to_string(f.path().join("stage.ready")).unwrap();
            assert!(name.starts_with(".__relay-file-io-"));
            assert!(
                fs::hard_link(f.path().join(name), outside.path().join("linked.txt")).is_err(),
                "delete-pending staging object accepted a hard link"
            );
        },
    );
    assert_eq!(response["files"][0]["status"], "APPLIED", "{response}");
    assert_eq!(
        fs::read_to_string(f.path().join("created.txt")).unwrap(),
        "payload"
    );
    assert!(!outside.path().join("linked.txt").exists());
}

#[test]
fn link_created_between_stage_create_and_delete_mark_is_rejected_before_write() {
    let f = Fixture::new();
    let outside = Fixture::new();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "created.txt", "CREATE");
    let response = latched(
        &f,
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"created.txt","action":"CREATE",
        "expected_parent_chain":captured["files"][0]["parent_chain"],
        "expected_target_id":null,"content":"payload"}]}),
        "post_create",
        || {
            let name = fs::read_to_string(f.path().join("post_create.ready")).unwrap();
            fs::hard_link(f.path().join(name), outside.path().join("linked.txt")).unwrap();
        },
    );
    assert_eq!(response["files"][0]["status"], "FAILED", "{response}");
    assert_eq!(response["files"][0]["error"], "HARD_LINK");
    assert_eq!(response["files"][0]["effect_uncertain"], true);
    assert!(!f.path().join("created.txt").exists());
    assert_eq!(fs::read(outside.path().join("linked.txt")).unwrap(), b"");
}

#[test]
fn staged_modify_blocks_a_new_hard_link_during_write() {
    let f = Fixture::new();
    let outside = Fixture::new();
    fs::write(f.path().join("existing.txt"), "before").unwrap();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "existing.txt", "MODIFY");
    let response = latched(
        &f,
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"existing.txt","action":"MODIFY",
        "expected_parent_chain":captured["files"][0]["parent_chain"],
        "expected_target_id":captured["files"][0]["target_id"],
        "baseline_sha256":captured["files"][0]["sha256"],"content":"after"}]}),
        "stage",
        || {
            let name = fs::read_to_string(f.path().join("stage.ready")).unwrap();
            assert!(
                fs::hard_link(f.path().join(name), outside.path().join("linked.txt")).is_err(),
                "delete-pending MODIFY staging object accepted a hard link"
            );
        },
    );
    assert_eq!(response["files"][0]["status"], "APPLIED", "{response}");
    assert_eq!(
        fs::read_to_string(f.path().join("existing.txt")).unwrap(),
        "after"
    );
    assert!(!outside.path().join("linked.txt").exists());
}

#[test]
fn killing_helper_during_staged_write_preserves_original_and_removes_stage() {
    let f = Fixture::new();
    fs::write(f.path().join("existing.txt"), "before").unwrap();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "existing.txt", "MODIFY");
    let ready = f.path().join("stage.ready");
    let release = f.path().join("stage.release");
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-file-io-helper"))
        .env("RELAY_FILE_IO_TEST_STAGE", "stage")
        .env("RELAY_FILE_IO_TEST_READY", &ready)
        .env("RELAY_FILE_IO_TEST_RELEASE", &release)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"version":VERSION,"op":"execute",
        "root_path":f.root(),"expected_root_id":root_id,"changes":[{
        "path":"existing.txt","action":"MODIFY",
        "expected_parent_chain":captured["files"][0]["parent_chain"],
        "expected_target_id":captured["files"][0]["target_id"],
        "baseline_sha256":captured["files"][0]["sha256"],"content":"after"}]})
    )
    .unwrap();
    for _ in 0..1000 {
        if ready.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(ready.exists());
    let stage_name = fs::read_to_string(&ready).unwrap();
    assert!(f.path().join(&stage_name).exists());
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(!f.path().join(stage_name).exists());
    assert_eq!(
        fs::read_to_string(f.path().join("existing.txt")).unwrap(),
        "before"
    );
}

#[test]
fn killing_helper_after_backup_rename_leaves_both_versions_for_recovery() {
    let f = Fixture::new();
    fs::write(f.path().join("new.txt"), "created\n").unwrap();
    fs::write(f.path().join("existing.txt"), "before").unwrap();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "existing.txt", "MODIFY");
    let ready = f.path().join("gap.ready");
    let release = f.path().join("gap.release");
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-file-io-helper"))
        .env("RELAY_FILE_IO_TEST_STAGE", "gap")
        .env("RELAY_FILE_IO_TEST_READY", &ready)
        .env("RELAY_FILE_IO_TEST_RELEASE", &release)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"version":VERSION,"op":"execute",
        "root_path":f.root(),"expected_root_id":root_id,"changes":[{
        "path":"existing.txt","action":"MODIFY",
        "expected_parent_chain":captured["files"][0]["parent_chain"],
        "expected_target_id":captured["files"][0]["target_id"],
        "baseline_sha256":captured["files"][0]["sha256"],"content":"after"}]})
    )
    .unwrap();
    for _ in 0..1000 {
        if ready.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(ready.exists(), "helper did not reach backup rename gap");
    assert_eq!(
        fs::read_to_string(&ready).unwrap().parse::<u32>().unwrap(),
        child.id()
    );
    assert!(!f.path().join("existing.txt").exists());
    child.kill().unwrap();
    child.wait().unwrap();
    let observed = f.inspect_residuals(
        &root_id,
        json!([{"path":"new.txt","expected_parent_chain":[],
            "expected_target_id":null,"expected_sha256":null},
            {"path":"existing.txt","expected_parent_chain":captured["files"][0]["parent_chain"],
            "expected_target_id":captured["files"][0]["target_id"],
            "expected_sha256":captured["files"][0]["sha256"]}]),
    );
    assert_eq!(observed["ok"], true, "{observed}");
    assert_eq!(observed["complete"], true);
    assert_eq!(observed["files"][0]["target"]["status"], "READABLE");
    assert_eq!(observed["files"][1]["target"]["state"], "MISSING");
    assert_eq!(
        observed["files"][1]["candidates"].as_array().unwrap().len(),
        2
    );
    let observed_candidates = observed["files"][1]["candidates"].as_array().unwrap();
    assert!(
        observed_candidates
            .iter()
            .all(|entry| entry["status"] == "READABLE")
    );
    assert!(
        observed_candidates
            .iter()
            .any(|entry| entry["id"] == captured["files"][0]["target_id"])
    );

    let residuals: Vec<_> = fs::read_dir(f.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".__relay-file-io-"))
        .collect();
    assert_eq!(residuals.len(), 2, "both backup and staged target remain");
    let backup_name = residuals
        .iter()
        .find(|name| fs::read_to_string(f.path().join(name)).unwrap() == "before")
        .unwrap();
    let stage_name = residuals
        .iter()
        .find(|name| fs::read_to_string(f.path().join(name)).unwrap() == "after")
        .unwrap();
    let backup = f.capture(&root_id, backup_name, "MODIFY");
    let stage = f.capture(&root_id, stage_name, "MODIFY");
    assert_eq!(
        backup["files"][0]["target_id"],
        captured["files"][0]["target_id"]
    );
    assert_ne!(
        stage["files"][0]["target_id"],
        captured["files"][0]["target_id"]
    );
    assert!(!f.path().join("existing.txt").exists());
}

#[test]
fn residual_inspection_observes_new_parents_but_rejects_frozen_parent_replacement() {
    let f = Fixture::new();
    fs::create_dir(f.path().join("frozen")).unwrap();
    let root_id = f.inspect();
    let captured = f.capture(&root_id, "frozen/new/a.txt", "CREATE");
    let frozen_chain = captured["files"][0]["parent_chain"].clone();
    assert_eq!(frozen_chain.as_array().unwrap().len(), 1);
    fs::create_dir_all(f.path().join("frozen/new")).unwrap();
    fs::write(f.path().join("frozen/new/a.txt"), "current").unwrap();
    let request = json!([{"path":"frozen/new/a.txt","expected_parent_chain":frozen_chain,
        "expected_target_id":null,"expected_sha256":null}]);
    let observed = f.inspect_residuals(&root_id, request.clone());
    assert_eq!(observed["ok"], true, "{observed}");
    assert_eq!(
        observed["files"][0]["parent_chain"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(observed["files"][0]["target"]["status"], "READABLE");
    fs::rename(f.path().join("frozen"), f.path().join("moved")).unwrap();
    fs::create_dir_all(f.path().join("frozen/new")).unwrap();
    fs::write(f.path().join("frozen/new/a.txt"), "current").unwrap();
    let replaced = f.inspect_residuals(&root_id, request);
    assert_eq!(replaced["ok"], false, "{replaced}");
    assert_eq!(replaced["error"]["code"], "PARENT_CHANGED");
}

#[test]
fn residual_inspection_fails_closed_for_hard_link_reparse_and_count_limit() {
    let f = Fixture::new();
    let outside = Fixture::new();
    fs::write(outside.path().join("external.txt"), "outside").unwrap();
    let root_id = f.inspect();
    let request = json!([{"path":"target.txt","expected_parent_chain":[],
        "expected_target_id":null,"expected_sha256":null}]);
    fs::hard_link(
        outside.path().join("external.txt"),
        f.path().join(".__relay-file-io-linked.tmp"),
    )
    .unwrap();
    let linked = f.inspect_residuals(&root_id, request.clone());
    assert_eq!(linked["ok"], false, "{linked}");
    assert_eq!(linked["complete"], false);
    assert_eq!(linked["files"][0]["candidates"][0]["status"], "UNSAFE");
    assert_eq!(linked["files"][0]["candidates"][0]["error"], "HARD_LINK");
    assert_eq!(
        fs::read_to_string(outside.path().join("external.txt")).unwrap(),
        "outside"
    );
    fs::remove_file(f.path().join(".__relay-file-io-linked.tmp")).unwrap();
    let junction = f.path().join(".__relay-file-io-junction.tmp");
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            junction.to_str().unwrap(),
            outside.root().as_str(),
        ])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());
    let reparse = f.inspect_residuals(&root_id, request.clone());
    assert_eq!(reparse["ok"], false, "{reparse}");
    assert_eq!(reparse["files"][0]["candidates"][0]["status"], "UNSAFE");
    assert_eq!(
        reparse["files"][0]["candidates"][0]["error"],
        "UNSAFE_ENTRY"
    );
    fs::remove_dir(junction).unwrap();
    for index in 0..33 {
        fs::write(f.path().join(format!(".__relay-file-io-{index}.tmp")), b"x").unwrap();
    }
    let limited = f.inspect_residuals(&root_id, request);
    assert_eq!(limited["ok"], false, "{limited}");
    assert_eq!(limited["error"]["code"], "RESIDUAL_LIMIT");
}

#[test]
fn residual_inspection_reports_current_target_without_attribution_and_rejects_oversize() {
    let f = Fixture::new();
    fs::write(f.path().join("target.txt"), "before").unwrap();
    let root_id = f.inspect();
    let frozen = f.capture(&root_id, "target.txt", "MODIFY");
    fs::remove_file(f.path().join("target.txt")).unwrap();
    fs::write(f.path().join("target.txt"), "after").unwrap();
    let request = json!([{"path":"target.txt","expected_parent_chain":[],
        "expected_target_id":frozen["files"][0]["target_id"],
        "expected_sha256":frozen["files"][0]["sha256"]}]);
    let changed = f.inspect_residuals(&root_id, request.clone());
    assert_eq!(changed["ok"], true, "{changed}");
    assert_eq!(changed["files"][0]["target"]["status"], "READABLE");
    assert_ne!(
        changed["files"][0]["target"]["id"],
        frozen["files"][0]["target_id"]
    );
    assert_ne!(
        changed["files"][0]["target"]["sha256"],
        frozen["files"][0]["sha256"]
    );
    fs::write(f.path().join("target.txt"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    let oversize = f.inspect_residuals(&root_id, request);
    assert_eq!(oversize["ok"], false, "{oversize}");
    assert_eq!(oversize["complete"], false);
    assert_eq!(oversize["files"][0]["target"]["status"], "TOO_LARGE");
    assert_eq!(oversize["files"][0]["target"]["sha256"], Value::Null);
}

#[test]
fn residual_inspection_detects_candidate_replacement_during_enumeration() {
    let f = Fixture::new();
    let markers = Fixture::new();
    let candidate = f.path().join(".__relay-file-io-candidate.tmp");
    fs::write(&candidate, "before").unwrap();
    let root_id = f.inspect();
    let ready = markers.path().join("inspect.ready");
    let release = markers.path().join("inspect.release");
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-file-io-helper"))
        .env("RELAY_FILE_IO_TEST_STAGE", "inspect_enum")
        .env("RELAY_FILE_IO_TEST_READY", &ready)
        .env("RELAY_FILE_IO_TEST_RELEASE", &release)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"version":VERSION,
        "op":"inspect-residuals","root_path":f.root(),"expected_root_id":root_id,
        "files":[{"path":"target.txt","expected_parent_chain":[],
            "expected_target_id":null,"expected_sha256":null}]})
    )
    .unwrap();
    for _ in 0..1000 {
        if ready.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(ready.exists(), "inspector did not reach enumeration latch");
    fs::rename(&candidate, f.path().join("removed.tmp")).unwrap();
    fs::write(&candidate, "replacement").unwrap();
    fs::write(&release, b"go").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "DIRECTORY_CHANGED");
}

#[test]
fn target_name_squat_after_backup_never_overwrites_and_flags_partial_unknown() {
    let f = Fixture::new();
    fs::write(f.path().join("target.txt"), "original").unwrap();
    let root_id = f.inspect();
    let baseline = f.capture(&root_id, "target.txt", "MODIFY");
    let response = latched(
        &f,
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[
        {"path":"first.txt","action":"CREATE","expected_parent_chain":[],
         "expected_target_id":null,"content":"first-applied"},
        {"path":"target.txt","action":"MODIFY",
         "expected_parent_chain":baseline["files"][0]["parent_chain"],
         "expected_target_id":baseline["files"][0]["target_id"],
         "baseline_sha256":baseline["files"][0]["sha256"],"content":"new-content"}]}),
        "gap",
        || {
            assert!(!f.path().join("target.txt").exists());
            fs::write(f.path().join("target.txt"), "squatter").unwrap();
        },
    );
    assert_eq!(response["files"][0]["status"], "APPLIED", "{response}");
    assert_eq!(response["files"][0]["effect_uncertain"], false);
    assert_eq!(response["files"][1]["status"], "FAILED", "{response}");
    assert_eq!(response["files"][1]["effect_uncertain"], true);
    assert_eq!(
        fs::read_to_string(f.path().join("first.txt")).unwrap(),
        "first-applied"
    );
    assert_eq!(
        fs::read_to_string(f.path().join("target.txt")).unwrap(),
        "squatter"
    );
    let backup = response["files"][1]["backup_path"].as_str().unwrap();
    assert_eq!(
        fs::read_to_string(f.path().join(backup)).unwrap(),
        "original"
    );
}

#[test]
fn delete_rejects_a_hard_link_added_while_target_is_held() {
    let f = Fixture::new();
    let outside = Fixture::new();
    fs::write(f.path().join("delete.txt"), "original").unwrap();
    let root_id = f.inspect();
    let baseline = f.capture(&root_id, "delete.txt", "DELETE");
    let response = latched(
        &f,
        json!({"version":VERSION,"op":"execute","root_path":f.root(),
        "expected_root_id":root_id,"changes":[{"path":"delete.txt","action":"DELETE",
        "expected_parent_chain":baseline["files"][0]["parent_chain"],
        "expected_target_id":baseline["files"][0]["target_id"],
        "baseline_sha256":baseline["files"][0]["sha256"]}]}),
        "target",
        || {
            fs::hard_link(
                f.path().join("delete.txt"),
                outside.path().join("linked.txt"),
            )
            .unwrap();
        },
    );
    assert_eq!(response["files"][0]["status"], "FAILED", "{response}");
    assert_eq!(response["files"][0]["error"], "HARD_LINK");
    assert_eq!(response["files"][0]["effect_uncertain"], false);
    assert_eq!(
        fs::read_to_string(f.path().join("delete.txt")).unwrap(),
        "original"
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("linked.txt")).unwrap(),
        "original"
    );
}
