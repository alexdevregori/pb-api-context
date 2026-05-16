#!/usr/bin/env python3
"""
Productboard API skill integration test.

For each test case in test_cases.json:
  1. Ask Claude (with the productboard-api skill loaded as system prompt) to write
     a Python function that calls a specific PB API endpoint.
  2. Extract the function from Claude's response.
  3. Execute it against the real sandbox workspace.
  4. Validate the response shape.
  5. Clean up any entities the test created.

Distinguishes between:
  - skill-bug failures (the generated code produced a 4xx, missing fields, wrong shape)
  - infrastructure failures (5xx, network errors, sandbox unreachable)

Only the first kind opens GitHub issues. Infra failures fail the workflow but
don't generate noise.

Environment:
  ANTHROPIC_API_KEY      — required, for code generation
  PB_SANDBOX_TOKEN       — required, for executing against the sandbox
  ANTHROPIC_MODEL        — optional, defaults to claude-opus-4-7
  PB_BASE_URL            — optional, defaults to https://api.productboard.com

Usage:
  python test.py                    # run all cases
  python test.py --case NAME        # run one case for debugging
  python test.py --skip-cleanup     # leave entities behind (debugging only)
"""

import argparse
import json
import os
import re
import sys
import time
import traceback
import uuid
from pathlib import Path

import httpx  # using httpx over requests for better timeout control

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_DIR = REPO_ROOT / "plugins" / "productboard-api" / "skills" / "productboard-api"
REF_DIR = SKILL_DIR / "reference"
RUN_ID = f"{int(time.time())}-{uuid.uuid4().hex[:6]}"
ENTITY_PREFIX = f"[smoke-test-{RUN_ID}]"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
PB_TOKEN = os.environ.get("PB_SANDBOX_TOKEN")
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-4-7")
PB_BASE_URL = os.environ.get("PB_BASE_URL", "https://api.productboard.com")

if not ANTHROPIC_API_KEY:
    print("ANTHROPIC_API_KEY not set", file=sys.stderr)
    sys.exit(2)
if not PB_TOKEN:
    print("PB_SANDBOX_TOKEN not set", file=sys.stderr)
    sys.exit(2)


# ---------- LOAD SKILL ----------

def load_skill_context() -> dict:
    skill_md = (SKILL_DIR / "SKILL.md").read_text()
    # Strip frontmatter
    skill_body = re.sub(r"^---[\s\S]*?---\n", "", skill_md, count=1)
    data_model = (REF_DIR / "DATA_MODEL.md").read_text()
    index_md = (REF_DIR / "INDEX.md").read_text()

    specs = {}
    for f in sorted(REF_DIR.glob("*.yaml")):
        specs[f.name] = f.read_text()

    return {"skill": skill_body, "data_model": data_model, "index": index_md, "specs": specs}


def build_system_prompt(ctx: dict) -> str:
    spec_listing = "\n".join(f"### {name}\n\n```yaml\n{text[:30000]}\n```" for name, text in ctx["specs"].items())
    return f"""You are operating with the productboard-api skill loaded. Follow the skill instructions exactly.

When asked to write a Python function, return ONLY the function (and any required imports at the top). No example usage, no main block, no explanation outside docstrings.

---SKILL.md---
{ctx["skill"]}

---reference/INDEX.md---
{ctx["index"]}

---reference/DATA_MODEL.md---
{ctx["data_model"]}

---spec file contents---

{spec_listing}
"""


# ---------- CALL CLAUDE ----------

def ask_claude(system_prompt: str, user_prompt: str) -> str:
    with httpx.Client(timeout=120) as client:
        res = client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 4096,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_prompt}],
            },
        )
    if res.status_code != 200:
        raise InfraError(f"Anthropic API call failed: {res.status_code} {res.text[:500]}")
    body = res.json()
    return "".join(block.get("text", "") for block in body.get("content", []))


# ---------- EXTRACT CODE ----------

def extract_python_code(response: str) -> str:
    """Pull the first Python code block out of Claude's response."""
    match = re.search(r"```python\n([\s\S]*?)```", response)
    if match:
        return match.group(1)
    # Fallback: any code block
    match = re.search(r"```\w*\n([\s\S]*?)```", response)
    if match:
        return match.group(1)
    # Last resort: assume the whole response is code
    return response


# ---------- EXECUTE ----------

class SkillBugError(Exception):
    """Generated code is broken or produced a 4xx from the API."""


class InfraError(Exception):
    """Test infrastructure failed (5xx, network, sandbox down). Not a skill bug."""


def execute_generated_function(code: str, func_name: str, args: list):
    """Execute the generated code in a sandboxed namespace, return the named function's result."""
    namespace = {}
    try:
        exec(code, namespace)
    except SyntaxError as e:
        raise SkillBugError(f"generated code has syntax error: {e}")
    except Exception as e:
        raise SkillBugError(f"generated code failed to import/define: {e}")

    if func_name not in namespace:
        raise SkillBugError(f"expected function '{func_name}' not defined in generated code")

    fn = namespace[func_name]

    # Resolve template args
    resolved_args = []
    for a in args:
        if a == "{{TOKEN}}":
            resolved_args.append(PB_TOKEN)
        elif a == "{{ENTITY_PREFIX}}":
            resolved_args.append(ENTITY_PREFIX)
        elif isinstance(a, str) and a.startswith("{{") and a.endswith("}}"):
            raise SkillBugError(f"unresolved template placeholder: {a}")
        else:
            resolved_args.append(a)

    try:
        return fn(*resolved_args)
    except httpx.HTTPError as e:
        raise InfraError(f"HTTP infrastructure error: {e}")
    except Exception as e:
        # Distinguish: did the generated code itself fail, or did the API reject it?
        msg = str(e)
        if any(token in msg for token in ["400", "401", "403", "404", "409", "422"]):
            raise SkillBugError(f"API rejected the generated request ({msg})")
        if any(token in msg for token in ["500", "502", "503", "504", "timeout"]):
            raise InfraError(f"API infrastructure error: {msg}")
        raise SkillBugError(f"generated code raised {type(e).__name__}: {e}")


# ---------- VALIDATE ----------

def validate(result, exec_spec: dict):
    if exec_spec.get("expect_dict_with_keys"):
        if not isinstance(result, dict):
            raise SkillBugError(f"expected dict response, got {type(result).__name__}")
        for k in exec_spec["expect_dict_with_keys"]:
            if k not in result:
                raise SkillBugError(f"expected key '{k}' not in response. Got: {list(result.keys())}")

    if exec_spec.get("expect_string_uuid"):
        # Either a bare UUID string, or a dict with an id we can dig out
        candidate = result
        if isinstance(result, dict):
            candidate = result.get("id") or result.get("data", {}).get("id") if isinstance(result.get("data"), dict) else None
        if not isinstance(candidate, str):
            raise SkillBugError(f"expected UUID string, got {type(result).__name__}: {result!r}")
        if not re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", candidate):
            raise SkillBugError(f"expected UUID format, got: {candidate}")
        return candidate

    return result


# ---------- CLEANUP ----------

def cleanup_one(cleanup_spec: dict, stored: dict):
    """Run a cleanup HTTP call. Failures here are logged but don't fail the test."""
    method = cleanup_spec["method"]
    path = cleanup_spec["path"]
    for k, v in stored.items():
        path = path.replace(f"{{{{{k}}}}}", str(v))
    try:
        with httpx.Client(timeout=30) as client:
            res = client.request(
                method,
                f"{PB_BASE_URL}{path}",
                headers={"Authorization": f"Bearer {PB_TOKEN}", "X-Version": "1"},
            )
            if res.status_code >= 400:
                print(f"  cleanup warning: {method} {path} returned {res.status_code}")
            else:
                print(f"  cleanup ok: {method} {path}")
    except Exception as e:
        print(f"  cleanup failed: {e}")


def sweep_orphans():
    """Best-effort: try to find and delete any test entities from prior failed runs."""
    # Notes are the main thing we create. If a previous run failed mid-test,
    # there might be orphan notes with our prefix pattern. The prefix changes per
    # run (RUN_ID), but the [smoke-test- string is stable.
    try:
        with httpx.Client(timeout=30) as client:
            # List recent notes and look for any whose name starts with [smoke-test-
            res = client.get(
                f"{PB_BASE_URL}/v2/notes",
                headers={"Authorization": f"Bearer {PB_TOKEN}", "X-Version": "1"},
                params={"pageLimit": 100},
            )
            if res.status_code != 200:
                return
            notes = res.json().get("data", [])
            orphans = [n for n in notes if isinstance(n.get("fields", {}).get("name"), str) and n["fields"]["name"].startswith("[smoke-test-")]
            if orphans:
                print(f"  found {len(orphans)} orphan test notes from prior runs, cleaning up...")
                for n in orphans:
                    client.delete(
                        f"{PB_BASE_URL}/v2/notes/{n['id']}",
                        headers={"Authorization": f"Bearer {PB_TOKEN}", "X-Version": "1"},
                    )
    except Exception as e:
        print(f"  orphan sweep failed: {e}")


# ---------- RUN ----------

def run_case(case: dict, ctx: dict, skip_cleanup: bool = False) -> dict:
    result = {
        "name": case["name"],
        "prompt": case["prompt"],
        "passed": False,
        "category": None,  # "skill-bug" | "infra" | "pass"
        "error": None,
        "generated_code": None,
        "api_response": None,
    }

    system_prompt = build_system_prompt(ctx)

    try:
        response = ask_claude(system_prompt, case["prompt"])
        code = extract_python_code(response)
        result["generated_code"] = code

        api_result = execute_generated_function(code, case["execution"]["function_name"], case["execution"]["args"])
        result["api_response"] = _safe_excerpt(api_result)

        validated = validate(api_result, case["execution"])

        # Store result for cleanup if requested
        stored = {}
        if case["execution"].get("store_result_as"):
            stored[case["execution"]["store_result_as"]] = validated if not isinstance(api_result, dict) else (api_result.get("id") or api_result.get("data", {}).get("id"))

        # Cleanup
        if case.get("creates_entities") and case.get("cleanup") and not skip_cleanup:
            cleanup_one(case["cleanup"], stored)

        result["passed"] = True
        result["category"] = "pass"
        return result

    except InfraError as e:
        result["category"] = "infra"
        result["error"] = str(e)
        return result
    except SkillBugError as e:
        result["category"] = "skill-bug"
        result["error"] = str(e)
        return result
    except Exception as e:
        # Unknown — treat as skill-bug to be safe (better false positive than missed bug)
        result["category"] = "skill-bug"
        result["error"] = f"unexpected error: {type(e).__name__}: {e}\n{traceback.format_exc()}"
        return result


def _safe_excerpt(obj, limit: int = 500) -> str:
    try:
        s = json.dumps(obj, default=str)
    except Exception:
        s = str(obj)
    return s[:limit] + ("..." if len(s) > limit else "")


def render_report(results: list[dict]) -> str:
    lines = ["# Productboard API Integration Test", f"Run: {RUN_ID}", f"Model: {MODEL}", ""]

    passed = [r for r in results if r["category"] == "pass"]
    skill_bugs = [r for r in results if r["category"] == "skill-bug"]
    infra = [r for r in results if r["category"] == "infra"]

    lines.append(f"**{len(passed)}/{len(results)} cases passed.**")
    if skill_bugs:
        lines.append(f"- {len(skill_bugs)} skill bugs (generated code is broken)")
    if infra:
        lines.append(f"- {len(infra)} infrastructure failures (not skill problems)")
    lines.append("")

    if skill_bugs:
        lines.append(f"## Skill bugs ({len(skill_bugs)})")
        lines.append("")
        for r in skill_bugs:
            lines.append(f"### `{r['name']}`")
            lines.append(f"**Prompt:** {r['prompt']}")
            lines.append("")
            lines.append(f"**Error:** {r['error']}")
            lines.append("")
            if r.get("generated_code"):
                lines.append("**Generated code:**")
                lines.append("```python")
                lines.append(r["generated_code"][:2000])
                lines.append("```")
                lines.append("")
            if r.get("api_response"):
                lines.append(f"**API response (excerpt):** `{r['api_response']}`")
                lines.append("")

    if infra:
        lines.append(f"## Infrastructure failures ({len(infra)})")
        lines.append("These don't indicate a skill problem — usually transient.")
        lines.append("")
        for r in infra:
            lines.append(f"- `{r['name']}`: {r['error']}")
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", help="Run a single case by name")
    parser.add_argument("--skip-cleanup", action="store_true", help="Leave test entities behind (debugging only)")
    args = parser.parse_args()

    print(f"Run ID: {RUN_ID}")
    print(f"Entity prefix: {ENTITY_PREFIX}")
    print("Sweeping orphan entities from prior runs...")
    sweep_orphans()

    print(f"Loading skill context from {SKILL_DIR}...")
    ctx = load_skill_context()
    print(f"Loaded {len(ctx['specs'])} spec files.")

    cases = json.loads((Path(__file__).parent / "test_cases.json").read_text())
    if args.case:
        cases = [c for c in cases if c["name"] == args.case]
        if not cases:
            print(f"No case named '{args.case}'", file=sys.stderr)
            sys.exit(2)

    print(f"Running {len(cases)} case(s) against {PB_BASE_URL}...\n")

    results = []
    for c in cases:
        print(f"  {c['name']}...", end=" ", flush=True)
        r = run_case(c, ctx, skip_cleanup=args.skip_cleanup)
        results.append(r)
        if r["category"] == "pass":
            print("PASS")
        elif r["category"] == "infra":
            print(f"INFRA ({r['error'][:60]})")
        else:
            print(f"SKILL BUG ({r['error'][:60]})")

    report = render_report(results)
    (Path(__file__).parent / "report.md").write_text(report)
    print(f"\nReport: {Path(__file__).parent / 'report.md'}")

    skill_bugs = sum(1 for r in results if r["category"] == "skill-bug")
    infra_failures = sum(1 for r in results if r["category"] == "infra")

    # Exit codes: 0=all pass, 1=skill bug, 2=infra only
    if skill_bugs > 0:
        sys.exit(1)
    if infra_failures > 0:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
