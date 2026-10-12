// Permission model (pure functions, mirrored by firestore.rules and storage.rules).
//
// A level is "none", "own" (records the person created) or "all".
// Each group has an access map:  { "*": {view, edit}, "<formId>": {view, edit} }
// "*" is the default for every form without its own entry.
// A person's effective access is the most permissive level across their groups,
// computed by an admin's browser and stored on users/{uid}.access, where the
// security rules read it.

export const LEVELS = ['none', 'own', 'all'];
export const NONE = Object.freeze({ view: 'none', edit: 'none' });
export const FULL = Object.freeze({ view: 'all', edit: 'all' });

export const rank = (l) => Math.max(0, LEVELS.indexOf(l));

/** Editing implies seeing: raise view to at least the edit level. */
export function normalize(l) {
  const view = LEVELS[Math.max(rank(l?.view), rank(l?.edit))];
  const edit = LEVELS[rank(l?.edit)];
  return { view, edit };
}

/** Level for one form from an access map, falling back to "*". */
export function levelFor(access, formId) {
  return normalize(access?.[formId] || access?.['*'] || NONE);
}

/** Union of several groups' access maps (most permissive wins, per form). */
export function effectiveAccess(groups) {
  const keys = new Set(['*']);
  groups.forEach((g) => Object.keys(g.access || {}).forEach((k) => keys.add(k)));
  const out = {};
  for (const k of keys) {
    let v = 0;
    let e = 0;
    for (const g of groups) {
      const a = g.access || {};
      const l = a[k] || a['*'] || NONE;
      v = Math.max(v, rank(l.view));
      e = Math.max(e, rank(l.edit));
    }
    out[k] = normalize({ view: LEVELS[v], edit: LEVELS[e] });
  }
  // Drop per-form entries identical to the default to keep the document small.
  for (const k of Object.keys(out)) {
    if (k !== '*' && out[k].view === out['*'].view && out[k].edit === out['*'].edit) delete out[k];
  }
  return out;
}

export const isAdmin = (me) => me?.role === 'admin';

export function formLevel(me, formId) {
  if (isAdmin(me)) return { ...FULL };
  return levelFor(me?.access, formId);
}

export const canViewForm = (me, formId) => formLevel(me, formId).view !== 'none';
export const canCreate = (me, formId) => formLevel(me, formId).edit !== 'none';

export function canViewRecord(me, rec) {
  const l = formLevel(me, rec.formId);
  return l.view === 'all' || (l.view === 'own' && rec.ownerId === me?.uid);
}

export function canEditRecord(me, rec) {
  const l = formLevel(me, rec.formId);
  return l.edit === 'all' || (l.edit === 'own' && rec.ownerId === me?.uid);
}

/** Plain-language summary, e.g. "View all · edit own". */
export function describeLevel(l) {
  const n = normalize(l);
  if (n.view === 'none') return 'No access';
  const v = n.view === 'all' ? 'View all' : 'View own';
  const e = n.edit === 'none' ? 'read only' : n.edit === 'all' ? 'edit all' : 'edit own';
  return `${v} · ${e}`;
}

export const PRESETS = [
  { key: 'all', label: 'View and edit all', level: { view: 'all', edit: 'all' } },
  { key: 'mine', label: 'View and edit mine only', level: { view: 'own', edit: 'own' } },
  { key: 'all-mine', label: 'View all, edit mine', level: { view: 'all', edit: 'own' } },
  { key: 'read', label: 'View all, read only', level: { view: 'all', edit: 'none' } },
  { key: 'none', label: 'No access', level: { view: 'none', edit: 'none' } },
];
