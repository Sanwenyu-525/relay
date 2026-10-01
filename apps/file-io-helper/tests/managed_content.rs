#![cfg(windows)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

const VERSION: &str = "relay-managed-content-v1";
const NONCE: &str = "00000000-0000-4000-8000-000000000001";
const ARTIFACT: &str = "00000000-0000-4000-8000-000000000002";
const CONTENT_VERSION: &str = "00000000-0000-4000-8000-000000000003";
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "relay-content-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn publish(&self, content: &[u8]) -> Value {
        json!({ "version": VERSION, "op": "publish-content", "root_path": self.0,
            "artifact_id": ARTIFACT, "version_id": CONTENT_VERSION,
            "content_hex": content.iter().map(|byte| format!("{byte:02x}")).collect::<String>() })
    }
    fn freeze(&self) -> Value {
        json!({ "version": VERSION, "op": "hold-content-freeze", "root_path": self.0, "nonce": NONCE })
    }
    fn target(&self) -> PathBuf {
        self.0
            .join("artifacts")
            .join(ARTIFACT)
            .join(CONTENT_VERSION)
            .join("content.md")
    }
    fn invoke(&self, request: Value) -> Value {
        let mut child = command().spawn().unwrap();
        writeln!(child.stdin.take().unwrap(), "{request}").unwrap();
        let result = child.wait_with_output().unwrap();
        let reply: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(result.status.success(), reply["ok"] == true, "{reply}");
        reply
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert!(self.0.starts_with(std::env::temp_dir()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("relay-content-native-")
        );
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_relay-file-io-helper"));
    command
        .arg("--managed-content")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    command
}
struct Held {
    child: Child,
    output: BufReader<ChildStdout>,
}
impl Held {
    fn freeze(fixture: &Fixture) -> Self {
        let mut child = command().spawn().unwrap();
        writeln!(child.stdin.as_mut().unwrap(), "{}", fixture.freeze()).unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut held = Self { child, output };
        assert_eq!(held.line()["event"], "content_freeze_ready");
        held
    }
    fn line(&mut self) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
    fn release(&mut self) {
        writeln!(
            self.child.stdin.take().unwrap(),
            "{}",
            json!({ "version": VERSION, "op": "release-content-freeze", "nonce": NONCE })
        )
        .unwrap();
        assert_eq!(self.line()["event"], "content_freeze_released");
        assert!(self.child.wait().unwrap().success());
    }
}
impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn content_publish_preserves_bytes_hash_and_never_replaces_an_existing_version() {
    let fixture = Fixture::new();
    let content = "# 原生内容\n".as_bytes();
    let first = fixture.invoke(fixture.publish(content));
    assert_eq!(first["ok"], true);
    assert_eq!(first["sha256"], format!("{:x}", Sha256::digest(content)));
    assert_eq!(first["size"], content.len().to_string());
    assert_eq!(fs::read(fixture.target()).unwrap(), content);
    assert!(
        !fixture
            .0
            .join("staging")
            .join(format!("{CONTENT_VERSION}.part"))
            .exists()
    );
    let second = fixture.invoke(fixture.publish(b"replacement"));
    assert_eq!(second["error"]["code"], "CONFLICT");
    assert_eq!(fs::read(fixture.target()).unwrap(), content);
}

#[test]
fn exclusive_freeze_blocks_publish_before_any_part_or_target_and_release_restores_it() {
    let fixture = Fixture::new();
    let mut freeze = Held::freeze(&fixture);
    assert_eq!(
        fixture.invoke(fixture.publish(b"blocked"))["error"]["code"],
        "CONTENT_FROZEN"
    );
    assert!(!fixture.0.join("staging").exists());
    assert!(!fixture.0.join("artifacts").exists());
    assert!(fs::remove_file(fixture.0.join(".relay-content-admission.lock")).is_err());
    freeze.release();
    assert_eq!(
        fixture.invoke(fixture.publish(b"after release"))["ok"],
        true
    );
}

#[test]
fn real_shared_publisher_blocks_freeze_and_its_exit_releases_the_lock() {
    let fixture = Fixture::new();
    let ready = fixture.0.join("shared.ready");
    let release = fixture.0.join("shared.release");
    let mut publish = command()
        .env("RELAY_FILE_IO_TEST_STAGE", "content_shared")
        .env("RELAY_FILE_IO_TEST_READY", &ready)
        .env("RELAY_FILE_IO_TEST_RELEASE", &release)
        .spawn()
        .unwrap();
    writeln!(
        publish.stdin.take().unwrap(),
        "{}",
        fixture.publish(b"never written")
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fixture.invoke(fixture.freeze())["error"]["code"],
        "CONTENT_FREEZE_BUSY"
    );
    publish.kill().unwrap();
    assert!(!publish.wait().unwrap().success());
    assert!(!fixture.target().exists());
    assert!(!fixture.0.join("staging").exists());
    let mut freeze = Held::freeze(&fixture);
    freeze.release();
    assert_eq!(fixture.invoke(fixture.publish(b"recovered"))["ok"], true);
}

#[test]
fn eof_and_bad_release_freeze_sessions_close_their_actual_os_lock() {
    let fixture = Fixture::new();
    let mut freeze = Held::freeze(&fixture);
    drop(freeze.child.stdin.take());
    assert!(freeze.child.wait().unwrap().success());
    let mut freeze = Held::freeze(&fixture);
    writeln!(
        freeze.child.stdin.take().unwrap(),
        "{}",
        json!({ "version": VERSION, "op": "release-content-freeze", "nonce": ARTIFACT })
    )
    .unwrap();
    assert_eq!(freeze.line()["error"]["code"], "INVALID_INPUT");
    assert!(!freeze.child.wait().unwrap().success());
    assert_eq!(fixture.invoke(fixture.publish(b"unlocked"))["ok"], true);
}

#[test]
fn sentinel_hard_links_and_parent_reparse_points_fail_closed() {
    let fixture = Fixture::new();
    let sentinel = fixture.0.join(".relay-content-admission.lock");
    fs::write(&sentinel, b"").unwrap();
    fs::hard_link(&sentinel, fixture.0.join("alias.lock")).unwrap();
    assert_eq!(
        fixture.invoke(fixture.publish(b"blocked"))["error"]["code"],
        "HARD_LINK"
    );
    assert!(!fixture.target().exists());
    assert!(!fixture.0.join("staging").exists());
    fs::remove_file(fixture.0.join("alias.lock")).unwrap();
    let other = Fixture::new();
    assert!(
        Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                fixture.0.join("artifacts").to_str().unwrap(),
                other.0.to_str().unwrap()
            ])
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(
        fixture.invoke(fixture.publish(b"blocked"))["error"]["code"],
        "UNSAFE_ENTRY"
    );
    assert!(fs::read_dir(&other.0).unwrap().next().is_none());
}

#[test]
fn killing_native_io_after_write_cannot_finish_rename_and_releases_admission() {
    let fixture = Fixture::new();
    let ready = fixture.0.join("written.ready");
    let release = fixture.0.join("written.release");
    let mut publish = command()
        .env("RELAY_FILE_IO_TEST_STAGE", "content_before_rename")
        .env("RELAY_FILE_IO_TEST_READY", &ready)
        .env("RELAY_FILE_IO_TEST_RELEASE", &release)
        .spawn()
        .unwrap();
    writeln!(
        publish.stdin.take().unwrap(),
        "{}",
        fixture.publish(b"written but not published")
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        fixture
            .0
            .join("staging")
            .join(format!("{CONTENT_VERSION}.part"))
            .exists()
    );
    assert!(!fixture.target().exists());
    assert_eq!(
        fixture.invoke(fixture.freeze())["error"]["code"],
        "CONTENT_FREEZE_BUSY"
    );
    publish.kill().unwrap();
    assert!(!publish.wait().unwrap().success());
    fs::write(release, b"release").unwrap();
    assert!(
        !fixture.target().exists(),
        "no Node continuation can publish after native exit"
    );
    let mut freeze = Held::freeze(&fixture);
    freeze.release();
    let mut next = fixture.publish(b"fresh version after native exit");
    next["version_id"] = json!("00000000-0000-4000-8000-000000000004");
    assert_eq!(fixture.invoke(next)["ok"], true);
}

#[test]
fn content_over_256_kib_is_rejected_before_any_content_io() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture.invoke(fixture.publish(&vec![b'x'; 256 * 1024 + 1]))["error"]["code"],
        "INVALID_CONTENT"
    );
    assert!(!fixture.0.join("staging").exists());
    assert!(!fixture.0.join("artifacts").exists());
}
