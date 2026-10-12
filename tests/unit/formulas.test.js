import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FX } from '../../src/formulas.js';

const values = { Price: 12.5, Qty: 4, Hours: 0, Name: 'Ada', Start: '2026-10-01', End: '2026-10-12', Paid: true, Tags: ['a', 'b'] };
const ctx = (extra = {}) => ({
  ref: (n) => {
    if (!(n in values)) throw FX.E(`There is no field called {${n}} on this form.`);
    return values[n];
  },
  family: (fn, a) => (fn === 'CHILDCOUNT' ? 3 : fn === 'CHILDSUM' ? 600 : fn === 'PARENT' ? 99 : 0),
  ...extra,
});
const run = (src, extra) => FX.ev(FX.parse(src), ctx(extra));

test('arithmetic and precedence', () => {
  assert.equal(run('{Price} * {Qty}'), 50);
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('2 ^ 3 ^ 2'), 512);
  assert.equal(run('-{Qty} + 10'), 6);
  assert.equal(run('10 % 4'), 2);
});

test('functions', () => {
  assert.equal(run('ROUND({Price} * 1.13, 2)'), 14.13);
  assert.equal(run('SUM(1, 2, {Qty})'), 7);
  assert.equal(run('AVG(2, 4)'), 3);
  assert.equal(run('MAX({Price}, {Qty})'), 12.5);
  assert.equal(run('IF({Qty} > 3, "bulk", "single")'), 'bulk');
  assert.equal(run('IF(AND({Paid}, {Qty} >= 4), 1, 0)'), 1);
  assert.equal(run('COUNT({Tags})'), 2);
  assert.equal(run('{Name} & " x" & {Qty}'), 'Ada x4');
});

test('dates', () => {
  assert.equal(run('DAYS({End}, {Start})'), 11);
  assert.equal(run('{End} - {Start}'), 11);
});

test('child and parent lookups go through the context', () => {
  assert.equal(run('CHILDSUM("Projects", "Budget") / CHILDCOUNT("Projects")'), 200);
  assert.equal(run('PARENT("Rate") + 1'), 100);
});

test('division by zero is an error, except while checking a formula', () => {
  assert.throws(() => run('{Price} / {Hours}'), /divide by zero/i);
  assert.equal(run('{Price} / {Hours}', { check: true }), 0);
});

test('readable errors', () => {
  assert.throws(() => FX.parse('{Price} * '), /ends too early/);
  assert.throws(() => FX.parse('ROUND({Price}, 2'), /missing its closing/);
  assert.throws(() => FX.parse('FOO(1)'), /no function called FOO/);
  assert.throws(() => FX.parse('{Price} {Qty}'), /missing operator/);
  assert.throws(() => run('{Nope} + 1'), /no field called \{Nope\}/);
});

test('never evaluates JavaScript', () => {
  assert.throws(() => FX.parse('alert(1)'), /no function called ALERT/);
  assert.throws(() => FX.parse('constructor.constructor("x")()'), /./);
});
