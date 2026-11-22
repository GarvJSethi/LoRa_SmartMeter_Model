# Live appliance detection

`live_predict.py` reads the meter's serial output, parses every `[meter] #...` line with the same parser used for
the training data, and runs the final model (`models/final_model.joblib`, the hybrid selected in notebook 06).
It prints the ON/OFF state of the four appliances for every sample and saves all predictions to
`realtime/logs/predictions_<time>.csv`.

## 0. One-time setup (on the laptop that runs the model)

```bash
pip install -r requirements.txt
python scripts/build_final_model.py      # only if models/final_model.joblib does not exist yet
```

Check that everything works without the board (replays the recorded test session 20x faster):

```bash
python realtime/live_predict.py --replay data/raw/testingdataset.log --speed 20
```

## 1. Find the board's COM port and baud rate

Connect the NUCLEO board by USB, then either:
- **Device Manager → Ports (COM & LPT)** → *STMicroelectronics STLink Virtual COM Port (COMx)*, or
- `python -m serial.tools.list_ports -v`

The baud rate is the one used in Tera Term (**Setup → Serial port → Speed**), usually 115200.

## 2a. Option A: read the port directly (no Tera Term needed)

Only one program can open a COM port at a time, so **close Tera Term** (or disconnect it) first.

```bash
python realtime/live_predict.py --port COM5 --baud 115200
```

## 2b. Option B: keep Tera Term open and follow its log

1. In Tera Term: **File → Log...**, choose a file (e.g. `Desktop\meter_live.log`), untick *Binary*, click *Save*.
2. Start the model on the same file:

```bash
python realtime/live_predict.py --logfile "%USERPROFILE%\Desktop\meter_live.log"
```

Tera Term keeps showing the raw data; the script shows the predictions as new lines are written.

## 3. Testing

Switch the appliances on and off and watch the output. Each line looks like:

```
20:52:12  #285    P=  518.5 W  PF= 0.999 | dryer: off  straightener: ON  200 W bulb: ON  100 W bulb: ON (deciding) <- 200 W bulb switched ON
```

- `(deciding)`: a switch was just detected; the answer is final after a few samples (≈ 15 s).
- Leave ≈ 10 s between switches when possible; the model was trained on switches ≥ 30 s apart.
- If the board restarts (counter goes back) or data stops for more than 60 s, tracking restarts automatically.
- `--average` averages all samples inside each 5-second window (useful if the firmware prints every second).
- Write down the time and what you switched; the saved CSV can then be compared with your notes.

Press **Ctrl+C** to stop.
