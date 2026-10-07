# JSON Pointer Patch

Apply RFC 6901 JSON Pointer `add` and `remove` operations to plain JavaScript objects and arrays. Read values with `get`. No dependencies, ESM only.

```js
import { get, add, remove, applyPatch } from 'json-pointer-patch';

const doc = { users: [{ name: 'alice' }, { name: 'bob' }] };

// Read
get(doc, '/users/1/name'); // 'bob'

// Write (returns a new document; never mutates the input)
const withCarol = add(doc, '/users/-', { name: 'carol' });

// Delete
const withoutBob = remove(doc, '/users/1');

// Sequence
const results = applyPatch(doc, [
  { op: 'add', path: '/users/-', value: { name: 'carol' } },
  { op: 'remove', path: '/users/0' },
]);
```

## Why this exists

A common need when working with parsed JSON configuration files is to surgically read, write, or delete one nested value by path. Full RFC 6902 patch libraries exist, but they drag in transactional semantics, six operations, and frequently a dependency tree. This library implements exactly the two operations that matter for editing config in place — `add` (set or insert) and `remove` (delete) — plus `get` for reading, and a thin `applyPatch` wrapper for sequences. The trade-off: you do not get `replace`, `move`, `copy`, or `test`, and you do not get all-or-nothing transactions. You get a small, predictable, no-dependency tool whose behaviour you can hold in your head.

## Decisions you will hit

- **Only `add` and `remove` are implemented.** `applyPatch` will reject `replace`, `move`, `copy`, and `test` with a `PatchError`. If you need those, use a full RFC 6902 library.
- **`applyPatch` is not transactional.** It applies operations in order and reports a result per operation. A failure does not abort the sequence; the caller decides whether to stop at the first `{ ok: false }`. This deviates from RFC 6902's all-or-nothing contract, deliberately.
- **Inputs are never mutated.** `add`, `remove`, and `applyPatch` all clone the document before touching it. The value passed to `add` is also cloned, so later mutation of the caller's original cannot leak into the patched document.
- **Array indices are strict.** `"0"` is valid; `"01"`, `"-0"`, `"+0"`, `"0x1"` are rejected as non-numeric and will throw. This avoids ambiguity between object keys and array indices.
- **The `"-"` token means append for `add` only.** `remove` with `"-"` throws, because `"-"` names no existing element.
- **Missing intermediate keys throw.** `add` does not auto-create intermediate objects along the path; `locateParent` throws a `PatchError` on a missing key. Auto-creation was rejected because it hides typos.
- **Fragments are not supported.** Pointers must begin with `/` or be empty. Strip any leading `#` yourself; we do not guess intent.

## Exports

- `get(doc, pointer)` — read the value at a pointer; returns `undefined` for missing keys.
- `add(doc, pointer, value)` — set or insert a value; returns a new document.
- `remove(doc, pointer)` — delete a value; returns a new document.
- `applyPatch(doc, operations)` — apply an array of `{ op, path, value }` operations; returns `{ ok, doc } | { ok, error }` per operation.
- `PatchError` — thrown for all pointer resolution failures; subclasses `Error`.

## Tests

```
node --test
```
