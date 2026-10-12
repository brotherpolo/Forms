import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAccess, levelFor, normalize, formLevel, canViewRecord, canEditRecord, canCreate } from '../../src/access.js';

const field = { id: 'g1', access: { '*': { view: 'own', edit: 'own' } } };
const office = { id: 'g2', access: { '*': { view: 'all', edit: 'all' }, f_secret: { view: 'none', edit: 'none' } } };
const readers = { id: 'g3', access: { '*': { view: 'none', edit: 'none' }, f_reports: { view: 'all', edit: 'none' } } };

test('editing implies seeing', () => {
  assert.deepEqual(normalize({ view: 'none', edit: 'own' }), { view: 'own', edit: 'own' });
  assert.deepEqual(normalize({ view: 'all', edit: 'none' }), { view: 'all', edit: 'none' });
});

test('per-form entries fall back to the default', () => {
  assert.deepEqual(levelFor(office.access, 'f_other'), { view: 'all', edit: 'all' });
  assert.deepEqual(levelFor(office.access, 'f_secret'), { view: 'none', edit: 'none' });
  assert.deepEqual(levelFor({}, 'f_any'), { view: 'none', edit: 'none' });
});

test('the most generous group wins, form by form', () => {
  const eff = effectiveAccess([field, readers]);
  assert.deepEqual(levelFor(eff, 'f_jobs'), { view: 'own', edit: 'own' });
  assert.deepEqual(levelFor(eff, 'f_reports'), { view: 'all', edit: 'own' });
});

test('an exception in one group does not undo another group', () => {
  const eff = effectiveAccess([office, field]);
  assert.deepEqual(levelFor(eff, 'f_secret'), { view: 'own', edit: 'own' });
});

test('no groups means no access', () => {
  assert.deepEqual(effectiveAccess([]), { '*': { view: 'none', edit: 'none' } });
});

test('record checks', () => {
  const me = { uid: 'u1', role: 'member', access: effectiveAccess([field]) };
  const mine = { formId: 'f_jobs', ownerId: 'u1' };
  const theirs = { formId: 'f_jobs', ownerId: 'u2' };
  assert.equal(canViewRecord(me, mine), true);
  assert.equal(canViewRecord(me, theirs), false);
  assert.equal(canEditRecord(me, mine), true);
  assert.equal(canEditRecord(me, theirs), false);
  assert.equal(canCreate(me, 'f_jobs'), true);

  const viewer = { uid: 'u3', role: 'member', access: effectiveAccess([readers]) };
  assert.equal(canViewRecord(viewer, { formId: 'f_reports', ownerId: 'u1' }), true);
  assert.equal(canEditRecord(viewer, { formId: 'f_reports', ownerId: 'u3' }), false);
  assert.equal(canCreate(viewer, 'f_reports'), false);
});

test('administrators have full access', () => {
  assert.deepEqual(formLevel({ uid: 'a', role: 'admin', access: {} }, 'anything'), { view: 'all', edit: 'all' });
});
