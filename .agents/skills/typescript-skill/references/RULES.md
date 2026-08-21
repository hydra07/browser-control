# TypeScript Engine Rules

Applies to TypeScript running on any modern engine: V8 (Node, Deno, Chrome)
or JavaScriptCore (Bun, Safari, WebKit). Section 3's engine rules apply
only to a hot path that has actually been measured (profiler, benchmark).
Do not apply them speculatively to ordinary code - that trades readability
for nothing.

Reference sections by number, e.g. "Rule 3.1" or "1.4".

This file is a project-agnostic base template - project-specific additions
(this codebase's own conventions, framework-specific rules) belong appended
below Section 5/6 or in a separate project skill, not mixed into the rules
above.

---

## 1. Type Placement Philosophy

### 1.1 `.ts` versus `.d.ts`

A `.ts` file holds runtime logic and may use type assertions (`as`). A
`.d.ts` file is an ambient declaration only - no logic, and it produces
zero runtime output. Node, Bun, and Deno never execute a `.d.ts` file.

For an ordinary `.ts` file, Bun and Deno strip types in memory with a
native transpiler (Zig/Rust) before handing plain JS to the engine. Its
runtime memory and CPU cost is identical to hand-written JS - types are
a compile-time-only construct.

### 1.2 Trust Inference

Do not annotate what the compiler already infers correctly. A redundant
annotation is noise, not extra safety.

```ts
// Avoid
let name: string = "gem";
const users: User[] = data.map((d): User => toUser(d));

// Prefer - inference resolves the same type
let name = "gem"; // string
const users = data.map(toUser); // User[] if toUser: (d) => User
```

### 1.3 Where an Explicit Type Is Required

These are the boundaries inference cannot see across:

```ts
// 1. Function parameters - no source to infer from
function parse(input: string, opts: ParseOpts) {
  /* ... */
}

// 2. Variables initialized empty, filled in later
let socket: WebSocket | null = null;

// 3. Domain literal unions - narrow the type on purpose
type Role = "admin" | "editor" | "viewer";
let role: Role = "viewer";

// 4. Public API / boundary return types - stop inference from drifting
async function fetchUser(id: string): Promise<User> {
  /* ... */
}
```

### 1.4 `satisfies` - Narrow Inference With a Safety Net

```ts
type Config = Record<string, { url: string; retries: number }>;

// as const alone: readonly, but no shape check
const a = { db: { url: "x", retries: 3 } } as const;

// : Config alone: shape-checked, but literal keys widen to an index type
const b: Config = { db: { url: "x", retries: 3 } };
b.wtf; // no error - index signature accepts any key

// satisfies: shape-checked AND keeps the concrete key set
const c = {
  db: { url: "x", retries: 3 },
} satisfies Config;
c.db.retries; // ok, narrowed
c.wtf; // compile error - key does not exist

// combine with as const to lock literal values and readonly-ness
const routes = {
  home: "/",
  user: "/u/:id",
} as const satisfies Record<string, string>;
```

### 1.5 Single Source of Truth

Do not re-declare an interface for each variant - derive it.

```ts
interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

type CreateUser = Omit<User, "id" | "createdAt">;
type UpdateUser = Partial<CreateUser>;
type UserPreview = Pick<User, "id" | "name">;

// Or let a runtime schema be the one source - type is inferred from it
import { z } from "zod";
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
type User = z.infer<typeof UserSchema>; // runtime validation + static type from one place
```

### 1.6 Compiler Strictness

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "verbatimModuleSyntax": true, // forces explicit `import type`, bundlers strip it cleanly
    "erasableSyntaxOnly": true, // see Section 4 - blocks syntax that can't be stripped
    "noUncheckedIndexedAccess": true, // arr[i] becomes T | undefined - catches off-by-one bugs
  },
}
```

```ts
// Avoid - any disables every check on this value
function handle(x: any) {
  x.foo.bar();
}

// Prefer - unknown forces narrowing before use
function handle(x: unknown) {
  if (typeof x === "object" && x && "foo" in x) {
    /* narrowed, safe to use */
  }
}

// import type separates values from types so bundlers strip the type-only import entirely
import type { User } from "./types";
import { createUser } from "./user";
```

### 1.7 Array Typing - `any[]` Is Almost Always Wrong

`any[]` costs twice: it loses type safety (the element type becomes `any`
and spreads through the rest of the code) and it often costs performance
too. "Any type" in a function's context means a generic; at a data
boundary it means `unknown[]`, validated before use.

```ts
// Avoid - any erases the link between input and output
function first(arr: any[]): any {
  return arr[0];
}

// Prefer - generic keeps the type flowing through the function
function first<T>(arr: T[]): T | undefined {
  return arr[0];
}

// constrained generic - open, but still safe
function sortById<T extends { id: string }>(arr: T[]): T[] {
  /* ... */ return arr;
}

// boundary with an unknown shape -> unknown[], narrow each element
const items: unknown[] = getData();
const head = items[0];
if (typeof head === "string") head.toUpperCase();
```

Watch the `Array.isArray` narrowing trap - `any` can leak back in even
when starting from `unknown`:

```ts
function handle(x: unknown) {
  if (Array.isArray(x)) {
    x[0].whatever(); // x is any[] here - no error, any is back
    const arr: unknown[] = x; // cast to unknown[] immediately, then narrow further
  }
}
```

Fixed position or fixed length: use a tuple, not an array.

```ts
const pair: [string, number] = ["gem", 42]; // TS knows [0] is string, [1] is number, length 2
const dims = [1920, 1080] as const; // readonly [1920, 1080], literal values locked
```

Further tightening: `readonly T[]` for a parameter that must not be
mutated; a non-empty tuple `[T, ...T[]]` to guarantee at least one
element without an `undefined` check; `.filter` with a type predicate to
narrow the result (`xs.filter((x): x is string => x !== null)`).

| Situation                              | Use                                                         |
| -------------------------------------- | ----------------------------------------------------------- |
| Unknown shape, boundary                | `unknown[]`, then narrow (e.g. `z.array`)                   |
| Uniform, known type                    | `T[]`                                                       |
| Function that works over any type      | generic `<T>(arr: T[])`                                     |
| Function needs a field on each element | `<T extends {...}>`                                         |
| Mix of known types                     | `(A \| B)[]` (watch for holey/polymorphic arrays, Rule 3.3) |
| Fixed position or length               | tuple `[A, B]`, or `as const`                               |
| Parameter must not be mutated          | `readonly T[]`                                              |
| At least one element guaranteed        | `[T, ...T[]]`                                               |

---

## 2. Function and File Structure

### 2.1 Function Declaration versus Arrow Function

Use `function` for anything top-level, exported, or generic - it hoists,
which keeps the primary logic readable top-down, and it avoids the JSX
ambiguity generics hit in `.tsx`. Use arrow functions for local helpers
and callbacks.

```tsx
// Prefer - top-level export as a function declaration (hoisted, reads top-down)
export function processOrders(orders: Order[]): Result {
  const valid = orders.filter(isValid); // local arrow/callback here is fine
  return summarize(valid);
}

// generic in .tsx - an arrow function's <T> is parsed as a JSX tag
const bad = <T,>(x: T) => x; // ambiguous, easy to get wrong
function good<T>(x: T): T {
  return x;
} // unambiguous

// callback -> arrow
orders.map((o) => o.total);
```

### 2.2 Guard Clauses - Return Early

```ts
// Avoid - deep nesting, the happy path is buried
function pay(u: User | null) {
  if (u) {
    if (u.active) {
      if (u.balance > 0) {
        return doPay(u);
      }
    }
  }
}

// Prefer - reject invalid cases up front, happy path stays flat
function pay(u: User | null) {
  if (!u) return err("no user");
  if (!u.active) return err("inactive");
  if (u.balance <= 0) return err("no funds");
  return doPay(u);
}
```

---

## 3. Runtime Performance (V8 and JavaScriptCore)

Apply this section only to a hot path that has been measured. Everything
here trades code shape for speed - paying that cost where it is not
needed is a net loss.

### 3.1 Monomorphism - Rule Number One

A function should receive objects of one consistent hidden class. When
the same call site sees multiple shapes, the engine's inline cache
degrades from monomorphic to polymorphic to megamorphic, losing the
inlining that makes property access fast - a much larger cost than any
switch statement or lookup choice.

```ts
// Avoid - megamorphic: the same function receives three different shapes
function area(s: any) {
  return s.w * s.h;
}
area({ w: 1, h: 2 }); // shape A
area({ w: 1, h: 2, color: 1 }); // shape B - extra field, different hidden class
area({ h: 2, w: 1 }); // shape C - different field order, still a different shape

// Prefer - monomorphic: same fields, same order, same constructor
class Rect {
  constructor(
    public w: number,
    public h: number,
  ) {}
}
function area(r: Rect) {
  return r.w * r.h;
}
```

Consequence: initialize every property at construction time, in one
consistent order.

```ts
// Avoid - patching fields in one at a time triggers a hidden-class transition each time
const p = {};
p.x = 1;
p.y = 2;

// Prefer - declare the full shape once, same field order everywhere it's created
const p = { x: 1, y: 2 };
```

### 3.2 Never Use `delete` - Use `= null` or a `Map`

`delete` forces an object into dictionary mode (roughly 10 to 50 times
slower for property access), and it cannot revert.

```ts
// Avoid
delete user.session; // dictionary mode, permanent for this object

// Prefer - keep the shape stable
user.session = null;

// Prefer, when keys are genuinely dynamic (frequent add/remove) - Map exists for this
const cache = new Map<string, Session>();
cache.set(id, s);
cache.delete(id); // does not affect any object's hidden class
```

### 3.3 Packed versus Holey Arrays

An array's internal "elements kind" only ever downgrades, never upgrades:
`PACKED_SMI -> PACKED_DOUBLE -> PACKED -> HOLEY_*`. Every holey variant
is slower than its packed counterpart.

```ts
// Avoid - creates a hole, permanently downgrades to HOLEY
const a = [1, 2, 3];
a[100] = 4; // indices 3..99 are now holes
const b = new Array(1000); // pre-allocated empty = all holes
b[0] = 1;

// Avoid - mixing types downgrades PACKED_SMI toward generic PACKED
const c = [1, 2, 3];
c.push(1.5); // SMI -> DOUBLE
c.push("x"); // -> PACKED (generic)

// Prefer - push sequentially, keep a single element type, leave no gaps
const d: number[] = [];
for (let i = 0; i < n; i++) d.push(i); // stays PACKED_SMI
```

### 3.4 `switch`/`case` - Use It Where It Actually Helps

The engine only generates a real jump table for a dense, small-range
integer or enum-like discriminant. A `switch` on strings compiles to
sequential comparison or a hash lookup - not a zero-cost dispatch.

```ts
// Prefer - integer/enum discriminant compiles to a real jump table
const enum Op {
  Add = 0,
  Sub = 1,
  Mul = 2,
  Div = 3,
}
function apply(op: Op, a: number, b: number) {
  switch (op) {
    case Op.Add:
      return a + b;
    case Op.Sub:
      return a - b;
    case Op.Mul:
      return a * b;
    case Op.Div:
      return a / b;
  }
}

// String dispatch: a static Map (built once, outside the hot path) is at
// least as fast, allocation-free per call, and avoids sequential string comparison
const handlers = new Map<string, Handler>([
  ["click", onClick],
  ["hover", onHover],
]);
function dispatch(type: string, e: Event) {
  handlers.get(type)?.(e); // one hash lookup, no per-case string comparison
}
```

Rule: switch for an integer/enum discriminant; a static `Map` for string
dispatch.

### 3.5 Exhaustiveness Checking With `never`

Catch a forgotten case at compile time when a union grows a new variant.

```ts
type Shape =
  { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };

function assertNever(x: never): never {
  throw new Error(`unhandled: ${JSON.stringify(x)}`);
}

function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.PI * s.r ** 2;
    case "rect":
      return s.w * s.h;
    default:
      return assertNever(s); // adding "triangle" fails to compile here
  }
}
```

### 3.6 Zero-Allocation Hot Paths

```ts
// Avoid - map/filter allocate intermediate arrays, and can be harder to
// inline if the call site sees multiple shapes
const sum = data
  .map((x) => x * 2)
  .filter((x) => x > 10)
  .reduce((a, b) => a + b, 0);
// three passes plus two throwaway arrays - the real cost is the intermediate
// arrays, not "a closure allocated per iteration" (the callback allocates once)

// Prefer - one loop, zero intermediate arrays
let sum = 0;
for (let i = 0; i < data.length; i++) {
  const v = data[i]! * 2;
  if (v > 10) sum += v;
}
```

Prefer a typed array over an array of small objects for pure numeric data:

```ts
// Avoid - array of objects: each element is a pointer to a heap number, cache-unfriendly
const pts = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

// Prefer - flat typed array: contiguous in memory, cache-friendly
const xy = new Float32Array(n * 2); // [x0, y0, x1, y1, ...]
```

### 3.7 Object Pooling - Correct, But Has a GC Trap

Only worth it when churn is actually measured (a buffer parser, particle
system, token stream). The trap: a pool keeps objects alive long enough
to get promoted to the old generation, defeating the cheap young-generation
GC sweep that most short-lived objects benefit from.

```ts
// Only worth it under a genuinely hot allocate/free loop
class BufPool {
  private free: Uint8Array[] = [];
  acquire(size: number) {
    return this.free.pop() ?? new Uint8Array(size);
  }
  release(b: Uint8Array) {
    if (this.free.length < 64) this.free.push(b);
  } // cap so it can't grow unbounded
}
```

### 3.8 Prefer the Runtime's Native Fast Path

Every runtime ships primitives written in a native language (Zig for Bun,
Rust/C++ for Node's internals and Deno) that avoid round-tripping data
between the JS heap and a C/native heap. Prefer the runtime's own API over
a hand-rolled equivalent, especially for I/O.

```ts
// Bun example - file read goes through a native, near-zero-copy path
const bytes = await Bun.file("data.bin").bytes();
const buf = Bun.allocUnsafe(4096); // no zero-fill, faster when the caller overwrites it fully
```

The same principle applies on Node/Deno: prefer `node:fs`'s native bindings,
`fetch`, and built-in `stream` primitives over a userland reimplementation.

### 3.9 Choosing a Container: Object, Map, Array, or Set

Choose by access pattern, not by which one sounds more sophisticated -
these four are handled very differently by the engine.

An object is a struct, not a map. It is fastest when keys are fixed and
known ahead of time and fully initialized up front - monomorphic hidden
class, inline offset access (see 3.1). It becomes slow the moment it is
used as a dynamic dictionary (dictionary mode, see 3.2). Two traps:

```ts
// Trap 1: integer-like keys get re-sorted, insertion order is lost
const o: Record<string, string> = {};
o["2"] = "a";
o["1"] = "b";
o["10"] = "c";
Object.keys(o); // ["1", "2", "10"] - engine sorts numeric-looking keys ascending

// Trap 2: prototype pollution when a key comes from external input
const dict: Record<string, unknown> = {};
"toString" in dict; // true - inherited from the prototype, not actual data
// use Object.create(null) or a Map when keys come from user/network input
```

A `Map` is a genuine dynamic dictionary. It wins when: keys are dynamic
(frequent add/delete without disturbing any object's shape), keys are not
strings (object keys, or a `WeakMap` for GC-collectible keys), insertion
order must be preserved even with integer-like keys, `.size` and
`.delete` need to be first-class O(1) operations, or keys come from
external input (no pollution risk).

```ts
const m = new Map<string, string>();
m.set("2", "a");
m.set("1", "b");
m.set("10", "c");
[...m.keys()]; // ["2", "1", "10"] - insertion order preserved for every key type
```

A `Map` is not always faster, though:

- For a small N (a few dozen entries), a linear scan over a packed array
  is often more cache-friendly than a hash lookup - hashing and pointer
  chasing carry a real constant-factor cost.
- With a fixed, known key set, an object-as-struct beats `Map.get`, since
  the object access is inlined and skips a function call plus a hash.
- A `Map` uses more memory per entry - a large static dataset is cheaper
  as a plain object or array.

`Set` replaces `array.includes` for membership tests, but only pays off
for a large N queried repeatedly:

```ts
// Avoid - O(n) per check, O(n^2) inside a loop
if (bigList.includes(x)) {
  /* ... */
}

// Prefer - O(1) lookup, built once and queried many times
const seen = new Set(bigList);
if (seen.has(x)) {
  /* ... */
}

// Small N or a single query: array.includes wins - cache-friendly, no Set to build
```

`WeakMap` attaches metadata to an object's lifetime without keeping it
alive:

```ts
const meta = new WeakMap<Node, Metadata>(); // entry disappears once the key is collected, no leak
```

On arrays: `.includes` / `.indexOf` / `.find` are O(n) linear scans -
avoid them inside a hot loop over a large array, use a `Set`/`Map`
instead. To clear an array for reuse, `arr.length = 0` keeps the elements
kind and reuses the backing store; `arr = []` allocates a fresh one.

| Situation                                 | Choose                        |
| ----------------------------------------- | ----------------------------- |
| Fixed, known keys                         | object (struct, monomorphic)  |
| Dynamic keys, frequent add/delete         | `Map`                         |
| Object keys, or GC-collectible entries    | `Map` / `WeakMap`             |
| Insertion order needed with integer keys  | `Map`                         |
| Membership, large N, queried often        | `Set`                         |
| Membership, small N or single query       | `array.includes`              |
| Ordered / indexed / fast iteration        | array (packed)                |
| Pure numeric data, heavy computation      | `TypedArray`                  |
| Keys from external input (pollution risk) | `Map` / `Object.create(null)` |

### 3.10 Array Allocation and Reuse - Reference Arrays to Value Arrays

Core insight: an array's GC cost depends on what it holds. A `T[]` of
objects is an array of N pointers - the collector traces each one. A
typed array is one flat block of bytes - the collector treats it as a
single object with zero per-element scanning. "Optimizing allocation"
mostly means converting a reference array into a value array wherever
possible.

Plain numeric arrays convert directly to a typed array:

```ts
const ids = new Uint32Array(n); // non-negative ints under 4B - pick the narrowest width that fits
const gains = new Float32Array(n); // audio samples, pixel values
const acc = new Float64Array(n); // where precision matters
```

A repeated `string[]` becomes a string table plus an index:

```ts
const table: string[] = []; // stable, long-lived vocabulary
const rows = new Uint32Array(n); // rows[i] = index into table - cold numbers instead of hot strings
// comparisons and lookups run on numbers; resolve back to a string only when displaying
```

An array of small records (array-of-structs) becomes a struct-of-arrays -
one typed array per field, in place of N heap-allocated objects:

```ts
// Avoid - array-of-structs: N heap objects, GC traces each one, cache misses on access
type Node = { x: number; y: number; kind: number };
const nodes: Node[] = [];

// Prefer - struct-of-arrays: three flat buffers, zero boxing, freed as one block
const x = new Float32Array(N);
const y = new Float32Array(N);
const kind = new Uint8Array(N); // node i is (x[i], y[i], kind[i])
```

Reuse instead of reallocating:

```ts
// 1. length = 0 clears the array but keeps its backing store - no reallocation
scratch.length = 0;

// 2. in-place filter/map with two pointers - zero intermediate arrays
let w = 0;
for (let r = 0; r < arr.length; r++) if (pred(arr[r]!)) arr[w++] = arr[r]!;
arr.length = w; // truncate, same backing store

// 3. arena / bump allocator - allocate one big buffer, reset the offset to free everything at once
class Arena {
  private buf: Float32Array;
  private off = 0;
  constructor(cap: number) {
    this.buf = new Float32Array(cap);
  }
  alloc(size: number) {
    const s = this.buf.subarray(this.off, this.off + size);
    this.off += size;
    return s;
  }
  reset() {
    this.off = 0;
  } // "frees" everything, no GC involved - the arena/bump-allocator model
}
```

A ring buffer replaces a queue to avoid `.shift()`'s O(n) reindexing -
push-then-shift on a plain array becomes O(n squared) over time:

```ts
class RingBuffer {
  private buf: Float32Array;
  private head = 0;
  private tail = 0;
  private len = 0;
  constructor(cap: number) {
    this.buf = new Float32Array(cap);
  }
  push(v: number) {
    this.buf[this.tail] = v;
    this.tail = (this.tail + 1) % this.buf.length;
    this.len++;
  }
  shift() {
    const v = this.buf[this.head]!;
    this.head = (this.head + 1) % this.buf.length;
    this.len--;
    return v;
  }
}
```

View versus copy: `big.subarray(0, 100)` is a view sharing the same
buffer - zero allocation. `big.slice(0, 100)` copies into a new buffer.
Use `subarray` for a data window in a hot path. For a plain `T[]`, both
`slice` and spread copy - avoid either inside a loop.

| Element type                  | Replace with                                | Reclaim by                     |
| ----------------------------- | -------------------------------------------- | ------------------------------- |
| `number[]`                    | `Float64Array` / `Int32Array` / etc.        | one buffer, freed as a block   |
| `string[]`, repeated          | string table + `Uint32Array` index          | cold numbers, long-lived table |
| `{x, y}[]` (array-of-structs) | struct-of-arrays: one typed array per field | zero allocation per item       |
| scratch/temporary             | reuse + `length = 0`                        | keeps backing store            |
| per-frame allocation          | arena + `subarray` + `reset()`              | O(1) reset, no GC              |
| queue / stream                | ring buffer over a typed array              | avoids `.shift()`'s O(n)       |
| a window into data            | `subarray`                                  | zero-copy view                 |

Note: this applies only to a measured hot path - a parser, audio
samples, a particle system, a node arena, or streaming data. A 20-row
user list is fine as a plain `T[]` with packed-array discipline (3.3) -
do not reach for an arena over ordinary code.

---

## 4. Erasable Syntax - Required for Native Type Stripping

A type stripper (Bun, Deno, or Node 22.6+'s `--experimental-strip-types`)
only erases annotations - it does not transform code. Any syntax that
compiles to real runtime output is therefore off-limits under native
stripping.

```ts
// Avoid - enum compiles to a runtime IIFE, cannot be stripped, tree-shakes poorly
enum Color {
  Red,
  Green,
}

// Prefer - as const object plus a derived union: strips cleanly, tree-shakes well
const Color = { Red: "red", Green: "green" } as const;
type Color = (typeof Color)[keyof typeof Color];

// Avoid - parameter properties generate a runtime assignment inside the constructor
class User {
  constructor(private id: string) {}
}

// Prefer - declare the field explicitly
class User {
  private id: string;
  constructor(id: string) {
    this.id = id;
  }
}

// Also avoid: namespace (has runtime output), legacy experimental decorators (not strippable)
```

```jsonc
// tsconfig - have the compiler enforce this from the start
{
  "compilerOptions": {
    "erasableSyntaxOnly": true, // fails immediately on enum/namespace/parameter properties
    "verbatimModuleSyntax": true,
  },
}
```

If a project intentionally uses a real `enum` for compile-time
exhaustiveness or to build a runtime lookup table from one source (e.g.
`Object.values(SomeEnum)`), that is a deliberate trade: a small,
infrequently-called runtime IIFE in exchange for guaranteed consistency
between two places that must never drift apart. Document that trade
where it is made, and do not enable `erasableSyntaxOnly` in a project
that relies on it without converting those enums first.

---

## 5. Common Performance Myths

| Myth                                                     | Reality                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `\| 0` or `>> 0` forces an SMI for speed                 | An asm.js-era relic. TurboFan/JSC already track int32-versus-double through type feedback. This inserts a real `ToInt32` operation and changes semantics (32-bit wraparound) - only use it when wraparound is actually needed, not as a perf trick. |
| `switch` always beats a lookup                           | Only true for an integer discriminant. String `switch` is not zero-cost.                                                                                                                                                                            |
| `.map` allocates a new closure per iteration             | The callback is allocated once. The real cost is the intermediate array and reduced inlining.                                                                                                                                                       |
| `try`/`catch` deoptimizes the whole function             | Not true on any modern engine. TurboFan handles it fine - use it freely, including in a hot path.                                                                                                                                                   |
| String concatenation with `+=` is slow, use `array.join` | V8 uses cons-strings (a rope structure) internally; `+=` is fine.                                                                                                                                                                                   |
| Object pooling is always a win                           | Not necessarily - it can promote objects to the old generation and defeat generational GC. Only use it under measured churn.                                                                                                                        |
| `Map` is always faster than an object                    | Not true - an object-as-struct with fixed keys beats `Map.get`. `Map` wins specifically when keys are dynamic.                                                                                                                                      |
| `Set.has` always beats `array.includes`                  | Only for a large N queried repeatedly. For a small N or a single query, an array is more cache-friendly.                                                                                                                                            |

---

## 6. Priority Checklist

1. Monomorphism - keep every hot function's input to one consistent shape. Highest-leverage rule.
2. Packed arrays, stable hidden classes - no `delete`, no holes.
3. Zero-allocation hot paths - plain loops, typed arrays, fewer intermediate arrays.
4. The right container - object for fixed keys, `Map` for dynamic keys, packed array for ordered data, `Set` for large-N membership, `TypedArray` for numbers.
5. Allocation strategy - convert reference arrays to value arrays (TypedArray/struct-of-arrays), reuse via `length = 0`, use an arena with `reset()`, use a ring buffer instead of `.shift()`.
6. `switch` for an integer discriminant, a static `Map` for string dispatch.
7. Prefer the runtime's native fast path for I/O.

Measure first (a profiler, a benchmark, or a runtime's built-in sampling
flag), optimize second. Every rule in Section 3 is meaningless applied to
code that is not actually a hot path.

---

## 7. Project-Specific Additions

_(Empty in the base template. Append this project's own conventions here
when copying this file into a new project - do not edit Sections 1-6,
they are the shared base every project starts from.)_
