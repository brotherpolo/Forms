// Administrator screens: security groups and users.
// Effective access is recomputed here and written to each affected users/{uid} document,
// where firestore.rules and storage.rules read it.

import { store, saveGroup, deleteGroup, setUserGroups, setUserRole, recomputeAllAccess } from './store.js';
import { go, render, renderMain, byOrder } from './app.js';
import { esc, uid, clone, toast, badge } from './ui.js';
import { LEVELS, NONE, PRESETS, normalize, describeLevel, levelFor, isAdmin } from './access.js';

const VIEWS = new Set(['users', 'groups', 'groupEdit']);
let gdraft = null;
let confirmDel = false;
let leaveArmed = false;

const VIEW_LABEL = { none: 'Can’t see', own: 'Only their own', all: 'All records' };
const EDIT_LABEL = { none: 'Can’t edit', own: 'Their own', all: 'All records' };

export const handles = (view) => VIEWS.has(view.name);
export const isDirty = (view) => view.name === 'groupEdit' && !!gdraft?.dirty && !leaveArmed;

const userName = (u) => store.profiles[u.id]?.displayName || u.displayName || (u.email || '').split('@')[0] || 'Unnamed user';
const sortedUsers = () => [...store.users].sort((a, b) => userName(a).localeCompare(userName(b)));
const sortedGroups = () => [...store.groups].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

export function renderView(view) {
  if (view.name === 'users') return { title: 'Users', html: viewUsers() };
  if (view.name === 'groups') return { title: 'Security groups', html: viewGroups() };
  if (view.name === 'groupEdit') return { title: 'Edit group', html: viewGroupEdit() };
  return { title: '', html: '' };
}

/* ---------- Groups list ---------- */

function viewGroups() {
  const gs = sortedGroups();
  const memberCount = (g) => store.users.filter((u) => (u.groups || []).includes(g.id)).length;
  return `
  <div class="head"><div class="ttl"><div><h1>Security groups</h1>
    <p class="sub">A group decides which forms its members can see and change, and whether that covers every record or only the ones they created. People get the most generous access across all their groups. Administrators can always see and edit everything.</p></div></div>
    <div class="actions"><button class="btn ghost" data-act="g-recompute">Recalculate access</button><button class="btn primary" data-act="g-new">+ New group</button></div></div>
  ${gs.length ? `<div class="panel flist">${gs.map((g) => {
    const exceptions = Object.keys(g.access || {}).filter((k) => k !== '*').length;
    const n = memberCount(g);
    return `<div class="fcard"><span class="glyph" style="width:40px;height:40px">◫</span><div class="info"><b>${esc(g.name || 'Untitled group')}</b>${g.description ? `<span class="help">${esc(g.description)}</span>` : ''}
      <div class="tags"><span class="chip">${n} member${n === 1 ? '' : 's'}</span><span class="chip acc">Default: ${esc(describeLevel(g.access?.['*'] || NONE))}</span>${exceptions ? `<span class="chip">${exceptions} form exception${exceptions === 1 ? '' : 's'}</span>` : ''}</div></div>
      <div class="ctl"><button class="btn sm primary" data-act="g-edit" data-id="${g.id}">Edit</button></div></div>`;
  }).join('')}</div>`
  : `<div class="panel empty"><h2>No groups yet</h2><p>Create a group such as “Field staff” (view and edit their own records) or “Office” (view and edit everything), then add people to it.</p><button class="btn primary" data-act="g-new">+ New group</button></div>`}`;
}

/* ---------- Group editor ---------- */

function openGroup(id) {
  const g = id ? store.groups.find((x) => x.id === id) : null;
  gdraft = g
    ? { id: g.id, name: g.name || '', description: g.description || '', access: clone(g.access || {}), members: store.users.filter((u) => (u.groups || []).includes(g.id)).map((u) => u.id), isNew: false, dirty: false }
    : { id: uid('g'), name: '', description: '', access: { '*': { view: 'own', edit: 'own' } }, members: [], isNew: true, dirty: true };
  confirmDel = false;
  leaveArmed = false;
}

function levelSelect(key, dim, value, allowDefault) {
  const labels = dim === 'view' ? VIEW_LABEL : EDIT_LABEL;
  const opts = (allowDefault ? [['', 'Same as default']] : []).concat(LEVELS.map((l) => [l, labels[l]]));
  return `<select class="in" data-gacc="${esc(key)}" data-dim="${dim}" aria-label="${dim === 'view' ? 'Can see' : 'Can edit'}">${opts
    .map(([v, l]) => `<option value="${v}"${v === (value ?? '') ? ' selected' : ''}>${l}</option>`)
    .join('')}</select>`;
}

function viewGroupEdit() {
  if (!gdraft) return '';
  const g = gdraft;
  const def = normalize(g.access['*'] || NONE);
  const forms = [...store.forms].sort(byOrder);
  const users = sortedUsers();
  return `
  <div class="crumbs"><button data-act="nav-groups">Security groups</button><span>›</span><span>${g.isNew ? 'New group' : esc(g.name)}</span></div>
  <div class="head"><div class="ttl"><span class="glyph" style="width:40px;height:40px">◫</span><div style="flex:1;min-width:0"><input class="title-in" data-gp="name" value="${esc(g.name)}" placeholder="Group name, e.g. Field staff" aria-label="Group name"></div></div></div>
  <div class="panel"><div class="settings"><label class="prop full"><span>Description</span><input class="in" data-gp="description" value="${esc(g.description)}" placeholder="Who belongs here"></label></div></div>

  <section class="section"><div class="section-h"><h2>Default for every form</h2></div>
    <div class="panel"><div class="settings">
      <div class="prop full"><span>Quick choices</span><div class="chips">${PRESETS.map((p) => `<button type="button" class="chipbtn${p.level.view === def.view && p.level.edit === def.edit ? ' on' : ''}" data-act="g-preset" data-key="*" data-preset="${p.key}">${p.label}</button>`).join('')}</div></div>
      <label class="prop"><span>Can see</span>${levelSelect('*', 'view', def.view, false)}</label>
      <label class="prop"><span>Can edit</span>${levelSelect('*', 'edit', def.edit, false)}</label>
      <p class="help full" style="grid-column:1/-1">“Only their own” and “Their own” mean records the person created. Editing includes creating and deleting.</p>
    </div></div></section>

  <section class="section"><div class="section-h"><h2>Exceptions by form</h2><span class="help">Leave as “Same as default” unless a form needs different access.</span></div>
    <div class="panel">${forms.length ? `<div class="tblwrap"><table class="tbl acc-tbl"><thead><tr><th>Form</th><th>Can see</th><th>Can edit</th><th>Result</th></tr></thead><tbody>${forms.map((f) => {
      const own = g.access[f.id];
      const eff = normalize(own || def);
      return `<tr><td><span class="formcell">${badge(f)}${esc(f.name)}</span></td><td>${levelSelect(f.id, 'view', own?.view, true)}</td><td>${levelSelect(f.id, 'edit', own?.edit, true)}</td><td><span class="chip${own ? ' acc' : ''}">${esc(describeLevel(eff))}</span></td></tr>`;
    }).join('')}</tbody></table></div>` : `<p class="note">No forms yet. The default above will apply to forms you create later.</p>`}</div></section>

  <section class="section"><div class="section-h"><h2>Members <span class="count">${g.members.length}</span></h2></div>
    <div class="panel">${users.length ? `<div class="members">${users.map((u) => `<label class="member"><input type="checkbox" data-gmember="${u.id}"${g.members.includes(u.id) ? ' checked' : ''}><span class="grow"><b>${esc(userName(u))}</b><small>${esc(u.email || '')}${isAdmin(u) ? ' · Administrator' : ''}</small></span></label>`).join('')}</div>` : `<p class="note">Nobody has signed in yet.</p>`}</div></section>

  <div class="panel savebar" style="border-radius:var(--r)">
    ${g.isNew ? '' : `<button class="btn danger${confirmDel ? ' armed' : ''}" data-act="g-del">${confirmDel ? 'Tap again to delete' : 'Delete group'}</button>`}
    <span class="grow" id="gdirty">${g.dirty ? 'Unsaved changes' : 'All changes saved'}</span>
    <button class="btn ghost" data-act="g-cancel">${g.dirty ? 'Discard' : 'Done'}</button>
    <button class="btn primary" data-act="g-save">Save group</button>
  </div>`;
}

function setDirty() {
  gdraft.dirty = true;
  const n = document.getElementById('gdirty');
  if (n) n.textContent = 'Unsaved changes';
}

/* ---------- Users ---------- */

function viewUsers() {
  const users = sortedUsers();
  const gs = sortedGroups();
  const admins = store.users.filter(isAdmin).length;
  const formsVisible = (u) => (isAdmin(u) ? store.forms.length : store.forms.filter((f) => levelFor(u.access, f.id).view !== 'none').length);
  return `
  <div class="head"><div class="ttl"><div><h1>Users</h1><p class="sub">People appear here after they sign in for the first time. Add them to security groups to give them access to forms.</p></div></div></div>
  ${users.length ? `<div class="panel flist">${users.map((u) => {
    const self = u.id === store.user?.uid;
    const lastAdmin = isAdmin(u) && admins <= 1;
    return `<div class="ucard">
      <div class="uhead"><div class="grow"><b>${esc(userName(u))}${self ? ' <span class="chip">You</span>' : ''}</b><small>${esc(u.email || 'No email')}</small></div>
        <label class="prop urole"><span class="sr">Role</span><select class="in" data-urole="${u.id}"${self || lastAdmin ? ' disabled title="You can’t remove the last administrator or change your own role."' : ''}><option value="member"${!isAdmin(u) ? ' selected' : ''}>Member</option><option value="admin"${isAdmin(u) ? ' selected' : ''}>Administrator</option></select></label></div>
      ${isAdmin(u) ? `<p class="help">Administrators see and edit every form and manage forms, groups and users.</p>` : gs.length ? `<div class="opts">${gs.map((g) => `<label class="opt"><input type="checkbox" data-ugroup="${u.id}" value="${g.id}"${(u.groups || []).includes(g.id) ? ' checked' : ''}>${esc(g.name || 'Untitled group')}</label>`).join('')}</div>
        <p class="help">${(u.groups || []).length ? `Can open ${formsVisible(u)} of ${store.forms.length} forms.` : 'Not in any group, so no forms are visible yet.'}</p>` : `<p class="help">Create a security group first, then add this person to it.</p>`}
    </div>`;
  }).join('')}</div>` : `<div class="panel empty"><p>No one has signed in yet.</p></div>`}`;
}

/* ---------- Events (delegated from app.js) ---------- */

export async function onClick(el, a, id) {
  switch (a) {
    case 'g-new':
      openGroup(null);
      if (go({ name: 'groupEdit' })) setTimeout(() => document.querySelector('[data-gp=name]')?.focus(), 50);
      break;
    case 'g-edit':
      openGroup(id);
      gdraft.dirty = false;
      go({ name: 'groupEdit', groupId: id });
      break;
    case 'g-cancel':
      if (gdraft?.dirty && !leaveArmed) {
        leaveArmed = true;
        toast('Tap Discard again to drop your changes.');
        setTimeout(() => (leaveArmed = false), 4000);
        return;
      }
      gdraft = null;
      leaveArmed = false;
      go({ name: 'groups' });
      break;
    case 'g-preset': {
      const p = PRESETS.find((x) => x.key === el.dataset.preset);
      gdraft.access[el.dataset.key] = { ...p.level };
      setDirty();
      renderMain();
      break;
    }
    case 'g-save':
      await saveDraft();
      break;
    case 'g-del':
      if (!confirmDel) { confirmDel = true; renderMain(); return; }
      try {
        await deleteGroup(gdraft.id);
        toast('Group deleted. Members’ access was updated.');
        gdraft = null;
        go({ name: 'groups' }, false);
      } catch (e) {
        console.error(e);
        toast('Delete failed. Try again.');
      }
      break;
    case 'g-recompute':
      try {
        await recomputeAllAccess();
        toast('Access recalculated for everyone.');
      } catch (e) {
        console.error(e);
        toast('Recalculating failed. Try again.');
      }
      break;
  }
}

async function saveDraft() {
  const g = gdraft;
  if (!g.name.trim()) {
    toast('Give the group a name first.');
    document.querySelector('[data-gp=name]')?.focus();
    return;
  }
  const access = {};
  for (const [k, l] of Object.entries(g.access)) {
    if (!l || (!l.view && !l.edit)) continue;
    access[k] = normalize(l);
  }
  if (!access['*']) access['*'] = { ...NONE };
  try {
    await saveGroup({ id: g.id, name: g.name.trim(), description: g.description.trim(), access }, g.members);
    g.access = access;
    g.dirty = false;
    g.isNew = false;
    toast(`Saved. ${g.members.length} member${g.members.length === 1 ? '' : 's'} updated.`);
    renderMain();
  } catch (e) {
    console.error(e);
    toast(e?.code === 'permission-denied' ? 'Only administrators can change groups.' : 'Saving failed. Check your connection and try again.');
  }
}

export function onInput(t) {
  if (t.dataset.gp && gdraft) {
    gdraft[t.dataset.gp] = t.value;
    setDirty();
  }
}

export async function onChange(t) {
  if (t.dataset.gacc != null && gdraft) {
    const key = t.dataset.gacc;
    const dim = t.dataset.dim;
    const def = normalize(gdraft.access['*'] || NONE);
    let cur = gdraft.access[key] ? { ...gdraft.access[key] } : key === '*' ? { ...def } : {};
    if (t.value === '') delete cur[dim];
    else cur[dim] = t.value;
    if (key !== '*' && !cur.view && !cur.edit) {
      delete gdraft.access[key];
    } else {
      cur = { view: cur.view || def.view, edit: cur.edit || def.edit };
      if (dim === 'view' && cur.view === 'none') cur.edit = 'none';
      if (LEVELS.indexOf(cur.edit) > LEVELS.indexOf(cur.view)) cur.view = cur.edit;
      gdraft.access[key] = cur;
    }
    setDirty();
    renderMain();
    return;
  }
  if (t.dataset.gmember && gdraft) {
    const id = t.dataset.gmember;
    gdraft.members = gdraft.members.filter((m) => m !== id).concat(t.checked ? [id] : []);
    setDirty();
    renderMain();
    return;
  }
  if (t.dataset.urole) {
    try {
      await setUserRole(t.dataset.urole, t.value);
      toast(t.value === 'admin' ? 'Now an administrator.' : 'Now a member.');
    } catch (e) {
      console.error(e);
      toast('Could not change the role. Try again.');
      render();
    }
    return;
  }
  if (t.dataset.ugroup) {
    const u = store.users.find((x) => x.id === t.dataset.ugroup);
    if (!u) return;
    const groups = (u.groups || []).filter((g) => g !== t.value).concat(t.checked ? [t.value] : []);
    try {
      await setUserGroups(u.id, groups);
      toast('Access updated.');
    } catch (e) {
      console.error(e);
      toast('Could not update groups. Try again.');
      render();
    }
  }
}
