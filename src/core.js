/**
 * Core JSON Pointer (RFC 6901) and subset of RFC 6902 Patch operations.
 *
 * Design decisions (stated plainly so the README can defer here):
 *
 * 1. References are resolved against plain JS objects/arrays only. DOM nodes,
 *    Maps, Sets, or class instances are treated as opaque leaves: we never
 *    recurse into them and never invent pointer semantics for them. This keeps
 *    the library a no-dependency, predictable tool for parsed JSON.
 *
 * 2. The root document is addressable as "" (the empty string), per RFC 6901.
 *    A pointer of "" always refers to the whole document, regardless of type.
 *
 * 3. Pointers are strictly RFC 6901: they begin with "/" or are empty.
 *      - ""           -> the root
 *      - "/foo"        -> root.foo
 *      - "/a/b"        -> root.a.b
 *      - "/"           -> root[""] (empty-string key, legal in JSON objects)
 *      - "/a~1b"       -> root["a/b"]   ("~1" decodes to "/")
 *      - "/a~0b"       -> root["a~b"]   ("~0" decodes to "~")
 *    We reject fragments and URI decoding. If a caller has a fragment pointer
 *    ("#/foo"), they must strip the "#" themselves; we do not guess intent.
 *
 * 4. Array indices: a reference token that is a non-negative decimal integer
 *    ("0", "1", "42") addresses an array element. We do NOT accept "+0", "-0",
 *    "01", "0x0", or any surrounding whitespace. Strictness here avoids
 *    ambiguity between object keys and array indices for the values JSON
 *    actually permits as object keys.
 *
 * 5. The special end-of-array token "-" is supported for `add` (append), but
 *    is rejected for `get` and `remove` — it names no existing element.
 *
 * 6. `add` and `remove` are the two patch operations implemented. `replace`,
 *    `move`, `copy`, and `test` are NOT implemented. A user who needs the
 *    full RFC 6902 op set should use a dedicated library; this module is a
 *    small, focused read/write/delete tool, not a full patch engine.
 *
 * 7. `applyPatch` returns an array of results, one per operation, in order.
 *    Each result is `{ ok: true, doc }` on success or `{ ok: false, error }`
 *    on failure. The original document is never mutated; we deep-clone the
 *    input before applying. Failures do not abort the sequence — the caller
 *    can inspect each result. (RFC 6902 says all-or-nothing, but the brief
 *    here is read/write/delete, not transactional patching. We state this
 *    plainly so nobody is surprised.)
 */

/**
 * A PatchError carries the pointer and a short reason. It subclasses Error
 * so callers can `instanceof PatchError` if they want to distinguish
 * pointer failures from unexpected runtime failures.
 */
class PatchError extends Error {
  constructor(message, pointer) {
    super(message);
    this.name = 'PatchError';
    this.pointer = pointer;
  }
}

/**
 * Decode a single reference token per RFC 6901 §4:
 *   "~1" -> "/"
 *   "~0" -> "~"
 * Order matters: we must decode "~1" before "~0" so that "~01" decodes
 * to "~1" (tilde then one), not "/1". Doing "~0" first would turn "~01" into
 * "~1" and then into "/", which is wrong.
 */
function decodeToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Split a JSON Pointer string into reference tokens.
 *
 * Returns `[]` for the root pointer "". Throws PatchError for malformed
 * pointers: anything that does not start with "/" or is not empty is illegal.
 * We deliberately reject "#/foo" and relative pointers; the caller is
 * responsible for stripping fragments.
 */
function parsePointer(pointer) {
  if (typeof pointer !== 'string') {
    throw new PatchError('pointer must be a string', String(pointer));
  }
  if (pointer === '') {
    return [];
  }
  if (pointer.charCodeAt(0) !== 0x2f /* '/' */) {
    throw new PatchError(
      `invalid pointer: must start with "/" or be empty, got ${JSON.stringify(pointer)}`,
      pointer,
    );
  }
  // A pointer of "/" splits to [""], which addresses the empty-string key.
  // String.prototype.split would return [""] for "", which we do not want,
  // so we handle root above and slice the leading "/" here.
  return pointer.slice(1).split('/').map(decodeToken);
}

/**
 * Strict, unforgiving test for an RFC 6901 array index token.
 *
 * We accept exactly the decimal form: optional leading digits, no sign, no
 * decimal point, no exponent, no leading zeros (except the literal "0").
 * "01" is rejected because it is ambiguous with an object key "01"; RFC
 * 6901 treats "01" as an error for array targets, and we follow that.
 */
function isArrayIndex(token) {
  if (token === '0') return true;
  return /^[1-9][0-9]*$/.test(token);
}

/**
 * Structural shallow clone sufficient for JSON values.
 *
 * We only need to clone objects and arrays; primitives and null are
 * immutable and can be shared. We intentionally do NOT use JSON.parse(
 * JSON.stringify(x)) because that would destroy `undefined` values and
 * convert non-JSON types silently. A structural clone keeps the value's
 * identity for primitives and reconstructs containers.
 *
 * This clone is used at the boundary of `applyPatch` so the caller's
 * original document is never mutated by an `add` or `remove`.
 */
function clone(value) {
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = clone(value[i]);
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    // Plain JSON objects clone to plain objects with Object.prototype so
    // deep equality checks against object literals succeed. Class
    // instances (non-Object.prototype) round-trip as themselves.
    const proto = Object.getPrototypeOf(value);
    const out = proto === Object.prototype ? {} : Object.create(proto);
    for (const key of Object.keys(value)) {
      out[key] = clone(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Navigate to the parent of the final token, returning the container and the
 * final key. Used by `add` and `remove` to actually mutate the tree.
 *
 * For the root pointer (""), parent is `null` and key is `undefined`; callers
 * handle that case specially because root operations replace the whole doc.
 */
function locateParent(doc, tokens) {
  if (tokens.length === 0) {
    return { parent: null, finalKey: undefined, isRoot: true };
  }
  let parent = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    if (Array.isArray(parent)) {
      if (!isArrayIndex(tok)) {
        throw new PatchError(
          `cannot index array with non-numeric token ${JSON.stringify(tok)}`,
          rebuildPointer(tokens),
        );
      }
      const idx = Number(tok);
      if (idx >= parent.length) {
        throw new PatchError(
          `index ${idx} out of bounds (length ${parent.length})`,
          rebuildPointer(tokens),
        );
      }
      parent = parent[idx];
    } else if (parent !== null && typeof parent === 'object') {
      if (!Object.prototype.hasOwnProperty.call(parent, tok)) {
        throw new PatchError(
          `missing key ${JSON.stringify(tok)} in object`,
          rebuildPointer(tokens),
        );
      }
      parent = parent[tok];
    } else {
      throw new PatchError(
        `cannot descend into ${describeScalar(parent)} at token ${JSON.stringify(tok)}`,
        rebuildPointer(tokens),
      );
    }
  }
  return { parent, finalKey: tokens[tokens.length - 1], isRoot: false };
}

/**
 * Rebuild a human-readable pointer string from tokens, for error messages.
 * This is the inverse of parsePointer modulo the empty-string root case.
 */
function rebuildPointer(tokens) {
  if (tokens.length === 0) return '';
  return '/' + tokens.map((t) => t.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

function describeScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return typeof value;
}

/**
 * Read the value at a JSON Pointer. Returns `undefined` for missing keys,
 * which matches JS semantics and lets callers distinguish "absent" from
 * "present but null". The root pointer always returns the document itself.
 */
export function get(doc, pointer) {
  const tokens = parsePointer(pointer);
  let current = doc;
  for (const tok of tokens) {
    if (Array.isArray(current)) {
      if (!isArrayIndex(tok)) {
        throw new PatchError(
          `cannot index array with non-numeric token ${JSON.stringify(tok)}`,
          pointer,
        );
      }
      const idx = Number(tok);
      if (idx >= current.length) {
        return undefined;
      }
      current = current[idx];
    } else if (current !== null && typeof current === 'object') {
      current = current[tok];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Add a value at a JSON Pointer. Two cases:
 *
 *  - If the parent is an array, the final token must be a non-negative index
 *    or the literal "-" (append). For an existing index <= length, we splice
 *    the value in, shifting later elements right (RFC 6902 add semantics).
 *    An index strictly greater than length is an error.
 *
 *  - If the parent is an object, the final token is the key to set. We
 *    overwrite an existing value, matching RFC 6902 add-on-object semantics.
 *
 *  - If the pointer is root (""), the entire document is replaced by `value`.
 *
 * Returns the new document (the input is not mutated).
 */
export function add(doc, pointer, value) {
  const tokens = parsePointer(pointer);
  const cloned = clone(doc);
  const { parent, finalKey, isRoot } = locateParent(cloned, tokens);

  if (isRoot) {
    return clone(value);
  }

  if (Array.isArray(parent)) {
    if (finalKey === '-') {
      parent.push(clone(value));
      return cloned;
    }
    if (!isArrayIndex(finalKey)) {
      throw new PatchError(
        `cannot index array with non-numeric token ${JSON.stringify(finalKey)}`,
        pointer,
      );
    }
    const idx = Number(finalKey);
    if (idx > parent.length) {
      throw new PatchError(
        `add index ${idx} out of bounds (length ${parent.length}); use "-" to append`,
        pointer,
      );
    }
    parent.splice(idx, 0, clone(value));
    return cloned;
  }

  if (parent !== null && typeof parent === 'object') {
    parent[finalKey] = clone(value);
    return cloned;
  }

  throw new PatchError(
    `cannot add to ${describeScalar(parent)}; parent must be object or array`,
    pointer,
  );
}

/**
 * Remove the value at a JSON Pointer.
 *
 *  - For arrays: the final token must be a valid index in range. We splice
 *    the element out, shifting later elements left. "-" is rejected because
 *    it names no existing element.
 *  - For objects: the key must exist (hasOwnProperty). We `delete` it.
 *  - For root: returns `undefined`, the only sensible "removed document".
 *
 * Throws PatchError if the target does not exist. We do not silently no-op;
 * silent no-ops hide bugs in callers and contradict the brief's focus on
 * genuine edge-case handling.
 */
export function remove(doc, pointer) {
  const tokens = parsePointer(pointer);
  const cloned = clone(doc);
  const { parent, finalKey, isRoot } = locateParent(cloned, tokens);

  if (isRoot) {
    return undefined;
  }

  if (Array.isArray(parent)) {
    if (finalKey === '-') {
      throw new PatchError(
        'cannot remove "-"; it names no existing element',
        pointer,
      );
    }
    if (!isArrayIndex(finalKey)) {
      throw new PatchError(
        `cannot index array with non-numeric token ${JSON.stringify(finalKey)}`,
        pointer,
      );
    }
    const idx = Number(finalKey);
    if (idx >= parent.length) {
      throw new PatchError(
        `remove index ${idx} out of bounds (length ${parent.length})`,
        pointer,
      );
    }
    parent.splice(idx, 1);
    return cloned;
  }

  if (parent !== null && typeof parent === 'object') {
    if (!Object.prototype.hasOwnProperty.call(parent, finalKey)) {
      throw new PatchError(
        `cannot remove missing key ${JSON.stringify(finalKey)}`,
        pointer,
      );
    }
    delete parent[finalKey];
    return cloned;
  }

  throw new PatchError(
    `cannot remove from ${describeScalar(parent)}; parent must be object or array`,
    pointer,
  );
}

/**
 * Apply a sequence of patch operations. Each operation is an object with
 * `op` ("add" or "remove"), `path` (a JSON Pointer string), and for "add"
 * a `value` field.
 *
 * We apply operations sequentially, threading the document through. We do
 * NOT abort on the first error: each result is reported independently. This
 * is a deliberate deviation from RFC 6902's all-or-nothing contract, stated
 * in the README. The caller can stop at the first `{ ok: false }` if they
 * want transactional behaviour; we give them the information to choose.
 *
 * Returns an array of `{ ok: true, doc } | { ok: false, error }`.
 */
export function applyPatch(doc, operations) {
  if (!Array.isArray(operations)) {
    throw new TypeError('applyPatch: operations must be an array');
  }
  let current = clone(doc);
  const results = [];
  for (const op of operations) {
    if (op === null || typeof op !== 'object') {
      results.push({ ok: false, error: new TypeError('operation must be an object') });
      continue;
    }
    const { op: kind, path, value } = op;
    if (kind !== 'add' && kind !== 'remove') {
      results.push({
        ok: false,
        error: new PatchError(`unsupported op ${JSON.stringify(kind)}; use "add" or "remove"`, path),
      });
      continue;
    }
    if (typeof path !== 'string') {
      results.push({
        ok: false,
        error: new TypeError(`operation "path" must be a string`),
      });
      continue;
    }
    try {
      if (kind === 'add') {
        current = add(current, path, value);
      } else {
        current = remove(current, path);
      }
      results.push({ ok: true, doc: current });
    } catch (e) {
      // Preserve the original error; do not wrap, so instanceof PatchError
      // still works for the caller. We just record it.
      results.push({ ok: false, error: e });
    }
  }
  return results;
}

// Exported for callers who want to catch pointer errors by type.
export { PatchError };
