"""Routing: which agency, deposit schedule and return each engine tax line belongs to."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import taxengine
from .money import D

DEFAULT_AGENCIES = Path(__file__).parent / "data" / "agencies.json"
STATE_ID = re.compile(r"^([A-Z]{2})_(.+)$")
GROUP_CODE = re.compile(r"^([A-Z]{2})-([A-Z0-9_]+)$")


@dataclass(frozen=True)
class DepositGroup:
    code: str
    name: str
    agency: str
    schedule: str
    return_form: str
    threshold: object = None
    business_days: int = 0
    due_day: int | None = None
    penalty: str | None = None
    eftps_tax_type: str | None = None
    note: str = ""
    configured: bool = True  # False when a state default schedule was assumed


@dataclass(frozen=True)
class Levy:
    """An employer levy the engine does not produce, computed on another tax's wage base."""
    code: str
    name: str
    state: str
    base_tax: str
    rate: object
    rate_key: str
    group: str
    source: str


def _group(code: str, g: dict, configured: bool = True) -> DepositGroup:
    return DepositGroup(
        code=code, name=g["name"], agency=g["agency"], schedule=g["schedule"], return_form=g["return"],
        threshold=D(g["threshold"]) if g.get("threshold") is not None else None,
        business_days=int(g.get("business_days", 0)), due_day=g.get("due_day"), penalty=g.get("penalty"),
        eftps_tax_type=g.get("eftps_tax_type"), note=g.get("note", ""), configured=configured)


class Remittance:
    def __init__(self, raw: dict):
        self.raw = raw
        self.federal_ids = {tid: grp for grp, ids in raw["federal_ids"].items() for tid in ids}
        self.local_ids = raw["local_ids"]
        self.fixed_groups = {**raw["federal_groups"], **raw["local_groups"]}
        self.levies = [Levy(**{**l, "rate": D(l["rate"])}) for l in raw.get("levies", [])]

    @classmethod
    def load(cls, path=None) -> "Remittance":
        return cls(json.loads(Path(path or DEFAULT_AGENCIES).read_text()))

    def group_code(self, tax_id: str) -> str:
        if tax_id in self.federal_ids:
            return self.federal_ids[tax_id]
        if tax_id in self.local_ids:
            return self.local_ids[tax_id]
        m = STATE_ID.match(tax_id)
        if not m:
            return f"OTHER-{tax_id}"
        st, rest = m.groups()
        override = self.raw["state_overrides"].get(st, {}).get("ids", {})
        if tax_id in override:
            return override[tax_id]
        if re.match(r"^((NYC|YONKERS)_)?SIT(_|$)", rest) or rest == "COUNTY":
            return f"{st}-WH"
        if rest in ("SUI_ER", "UC_EE", "SUI_EE"):
            return f"{st}-UI"
        if rest in ("PFML_EE", "PFML_ER"):
            return f"{st}-PFML"
        if rest == "LTC_EE":
            return f"{st}-LTC"
        if rest == "DBL_EE":
            return f"{st}-DI"
        return f"{st}-{re.sub(r'_(EE|ER)$', '', rest)}"

    def group(self, code: str, company=None) -> DepositGroup:
        overrides = (getattr(company, "deposit_schedules", None) or {}).get(code, {})
        if code in self.fixed_groups:
            return _group(code, {**self.fixed_groups[code], **overrides})
        m = GROUP_CODE.match(code)
        if not m:
            return _group(code, {"name": code, "agency": "unknown", "schedule": "quarterly",
                                 "return": "unknown", **overrides}, configured=False)
        st, kind = m.groups()
        defaults = self.raw["state_defaults"]
        base = dict(defaults.get(kind, defaults["OTHER"]))
        state_over = self.raw["state_overrides"].get(st, {}).get("groups", {}).get(code, {})
        ui = ((taxengine.state(st, 2026) or taxengine.state(st, 2025) or {}).get("unemploymentInsurance") or {})
        name = taxengine.state_name(st)
        fill = {"name": name, "code": st, "suffix": kind.replace("_", " ").lower(),
                "ui_agency": self.raw.get("ui_agencies", {}).get(st) or ui.get("administeredBy")
                or f"{name} unemployment agency",
                "wh_agency": self.raw.get("wh_agencies", {}).get(st) or f"{name} Department of Revenue"}
        merged = {k: v.format(**fill) if isinstance(v, str) else v for k, v in base.items()}
        merged.update(state_over)
        merged.update(overrides)
        configured = not (merged.pop("unconfigured_warning", False) and "schedule" not in state_over
                          and "schedule" not in overrides)
        return _group(code, merged, configured)
