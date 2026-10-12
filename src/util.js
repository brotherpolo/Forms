// Small pure helpers shared across modules (no DOM access, safe to import in Node tests).

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = (prefix = '') =>
  prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

export const isEmpty = (v) =>
  v == null ||
  v === '' ||
  (Array.isArray(v) && !v.length) ||
  (typeof v === 'object' && !Array.isArray(v) && !Object.values(v).some((x) => x != null && x !== ''));
