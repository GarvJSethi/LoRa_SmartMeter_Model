"""Project-wide paths and constants."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_RAW = ROOT / "data" / "raw"
DATA_PROCESSED = ROOT / "data" / "processed"
MODELS_DIR = ROOT / "models"
FIGURES_DIR = ROOT / "reports" / "figures"

LABELLED_CSV = DATA_RAW / "labelled_dataset.csv"
EVENTS_CSV = DATA_RAW / "switch_events.csv"

# Target columns (1 = appliance ON)
APPLIANCES = ["hair_dryer", "hair_straightener", "bulb_200W", "bulb_100W"]
APPLIANCE_NAMES = {
    "hair_dryer": "Hair dryer",
    "hair_straightener": "Hair straightener",
    "bulb_200W": "200 W bulb",
    "bulb_100W": "100 W bulb",
}

# Raw measurements reported by the meter
MEASUREMENTS = ["voltage_V", "current_A", "power_W", "pf", "freq_Hz", "energy_Wh"]

# Measurements that describe the appliances (used as model inputs).
# voltage / frequency describe the mains supply, energy_Wh and counter are cumulative.
APPLIANCE_FEATURES = ["power_W", "current_A", "pf"]

# Sampling period of the serial logs (every 5th 1-second sample is printed)
SAMPLE_PERIOD_S = 5

RANDOM_STATE = 42
