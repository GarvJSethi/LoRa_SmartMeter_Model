"""Live appliance detection from the smart meter's serial output.

Three input modes:

  A) Tera Term log file (keep Tera Term open and connected; it logs to a file, this script follows it)
       python realtime/live_predict.py --logfile "C:/Users/<you>/Desktop/meter_live.log"

  B) Serial port directly (close Tera Term first: only one program can open a COM port)
       python realtime/live_predict.py --port COM5 --baud 115200

  C) Replay a recorded log (no board needed, to check that everything works)
       python realtime/live_predict.py --replay data/raw/testingdataset.log --speed 20

Every "[meter] #<counter> V=... I=... P=... PF=... f=... E=... " line is parsed with the same parser used
for the training data, put on the same 5-second grid, and passed to the final model
(models/final_model.joblib), which prints the ON/OFF state of the four appliances.
Press Ctrl+C to stop.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config import APPLIANCE_NAMES, APPLIANCES  # noqa: E402
from src.data_loader import parse_meter_line  # noqa: E402

GRID_S = 5            # the model works on a 5-second grid, like the training data
MAX_GAP_S = 60        # a longer gap in the counter restarts tracking (too much was missed)

GREEN, GREY, YELLOW, CYAN, BOLD, RESET = "\033[92m", "\033[90m", "\033[93m", "\033[96m", "\033[1m", "\033[0m"


# ---------------------------------------------------------------- input sources
def follow_file(path: Path, from_start: bool):
    """Yield new lines appended to a (Tera Term) log file, like `tail -f`."""
    while not path.exists():
        print(f"{YELLOW}Waiting for log file {path} ...{RESET}", flush=True)
        time.sleep(2)
    fh = open(path, "r", encoding="utf-8", errors="replace", newline="")
    if not from_start:
        fh.seek(0, os.SEEK_END)
    buf = ""
    while True:
        chunk = fh.read()
        if chunk:
            buf += chunk
            *lines, buf = buf.replace("\r\n", "\n").replace("\r", "\n").split("\n")
            yield from lines
        else:
            # file truncated or replaced (e.g. a new Tera Term log) -> reopen
            if path.exists() and path.stat().st_size < fh.tell():
                fh.close()
                fh = open(path, "r", encoding="utf-8", errors="replace", newline="")
                buf = ""
            time.sleep(0.2)


def read_serial(port: str, baud: int):
    """Yield lines from a serial (COM) port."""
    import serial

    try:
        ser = serial.Serial(port, baud, timeout=1)
    except serial.SerialException as e:
        sys.exit(f"Could not open {port}: {e}\n"
                 "Is Tera Term (or another program) still connected to it? Close it, or use --logfile.")
    print(f"{CYAN}Connected to {port} at {baud} baud{RESET}", flush=True)
    while True:
        raw = ser.readline()
        if raw:
            yield raw.decode("utf-8", errors="replace").rstrip("\r\n")


def replay(path: Path, speed: float):
    """Yield the lines of a recorded log, pacing meter lines like the real meter (5 s / speed)."""
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if parse_meter_line(line):
                time.sleep(GRID_S / speed)
            yield line.rstrip("\r\n")


# ---------------------------------------------------------------- 5-second grid
class Grid:
    """Puts meter samples on the 5-second grid of the training data.

    Samples are kept when the counter has advanced by at least 5 s since the last kept sample (the
    firmware prints every 5th sample, so normally every line is kept). With `average=True`, all samples
    received in between are averaged instead (less noise if the firmware prints every second).
    """

    def __init__(self, average: bool = False):
        self.average = average
        self.last = None
        self.acc = []

    def push(self, rec: dict):
        """Returns (event, sample): event in {"start", "reboot", "gap", None}; sample is None if not due."""
        c = rec["counter"]
        if self.last is None:
            self.last, self.acc = c, []
            return "start", rec
        if c < self.last:
            self.last, self.acc = c, []
            return "reboot", rec
        if c - self.last > MAX_GAP_S:
            self.last, self.acc = c, []
            return "gap", rec
        self.acc.append(rec)
        if c - self.last < GRID_S:
            return None, None
        out = dict(rec)
        if self.average:
            for k in ("power_W", "current_A", "pf"):
                out[k] = float(np.mean([r[k] for r in self.acc]))
        self.last, self.acc = c, []
        return None, out


# ---------------------------------------------------------------- display
def describe(state) -> str:
    parts = []
    for a, on in zip(APPLIANCES, state):
        name = APPLIANCE_NAMES[a].replace("Hair ", "")
        parts.append(f"{GREEN}{BOLD}{name}: ON {RESET}" if on else f"{GREY}{name}: off{RESET}")
    return "  ".join(parts)


def changes(prev, new) -> str:
    if prev is None:
        return ""
    msg = [f"{APPLIANCE_NAMES[a]} switched {'ON' if n else 'OFF'}"
           for a, p, n in zip(APPLIANCES, prev, new) if p != n]
    return f"  {YELLOW}<- {', '.join(msg)}{RESET}" if msg else ""


# ---------------------------------------------------------------- main loop
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--logfile", type=Path, help="Tera Term log file to follow (Mode A)")
    src.add_argument("--port", help="serial port, e.g. COM5 (Mode B, close Tera Term first)")
    src.add_argument("--replay", type=Path, help="recorded log to replay (Mode C)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--speed", type=float, default=1.0, help="replay speed factor (Mode C)")
    ap.add_argument("--from-start", action="store_true", help="also process what is already in the log file")
    ap.add_argument("--average", action="store_true", help="average all samples inside each 5-second window")
    ap.add_argument("--model", type=Path, default=ROOT / "models" / "final_model.joblib")
    ap.add_argument("--save", type=Path, default=None,
                    help="CSV file for the predictions (default: realtime/logs/predictions_<time>.csv)")
    args = ap.parse_args()

    os.system("")   # enables ANSI colours in the Windows console
    if not args.model.exists():
        sys.exit(f"Model not found: {args.model}\nCreate it with:  python scripts/build_final_model.py")
    import joblib
    model = joblib.load(args.model)
    model.reset()

    save = args.save or ROOT / "realtime" / "logs" / f"predictions_{datetime.now():%Y%m%d_%H%M%S}.csv"
    save.parent.mkdir(parents=True, exist_ok=True)
    out = open(save, "w", newline="", encoding="utf-8")
    writer = csv.writer(out)
    writer.writerow(["time", "counter", "voltage_V", "current_A", "power_W", "pf", *APPLIANCES, "provisional"])

    if args.logfile:
        lines, where = follow_file(args.logfile, args.from_start), f"log file {args.logfile}"
    elif args.port:
        lines, where = read_serial(args.port, args.baud), f"serial port {args.port}"
    else:
        lines, where = replay(args.replay, args.speed), f"replay of {args.replay} (x{args.speed:g})"

    print(f"{BOLD}Live appliance detection{RESET}  |  input: {where}  |  model: {args.model.name}")
    print(f"Predictions are saved to {save}\nWaiting for [meter] lines ... (Ctrl+C to stop)\n", flush=True)

    grid = Grid(average=args.average)
    prev = None
    n = 0
    try:
        for line in lines:
            rec = parse_meter_line(line)
            if rec is None:
                continue
            event, sample = grid.push(rec)
            if event in ("reboot", "gap"):
                why = "board restarted (counter went back)" if event == "reboot" else "long gap in the data"
                print(f"{YELLOW}-- {why}: tracking restarts --{RESET}", flush=True)
                model.reset()
                prev = None
            if sample is None:
                continue
            state = model.step(sample["power_W"], sample["current_A"], sample["pf"])
            provisional = model.pending is not None
            n += 1
            now = datetime.now()
            tag = f" {CYAN}(deciding){RESET}" if provisional else ""
            print(f"{now:%H:%M:%S}  #{sample['counter']:<6d} P={sample['power_W']:7.1f} W  "
                  f"PF={sample['pf']:6.3f} | {describe(state)}{tag}{changes(prev, state)}", flush=True)
            writer.writerow([now.isoformat(timespec="seconds"), sample["counter"], sample["voltage_V"],
                             sample["current_A"], sample["power_W"], sample["pf"], *map(int, state),
                             int(provisional)])
            out.flush()
            prev = state
    except KeyboardInterrupt:
        pass
    finally:
        out.close()
        print(f"\nStopped after {n} samples. Predictions saved to {save}")


if __name__ == "__main__":
    main()
