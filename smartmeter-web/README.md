# Wattwise: website for the BTP smart energy meter

User dashboard and admin console for the STPM33 smart meter. The meter publishes one JSON message per second over
MQTT. The appliance detection runs on the chip, and this site stores, prices and shows the results.

- **Backend:** Node.js 22.13+ with one dependency (`mqtt`). Uses Node's built-in SQLite (`node:sqlite`) and `crypto`.
- **Frontend:** plain HTML, CSS and ES modules served by the backend. No build step; the charts are hand-drawn SVG.

## Run it

```bash
cd smartmeter-web
npm install
npm run dev      # with a simulated meter (sim-demo01) and 3 days of fake history
# or
npm start        # real meters only
```

Open <http://localhost:8080>. On first start two accounts are created, and their passwords are written to
`data/seed.json`:

| Account | Role | Gets |
|---|---|---|
| `admin@meter.local` | admin | everything, including the admin console |
| `user@meter.local` | user | meter `pm33-746d672b` (and the simulated meter in dev mode) |

Change both passwords after signing in (Settings → Password). The `data/` folder holds the database and is not
meant for git.

## Sign-in and roles (Supabase)

There is one sign-in page, then two different sites:

| Role | Site | Look | Pages |
|---|---|---|---|
| `user` | **Wattwise** | warm, dark, sidebar | Overview, Timeline, Usage & cost, Alerts, Settings (own meter only) |
| `admin` | **Wattwise Console** | light, blue, top navigation | Fleet, Live view (any meter), Users, Model, Labelling, Raw feed, Alerts |

Users cannot open console pages (they are sent home, and the API answers 403). Admins land in the console.

**With Supabase** (recommended), accounts live in Supabase Auth and the role in `public.profiles`:

1. Run `supabase/schema.sql` in the Supabase SQL editor. It creates `profiles` with row-level security, so users can
   read only their own profile and can never change their role.
2. Edit the passwords in `supabase/create-users.sql` and run it. It creates Robin and Abhigyan (users) and
   Garv Jain (admin).
3. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_ANON_KEY`. `SUPABASE_SERVICE_ROLE_KEY` is
   optional and lets admins create users, change roles and reset passwords from the console.
4. Restart the server. Sign-in now goes: browser → Supabase Auth → access token → server checks it with Supabase,
   reads the role from `profiles`, and opens a session.
5. In the console, open **Users** and assign each household its meter.

**Without Supabase** (`.env` empty), the server uses its own accounts (created on first start, see below).

## How data flows

```
meter ──MQTT──► broker (broker.emqx.io / hivemq / mosquitto) ──► server (subscribes 24/7) ──► SQLite
                                                                       │
                                                                       └─► browsers (Server-Sent Events, live)
```

- The server subscribes to `btp/meter/+/data` and `btp/meter/+/status`. Brokers are tried in order and the next
  one is used if a broker cannot be reached (`MQTT_BROKERS`).
- Every message is stamped with the server's arrival time (the meter sends no timestamp).
- Meters appear automatically the first time they publish. An admin assigns them to a user.

### What is stored

| Table | Content | Kept |
|---|---|---|
| `minutes` | 1-minute averages per meter: V, I, P (avg/min/max), Q, S, PF, f, **energy (Wh)**, share of time each appliance was ON, deciding samples, expected power, RSSI, minimum heap | forever |
| `events` | Appliance ON/OFF switches with server time and power before/after | forever |
| `raw` | Every 1 s message (raw viewer, labelling tool) | `RAW_RETENTION_HOURS` (72 h) |
| `alerts`, `labels`, `users`, `meters`, `status_log` | as named | forever |

### Energy and reboots

`e` is the meter's own energy counter, and it **resets to 0 when the meter reboots**. The server stores the
*difference* between consecutive messages:

- normal message: `energy += e − previous e`
- reboot (detected when `seq` or `up` goes backwards, or `e` drops): `energy += e` (the energy since the reboot)
- sanity check: a jump that would need more than 3.5 kW is replaced by `power × time`

The counter keeps counting while the meter is cut off from the broker, so energy used during a short Wi-Fi outage
is still counted when it reconnects.

### Appliance switches

`app.*` can change while the model is still confirming (`deciding = 1`). The site shows those appliances as
**Detecting…**. A switch is recorded only once the model confirms it (`deciding = 0`), and it is dated to when the
change first appeared, so short-lived guesses never reach the timeline.

## Features

**User side**

- Live power, cost per hour at the current rate, rate band and when it changes.
- Appliance cards (On / Off / Detecting…) with how long each has been on and today's run time and cost.
- Today and this month: kWh, rupees, and the projected month total.
- Power chart (1 h / 6 h / 24 h / 7 d) with a lane per appliance showing when it was ON.
- Timeline per day: runs with start, end, duration, estimated kWh and cost. Exports CSV (runs, switches, 1-min readings).
- Usage: cost or kWh per day for a month, and cost by appliance.
- Tariff editor (default ₹8/kWh, peak 14:00–17:00 and 22:00–01:00 +20%, off-peak 04:00–10:00 −20%) with a 24 h preview.
- Tips: heavy appliance at peak rate, 2/3/4 appliances together, straightener on for a long time, peak starting soon, off-peak now.
- Alerts: meter offline, dryer or straightener in peak hours, 3+ appliances at once, straightener left on (> 45 min),
  power above 2.2 kW. Each can be turned off in Settings.

**Admin side**

- Meters: online/offline, last seen, power, RSSI, free heap (warning below 9000), messages per minute, uptime,
  restarts, owner. Add or rename meters and assign them to users.
- Users: create, edit, change role, reset password, assign meters, set a per-user tariff, delete.
- Model monitor: switches per appliance, reverted switches (< 30 s), share of time spent deciding, and **measured vs
  expected power**. Expected power is the sum of the typical power of the detected appliances. Mismatching minutes
  are listed with a likely cause.
- Labelling: drag across the 1-second power chart, tick the appliances that were really on (or copy the model's
  answer), save. Export CSV with the training columns
  `voltage_V,current_A,power_W,pf,hair_dryer,hair_straightener,bulb_200W,bulb_100W`, either labelled seconds only or
  labelled seconds plus the model's confirmed answer elsewhere, with an optional timestamp column.
- Raw messages: live tail of every message, filter by meter, pause, click a row for the full JSON.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | web port |
| `MQTT_BROKERS` | emqx, hivemq, mosquitto (TCP 1883) | comma-separated broker URLs, tried in order |
| `TOPIC_PREFIX` | `btp/meter` | topic prefix |
| `MQTT` | `1` | `0` disables MQTT |
| `SIMULATE` | `0` | `1` (or `--simulate`) runs the virtual meter |
| `TZ_OFFSET_MIN` | `330` | local time offset for tariffs and "today" (IST) |
| `RAW_RETENTION_HOURS` | `72` | how long raw 1 s messages are kept |
| `OFFLINE_AFTER_SEC` | `30` | no data for this long = offline |
| `HEAP_WARN` | `9000` | free-heap warning threshold |
| `HIGH_POWER_W` | `2200` | high-power alert threshold |
| `STRAIGHTENER_LEFT_ON_MIN` | `45` | "left on" alert |
| `MISMATCH_W` | `90` | measured vs expected difference counted as a mismatch |
| `DB_PATH`, `SEED_PATH` | `data/…` | file locations |

Typical appliance powers (used for cost estimates and the mismatch check) are in `server/config.js` →
`APPLIANCES`. They are the meter's uncalibrated readings: dryer 1485 W, 200 W bulb 227 W, 100 W bulb 129 W,
straightener 116 W.

## Running 24/7

The backend must keep running to record data. On any always-on machine (a laptop, a Raspberry Pi, a small cloud VM):

```bash
npm install -g pm2
pm2 start "node --disable-warning=ExperimentalWarning server/index.js" --name wattwise
pm2 save && pm2 startup
```

Put it behind HTTPS (Caddy or nginx) before you share it outside your network.

## Security notes

- **The broker is public and has no login.** Anyone who knows the topic can read the meter's data, and anyone can
  *publish fake data* to `btp/meter/<id>/data`, which the site would store as real. For anything beyond a demo, use
  a private broker or one with username/password and TLS, and set `MQTT_BROKERS` accordingly.
- Passwords are hashed with scrypt; sessions are random tokens in an HttpOnly cookie; login attempts are throttled.

## Project layout

```
server/
  index.js      web server, static files, first-start accounts, timers
  config.js     settings, appliances, default tariff
  db.js         SQLite schema
  mqtt.js       broker connection with failover
  ingest.js     message → raw log, minute averages, energy, switches, alerts
  tariff.js     time-of-day rates and costs (IST)
  api.js        HTTP API and CSV exports
  auth.js       passwords and sessions
  hub.js        live updates (Server-Sent Events)
  simulate.js   virtual meter for testing
public/
  index.html, app.css, favicon.svg
  js/app.js     shell, login, routing
  js/charts.js  SVG charts
  js/pages/     dashboard, timeline, usage, alerts, settings, admin-*
```
