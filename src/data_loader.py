"""Loading the labelled dataset and parsing raw meter logs.

The same `parse_meter_line` function is used for the offline logs and for the
live Wi-Fi stream, so training data and real-time data are parsed identically.
"""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from .config import APPLIANCES, EVENTS_CSV, LABELLED_CSV

# Example line:
# [meter] #2750 V=248.42 V  I=0.514 A  P=130.5 W  PF=0.983  f=49.98 Hz  E=51.173 Wh  heap=16584
METER_LINE = re.compile(
    r"\[meter\]\s+#(?P<counter>\d+)\s+"
    r"V=(?P<voltage_V>-?[\d.]+)\s*V\s+"
    r"I=(?P<current_A>-?[\d.]+)\s*A\s+"
    r"P=(?P<power_W>-?[\d.]+)\s*W\s+"
    r"PF=(?P<pf>-?[\d.]+)\s+"
    r"f=(?P<freq_Hz>-?[\d.]+)\s*Hz\s+"
    r"E=(?P<energy_Wh>-?[\d.]+)\s*Wh"
    r"(?:\s+heap=(?P<heap>\d+))?"
)


def parse_meter_line(line: str) -> dict | None:
    """Parse one `[meter] ...` console line. Returns None for any other line."""
    m = METER_LINE.search(line)
    if not m:
        return None
    d = m.groupdict()
    out = {k: float(v) for k, v in d.items() if v is not None and k not in ("counter", "heap")}
    out["counter"] = int(d["counter"])
    if d.get("heap"):
        out["heap"] = int(d["heap"])
    return out


def parse_log(path: str | Path) -> pd.DataFrame:
    """Parse a raw Tera Term log into a DataFrame of meter samples."""
    path = Path(path)
    rows = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            rec = parse_meter_line(line)
            if rec:
                rows.append(rec)
    df = pd.DataFrame(rows)
    df.insert(0, "source_file", path.name)
    return df


def add_combo(df: pd.DataFrame) -> pd.DataFrame:
    """Add a 4-character on/off string (dryer, straightener, 200 W, 100 W), e.g. '0110'."""
    df = df.copy()
    df["combo"] = df[APPLIANCES].astype(int).astype(str).agg("".join, axis=1)
    return df


def load_labelled(path: str | Path = LABELLED_CSV) -> pd.DataFrame:
    """Load labelled_dataset.csv, sorted in time order within each recording file."""
    df = pd.read_csv(path)
    df = df.sort_values(["run", "counter"]).reset_index(drop=True)
    for col in ["block", "split", "source_file"]:
        df[col] = df[col].astype("category")
    df = add_combo(df)
    # Time (seconds) since start of each run - useful for plots
    df["time_s"] = df["counter"]
    return df


def load_events(path: str | Path = EVENTS_CSV) -> pd.DataFrame:
    """Load switch_events.csv (one row per appliance switch)."""
    return pd.read_csv(path).sort_values(["run", "counter"]).reset_index(drop=True)
