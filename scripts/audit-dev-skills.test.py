import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

SPEC = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit-dev-skills.py"))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class SkillAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="技能 audit ' ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def skill(self, path, body="Read [guide](references/guide.md).", name="example"):
        path.mkdir(parents=True)
        (path / "SKILL.md").write_text(f"---\nname: {name}\ndescription: Test a bounded workflow.\n---\n{body}\n", encoding="utf-8")
        (path / "references").mkdir()
        (path / "references/guide.md").write_text("Guide", encoding="utf-8")
        return path

    def config(self):
        return {"shared": "${HOME}/shared", "scanRoots": [{"path": "${HOME}/shared", "scope": "shared"},
                 {"path": "${HOME}/target", "scope": "user-test"}],
                "agents": [{"name": "Test", "entries": ["${HOME}/target"], "discovery": "unverified", "smoke": "未实测"}],
                "linkTargets": ["${HOME}/target"], "provenance": {}}

    def test_missing_resource_is_failure_and_example_is_not_resource(self):
        p = self.skill(self.root / "example", "[missing](references/gone.md)\n```md\n[example](made-up.md)\n```\n[website](https://example.com)")
        result = audit.inspect_skill(p)
        self.assertEqual(result["errors"], ["missing-link:references/gone.md"])

    def test_empty_and_invalid_frontmatter(self):
        p = self.skill(self.root / "example")
        (p / "SKILL.md").write_text("", encoding="utf-8")
        self.assertEqual(audit.inspect_skill(p)["status"], "broken")
        (p / "SKILL.md").write_text("---\nname: example\ndescription: bad: scalar\n---\nBody", encoding="utf-8")
        self.assertIn("ScannerError", audit.inspect_skill(p)["errors"][0])

    def test_bom_that_native_codex_rejects_is_detected(self):
        p = self.skill(self.root / "example")
        manifest = p / "SKILL.md"
        manifest.write_bytes(b"\xef\xbb\xbf" + manifest.read_bytes())
        self.assertIn("utf8-bom-native-discovery-incompatible", audit.inspect_skill(p)["errors"])

    def test_pinned_source_drift_is_not_structural_pass(self):
        p = self.skill(self.root / "shared/example")
        config = self.config()
        config["provenance"]["example"] = {"installedHash": audit.digest_tree(p)[0]}
        (p / "references/guide.md").write_text("changed", encoding="utf-8")
        result = audit.inventory(config, self.root, self.root)
        self.assertIn("pinned-copy-drift", result["skills"][0]["errors"])
        self.assertEqual(result["summary"]["broken"], 1)

    def test_spaces_unicode_and_urlencoded_relative_link(self):
        p = self.skill(self.root / "例 子", "[guide](references/space%20name.md)")
        (p / "references/space name.md").write_text("Guide", encoding="utf-8")
        self.assertEqual(audit.inspect_skill(p)["errors"], [])

    def test_hash_detects_resource_changes_and_renames(self):
        p = self.skill(self.root / "example")
        first = audit.digest_tree(p)[0]
        (p / "references/guide.md").write_text("Changed", encoding="utf-8")
        second = audit.digest_tree(p)[0]
        self.assertNotEqual(first, second)
        (p / "references/guide.md").rename(p / "references/new.md")
        self.assertNotEqual(second, audit.digest_tree(p)[0])

    def test_readonly_inventory_and_divergent_duplicate(self):
        a = self.skill(self.root / "shared/example")
        self.skill(self.root / "target/example", "Different behavior")
        before = audit.digest_tree(self.root)
        result = audit.inventory(self.config(), self.root, self.root)
        self.assertEqual(before, audit.digest_tree(self.root))
        self.assertTrue(result["duplicates"][0]["divergent"])
        self.assertEqual(result["agents"][0]["conflicts"], [a.name])
        self.assertEqual(result["agents"][0]["smoke"], "未实测")

    def test_dry_run_and_real_junction_are_idempotent(self):
        source = self.skill(self.root / "shared/example")
        config = self.config()
        self.assertEqual(audit.link_shared(config, self.root, self.root, True)[0]["action"], "link")
        self.assertFalse((self.root / "target").exists())
        audit.link_shared(config, self.root, self.root, False)
        target = self.root / "target/example"
        self.assertTrue(audit.linked(target))
        self.assertEqual(target.resolve(), source.resolve())
        self.assertEqual(audit.link_shared(config, self.root, self.root, False)[0]["action"], "keep")
        self.assertEqual(audit.inventory(config, self.root, self.root)["summary"]["physicalCount"], 1)

    def test_conflict_does_not_overwrite_or_follow_to_mutate(self):
        self.skill(self.root / "shared/example")
        target = self.skill(self.root / "target/example", "Keep custom edits")
        before = audit.digest_tree(target)
        self.assertEqual(audit.link_shared(self.config(), self.root, self.root, False)[0]["action"], "conflict")
        self.assertEqual(before, audit.digest_tree(target))

    def test_incomplete_shared_source_is_not_mapped(self):
        self.skill(self.root / "shared/example", "[missing](references/not-installed.md)")
        plan = audit.link_shared(self.config(), self.root, self.root, False)
        self.assertEqual(plan[0]["action"], "blocked-source")
        self.assertFalse((self.root / "target/example").exists())

    def test_confirmed_inline_resources_are_required(self):
        p = self.skill(self.root / "shared/example", "Read `references/required.md`.")
        config = self.config()
        config["requiredResources"] = {"example": ["references/required.md"]}
        self.assertEqual(audit.link_shared(config, self.root, self.root, True)[0]["action"], "blocked-source")
        self.assertEqual(audit.inventory(config, self.root, self.root)["summary"]["broken"], 1)

    def test_same_id_in_different_directory_is_a_conflict(self):
        self.skill(self.root / "shared/example")
        self.skill(self.root / "target/example")
        self.skill(self.root / "target/other-directory", "Different instructions", name="example")
        result = audit.inventory(self.config(), self.root, self.root)
        self.assertEqual(result["agents"][0]["idConflicts"], ["example"])

    def test_broken_link_is_reported(self):
        source = self.skill(self.root / "shared/example")
        audit.link_shared(self.config(), self.root, self.root, False)
        source.rename(self.root / "shared/renamed")
        _, issues = audit.scan_root(self.root / "target")
        self.assertIn("broken-link", [i["problem"] for i in issues])

    def test_cli_readonly_then_explicit_baseline_and_drift(self):
        source = self.skill(self.root / "shared/example")
        config = self.root / "config.json"
        config.write_text(json.dumps(self.config()), encoding="utf-8")
        baseline = self.root / "baseline.json"
        cmd = [sys.executable, str(Path(audit.__file__)), "--config", str(config), "--home", str(self.root),
               "--baseline", str(baseline), "--json"]
        result = subprocess.run(cmd, capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(baseline.exists())
        subprocess.run(cmd + ["--write-baseline"], check=True, capture_output=True)
        (source / "references/guide.md").write_text("Drift", encoding="utf-8")
        result = subprocess.run(cmd, capture_output=True, encoding="utf-8")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["baseline"]["drift"], [str(source)])


if __name__ == "__main__":
    unittest.main()
