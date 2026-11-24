// Console: user accounts (from Supabase when enabled), meter assignment and per-user tariffs.
import { api } from '../api.js';
import { supabaseToken } from '../auth.js';
import { state, esc, $, icons, toast, modal, confirmBox, fmtRs, fmtDate } from '../ui.js';

export async function render(root, { refreshMeters }) {
  let data = { users: [] }, meters = [];
  root.innerHTML = `
    <div class="page-head"><div><h1>Users</h1><p id="u-sub">Accounts, their meters and their tariffs.</p></div>
      <div class="actions"><button class="btn" id="sync">Refresh</button><button class="btn primary" id="add">${icons.plus} New user</button></div></div>
    <div id="banner"></div>
    <section class="card"><div class="table-wrap"><table class="t">
      <thead><tr><th>Name</th><th>Role</th><th>Meters</th><th>Tariff</th><th>Added</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div></section>`;

  const tariffText = u => `${fmtRs(u.tariff.base)}/kWh · +${u.tariff.peakPct}% / −${u.tariff.offPeakPct}%${u.customTariff ? '' : ' <span class="faint">default</span>'}`;
  const paint = () => {
    const sb = data.authMode === 'supabase';
    $('#u-sub', root).textContent = sb ? 'Accounts come from Supabase Auth; roles from the profiles table.' : 'Accounts, their meters and their tariffs.';
    $('#add', root).classList.toggle('hidden', !data.canManage);
    $('#banner', root).innerHTML = sb && !data.canManage ? `<div class="c-banner">${icons.info}<div>Names, roles and passwords are managed in Supabase. To manage them from here too, add <span class="mono">SUPABASE_SERVICE_ROLE_KEY</span> to <span class="mono">.env</span>. Meters and tariffs can always be changed here.</div></div>` : '';
    $('#rows', root).innerHTML = data.users.map(u => `
      <tr>
        <td><div style="font-weight:600">${esc(u.name)}</div><div class="faint" style="font-size:12.5px">${esc(u.email)}</div></td>
        <td>${u.role === 'admin' ? '<span class="chip peak">Admin</span>' : '<span class="chip">User</span>'}</td>
        <td>${u.meters.length ? u.meters.map(m => `<span class="chip mono" style="margin:2px 4px 2px 0">${esc(m)}</span>`).join('') : '<span class="faint">None</span>'}</td>
        <td class="num" style="font-size:13px;white-space:nowrap">${tariffText(u)}</td>
        <td class="num faint">${fmtDate(u.created_at)}</td>
        <td class="r" style="white-space:nowrap">
          ${data.canManage ? `<button class="btn sm" data-edit="${u.id}">Edit</button>` : ''}
          ${u.role === 'user' ? `<button class="btn sm" data-meters="${u.id}">Meters</button> <button class="btn sm" data-tariff="${u.id}">Tariff</button>` : ''}
          ${u.id === state.me.id || !data.canManage ? '' : `<button class="btn ghost sm danger" data-del="${u.id}" aria-label="Delete user">${icons.x}</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">No users yet</td></tr>';
  };
  const load = async () => {
    const token = await supabaseToken().catch(() => null);
    [data, meters] = await Promise.all([api('/api/admin/users', { headers: token ? { 'X-SB-Token': token } : {} }), api('/api/meters')]);
    if (typeof data.synced === 'string') toast(`Could not read Supabase profiles: ${data.synced}`, 'bad');
    paint();
  };

  $('#sync', root).addEventListener('click', () => load().then(() => toast('User list refreshed')));
  $('#add', root).addEventListener('click', async () => {
    const r = await modal(`<h2>New user</h2>
      <label class="field"><span>Full name</span><input class="input" name="name" required></label>
      <label class="field mt"><span>Email</span><input class="input" name="email" type="email" required></label>
      <label class="field mt"><span>Temporary password</span><input class="input" name="password" type="text" minlength="6" required></label>
      <label class="field mt"><span>Role</span><select class="input" name="role"><option value="user">User</option><option value="admin">Admin</option></select></label>
      <div class="modal-actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Create user</button></div>`);
    if (!r) return;
    try { await api('/api/admin/users', { method: 'POST', body: r }); toast('User created. Share the password with them securely.', 'good'); load(); }
    catch (err) { toast(err.message, 'bad'); }
  });

  root.addEventListener('click', async e => {
    const el = e.target.closest('[data-edit],[data-meters],[data-tariff],[data-del]'); if (!el) return;
    const u = data.users.find(x => x.id === Number(el.dataset.edit || el.dataset.meters || el.dataset.tariff || el.dataset.del));
    try {
      if (el.dataset.edit) {
        const r = await modal(`<h2>Edit ${esc(u.name)}</h2>
          <label class="field"><span>Full name</span><input class="input" name="name" value="${esc(u.name)}"></label>
          <label class="field mt"><span>Role</span><select class="input" name="role"><option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
          <label class="field mt"><span>New password (leave empty to keep)</span><input class="input" name="password" type="text" minlength="6"></label>
          <div class="modal-actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`);
        if (!r) return;
        await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { name: r.name, role: r.role, password: r.password || undefined } });
        toast('User saved', 'good');
      } else if (el.dataset.meters) {
        const r = await modal(`<h2>Meters for ${esc(u.name)}</h2><p class="muted" style="margin-top:-6px">A meter belongs to one household at a time.</p>
          <div class="list">${meters.map(m => `<label class="li check"><input type="checkbox" name="m:${esc(m.deviceId)}" ${m.userId === u.id ? 'checked' : ''}>
            <div class="grow"><div class="t1">${esc(m.name)}</div><div class="t2 mono">${esc(m.deviceId)}${m.userId && m.userId !== u.id ? ' · now assigned to someone else' : ''}</div></div></label>`).join('') || '<div class="empty">No meters</div>'}</div>
          <div class="modal-actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`);
        if (!r) return;
        for (const m of meters) {
          const want = r[`m:${m.deviceId}`] === 'on';
          if (want && m.userId !== u.id) await api(`/api/admin/meters/${encodeURIComponent(m.deviceId)}`, { method: 'PUT', body: { userId: u.id } });
          if (!want && m.userId === u.id) await api(`/api/admin/meters/${encodeURIComponent(m.deviceId)}`, { method: 'PUT', body: { userId: null } });
        }
        toast('Meters updated', 'good'); refreshMeters();
      } else if (el.dataset.tariff) {
        const t = u.tariff, w = list => list.map(x => `${x.start}-${x.end}`).join(', ');
        const r = await modal(`<h2>Tariff for ${esc(u.name)}</h2>
          <div class="form-row">
            <label class="field"><span>Base ₹/kWh</span><input class="input num" name="base" type="number" step="0.01" value="${t.base}"></label>
            <label class="field"><span>Peak +%</span><input class="input num" name="peakPct" type="number" value="${t.peakPct}"></label>
            <label class="field"><span>Off-peak −%</span><input class="input num" name="offPeakPct" type="number" value="${t.offPeakPct}"></label>
          </div>
          <label class="field mt"><span>Peak windows (HH:MM-HH:MM, comma separated)</span><input class="input mono" name="peak" value="${esc(w(t.peak))}"></label>
          <label class="field mt"><span>Off-peak windows</span><input class="input mono" name="offPeak" value="${esc(w(t.offPeak))}"></label>
          <label class="check mt"><input type="checkbox" name="useDefault"> Reset to the default tariff</label>
          <div class="modal-actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Save tariff</button></div>`);
        if (!r) return;
        const parse = s => s.split(',').map(x => x.trim()).filter(Boolean).map(x => { const [start, end] = x.split('-').map(y => y.trim()); return { start, end }; });
        await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { tariff: r.useDefault ? null : { base: r.base, peakPct: r.peakPct, offPeakPct: r.offPeakPct, peak: parse(r.peak), offPeak: parse(r.offPeak) } } });
        toast('Tariff saved', 'good');
      } else if (el.dataset.del) {
        if (!await confirmBox('Delete user?', `${u.name} (${u.email}) will lose access${data.authMode === 'supabase' ? ' and be removed from Supabase' : ''}. Their meters stay and become unassigned. This cannot be undone.`, 'Delete user', true)) return;
        await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
        toast('User deleted'); refreshMeters();
      }
      load();
    } catch (err) { toast(err.message, 'bad'); }
  });
  await load();
}
