// DOM helpers and small presentational pieces shared by the app and admin screens.
import { esc } from './util.js';

export { esc, uid, clone, isEmpty } from './util.js';

export const $ = (s) => document.querySelector(s);

export const COLORS = ['#3346c8', '#0f7b6c', '#b4531a', '#8a3fb8', '#b42367', '#3d6b1f', '#56607a', '#0b6aa2'];

export const colorOf = (f) => COLORS[(f.color ?? 0) % COLORS.length];

export const itemName = (f) =>
  (f.itemName || '').trim() || (f.name || 'Record').replace(/s$/i, '') || 'Record';

export const badge = (f, lg) =>
  `<span class="badge${lg ? ' lg' : ''}" style="background:${colorOf(f)}">${esc(
    (f.name || '?').trim().charAt(0).toUpperCase() || '?'
  )}</span>`;

let toastTimer;
export function toast(message) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3600);
}
