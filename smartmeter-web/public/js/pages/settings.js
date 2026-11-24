// Settings: tariff (base rate, peak and off-peak windows), alert preferences, password, exports.
import { api } from '../api.js';
import { state, esc, $, $$, icons, toast, fmtRs, isoDay, fromIsoDay, dayStart, download } from '../ui.js';
import { tariffStrip } from '../charts.js';
import { changePassword } from '../auth.js';

export async function render(root) {
  const me = state.me;
  let t = structuredClone(me.tariff);

  root.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Your tariff is used for every cost on this site.</p></div></div>
    <div class="grid g-main">
      <section class="card">
        <div class="card-head"><h2>Electricity tariff</h2><button class="btn ghost sm" id="reset">Use default</button></div>
        <form id="tariff">
          <div class="form-row">
            <label class="field"><span>Base rate (₹/kWh)</span><input class="input num" name="base" type="number" step="0.01" min="0"></label>
            <label class="field"><span>Peak surcharge (%)</span><input class="input num" name="peakPct" type="number" step="1" min="0"></label>
            <label class="field"><span>Off-peak discount (%)</span><input class="input num" name="offPeakPct" type="number" step="1" min="0" max="100"></label>
          </div>
          <div class="mt"><div class="label">Peak hours</div><div id="peak"></div><button class="btn sm mt-s" type="button" data-add="peak">${icons.plus} Add peak window</button></div>
          <div class="mt"><div class="label">Off-peak hours</div><div id="offPeak"></div><button class="btn sm mt-s" type="button" data-add="offPeak">${icons.plus} Add off-peak window</button></div>
          <hr class="divider">
          <div class="label">Your day</div>
          <div id="strip" class="mt-s"></div>
          <div class="legend mt-s"><span><i class="swatch" style="--c:#ff7a2f"></i>Peak <b class="num" id="r-peak"></b></span><span><i class="swatch" style="--c:#3a3a41"></i>Normal <b class="num" id="r-norm"></b></span><span><i class="swatch" style="--c:#3ecf8e"></i>Off-peak <b class="num" id="r-off"></b></span></div>
          <div class="row mt"><button class="btn primary">Save tariff</button><span class="faint" style="font-size:13px">Windows may cross midnight, e.g. 22:00 to 01:00.</span></div>
        </form>
      </section>
      <div class="grid" style="align-content:start">
        <section class="card">
          <div class="card-head"><h2>Alerts</h2></div>
          <div class="list" id="prefs">
            ${[['peak', 'Heavy appliance in peak hours', 'Dryer or straightener running when prices are higher'],
               ['multi', 'Several appliances together', 'Three or more appliances on at once'],
               ['leftOn', 'Straightener left on', 'On for longer than 45 minutes'],
               ['high', 'High power', 'Total power above 2.2 kW'],
               ['offline', 'Meter offline', 'No data from the meter']].map(([k, a, b]) => `
              <label class="li" style="cursor:pointer"><div class="grow"><div class="t1">${a}</div><div class="t2">${b}</div></div>
              <span class="switch"><input type="checkbox" data-pref="${k}" ${me.alertPrefs[k] !== false ? 'checked' : ''}><span></span></span></label>`).join('')}
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Export data</h2></div>
          <div class="form-row">
            <label class="field"><span>From</span><input class="input" type="date" id="ex-from"></label>
            <label class="field"><span>To</span><input class="input" type="date" id="ex-to"></label>
          </div>
          <div class="row mt">
            <button class="btn sm" data-ex="minutes">${icons.download} Readings (1-min)</button>
            <button class="btn sm" data-ex="events">${icons.download} Switches</button>
            <button class="btn sm" data-ex="runs">${icons.download} Runs</button>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Password</h2></div>
          <form id="pw" class="grid" style="gap:10px">
            <input class="input" type="password" name="current" placeholder="Current password" autocomplete="current-password" required>
            <input class="input" type="password" name="next" placeholder="New password (6+ characters)" autocomplete="new-password" minlength="6" required>
            <button class="btn">Change password</button>
          </form>
        </section>
      </div>
    </div>`;

  const form = $('#tariff', root);
  const winRow = (kind, w, i) => `
    <div class="row mt-s" data-win="${kind}" data-i="${i}">
      <input class="input num" type="time" value="${esc(w.start)}" data-part="start" style="width:130px"><span class="faint">to</span>
      <input class="input num" type="time" value="${esc(w.end)}" data-part="end" style="width:130px">
      <button class="btn ghost sm" type="button" data-del="${kind}:${i}" aria-label="Remove window">${icons.x}</button>
    </div>`;
  const paint = () => {
    form.base.value = t.base; form.peakPct.value = t.peakPct; form.offPeakPct.value = t.offPeakPct;
    $('#peak', root).innerHTML = t.peak.map((w, i) => winRow('peak', w, i)).join('') || '<div class="faint mt-s">No peak hours</div>';
    $('#offPeak', root).innerHTML = t.offPeak.map((w, i) => winRow('offPeak', w, i)).join('') || '<div class="faint mt-s">No off-peak hours</div>';
    preview();
  };
  const read = () => {
    t.base = +form.base.value; t.peakPct = +form.peakPct.value; t.offPeakPct = +form.offPeakPct.value;
    for (const kind of ['peak', 'offPeak']) t[kind] = $$(`[data-win="${kind}"]`, root).map(r => ({ start: $('[data-part=start]', r).value, end: $('[data-part=end]', r).value })).filter(w => w.start && w.end);
  };
  // the preview is computed here, the same way the server does it
  const preview = () => {
    const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const inW = (m, w) => { const a = toMin(w.start), b = toMin(w.end); return a <= b ? m >= a && m < b : m >= a || m < b; };
    const day = dayStart(Date.now());
    const hours = Array.from({ length: 48 }, (_, i) => {
      const m = i * 30;
      const band = t.peak.some(w => inW(m, w)) ? 'peak' : t.offPeak.some(w => inW(m, w)) ? 'offpeak' : 'normal';
      const rate = band === 'peak' ? t.base * (1 + t.peakPct / 100) : band === 'offpeak' ? t.base * (1 - t.offPeakPct / 100) : t.base;
      return { t: day + m * 60e3, band, rate };
    });
    tariffStrip($('#strip', root), hours);
    $('#r-peak', root).textContent = fmtRs(t.base * (1 + t.peakPct / 100));
    $('#r-norm', root).textContent = fmtRs(t.base);
    $('#r-off', root).textContent = fmtRs(t.base * (1 - t.offPeakPct / 100));
  };
  form.addEventListener('input', () => { read(); preview(); });
  form.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (add) { read(); t[add.dataset.add].push(add.dataset.add === 'peak' ? { start: '18:00', end: '21:00' } : { start: '04:00', end: '06:00' }); paint(); }
    const del = e.target.closest('[data-del]');
    if (del) { read(); const [k, i] = del.dataset.del.split(':'); t[k].splice(Number(i), 1); paint(); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault(); read();
    try { const saved = await api('/api/tariff', { method: 'PUT', body: t }); me.tariff = saved; t = structuredClone(saved); paint(); toast('Tariff saved. All costs now use it.', 'good'); }
    catch (err) { toast(err.message, 'bad'); }
  });
  $('#reset', root).addEventListener('click', () => { t = structuredClone(me.defaultTariff); paint(); toast('Default tariff loaded. Save to apply it.'); });

  $('#prefs', root).addEventListener('change', async () => {
    const body = Object.fromEntries($$('[data-pref]', root).map(i => [i.dataset.pref, i.checked]));
    me.alertPrefs = await api('/api/me/alert-prefs', { method: 'PUT', body });
    toast('Alert preferences saved.', 'good');
  });

  const today = Date.now();
  $('#ex-from', root).value = isoDay(today - 6 * 86400e3);
  $('#ex-to', root).value = isoDay(today);
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-ex]'); if (!b) return;
    if (!state.meterId) return toast('No meter assigned', 'bad');
    const from = fromIsoDay($('#ex-from', root).value), to = fromIsoDay($('#ex-to', root).value) + 86400e3;
    if (!(to > from)) return toast('Pick a valid date range', 'bad');
    download(`/api/meters/${encodeURIComponent(state.meterId)}/export.csv?kind=${b.dataset.ex}&from=${from}&to=${to}`);
  });

  $('#pw', root).addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await changePassword(me.email, f.current, f.next); e.target.reset(); toast('Password changed.', 'good'); }
    catch (err) { toast(err.message, 'bad'); }
  });
  paint();
}
