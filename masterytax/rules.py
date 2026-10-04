"""Effective-dated tax rules loaded from data, never hard-coded in logic."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .money import ZERO, D

DEFAULT_RULES = Path(__file__).parent / "data" / "rules.json"


@dataclass(frozen=True)
class RuleVersion:
    effective: date
    source: str
    rate: object = None  # Decimal | None
    wage_base: object = None
    threshold: object = None


@dataclass(frozen=True)
class TaxRule:
    code: str
    name: str
    jurisdiction: str
    payer: str  # "employee" | "employer"
    kind: str  # "withholding" | "rate" | "threshold"
    deposit_group: str
    versions: tuple[RuleVersion, ...]
    exempt_deductions: tuple[str, ...] = ()
    reported_column: str | None = None
    rate_source: str = "rule"  # "rule" | "company"
    default_rate: object = None
    credit_reductions: dict = field(default_factory=dict)

    def version_for(self, on: date) -> RuleVersion:
        chosen = None
        for v in self.versions:
            if v.effective <= on:
                chosen = v
        if chosen is None:
            raise LookupError(f"{self.code} has no rule version effective on {on}")
        return chosen


@dataclass(frozen=True)
class DepositGroup:
    code: str
    name: str
    agency: str
    schedule: str
    return_form: str
    threshold: object = None
    business_days: int = 0
    penalty: str | None = None


class RuleBook:
    def __init__(self, taxes: dict[str, TaxRule], groups: dict[str, DepositGroup], disclaimer: str = ""):
        self.taxes = taxes
        self.groups = groups
        self.disclaimer = disclaimer

    @classmethod
    def load(cls, path: str | Path | None = None) -> "RuleBook":
        raw = json.loads(Path(path or DEFAULT_RULES).read_text())
        groups = {
            code: DepositGroup(
                code=code,
                name=g["name"],
                agency=g["agency"],
                schedule=g["schedule"],
                return_form=g["return"],
                threshold=D(g["threshold"]) if "threshold" in g else None,
                business_days=int(g.get("business_days", 0)),
                penalty=g.get("penalty"),
            )
            for code, g in raw["deposit_groups"].items()
        }
        taxes = {}
        for t in raw["taxes"]:
            versions = tuple(
                sorted(
                    (
                        RuleVersion(
                            effective=date.fromisoformat(v["effective"]),
                            source=v.get("source", ""),
                            rate=D(v["rate"]) if "rate" in v else None,
                            wage_base=D(v["wage_base"]) if "wage_base" in v else None,
                            threshold=D(v["threshold"]) if "threshold" in v else None,
                        )
                        for v in t["versions"]
                    ),
                    key=lambda v: v.effective,
                )
            )
            if t["deposit_group"] not in groups:
                raise ValueError(f"{t['code']} references unknown deposit group {t['deposit_group']}")
            taxes[t["code"]] = TaxRule(
                code=t["code"],
                name=t["name"],
                jurisdiction=t["jurisdiction"],
                payer=t["payer"],
                kind=t["kind"],
                deposit_group=t["deposit_group"],
                versions=versions,
                exempt_deductions=tuple(t.get("exempt_deductions", ())),
                reported_column=t.get("reported_column"),
                rate_source=t.get("rate_source", "rule"),
                default_rate=D(t["default_rate"]) if "default_rate" in t else None,
                credit_reductions={
                    int(y): {st: D(r) for st, r in states.items()}
                    for y, states in t.get("credit_reductions", {}).items()
                },
            )
        return cls(taxes, groups, raw.get("disclaimer", ""))

    def applicable(self, work_state: str) -> list[TaxRule]:
        return [t for t in self.taxes.values() if t.jurisdiction in ("US", work_state)]

    def supported_states(self) -> set[str]:
        return {t.jurisdiction for t in self.taxes.values()} - {"US"}

    def futa_credit_reduction(self, year: int, state: str) -> object:
        futa = self.taxes.get("FED_FUTA")
        if futa is None:
            return ZERO
        return futa.credit_reductions.get(year, {}).get(state, ZERO)
