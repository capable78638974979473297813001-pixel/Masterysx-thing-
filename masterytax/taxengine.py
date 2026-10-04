"""Bridge to the vendored TypeScript tax engine in ../engine.

The engine (federal + all 50 states + DC + local taxes, effective-dated and
sourced) is the single source of tax math. This module runs it through
engine/bridge.ts and reads its rate files for the few figures the filing
layer needs directly (941/940 rates, FUTA credit reductions, wage bases).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from .money import D

ENGINE_DIR = Path(os.environ.get("MASTERYTAX_ENGINE", Path(__file__).resolve().parent.parent / "engine"))
MIN_NODE = (22, 6)
UNFLAGGED_TYPES = (22, 18)  # node runs .ts without a flag from 22.18


class EngineUnavailable(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _node_command() -> tuple[str, ...]:
    node = shutil.which(os.environ.get("MASTERYTAX_NODE", "node"))
    if not node:
        raise EngineUnavailable("Node.js 22.6+ is required to run the tax engine (node not found on PATH)")
    out = subprocess.run([node, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    version = tuple(int(x) for x in re.findall(r"\d+", out)[:2])
    if version < MIN_NODE:
        raise EngineUnavailable(f"Node.js {'.'.join(map(str, MIN_NODE))}+ is required, found {out}")
    flags = ["--no-warnings"]
    if version < UNFLAGGED_TYPES:
        flags.append("--experimental-strip-types")
    return (node, *flags)


def run_paychecks(paychecks: list[dict]) -> dict[str, dict]:
    """Run a batch through the engine; returns {key: result-or-error}."""
    if not paychecks:
        return {}
    bridge = ENGINE_DIR / "bridge.ts"
    if not bridge.exists():
        raise EngineUnavailable(f"tax engine not found at {ENGINE_DIR}")
    proc = subprocess.run([*_node_command(), str(bridge)], input=json.dumps({"paychecks": paychecks}),
                          capture_output=True, text=True, cwd=ENGINE_DIR)
    if proc.returncode != 0:
        raise EngineUnavailable(f"tax engine failed: {proc.stderr.strip()[:2000]}")
    return {r["key"]: r for r in json.loads(proc.stdout)["results"]}


def locate(requests: list[dict], timeout: int = 300) -> dict[str, dict]:
    """Address -> certificate fields through engine/locate.ts (needs network to Census/TIGERweb)."""
    if not requests:
        return {}
    proc = subprocess.run([*_node_command(), str(ENGINE_DIR / "locate.ts")],
                          input=json.dumps({"employees": requests}), capture_output=True, text=True,
                          cwd=ENGINE_DIR, timeout=timeout)
    if proc.returncode != 0:
        raise EngineUnavailable(f"tax locator failed: {proc.stderr.strip()[:2000]}")
    return {r["key"]: r for r in json.loads(proc.stdout)["results"]}


# ------------------------------------------------------------ rate data ---

@lru_cache(maxsize=None)
def federal(year: int) -> dict:
    path = ENGINE_DIR / "data" / "federal" / f"{year}.json"
    if not path.exists():
        raise LookupError(f"no federal ruleset for {year}")
    return json.loads(path.read_text())


@lru_cache(maxsize=None)
def state(code: str, year: int) -> dict | None:
    path = ENGINE_DIR / "data" / "states" / f"{code}-{year}.json"
    return json.loads(path.read_text()) if path.exists() else None


def state_name(code: str) -> str:
    for year in (2026, 2025):
        s = state(code, year)
        if s:
            return s.get("name", code)
    return code


def covered_years() -> list[int]:
    return sorted(int(p.stem) for p in (ENGINE_DIR / "data" / "federal").glob("*.json"))


def covered_states(year: int) -> list[str]:
    return sorted(p.stem.split("-")[0] for p in (ENGINE_DIR / "data" / "states").glob(f"*-{year}.json"))


def local_registries(year: int) -> list[str]:
    return sorted(p.stem.rsplit("-", 1)[0] for p in (ENGINE_DIR / "data" / "local").glob(f"*-{year}.json"))


def fica_rates(year: int) -> dict:
    f = federal(year)
    return {
        "ss": D(str(f["socialSecurity"]["employeeRate"])) + D(str(f["socialSecurity"]["employerRate"])),
        "ss_ee": D(str(f["socialSecurity"]["employeeRate"])),
        "ss_base": D(str(f["socialSecurity"]["wageBase"])),
        "med": D(str(f["medicare"]["employeeRate"])) + D(str(f["medicare"]["employerRate"])),
        "addl": D(str(f["medicare"]["additional"]["rate"])),
    }


def futa_rates(year: int) -> dict:
    f = federal(year)["futa"]
    return {
        "net": D(str(f["netRate"])),
        "base": D(str(f["wageBase"])),
        "credit_reductions": {st: D(str(r)) for st, r in f.get("creditReduction", {}).get("states", {}).items()},
        "determination_date": f.get("creditReduction", {}).get("determinationDate"),
    }


def sui_new_employer_rate(code: str, year: int):
    s = state(code, year) or {}
    rate = (s.get("suiEmployer") or {}).get("newEmployerRate")
    return D(str(rate)) if rate is not None else None


def exempt_pretax(code: str, year: int) -> list[str]:
    """Pre-tax categories excluded from the state's income-tax wages (W-2 box 16)."""
    s = state(code, year) or {}
    return list(s.get("exemptPretax", []))


def federal_exempt(year: int, kind: str) -> list[str]:
    f = federal(year)
    block = {"fit": f["incomeTax"], "futa": f["futa"]}[kind]
    return list(block.get("exemptPretax", []))
