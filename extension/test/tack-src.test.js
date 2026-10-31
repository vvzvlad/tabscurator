import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// tack-src.js is a classic script for the page's MAIN world. It is run here the way the
// browser runs it — as a script, in its own global — with `module` present, so it exports
// the API instead of setting window.__tackSource.
const SRC = readFileSync(
  fileURLToPath(new URL("../vendor/tack/tack-src.js", import.meta.url)),
  "utf8",
);
const ORIGIN = "http://localhost:5299";

function load(fetchFn = vi.fn()) {
  const module = { exports: {} };
  vm.runInNewContext(SRC, {
    module,
    location: { origin: ORIGIN },
    fetch: fetchFn,
    URL,
    atob,
    TextDecoder,
  });
  return { resolve: module.exports.resolve, fetchFn };
}

// A DOM element double: own expando props (what React/Vue/Svelte attach) + a parent.
function el(props = {}, parentElement = null) {
  return Object.assign(Object.create({ parentElement }), props);
}

// --- Source Map v3 VLQ, encoded independently of the decoder under test ----------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}
// lines: [[ [genCol, src, origLine, origCol], ... ], ...] with absolute 0-based values.
function encodeMappings(lines) {
  let src = 0, oLine = 0, oCol = 0;
  return lines
    .map((segs) => {
      let gCol = 0;
      return segs
        .map(([g, s, l, c]) => {
          const out = vlq(g - gCol) + vlq(s - src) + vlq(l - oLine) + vlq(c - oCol);
          gCol = g; src = s; oLine = l; oCol = c;
          return out;
        })
        .join(",");
    })
    .join(";");
}
// A host (DOM) fiber as the DOM node's `__reactFiber$` finds it. React alternates a pair of
// fibers, and the one the node points at holds the PREVIOUS render's props after an odd
// number of updates (`stale`; the same as `props` by default — mount, or an even count). The
// current props are on the node's `__reactProps$`: commitUpdate refreshes only those. The
// node's class may hold more than the props (code adds classes at runtime): `domClass`.
function hostFiber(type, props, stack, { stale = props, domClass = props.className } = {}) {
  const attrs = { class: domClass, id: props.id };
  const stateNode = {
    "__reactProps$q": props,
    getAttribute: (n) => (attrs[n] == null ? null : attrs[n]),
  };
  return { type, memoizedProps: stale, stateNode, _debugStack: { stack } };
}

function moduleWithInlineMap(map) {
  const json = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
  return "const a = 1;\n//# sourceMappingURL=data:application/json;base64," + json + "\n";
}

describe("tack-src: React <=18 (fiber._debugSource)", () => {
  it("returns file:line:col of the element's own JSX", async () => {
    const { resolve } = load();
    const fiber = { _debugSource: { fileName: "/w/src/App.jsx", lineNumber: 451, columnNumber: 7 } };
    expect(await resolve(el({ "__reactFiber$abc": fiber }))).toBe("/w/src/App.jsx:451:7");
  });

  it("walks the DOM up to a React element, then the fiber chain past library code", async () => {
    const { resolve } = load();
    const app = { _debugSource: { fileName: "/w/src/Card.jsx", lineNumber: 12, columnNumber: 5 } };
    const lib = { _debugSource: { fileName: "/w/node_modules/ui/Button.js", lineNumber: 3 }, return: app };
    const host = { return: lib }; // a div a library component rendered: no source of its own
    const reactEl = el({ "__reactFiber$x": host });
    expect(await resolve(el({}, reactEl))).toBe("/w/src/Card.jsx:12:5");
  });
});

describe("tack-src: React 19 (fiber._debugStack + inline source map)", () => {
  const stack = [
    "Error: react-stack-top-frame",
    `    at exports.jsxDEV (${ORIGIN}/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=9f:193:83)`,
    `    at Wrapper (${ORIGIN}/@fs/w/linked/Wrapper.jsx:1:1)`,
    `    at App (${ORIGIN}/src/App.jsx?t=17:3:26)`,
    `    at Object.react_stack_bottom_frame (${ORIGIN}/node_modules/.vite/deps/react-dom_client.js?v=f7:12866:12)`,
  ].join("\n");
  // Generated line 3 (0-based 2): col 0 -> App.jsx 0:0, col 25 -> 387:12, col 26 -> 389:0,
  // col 40 -> 390:0. The segment right after 25 catches a column read 1-based.
  const map = {
    version: 3,
    sources: ["App.jsx"],
    names: [],
    mappings: encodeMappings([[[0, 0, 0, 0]], [[0, 0, 1, 0]], [[0, 0, 2, 0], [25, 0, 387, 12], [26, 0, 389, 0], [40, 0, 390, 0]]]),
  };

  it("maps the first app-code frame back to the original file and line", async () => {
    const fetchFn = vi.fn(async () => ({ text: async () => moduleWithInlineMap(map) }));
    const { resolve } = load(fetchFn);
    const fiber = { _debugStack: { stack } };
    // Frame 3:26 -> 0-based 2:25 -> source line 387, col 12 -> 1-based 388:13; the module
    // url's path is where the relative source resolves.
    expect(await resolve(el({ "__reactFiber$q": fiber }))).toBe("src/App.jsx:388:13");
    expect(fetchFn).toHaveBeenCalledWith(`${ORIGIN}/src/App.jsx?t=17`);
  });

  it("fetches each module once, however many elements ask", async () => {
    const fetchFn = vi.fn(async () => ({ text: async () => moduleWithInlineMap(map) }));
    const { resolve } = load(fetchFn);
    const a = el({ "__reactFiber$q": { _debugStack: { stack } } });
    await Promise.all([resolve(a), resolve(a), resolve(a)]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("skips frames from another origin and answers '' when no frame is app code", async () => {
    const fetchFn = vi.fn();
    const { resolve } = load(fetchFn);
    const foreign = "Error\n    at x (https://cdn.example/app.js:1:1)\n" +
      `    at y (${ORIGIN}/node_modules/lib/index.js:2:2)`;
    expect(await resolve(el({ "__reactFiber$q": { _debugStack: { stack: foreign } } }))).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("answers '' (never rejects) when the module has no inline map", async () => {
    const fetchFn = vi.fn(async () => ({ text: async () => "const a = 1;\n" }));
    const { resolve } = load(fetchFn);
    expect(await resolve(el({ "__reactFiber$q": { _debugStack: { stack } } }))).toBe("");
  });
});

// React 19 keeps the FIRST element's stack on a fiber it reuses: `if (!graph) return <div
// className="loading">` followed by `return <div className="app">` renders the app div into
// the loading div's fiber, and its stack still points at the loading branch (rost_map,
// react-dom 19.2.8: updateElement refreshes _debugOwner but not _debugStack).
describe("tack-src: React 19, a fiber reused across branches", () => {
  const APP = [
    "export default function App({ graph }) {",
    "  if (!graph) {",
    '    return <div className="loading">wait</div>', // line 3, "<" at column 12
    "  }",
    "  return (",
    '    <div className="app">', // line 6, "<" at column 5
    '      <div className="canvas" onClick={() => go("}>")} />',
    "      <div>{graph.title}</div><div>{graph.note}</div>",
    "    </div>",
    "  )",
    "}",
  ].join("\n");
  // Generated 2:5 (0-based 1:4) -> source 0-based 2:11, the loading div's "<".
  const map = {
    version: 3,
    sources: ["App.jsx"],
    sourcesContent: [APP],
    names: [],
    mappings: encodeMappings([[[0, 0, 0, 0]], [[4, 0, 2, 11]]]),
  };
  const stack = `Error: react-stack-top-frame\n    at App (${ORIGIN}/src/App.jsx:2:5)`;
  const hostDiv = (props, opts) => el({ "__reactFiber$q": hostFiber("div", props, stack, opts) });
  const loadWithMap = () => load(vi.fn(async () => ({ text: async () => moduleWithInlineMap(map) })));

  it("the stale position is replaced by the one tag that matches the element", async () => {
    const { resolve } = loadWithMap();
    expect(await resolve(hostDiv({ className: "app", children: [] }))).toBe("src/App.jsx:6:5");
  });

  it("a position that matches the element is kept", async () => {
    const { resolve } = loadWithMap();
    expect(await resolve(hostDiv({ className: "loading", children: "wait" }))).toBe("src/App.jsx:3:12");
  });

  it("after an odd number of updates the node's fiber has the previous props; the node's own are used", async () => {
    // react-dom 19.2.8, one update after the loading render: __reactFiber$ -> the fiber with
    // the loading div's props, __reactProps$ -> the app div's.
    const { resolve } = loadWithMap();
    const stale = { className: "loading", children: "wait" };
    expect(await resolve(hostDiv({ className: "app", children: [] }, { stale }))).toBe("src/App.jsx:6:5");
  });

  it("several matching tags: the file alone, no line", async () => {
    const { resolve } = loadWithMap();
    // No class: only the two attribute-less divs of line 8 could have rendered it.
    expect(await resolve(hostDiv({ children: "t" }))).toBe("src/App.jsx");
  });
});

// `source` is the file, `at` the 0-based [line, col] of the tag's "<" the frame maps to.
function resolveAt(source, at, type, props, opts) {
  const map = {
    version: 3,
    sources: ["App.jsx"],
    sourcesContent: [source],
    names: [],
    mappings: encodeMappings([[[0, 0, 0, 0]], [[4, 0, at[0], at[1]]]]),
  };
  const { resolve } = load(vi.fn(async () => ({ text: async () => moduleWithInlineMap(map) })));
  const stack = `Error: react-stack-top-frame\n    at App (${ORIGIN}/src/App.jsx:2:5)`;
  return resolve(el({ "__reactFiber$q": hostFiber(type, props, stack, opts) }));
}

// The most common reuse: a loading branch first, the real markup later at the same place.
describe("tack-src: React 19, a loading branch reused for the real markup", () => {
  const loading = (tag) => [
    "export default function App({ data }) {",
    `  if (!data) return ${tag}Loading…</div>;`, // line 2, "<" at column 21
    "  return (",
    '    <div className="p-4 flex">', // line 4
    "      <h1>{data.title}</h1>",
    "    </div>",
    "  );",
    "}",
  ].join("\n");
  const main = { className: "p-4 flex", children: {} };

  it("a class-less loading div does not keep the main div's line", async () => {
    expect(await resolveAt(loading("<div>"), [1, 20], "div", main)).toBe("src/App.jsx:4:5");
  });

  it("nor does one whose classes are a subset of the main div's", async () => {
    expect(await resolveAt(loading('<div className="p-4">'), [1, 20], "div", main)).toBe("src/App.jsx:4:5");
  });

  it("the loading div itself keeps its line", async () => {
    expect(await resolveAt(loading("<div>"), [1, 20], "div", { children: "Loading…" })).toBe("src/App.jsx:2:21");
  });

  it("a literal class replaced by a computed one: the file alone, no line", async () => {
    const src = [
      "export default function App({ data, open }) {",
      '  if (!data) return <div className="loading">wait</div>;', // line 2
      '  return <div className={cn("row", open && "open")}>{data.title}</div>;', // line 3
      "}",
    ].join("\n");
    expect(await resolveAt(src, [1, 20], "div", { className: "row open", children: "x" })).toBe("src/App.jsx");
  });

  it("the replacement may be written through a variable tag", async () => {
    const src = [
      "export default function App({ data, as: Comp = 'div' }) {",
      '  if (!data) return <div className="loading">wait</div>;', // line 2
      '  return <Comp className="card">{data.title}</Comp>;', // line 3, "<" at column 10
      "}",
    ].join("\n");
    expect(await resolveAt(src, [1, 20], "div", { className: "card", children: "x" })).toBe("src/App.jsx:3:10");
  });

  it("a TS type argument (useRef<HTMLDivElement>) is not a candidate tag", async () => {
    const src = [
      "export default function App({ data }) {",
      '  if (!data) return <div className="spinner" />;', // line 2
      "  const ref = useRef<HTMLDivElement>(null);",
      "  return <div ref={ref}>{data.title}</div>;", // line 4, "<" at column 9
      "}",
    ].join("\n");
    expect(await resolveAt(src, [1, 20], "div", { ref: {}, children: "x" })).toBe("src/App.jsx:4:10");
  });
});

// A child cloned by its parent carries props its own JSX does not show: Radix Slot (shadcn
// `asChild`) merges the parent's className into it, a Radix trigger adds an `id`. Its line
// stays unless another tag in the file matches those props exactly.
describe("tack-src: React 19, props a parent added to a cloned child", () => {
  it("<Button asChild><a href>: the className Slot merged in keeps the <a> line", async () => {
    const src = [
      'import { Button } from "@/components/ui/button";',
      "export default function App() {",
      "  return (",
      '    <Button asChild><a href="/docs">Docs</a></Button>', // line 4, "<a" at column 21
      "  );",
      "}",
    ].join("\n");
    const props = { href: "/docs", className: "btn ", children: "Docs" };
    expect(await resolveAt(src, [3, 20], "a", props)).toBe("src/App.jsx:4:21");
  });

  it("a Radix trigger's <button> with the id Radix added keeps its line", async () => {
    const src = [
      'import * as DropdownMenu from "@radix-ui/react-dropdown-menu";',
      "export default function Menu() {",
      "  return (",
      "    <DropdownMenu.Root>",
      "      <DropdownMenu.Trigger asChild>",
      '        <button className="icon-btn">⋮</button>', // line 6, "<" at column 9
      "      </DropdownMenu.Trigger>",
      "    </DropdownMenu.Root>",
      "  );",
      "}",
    ].join("\n");
    const props = { className: "icon-btn", id: "radix-:r1:", type: "button", "aria-haspopup": "menu", children: "⋮" };
    expect(await resolveAt(src, [5, 8], "button", props)).toBe("src/App.jsx:6:9");
  });
});

// A right position must not be traded for a wrong one: the element can carry more than its
// tag's literals say (a class added at runtime, props spread over the literal).
describe("tack-src: React 19, a correct position is kept", () => {
  it("a class added at runtime does not move the line to a computed className below", async () => {
    const src = [
      'import { Slot } from "@radix-ui/react-slot";',
      "export function Button({ asChild, className, ...props }) {",
      '  const Comp = asChild ? Slot : "button";',
      '  return <Comp className={cn("btn", className)} {...props} />;',
      "}",
      "export default function App() {",
      "  return (",
      '    <div className="card">', // line 8
      '      <div className={cn("row", open && "open")}>x</div>',
      '      <h1 id="title">Hi</h1>',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    const props = { className: "card", children: [] };
    expect(await resolveAt(src, [7, 4], "div", props, { domClass: "card is-visible" })).toBe("src/App.jsx:8:5");
  });

  it("a host element written through a variable tag (<Comp>, shadcn Button) keeps its line", async () => {
    const src = [
      'import { Slot } from "@radix-ui/react-slot";',
      "export function Button({ asChild, className, ...props }) {",
      '  const Comp = asChild ? Slot : "button";',
      '  return <Comp className={cn("btn", className)} {...props} />;', // line 4, "<" at column 10
      "}",
    ].join("\n");
    const props = { className: "btn primary", onClick() {}, children: "Go" };
    expect(await resolveAt(src, [3, 9], "button", props)).toBe("src/App.jsx:4:10");
  });

  it("props spread after the literal className keep the line", async () => {
    const src = [
      "export default function Panel({ open, ...rest }) {",
      "  return (",
      '    <section className="panel" {...rest}>', // line 3
      '      <section className={open ? "a" : "b"}>x</section>',
      "    </section>",
      "  );",
      "}",
    ].join("\n");
    // The parent's className came in through the spread and overrode the literal.
    const props = { className: "parent-cls", children: {} };
    expect(await resolveAt(src, [2, 4], "section", props)).toBe("src/App.jsx:3:5");
  });
});

describe("tack-src: Vue 3 and Svelte", () => {
  it("Vue: the nearest component that knows its file", async () => {
    const { resolve } = load();
    const parent = { type: { __file: "/w/src/views/Home.vue" } };
    const inner = { type: {}, parent }; // a component compiled without __file
    expect(await resolve(el({ __vueParentComponent: inner }))).toBe("/w/src/views/Home.vue");
  });

  it("Svelte 4: loc line and column are 0-based (and carry `char`)", async () => {
    // timeline_planner, App.svelte: `<main>` on line 12, column 1 arrives as {line: 11, column: 0}.
    const { resolve } = load();
    const meta = { loc: { file: "src/App.svelte", line: 11, column: 0, char: 261 } };
    expect(await resolve(el({ __svelte_meta: meta }))).toBe("src/App.svelte:12:1");
  });

  it("Svelte 5: loc line is 1-based, column 0-based (no `char`)", async () => {
    const { resolve } = load();
    const meta = { loc: { file: "src/routes/+page.svelte", line: 14, column: 2 } };
    expect(await resolve(el({ __svelte_meta: meta }))).toBe("src/routes/+page.svelte:14:3");
  });

  it("an element no framework owns answers ''", async () => {
    const { resolve } = load();
    expect(await resolve(el({}, el({})))).toBe("");
  });
});
