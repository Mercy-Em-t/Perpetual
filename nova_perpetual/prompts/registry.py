"""
Prompt registry with an integrity lock and an eval release gate.

Rules (the "Friday tweak" defence):
  1. Prompt files are immutable once registered. Their SHA-256 is recorded;
     an in-place edit is detected and the prompt refuses to load.
  2. Changes go into a NEW version file (`cli prompt new`).
  3. A version can only be activated/served once the eval suite has passed
     against that exact hash (`cli evals --stamp`). Editing after stamping
     invalidates the stamp.
"""

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional


class PromptIntegrityError(RuntimeError):
    pass


class EvalGateError(RuntimeError):
    pass


@dataclass
class LoadedPrompt:
    version: str
    sha256: str
    template: str

    def render(self, **values: Any) -> str:
        return self.template.format(**values)


def sha256_file(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest()


class PromptRegistry:
    def __init__(self, prompts_dir: str):
        self.dir = prompts_dir
        self.path = os.path.join(prompts_dir, "registry.json")

    # ---- persistence
    def _read(self) -> Dict[str, Any]:
        if not os.path.exists(self.path):
            return {"active": None, "versions": {}}
        with open(self.path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write(self, data: Dict[str, Any]) -> None:
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")

    # ---- operations
    def register(self, version: str) -> str:
        data = self._read()
        if version in data["versions"]:
            raise PromptIntegrityError(f"{version} is already registered and immutable. Create a new version.")
        file = f"system.{version}.md"
        digest = sha256_file(os.path.join(self.dir, file))
        data["versions"][version] = {"file": file, "sha256": digest, "registered_at": time.time(), "eval": None}
        if not data["active"]:
            data["active"] = version
        self._write(data)
        return digest

    def new_version(self, from_version: Optional[str] = None) -> str:
        data = self._read()
        nums = [int(re.sub(r"\D", "", v) or 0) for v in data["versions"]]
        new = f"v{max(nums or [0]) + 1}"
        src = data["versions"][from_version or data["active"]]["file"]
        with open(os.path.join(self.dir, src), "r", encoding="utf-8") as f:
            content = f.read()
        with open(os.path.join(self.dir, f"system.{new}.md"), "w", encoding="utf-8") as f:
            f.write(content)
        return new  # registered later with register(), after editing

    def stamp_eval(self, version: str, passed: bool, report: Dict[str, Any]) -> None:
        data = self._read()
        entry = data["versions"][version]
        current = sha256_file(os.path.join(self.dir, entry["file"]))
        if current != entry["sha256"]:
            raise PromptIntegrityError(f"{version} was edited after registration; refusing to stamp.")
        entry["eval"] = {"passed": passed, "sha256": current, "at": time.time(),
                         "score": report.get("score"), "total": report.get("total")}
        self._write(data)

    def activate(self, version: str) -> None:
        data = self._read()
        entry = data["versions"].get(version)
        if not entry:
            raise PromptIntegrityError(f"Unknown prompt version {version}")
        ev = entry.get("eval") or {}
        if not (ev.get("passed") and ev.get("sha256") == entry["sha256"]):
            raise EvalGateError(f"{version} has no passing eval stamp for its current content. Run evals first.")
        data["active"] = version
        self._write(data)

    def load(self, version: Optional[str] = None, enforce_gate: bool = True) -> LoadedPrompt:
        data = self._read()
        version = version or data.get("active")
        if not version or version not in data["versions"]:
            raise PromptIntegrityError("No registered prompt version. Run `python -m nova_perpetual.cli prompt register v1`.")
        entry = data["versions"][version]
        path = os.path.join(self.dir, entry["file"])
        digest = sha256_file(path)
        if digest != entry["sha256"]:
            raise PromptIntegrityError(
                f"System prompt {version} was modified in place (hash mismatch). "
                f"Revert it, or create a new version and run the evals.")
        if enforce_gate:
            ev = entry.get("eval") or {}
            if not (ev.get("passed") and ev.get("sha256") == digest):
                raise EvalGateError(f"Prompt {version} has not passed the eval suite; it cannot be served.")
        with open(path, "r", encoding="utf-8") as f:
            return LoadedPrompt(version, digest, f.read())
