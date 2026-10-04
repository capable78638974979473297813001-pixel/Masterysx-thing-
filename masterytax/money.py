"""Decimal helpers. All money is Decimal; floats never touch tax math."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

ZERO = Decimal("0")
CENT = Decimal("0.01")


def D(value) -> Decimal:
    """Coerce a str/int/Decimal (or empty) to Decimal. Floats are rejected."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        raise TypeError("floats are not allowed in money math; pass a string")
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return ZERO
    try:
        return Decimal(str(value).replace(",", "").replace("$", "").strip())
    except InvalidOperation as exc:
        raise ValueError(f"not a number: {value!r}") from exc


def r2(value) -> Decimal:
    """Round half-up to cents, the way agencies round."""
    return D(value).quantize(CENT, rounding=ROUND_HALF_UP)


def clamp(value: Decimal, low: Decimal, high: Decimal | None) -> Decimal:
    if value < low:
        return low
    if high is not None and value > high:
        return high
    return value


def fmt(value: Decimal) -> str:
    return f"{r2(value):,.2f}"
