# Live test sessions

Recorded with the meter streaming to a laptop over USB (Tera Term log + `realtime/live_predict.py`).

## `live_session_1.csv` (22 Nov 2026, 22:16 - 22:23)

- 85 samples (5-second grid), counters 1350 - 1770, mains voltage normal, dryer not used.
- Columns: `clock_time`, `counter`, `power_W`, `pf`, and the true ON/OFF state of the four appliances.
- Taken from the live script's console output, which shows power and power factor but not voltage and
  current.
- Ground truth: the switching sequence in `live_session_1_events.csv`, reconstructed from the power trace and
  the operator's notes and confirmed by the operator.

This session exposed a weakness of tracker v2 (straightener switched OFF while the 100 W bulb stays ON) and
is analysed in `notebooks/07_live_test.ipynb`.
