// Console: the live dashboard of any meter, as its household sees it.
import { state, esc, $ } from '../ui.js';

export async function render(root, ctx) {
  let inner = null;
  root.innerHTML = `
    <div class="page-head"><div><h1>Live view</h1><p>Any meter's dashboard, exactly as its household sees it.</p></div>
      <div class="actions"><select class="input" id="lv-meter" style="width:260px">${state.meters.map(m => `<option value="${esc(m.deviceId)}">${esc(m.name)} · ${esc(m.deviceId)}</option>`).join('')}</select></div></div>
    <div id="lv"></div>`;
  const sel = $('#lv-meter', root);
  sel.value = state.meterId || state.meters[0]?.deviceId || '';
  const mount = async () => {
    try { inner?.(); } catch {}
    state.meterId = sel.value;
    const box = $('#lv', root);
    box.innerHTML = '';
    if (!state.meterId) { box.innerHTML = '<div class="card empty">No meters yet.</div>'; return; }
    const { render: dash } = await import('./dashboard.js');
    inner = (await dash(box, ctx)) || null;
  };
  sel.addEventListener('change', mount);
  await mount();
  return () => { try { inner?.(); } catch {} };
}
