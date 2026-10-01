use std::{fs, io::ErrorKind, path::Path};

const MARKER: &str = "restore-isolation.json";
const ISOLATED: &str = "RESTORE_ISOLATED";
const UNAVAILABLE: &str = "RESTORE_ISOLATION_UNAVAILABLE";

/// This check only inspects directory entries; marker contents never authorize startup.
pub(crate) fn assert_not_restore_isolated(data_root: &Path) -> Result<(), String> {
    if !data_root.is_absolute() {
        return Err(UNAVAILABLE.into());
    }
    // A missing root is valid on first install. An existing non-directory ancestor is not.
    for ancestor in data_root.ancestors() {
        match fs::metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            _ => return Err(UNAVAILABLE.into()),
        }
    }
    match fs::symlink_metadata(data_root.join(MARKER)) {
        Ok(_) => Err(ISOLATED.into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err(UNAVAILABLE.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{ISOLATED, MARKER, UNAVAILABLE, assert_not_restore_isolated};
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    use uuid::Uuid;

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("relay-restore-isolation-{}", Uuid::new_v4()));
            fs::create_dir(&root).expect("create private root");
            Self(root)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            fs::remove_dir_all(&self.0).expect("remove private root");
        }
    }

    fn refused(root: &Path, code: &str) {
        assert_eq!(assert_not_restore_isolated(root), Err(code.to_owned()));
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let command = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system root"))
            .join("System32")
            .join("cmd.exe");
        let output = std::process::Command::new(command)
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("create own native junction");
        assert!(
            output.status.success(),
            "own junction creation must succeed"
        );
    }

    #[test]
    fn absent_marker_allows_existing_or_first_install_root_without_creating_entries() {
        let root = TestRoot::new();
        assert_eq!(assert_not_restore_isolated(&root.0), Ok(()));
        let missing = root.0.join("not-created").join("data");
        assert_eq!(assert_not_restore_isolated(&missing), Ok(()));
        assert!(!missing.exists());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn any_marker_file_bytes_or_directory_refuse_without_creating_launches() {
        let root = TestRoot::new();
        let marker = root.0.join(MARKER);
        for bytes in [
            b"".as_slice(),
            b"not-json",
            &[0xff, 0x00],
            b"{\"isolated\":false}",
        ] {
            fs::write(&marker, bytes).unwrap();
            refused(&root.0, ISOLATED);
            assert_eq!(fs::read(&marker).unwrap(), bytes);
            assert!(!root.0.join("runtime-launches").exists());
            fs::remove_file(&marker).unwrap();
        }
        fs::create_dir(&marker).unwrap();
        fs::write(marker.join("opaque"), "private marker evidence").unwrap();
        refused(&root.0, ISOLATED);
        assert!(!root.0.join("runtime-launches").exists());
    }

    #[test]
    fn invalid_roots_and_actual_metadata_errors_fail_closed() {
        let root = TestRoot::new();
        refused(Path::new(""), UNAVAILABLE);
        refused(Path::new("relative-data"), UNAVAILABLE);
        let file = root.0.join("file");
        fs::write(&file, "existing non-directory").unwrap();
        refused(&file, UNAVAILABLE);
        refused(&file.join("not-created"), UNAVAILABLE);
        let invalid = root.0.join("invalid\0root");
        assert_ne!(
            fs::symlink_metadata(&invalid).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        refused(&invalid, UNAVAILABLE);
        assert_eq!(fs::read(&file).unwrap(), b"existing non-directory");
        assert!(!root.0.join("runtime-launches").exists());
    }

    #[cfg(windows)]
    #[test]
    fn native_marker_links_refuse_including_a_junction_and_supported_dangling_symlink() {
        use std::os::windows::fs::symlink_file;
        let root = TestRoot::new();
        let marker = root.0.join(MARKER);
        match symlink_file(root.0.join("absent-target"), &marker) {
            Ok(()) => {
                refused(&root.0, ISOLATED);
                assert!(
                    fs::symlink_metadata(&marker)
                        .unwrap()
                        .file_type()
                        .is_symlink()
                );
                fs::remove_file(&marker).unwrap();
                println!("NATIVE_DANGLING_SYMLINK=PASSED");
            }
            Err(error) if error.raw_os_error() == Some(1314) => {
                println!("NATIVE_DANGLING_SYMLINK=UNAVAILABLE_PRIVILEGE_1314");
            }
            Err(error) => panic!("native symlink creation failed: {error}"),
        }
        let target = root.0.join("junction-target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("opaque"), "retained target bytes").unwrap();
        junction(&marker, &target);
        refused(&root.0, ISOLATED);
        fs::remove_dir(&marker).unwrap();
        assert_eq!(
            fs::read(target.join("opaque")).unwrap(),
            b"retained target bytes"
        );
        println!("NATIVE_MARKER_JUNCTION=PASSED");
    }

    #[cfg(windows)]
    #[test]
    fn native_root_and_ancestor_junctions_preserve_startup_only_when_marker_absent() {
        let root = TestRoot::new();
        let target = root.0.join("target");
        fs::create_dir(&target).unwrap();
        let alias = root.0.join("root-alias");
        junction(&alias, &target);
        assert_eq!(assert_not_restore_isolated(&alias), Ok(()));
        fs::write(target.join(MARKER), "invalid marker bytes").unwrap();
        refused(&alias, ISOLATED);
        fs::remove_file(target.join(MARKER)).unwrap();
        assert_eq!(assert_not_restore_isolated(&alias), Ok(()));
        let nested_alias = alias.join("new-data");
        assert_eq!(assert_not_restore_isolated(&nested_alias), Ok(()));
        assert!(!target.join("new-data").exists());
        fs::create_dir(target.join("new-data")).unwrap();
        fs::write(target.join("new-data").join(MARKER), "opaque marker").unwrap();
        refused(&nested_alias, ISOLATED);
        fs::remove_file(target.join("new-data").join(MARKER)).unwrap();
        assert_eq!(assert_not_restore_isolated(&nested_alias), Ok(()));
        assert!(!target.join("runtime-launches").exists());
        assert!(!target.join("new-data").join("runtime-launches").exists());
        fs::remove_dir(&alias).unwrap();
        println!("NATIVE_ROOT_AND_ANCESTOR_JUNCTION=PASSED");
    }

    #[cfg(unix)]
    #[test]
    fn native_dangling_marker_symlink_refuses_without_following_its_target() {
        let root = TestRoot::new();
        let marker = root.0.join(MARKER);
        std::os::unix::fs::symlink(root.0.join("absent-target"), &marker).unwrap();
        refused(&root.0, ISOLATED);
        assert!(
            fs::symlink_metadata(&marker)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(windows)]
    fn context(root: &Path) -> crate::SupervisorSpawnContext {
        crate::SupervisorSpawnContext {
            node: root.join("must-not-spawn.exe"),
            supervisor_entry: root.join("must-not-read.js"),
            env_file: "--env-file=must-not-read".into(),
            data_root: root.to_owned(),
            file_io_helper: "must-not-spawn.exe".into(),
            worker_log: root.join("logs").join("must-not-create.log"),
            api_launch_id: Uuid::new_v4().to_string(),
        }
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_refuses_before_recovering_original_armed_bytes() {
        let root = TestRoot::new();
        let records = root.0.join("runtime-launches");
        fs::create_dir(&records).unwrap();
        let record = records.join(format!("{}.json", Uuid::new_v4()));
        let bytes = b"opaque original ARMED bytes\0\xff";
        fs::write(&record, bytes).unwrap();
        fs::write(root.0.join(MARKER), b"invalid marker").unwrap();
        assert_eq!(
            crate::spawn_supervisor(&context(&root.0)).err().as_deref(),
            Some(ISOLATED)
        );
        assert_eq!(fs::read(&record).unwrap(), bytes);
        assert_eq!(fs::read_dir(&records).unwrap().count(), 1);
        assert!(!root.0.join("logs").exists());
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_refuses_before_creating_a_new_runtime_launch_directory() {
        let root = TestRoot::new();
        fs::create_dir(root.0.join(MARKER)).unwrap();
        assert_eq!(
            crate::spawn_supervisor(&context(&root.0)).err().as_deref(),
            Some(ISOLATED)
        );
        assert!(!root.0.join("runtime-launches").exists());
        assert!(!root.0.join("logs").exists());
    }
}
