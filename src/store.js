// Data layer: Firestore subscriptions, writes, and Storage uploads.
// The UI reads the synchronous arrays on `store` and re-renders when `store.onChange` fires.

import { db, storage } from './firebase.js';
import {
  collection,
  doc,
  query,
  where,
  onSnapshot,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { isAdmin, formLevel, effectiveAccess } from './access.js';
import { clone } from './util.js';

export const store = {
  mode: 'cloud',
  ready: false,
  user: null, // Firebase Auth user
  me: null, // users/{uid} document + uid
  forms: [],
  records: [],
  profiles: {},
  groups: [],
  users: [],
  recordsLoading: new Set(),
  onChange: () => {},
  onError: () => {},
  put,
  del,
};

let baseUnsubs = [];
let adminUnsubs = [];
const recordSubs = new Map(); // formId -> { key, unsub }
const recordsByForm = new Map(); // formId -> records[]
const got = { forms: false, me: false };

const fail = (where) => (err) => {
  console.error(`[formwright] ${where}`, err);
  store.onError(err, where);
};

function changed() {
  if (!store.ready && got.forms && got.me) store.ready = true;
  if (store.ready) store.onChange();
}

/** Create users/{uid} and profiles/{uid} on first sign-in. */
export async function ensureAccount(user) {
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    await setDoc(userRef, {
      email: user.email || '',
      displayName: user.displayName || '',
      role: 'member',
      groups: [],
      access: {},
      createdAt: Date.now(),
    });
  }
  const name = user.displayName || (user.email || '').split('@')[0] || 'User';
  try {
    await setDoc(doc(db, 'profiles', user.uid), { displayName: name });
  } catch (e) {
    console.warn('[formwright] profile not saved', e);
  }
}

export function startData(user) {
  stopData();
  store.user = user;
  store.ready = false;
  got.forms = got.me = false;

  baseUnsubs.push(
    onSnapshot(
      doc(db, 'users', user.uid),
      (s) => {
        store.me = s.exists() ? { uid: user.uid, ...s.data() } : null;
        got.me = true;
        syncAdminSubs();
        syncRecordSubs();
        changed();
      },
      fail('your account')
    )
  );
  baseUnsubs.push(
    onSnapshot(
      collection(db, 'forms'),
      (s) => {
        store.forms = s.docs.map((d) => ({ ...d.data(), id: d.id }));
        got.forms = true;
        syncRecordSubs();
        changed();
      },
      fail('forms')
    )
  );
  baseUnsubs.push(
    onSnapshot(
      collection(db, 'profiles'),
      (s) => {
        store.profiles = Object.fromEntries(s.docs.map((d) => [d.id, d.data()]));
        changed();
      },
      fail('profiles')
    )
  );
}

export function stopData() {
  baseUnsubs.forEach((u) => u());
  baseUnsubs = [];
  adminUnsubs.forEach((u) => u());
  adminUnsubs = [];
  recordSubs.forEach((s) => s.unsub());
  recordSubs.clear();
  recordsByForm.clear();
  Object.assign(store, { ready: false, user: null, me: null, forms: [], records: [], profiles: {}, groups: [], users: [] });
  store.recordsLoading.clear();
}

function syncAdminSubs() {
  const admin = isAdmin(store.me);
  if (admin && !adminUnsubs.length) {
    adminUnsubs.push(
      onSnapshot(
        collection(db, 'groups'),
        (s) => {
          store.groups = s.docs.map((d) => ({ ...d.data(), id: d.id }));
          changed();
        },
        fail('groups')
      )
    );
    adminUnsubs.push(
      onSnapshot(
        collection(db, 'users'),
        (s) => {
          store.users = s.docs.map((d) => ({ ...d.data(), id: d.id }));
          changed();
        },
        fail('users')
      )
    );
  } else if (!admin && adminUnsubs.length) {
    adminUnsubs.forEach((u) => u());
    adminUnsubs = [];
    store.groups = [];
    store.users = [];
  }
}

/**
 * Subscribe to the records the person may see, one query per form.
 * "all" -> every record of the form; "own" -> only records they own.
 * Queries must match the security rules exactly or Firestore rejects them.
 */
function syncRecordSubs() {
  if (!store.user || !got.me) return;
  const uidNow = store.user.uid;
  const want = new Map();
  for (const f of store.forms) {
    const view = formLevel(store.me, f.id).view;
    if (view !== 'none') want.set(f.id, view);
  }
  for (const [formId, sub] of recordSubs) {
    if (want.get(formId) !== sub.key) {
      sub.unsub();
      recordSubs.delete(formId);
      recordsByForm.delete(formId);
    }
  }
  for (const [formId, view] of want) {
    if (recordSubs.has(formId)) continue;
    const base = collection(db, 'records');
    const q =
      view === 'all'
        ? query(base, where('formId', '==', formId))
        : query(base, where('formId', '==', formId), where('ownerId', '==', uidNow));
    store.recordsLoading.add(formId);
    const unsub = onSnapshot(
      q,
      (s) => {
        recordsByForm.set(
          formId,
          s.docs.map((d) => ({ ...d.data(), id: d.id }))
        );
        store.recordsLoading.delete(formId);
        flattenRecords();
        changed();
      },
      (err) => {
        store.recordsLoading.delete(formId);
        fail(`records for form ${formId}`)(err);
      }
    );
    recordSubs.set(formId, { key: view, unsub });
  }
  flattenRecords();
}

function flattenRecords() {
  store.records = [...recordsByForm.values()].flat();
}

/** Update the display name other people see. */
export async function saveProfileName(userId, displayName) {
  await setDoc(doc(db, 'profiles', userId), { displayName: String(displayName).slice(0, 120) });
}

/* ---------- Writes ---------- */

const plain = (o) => JSON.parse(JSON.stringify(o ?? null));

async function put(col, obj) {
  if (col === 'records') return putRecord(obj);
  const data = plain(obj);
  delete data.id;
  await setDoc(doc(db, col, obj.id), data);
}

async function del(col, id) {
  await deleteDoc(doc(db, col, id));
}

/** Save a record, stamping ownership. Owner and creator never change after creation. */
export async function putRecord(rec) {
  const me = store.user.uid;
  const existing = store.records.find((r) => r.id === rec.id);
  const now = Date.now();
  const data = {
    formId: rec.formId,
    values: plain(rec.values || {}),
    parentId: rec.parentId || null,
    parentFormId: rec.parentFormId || null,
    ownerId: existing?.ownerId || me,
    createdBy: existing?.createdBy || me,
    createdAt: existing?.createdAt || rec.createdAt || now,
    updatedAt: rec.updatedAt || now,
    updatedBy: me,
  };
  await setDoc(doc(db, 'records', rec.id), data);
}

/** Commit many writes in chunks under Firestore's 500-operation batch limit. */
async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    ops.slice(i, i + 450).forEach((op) => op(batch));
    await batch.commit();
  }
}

/** Admin: delete a form, its records, and references to it from other forms. */
export async function deleteFormCascade(formId) {
  const ops = [];
  store.records
    .filter((r) => r.formId === formId)
    .forEach((r) => ops.push((b) => b.delete(doc(db, 'records', r.id))));
  store.forms
    .filter((f) => f.id !== formId && (f.children || []).some((c) => c.formId === formId))
    .forEach((f) =>
      ops.push((b) => b.update(doc(db, 'forms', f.id), { children: f.children.filter((c) => c.formId !== formId) }))
    );
  ops.push((b) => b.delete(doc(db, 'forms', formId)));
  await commitOps(ops);
}

/** Admin: load the example forms and records. */
export async function loadExamples(examples) {
  const me = store.user.uid;
  const ops = [];
  examples.forms.forEach((f) => {
    const d = clone(f);
    delete d.id;
    ops.push((b) => b.set(doc(db, 'forms', f.id), d));
  });
  examples.records.forEach((r) => {
    const d = {
      formId: r.formId,
      values: r.values,
      parentId: r.parentId || null,
      parentFormId: r.parentFormId || null,
      ownerId: me,
      createdBy: me,
      createdAt: r.createdAt || Date.now(),
      updatedAt: r.updatedAt || Date.now(),
      updatedBy: me,
    };
    ops.push((b) => b.set(doc(db, 'records', r.id), d));
  });
  await commitOps(ops);
}

/* ---------- Files ---------- */

export async function uploadFile(file, formId) {
  const me = store.user.uid;
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
  const path = `uploads/${formId}/${me}/${Date.now()}-${safe}`;
  const r = ref(storage, path);
  await uploadBytes(r, file, { contentType: file.type || 'application/octet-stream' });
  const url = await getDownloadURL(r);
  return { name: file.name, size: file.size, type: file.type, path, url };
}

/* ---------- Admin: users and groups ---------- */

function accessFor(groupIds, groups) {
  return effectiveAccess(groups.filter((g) => groupIds.includes(g.id)));
}

/**
 * Save a group and its membership, then recompute effective access for every
 * person whose membership or permissions changed.
 */
export async function saveGroup(group, memberIds) {
  const data = plain({ name: group.name, description: group.description || '', access: group.access || {}, updatedAt: Date.now() });
  const groupsAfter = store.groups.filter((g) => g.id !== group.id).concat([{ ...data, id: group.id }]);
  const ops = [(b) => b.set(doc(db, 'groups', group.id), data)];
  for (const u of store.users) {
    const had = (u.groups || []).includes(group.id);
    const has = memberIds.includes(u.id);
    if (!had && !has) continue;
    const groups = (u.groups || []).filter((g) => g !== group.id).concat(has ? [group.id] : []);
    ops.push((b) => b.update(doc(db, 'users', u.id), { groups, access: accessFor(groups, groupsAfter) }));
  }
  await commitOps(ops);
}

export async function deleteGroup(groupId) {
  const groupsAfter = store.groups.filter((g) => g.id !== groupId);
  const ops = [(b) => b.delete(doc(db, 'groups', groupId))];
  for (const u of store.users) {
    if (!(u.groups || []).includes(groupId)) continue;
    const groups = u.groups.filter((g) => g !== groupId);
    ops.push((b) => b.update(doc(db, 'users', u.id), { groups, access: accessFor(groups, groupsAfter) }));
  }
  await commitOps(ops);
}

export async function setUserGroups(userId, groupIds) {
  await updateDoc(doc(db, 'users', userId), { groups: groupIds, access: accessFor(groupIds, store.groups) });
}

export async function setUserRole(userId, role) {
  await updateDoc(doc(db, 'users', userId), { role });
}

/** Recompute everyone's access from their groups (repair tool). */
export async function recomputeAllAccess() {
  const ops = store.users.map((u) => (b) =>
    b.update(doc(db, 'users', u.id), { access: accessFor(u.groups || [], store.groups) })
  );
  await commitOps(ops);
}
