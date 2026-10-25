"""Read-only developer Skill inventory; explicit --link / --write-baseline mutate only named targets."""
import argparse
import ast
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import warnings

try:
    import yaml
except ImportError:
    sys.exit("Requires Python 3.12+ and PyYAML (python -m pip install PyYAML).")

CONFIG = Path(__file__).with_name("dev-skills.config.json")
SKIP = {".git", "node_modules", "__pycache__", ".pytest_cache", ".venv", "venv", "site-packages",
        ".in_use", ".orphaned_at", ".downloaded_at"}


def expand(value, project, home):
    return Path(os.path.expandvars(value.replace("${HOME}", str(home)).replace("${PROJECT}", str(project))))


def linked(path):
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def digest_tree(root):
    """Include paths and bytes, follow internal links but reject loops and broken links."""
    files, problems = {}, []

    def visit(path, relative, ancestors):
        try:
            real = path.resolve(strict=True)
            if path.is_dir():
                if real in ancestors:
                    problems.append(f"link-cycle:{relative}")
                    return
                for child in sorted(path.iterdir()):
                    if child.name not in SKIP:
                        visit(child, relative / child.name, ancestors | {real})
            elif path.is_file():
                with path.open("rb") as stream:
                    files[relative.as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
            else:
                problems.append(f"unreadable:{relative}")
        except (OSError, RuntimeError) as error:
            problems.append(f"unreadable:{relative}:{type(error).__name__}")

    visit(root, Path(), set())
    digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    return digest, files, problems


def inspect_skill(path, required_resources=()):
    result = {"path": str(path), "realPath": str(path.resolve()), "directory": path.name,
              "id": None, "errors": [], "warnings": [], "dependencies": [], "sources": []}
    result["sha256"], result["files"], problems = digest_tree(path)
    result["errors"].extend(problems)
    try:
        raw = (path / "SKILL.md").read_bytes()
        if raw.startswith(b"\xef\xbb\xbf"):
            result["errors"].append("utf8-bom-native-discovery-incompatible")
        text = raw.decode("utf-8-sig")
        match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)(.*)", text, re.S)
        if not match:
            raise ValueError("missing-frontmatter")
        metadata = yaml.safe_load(match[1])
        if not isinstance(metadata, dict):
            raise ValueError("frontmatter-not-mapping")
        for key in ("name", "description"):
            if not isinstance(metadata.get(key), str) or not metadata[key].strip():
                result["errors"].append(f"invalid-{key}")
        result["id"] = metadata.get("name")
        result["description"] = metadata.get("description")
        nested_metadata = metadata.get("metadata")
        result["version"] = metadata.get("version", nested_metadata.get("version", "unknown") if isinstance(nested_metadata, dict) else "unknown")
        if not match[2].strip():
            result["errors"].append("empty-instructions")
        if isinstance(result["id"], str) and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", result["id"]):
            result["warnings"].append("nonportable-id")
        if result["id"] != path.name:
            result["warnings"].append("directory-id-alias")
        # Fenced examples are not mandatory installed resources.
        body = re.sub(r"^```.*?^```[^\n]*", "", match[2], flags=re.M | re.S)
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", body):
            target = target.strip().split(' "')[0].strip("<>").split("#")[0]
            if not target or re.match(r"[a-z][a-z0-9+.-]*:", target, re.I):
                continue
            from urllib.parse import unquote
            target = unquote(target)
            if any(c in target for c in "{}*<>$"):
                result["warnings"].append(f"template-link:{target}")
            elif not (path / target).exists():
                # Bare renderer/URL/output labels are placeholders, not bundled files.
                bucket = "errors" if Path(target).suffix or target.startswith(("scripts/", "references/", "assets/")) else "warnings"
                result[bucket].append(f"missing-link:{target}" if bucket == "errors" else f"review-link:{target}")
        for target in sorted(set(re.findall(r"`((?:scripts|references|assets|templates|resources)/[^`\n]+)`", body))):
            if any(c in target for c in "{}*<>$ "):
                continue
            if not (path / target).exists():
                result["warnings"].append(f"review-resource:{target}")
        result["sources"] = sorted(set(re.findall(r"https://github\.com/[\w.-]+/[\w.-]+", text)))
        for filename in result["files"]:
            if Path(filename).name in {"requirements.txt", "pyproject.toml", "package.json"}:
                result["dependencies"].append({"manifest": filename, "status": "not-executed"})
            if filename.endswith(".py"):
                try:
                    code = (path / filename).read_text(encoding="utf-8-sig")
                    with warnings.catch_warnings(record=True) as notices:
                        warnings.simplefilter("always", SyntaxWarning)
                        ast.parse(code, filename=filename)
                    if notices:
                        result["warnings"].append(f"python-syntax-warning:{filename}")
                except (SyntaxError, UnicodeError) as error:
                    result["warnings"].append(f"python-syntax-review:{filename}:{type(error).__name__}")
        if any(name.endswith(".sh") for name in result["files"]):
            result["warnings"].append("requires-posix-shell-review")
    except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
        result["errors"].append(f"manifest:{type(error).__name__}:{error}")
    for resource in required_resources:
        if not (path / resource).exists():
            result["errors"].append(f"missing-required-resource:{resource}")
    result["status"] = "broken" if result["errors"] else "structural-pass"
    return result


def scan_root(root, cache=None):
    found, issues = [], []
    cache = {} if cache is None else cache
    if not root.exists():
        return [], [{"path": str(root), "problem": "broken-root-link" if linked(root) else "root-absent"}]

    def visit(path, ancestors, depth):
        try:
            real = path.resolve(strict=True)
            if real in ancestors:
                issues.append({"path": str(path), "problem": "directory-cycle"})
                return
            if (path / "SKILL.md").is_file():
                key = str(real).casefold()
                if key not in cache:
                    cache[key] = inspect_skill(path)
                skill = copy.deepcopy(cache[key])
                skill["path"] = str(path)
                skill["directory"] = path.name
                found.append(skill)
                return
            if depth > 14:
                issues.append({"path": str(path), "problem": "depth-limit"})
                return
            for child in sorted(path.iterdir()):
                if child.name in SKIP:
                    continue
                if linked(child) and not child.exists():
                    issues.append({"path": str(child), "problem": "broken-link"})
                elif child.is_dir():
                    before = len(found)
                    visit(child, ancestors | {real}, depth + 1)
                    if depth == 0 and len(found) == before and not child.name.startswith("."):
                        issues.append({"path": str(child), "problem": "no-skill-manifest"})
        except (OSError, RuntimeError) as error:
            issues.append({"path": str(path), "problem": type(error).__name__})

    visit(root, set(), 0)
    return found, issues


def inventory(config, project, home, verbose=False):
    entries, roots = [], []
    cache = {}
    for spec in config["scanRoots"]:
        root = expand(spec["path"], project, home)
        if verbose:
            print(f"Scanning {spec['scope']}: {root}", file=sys.stderr, flush=True)
        skills, issues = scan_root(root, cache)
        roots.append({"path": str(root), "scope": spec["scope"], "issues": issues})
        for skill in skills:
            skill["scope"] = spec["scope"]
            for resource in config.get("requiredResources", {}).get(skill["directory"], []):
                if not (Path(skill["path"]) / resource).exists():
                    skill["errors"].append(f"missing-required-resource:{resource}")
                    skill["status"] = "broken"
            # A pinned public copy is not the provenance of a different plugin's same-named Skill.
            skill["upstream"] = config.get("provenance", {}).get(skill["directory"], {"status": "unverified"}) if root == expand(config["shared"], project, home) or Path(skill["realPath"]).parent == expand(config["shared"], project, home) else {"status": "unverified"}
            expected = skill["upstream"].get("installedHash")
            if expected and expected != skill["sha256"]:
                skill["errors"].append("pinned-copy-drift")
                skill["status"] = "broken"
        entries.extend(skills)
    # A linked Skill appearing at multiple entries remains one physical installation.
    physical = {s["realPath"].casefold(): s for s in entries}
    groups = {}
    for skill in physical.values():
        groups.setdefault(str(skill["id"]), []).append(skill)
    duplicates = [{"id": key, "paths": [s["path"] for s in values],
                   "divergent": len({s["sha256"] for s in values}) > 1}
                  for key, values in groups.items() if len(values) > 1]
    shared = expand(config["shared"], project, home)
    shared_skills = {s["directory"]: s for s in entries if Path(s["path"]).parent == shared}
    agents = []
    for agent in config["agents"]:
        targets = [expand(p, project, home) for p in agent["entries"]]
        visible = [s for s in entries if Path(s["path"]).parent in targets]
        id_hashes = {}
        for skill in visible:
            id_hashes.setdefault(str(skill["id"]), set()).add(skill["sha256"])
            skill.setdefault("readableAgents", []).append(agent["name"])
        id_conflicts = sorted(key for key, hashes in id_hashes.items() if len(hashes) > 1)
        available, conflicts = [], []
        for name, source in shared_skills.items():
            matches = [p / name for p in targets if (p / name / "SKILL.md").is_file()]
            if matches:
                hashes = [cache[str(p.resolve()).casefold()]["sha256"] if str(p.resolve()).casefold() in cache else digest_tree(p)[0] for p in matches]
                if any(digest != source["sha256"] for digest in hashes):
                    conflicts.append(name)
                else:
                    available.append(name)
        agents.append({"name": agent["name"], "entries": [str(p) for p in targets],
                       "readableShared": len(available), "sharedTotal": len(shared_skills),
                       "structurallyValidShared": sum(shared_skills[name]["status"] == "structural-pass" for name in available),
                       "conflicts": conflicts, "idConflicts": id_conflicts,
                       "discovery": agent["discovery"], "smoke": agent["smoke"]})
    by_real_path = {}
    for skill in entries:
        by_real_path.setdefault(skill["realPath"], set()).update(skill.get("readableAgents", []))
    for skill in entries:
        skill["readableAgents"] = sorted(by_real_path[skill["realPath"]])
    return {"summary": {"entryCount": len(entries), "physicalCount": len(physical),
                        "structuralPass": sum(s["status"] == "structural-pass" for s in physical.values()),
                        "broken": sum(s["status"] == "broken" for s in physical.values()),
                        "dependencyManifestsUnexecuted": sum(len(s["dependencies"]) for s in physical.values())},
            "roots": roots, "skills": entries, "duplicates": duplicates, "agents": agents}


def link_shared(config, project, home, dry_run):
    shared = expand(config["shared"], project, home)
    plan = []
    sources = [p for p in sorted(shared.iterdir()) if (p / "SKILL.md").is_file()]
    source_errors = {p.name: inspect_skill(p, config.get("requiredResources", {}).get(p.name, []))["errors"] for p in sources}
    # Preflight the complete plan before changing anything. Never overwrite a divergent installation.
    for entry in config["linkTargets"]:
        root = expand(entry, project, home)
        for source in sources:
            target = root / source.name
            if target == source:
                continue
            if source_errors[source.name]:
                plan.append({"target": str(target), "source": str(source), "action": "blocked-source", "errors": source_errors[source.name]})
                continue
            if target.exists() or linked(target):
                same = target.exists() and digest_tree(target)[0] == digest_tree(source)[0]
                plan.append({"target": str(target), "source": str(source), "action": "keep" if same else "conflict"})
            else:
                plan.append({"target": str(target), "source": str(source), "action": "link"})
    if not dry_run:
        commands = []
        for item in plan:
            if item["action"] != "link":
                continue
            source, target = Path(item["source"]), Path(item["target"])
            target.parent.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                # Quote PowerShell literals; batch startup cost, never delete or replace anything.
                quote = lambda value: "'" + str(value).replace("'", "''") + "'"
                commands.append(f"New-Item -ItemType Junction -Path {quote(target)} -Target {quote(source)} -ErrorAction Stop | Out-Null")
            else:
                target.symlink_to(source, target_is_directory=True)
        for start in range(0, len(commands), 20):
            script = "$ErrorActionPreference='Stop'\n" + "\n".join(commands[start:start + 20])
            encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
            subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                           check=True, capture_output=True)
    return plan


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--link", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8-sig"))
    if args.link:
        plan = link_shared(config, args.project, args.home, args.dry_run)
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return int(any(p["action"] in {"conflict", "blocked-source"} for p in plan))
    result = inventory(config, args.project, args.home, args.verbose)
    baseline = args.baseline or args.home / ".agents/skill-audit/baseline.json"
    hashes = {s["path"]: s["sha256"] for s in result["skills"]}
    result["baseline"] = {"path": str(baseline), "status": "absent", "drift": []}
    if baseline.exists():
        previous = json.loads(baseline.read_text(encoding="utf-8"))
        result["baseline"]["status"] = "compared"
        result["baseline"]["drift"] = [p for p in sorted(set(previous) | set(hashes)) if previous.get(p) != hashes.get(p)]
    if args.write_baseline and not args.dry_run:
        baseline.parent.mkdir(parents=True, exist_ok=True)
        baseline.write_text(json.dumps(hashes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        result["baseline"]["status"] = "written"
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result["summary"], ensure_ascii=False))
        for agent in result["agents"]:
            print(f"{agent['name']}: readable={agent['readableShared']}/{agent['sharedTotal']}; structural={agent['structurallyValidShared']}; conflicts={len(agent['conflicts'])}; idConflicts={len(agent['idConflicts'])}; smoke={agent['smoke']}")
        print(f"Baseline: {result['baseline']['status']}; drift={len(result['baseline']['drift'])}")
        print("Structural checks do not establish dependencies, upstream trust, discovery or invocation.")
    broken_links = any(i["problem"] in {"broken-link", "broken-root-link", "directory-cycle"} for r in result["roots"] for i in r["issues"])
    return int(result["summary"]["broken"] > 0 or broken_links or bool(result["baseline"]["drift"]))


if __name__ == "__main__":
    sys.exit(main())
