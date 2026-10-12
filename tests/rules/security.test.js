// Security rules tests. Run with:  npm run test:rules
// (starts the Firestore and Storage emulators; needs Java 11+).

import { readFileSync } from 'node:fs';
import { before, after, beforeEach, describe, test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { ref, uploadString, getMetadata } from 'firebase/storage';

const OWN = { view: 'own', edit: 'own' };
const ALL = { view: 'all', edit: 'all' };
const READ = { view: 'all', edit: 'none' };
const NONE = { view: 'none', edit: 'none' };

const people = {
  admin: { role: 'admin', access: {} },
  alice: { role: 'member', access: { '*': OWN } }, // field staff: mine only
  bob: { role: 'member', access: { '*': OWN } },
  olivia: { role: 'member', access: { '*': ALL } }, // office: everything
  vera: { role: 'member', access: { '*': READ } }, // viewer: read only
  ned: { role: 'member', access: { '*': NONE } }, // no access
  mixed: { role: 'member', access: { '*': NONE, f_jobs: { view: 'all', edit: 'own' } } },
};

const record = (ownerId, extra = {}) => ({
  formId: 'f_jobs',
  values: { title: 'Job' },
  parentId: null,
  parentFormId: null,
  ownerId,
  createdBy: ownerId,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: ownerId,
  ...extra,
});

let env;
const as = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.com` });
const db = (uid) => as(uid).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-formwright',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    for (const [uid, p] of Object.entries(people)) {
      await setDoc(doc(d, 'users', uid), { email: `${uid}@example.com`, displayName: uid, groups: [], createdAt: 1, ...p });
    }
    await setDoc(doc(d, 'forms', 'f_jobs'), { name: 'Jobs', fields: [] });
    await setDoc(doc(d, 'forms', 'f_other'), { name: 'Other', fields: [] });
    await setDoc(doc(d, 'records', 'r_alice'), record('alice'));
    await setDoc(doc(d, 'records', 'r_bob'), record('bob'));
  });
});

describe('records: view and edit mine only', () => {
  test('reads own record, not someone else’s', async () => {
    await assertSucceeds(getDoc(doc(db('alice'), 'records', 'r_alice')));
    await assertFails(getDoc(doc(db('alice'), 'records', 'r_bob')));
  });

  test('list query must filter to own records', async () => {
    const col = collection(db('alice'), 'records');
    await assertSucceeds(getDocs(query(col, where('formId', '==', 'f_jobs'), where('ownerId', '==', 'alice'))));
    await assertFails(getDocs(query(col, where('formId', '==', 'f_jobs'))));
  });

  test('creates records only as themselves', async () => {
    await assertSucceeds(setDoc(doc(db('alice'), 'records', 'r_new'), record('alice')));
    await assertFails(setDoc(doc(db('alice'), 'records', 'r_fake'), record('bob', { updatedBy: 'alice' })));
  });

  test('edits and deletes only own records', async () => {
    await assertSucceeds(updateDoc(doc(db('alice'), 'records', 'r_alice'), { values: { title: 'Changed' }, updatedBy: 'alice' }));
    await assertFails(updateDoc(doc(db('alice'), 'records', 'r_bob'), { values: { title: 'Hijack' }, updatedBy: 'alice' }));
    await assertFails(deleteDoc(doc(db('alice'), 'records', 'r_bob')));
    await assertSucceeds(deleteDoc(doc(db('alice'), 'records', 'r_alice')));
  });

  test('cannot give a record away or move it to another form', async () => {
    await assertFails(updateDoc(doc(db('alice'), 'records', 'r_alice'), { ownerId: 'bob', updatedBy: 'alice' }));
    await assertFails(updateDoc(doc(db('alice'), 'records', 'r_alice'), { formId: 'f_other', updatedBy: 'alice' }));
  });

  test('must stamp updatedBy with their own id', async () => {
    await assertFails(updateDoc(doc(db('alice'), 'records', 'r_alice'), { values: {}, updatedBy: 'bob' }));
  });
});

describe('records: view and edit all', () => {
  test('reads every record with a form query', async () => {
    await assertSucceeds(getDocs(query(collection(db('olivia'), 'records'), where('formId', '==', 'f_jobs'))));
  });

  test('edits other people’s records but keeps their ownership', async () => {
    await assertSucceeds(updateDoc(doc(db('olivia'), 'records', 'r_bob'), { values: { title: 'Fixed' }, updatedBy: 'olivia' }));
    await assertFails(updateDoc(doc(db('olivia'), 'records', 'r_bob'), { ownerId: 'olivia', updatedBy: 'olivia' }));
  });
});

describe('records: read only, mixed and none', () => {
  test('read-only member can view but not change or create', async () => {
    await assertSucceeds(getDoc(doc(db('vera'), 'records', 'r_bob')));
    await assertFails(updateDoc(doc(db('vera'), 'records', 'r_bob'), { values: {}, updatedBy: 'vera' }));
    await assertFails(setDoc(doc(db('vera'), 'records', 'r_v'), record('vera')));
  });

  test('view all, edit mine', async () => {
    await assertSucceeds(getDoc(doc(db('mixed'), 'records', 'r_bob')));
    await assertFails(updateDoc(doc(db('mixed'), 'records', 'r_bob'), { values: {}, updatedBy: 'mixed' }));
    await assertSucceeds(setDoc(doc(db('mixed'), 'records', 'r_m'), record('mixed')));
  });

  test('member with no access sees nothing', async () => {
    await assertFails(getDoc(doc(db('ned'), 'records', 'r_alice')));
    await assertFails(getDocs(query(collection(db('ned'), 'records'), where('formId', '==', 'f_jobs'))));
    await assertFails(setDoc(doc(db('ned'), 'records', 'r_n'), record('ned')));
  });

  test('records need an existing form', async () => {
    await assertFails(setDoc(doc(db('olivia'), 'records', 'r_x'), record('olivia', { formId: 'f_missing' })));
  });

  test('unknown fields are rejected', async () => {
    await assertFails(setDoc(doc(db('alice'), 'records', 'r_y'), record('alice', { isAdmin: true })));
  });

  test('signed-out visitors see nothing', async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'records', 'r_alice')));
    await assertFails(getDoc(doc(anon, 'forms', 'f_jobs')));
  });
});

describe('administrators', () => {
  test('see and edit everything', async () => {
    await assertSucceeds(getDocs(query(collection(db('admin'), 'records'), where('formId', '==', 'f_jobs'))));
    await assertSucceeds(updateDoc(doc(db('admin'), 'records', 'r_bob'), { values: {}, updatedBy: 'admin' }));
  });

  test('only admins change forms and groups', async () => {
    await assertSucceeds(getDoc(doc(db('alice'), 'forms', 'f_jobs')));
    await assertFails(updateDoc(doc(db('alice'), 'forms', 'f_jobs'), { name: 'Mine now' }));
    await assertSucceeds(updateDoc(doc(db('admin'), 'forms', 'f_jobs'), { name: 'Jobs 2' }));
    await assertFails(setDoc(doc(db('olivia'), 'groups', 'g1'), { name: 'Sneaky', access: {} }));
    await assertSucceeds(setDoc(doc(db('admin'), 'groups', 'g1'), { name: 'Office', access: { '*': ALL } }));
  });

  test('only admins change roles, groups and access', async () => {
    await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { role: 'admin' }));
    await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { access: { '*': ALL } }));
    await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { groups: ['g1'] }));
    await assertSucceeds(updateDoc(doc(db('alice'), 'users', 'alice'), { displayName: 'Alice B' }));
    await assertSucceeds(updateDoc(doc(db('admin'), 'users', 'alice'), { access: { '*': ALL } }));
  });

  test('members cannot read other people’s accounts', async () => {
    await assertFails(getDoc(doc(db('alice'), 'users', 'bob')));
    await assertSucceeds(getDoc(doc(db('alice'), 'users', 'alice')));
    await assertSucceeds(getDoc(doc(db('admin'), 'users', 'bob')));
  });
});

describe('new accounts', () => {
  const fresh = (extra = {}) => ({ email: 'new@example.com', displayName: 'New', role: 'member', groups: [], access: {}, createdAt: 1, ...extra });

  test('start as members with no access', async () => {
    await assertSucceeds(setDoc(doc(db('new'), 'users', 'new'), fresh()));
  });

  test('cannot start as admin, with groups, or with access', async () => {
    await assertFails(setDoc(doc(db('new'), 'users', 'new'), fresh({ role: 'admin' })));
    await assertFails(setDoc(doc(db('new'), 'users', 'new'), fresh({ groups: ['g1'] })));
    await assertFails(setDoc(doc(db('new'), 'users', 'new'), fresh({ access: { '*': ALL } })));
  });

  test('cannot create someone else’s account', async () => {
    await assertFails(setDoc(doc(db('new'), 'users', 'other'), fresh()));
  });

  test('profiles: everyone reads, each person writes their own', async () => {
    await assertSucceeds(setDoc(doc(db('alice'), 'profiles', 'alice'), { displayName: 'Alice' }));
    await assertFails(setDoc(doc(db('alice'), 'profiles', 'bob'), { displayName: 'Not Bob' }));
    await assertSucceeds(getDoc(doc(db('bob'), 'profiles', 'alice')));
  });
});

describe('storage uploads', () => {
  const path = (formId, owner) => `uploads/${formId}/${owner}/file.txt`;

  test('upload only into your own folder, on forms you can edit', async () => {
    await assertSucceeds(uploadString(ref(as('alice').storage(), path('f_jobs', 'alice')), 'hi'));
    await assertFails(uploadString(ref(as('alice').storage(), path('f_jobs', 'bob')), 'hi'));
    await assertFails(uploadString(ref(as('vera').storage(), path('f_jobs', 'vera')), 'hi'));
    await assertFails(uploadString(ref(as('ned').storage(), path('f_jobs', 'ned')), 'hi'));
  });

  test('read follows view access', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadString(ref(ctx.storage(), path('f_jobs', 'bob')), 'hi');
    });
    await assertSucceeds(getMetadata(ref(as('vera').storage(), path('f_jobs', 'bob'))));
    await assertSucceeds(getMetadata(ref(as('bob').storage(), path('f_jobs', 'bob'))));
    await assertFails(getMetadata(ref(as('alice').storage(), path('f_jobs', 'bob'))));
    await assertFails(getMetadata(ref(as('ned').storage(), path('f_jobs', 'bob'))));
  });
});
