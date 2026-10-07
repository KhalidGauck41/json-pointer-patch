import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, add, remove, applyPatch, PatchError } from '../src/core.js';

// --- get: basic navigation ------------------------------------------------

test('get returns the root document for the empty pointer', () => {
  const doc = { a: 1 };
  assert.equal(get(doc, ''), doc);
});

test('get reads a single-level object key', () => {
  assert.equal(get({ a: 1 }, '/a'), 1);
});

test('get reads a nested object path', () => {
  assert.equal(get({ a: { b: { c: 42 } } }, '/a/b/c'), 42);
});

test('get reads array elements by index', () => {
  assert.equal(get({ list: [10, 20, 30] }, '/list/1'), 20);
});

test('get reads nested arrays and objects together', () => {
  const doc = { users: [{ name: 'alice' }, { name: 'bob' }] };
  assert.equal(get(doc, '/users/1/name'), 'bob');
});

test('get returns undefined for a missing object key', () => {
  assert.equal(get({ a: 1 }, '/b'), undefined);
});

test('get returns undefined when descending past a scalar', () => {
  assert.equal(get({ a: 5 }, '/a/b'), undefined);
});

test('get returns undefined for an out-of-bounds array index', () => {
  assert.equal(get({ list: [1, 2] }, '/list/9'), undefined);
});

test('get throws on a non-numeric token for an array', () => {
  assert.throws(
    () => get({ list: [1, 2] }, '/list/x'),
    (e) => e instanceof PatchError,
  );
});

test('get decodes ~1 to "/" and ~0 to "~" in object keys', () => {
  const doc = { 'a/b': 1, 'a~b': 2, 'a~0b': 3 };
  assert.equal(get(doc, '/a~1b'), 1);
  assert.equal(get(doc, '/a~0b'), 2);
  assert.equal(get(doc, '/a~00b'), 3);
});

test('get addresses the empty-string key via "/"', () => {
  assert.equal(get({ '': 'empty' }, '/'), 'empty');
});

test('get throws on a pointer that does not start with "/"', () => {
  assert.throws(
    () => get({ a: 1 }, 'a'),
    (e) => e instanceof PatchError,
  );
});

// --- add: object and array semantics --------------------------------------

test('add overwrites an existing object key', () => {
  const doc = { a: 1 };
  const out = add(doc, '/a', 2);
  assert.deepEqual(out, { a: 2 });
  // original not mutated
  assert.deepEqual(doc, { a: 1 });
});

test('add creates a new object key', () => {
  const out = add({ a: 1 }, '/b', 2);
  assert.deepEqual(out, { a: 1, b: 2 });
});

test('add inserts into an array at an existing index, shifting right', () => {
  const out = add({ list: [1, 2, 3] }, '/list/1', 99);
  assert.deepEqual(out, { list: [1, 99, 2, 3] });
});

test('add appends to an array with the "-" token', () => {
  const out = add({ list: [1, 2] }, '/list/-', 3);
  assert.deepEqual(out, { list: [1, 2, 3] });
});

test('add at an index equal to length appends in place', () => {
  const out = add({ list: [1, 2] }, '/list/2', 3);
  assert.deepEqual(out, { list: [1, 2, 3] });
});

test('add at an index past length throws', () => {
  assert.throws(
    () => add({ list: [1, 2] }, '/list/5', 9),
    (e) => e instanceof PatchError,
  );
});

test('add replaces the whole document at root pointer', () => {
  const out = add({ a: 1 }, '', { b: 2 });
  assert.deepEqual(out, { b: 2 });
});

test('add creates nested objects as needed is NOT supported; missing key throws', () => {
  // We chose strict parenting: locateParent throws on a missing key.
  assert.throws(
    () => add({}, '/a/b', 1),
    (e) => e instanceof PatchError,
  );
});

test('add does not mutate the input value (defensive clone)', () => {
  const value = { x: 1 };
  const out = add({}, '/a', value);
  value.x = 999;
  assert.equal(out.a.x, 1);
});

// --- remove: object, array, and root --------------------------------------

test('remove deletes an object key', () => {
  const doc = { a: 1, b: 2 };
  const out = remove(doc, '/a');
  assert.deepEqual(out, { b: 2 });
  assert.deepEqual(doc, { a: 1, b: 2 });
});

test('remove splices an array element out', () => {
  const out = remove({ list: [1, 2, 3] }, '/list/1');
  assert.deepEqual(out, { list: [1, 3] });
});

test('remove throws on a missing object key', () => {
  assert.throws(
    () => remove({ a: 1 }, '/b'),
    (e) => e instanceof PatchError,
  );
});

test('remove throws on an out-of-bounds array index', () => {
  assert.throws(
    () => remove({ list: [1, 2] }, '/list/9'),
    (e) => e instanceof PatchError,
  );
});

test('remove throws on "-" for an array', () => {
  assert.throws(
    () => remove({ list: [1, 2] }, '/list/-'),
    (e) => e instanceof PatchError,
  );
});

test('remove at root returns undefined', () => {
  assert.equal(remove({ a: 1 }, ''), undefined);
});

// --- applyPatch: sequencing and error handling ----------------------------

test('applyPatch threads the document through a sequence of adds', () => {
  const ops = [
    { op: 'add', path: '/a', value: 1 },
    { op: 'add', path: '/b', value: 2 },
  ];
  const results = applyPatch({}, ops);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[1].doc, { a: 1, b: 2 });
});

test('applyPatch continues after an error and records each result', () => {
  const ops = [
    { op: 'add', path: '/a', value: 1 },
    { op: 'remove', path: '/missing' },
    { op: 'add', path: '/b', value: 2 },
  ];
  const results = applyPatch({}, ops);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.ok(results[1].error instanceof PatchError);
  assert.equal(results[2].ok, true);
  assert.deepEqual(results[2].doc, { a: 1, b: 2 });
});

test('applyPatch rejects an unsupported op', () => {
  const results = applyPatch({}, [{ op: 'replace', path: '/a', value: 1 }]);
  assert.equal(results[0].ok, false);
  assert.ok(results[0].error instanceof PatchError);
});

test('applyPatch throws on a non-array operations argument', () => {
  assert.throws(
    () => applyPatch({}, { op: 'add', path: '/a', value: 1 }),
    TypeError,
  );
});

test('applyPatch does not mutate the input document', () => {
  const doc = { a: 1 };
  applyPatch(doc, [{ op: 'add', path: '/b', value: 2 }]);
  assert.deepEqual(doc, { a: 1 });
});

// --- strict index parsing --------------------------------------------------

test('array index "0" is valid', () => {
  assert.equal(get({ list: ['zero', 'one'] }, '/list/0'), 'zero');
});

test('array index "01" is rejected as non-numeric', () => {
  assert.throws(
    () => get({ list: [1, 2] }, '/list/01'),
    (e) => e instanceof PatchError,
  );
});

// --- decoding edge ---------------------------------------------------------

test('"~01" decodes to "~1" (tilde-one), not "/1"', () => {
  // Order: ~1 -> / first would give "/1"; but we do ~1 then ~0, so "~01"
  // becomes "~1" (the "~0" decodes to "~", leaving "1" intact).
  // Actually: input token "~01". After ~1->/: "/1". After ~0->~: "~1".
  // Wait, that is wrong: ~1 is applied first, so "~01" -> "/1" -> ???
  // The correct decode order is ~1 THEN ~0, and "~01" has no "~1" substring
  // because it is "~0" followed by "1". So ~1 does not match, ~0 decodes
  // to "~", giving "~1". Let's test that precisely.
  const doc = { '~1': 'value' };
  assert.equal(get(doc, '/~01'), 'value');
});
