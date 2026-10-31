// Source hint for the Tack fork (tack.js, withSrc): which file and line rendered an
// element, read from what a framework's DEV build already keeps on the page, so no project
// installs a plugin or changes its config (§16 item 26). Injected into the page's MAIN
// world before tack.js, where those fields are visible; also loadable under vitest.
//
// window.__tackSource.resolve(el) -> Promise<"file:line[:col]" | "">, never rejects.
// The DOM is walked up from `el` to the first element a framework owns:
//   React <=18  fiber._debugSource {fileName, lineNumber, columnNumber}
//   React 19    fiber._debugStack — an Error captured where the JSX was created. Its first
//               frame in the app's own code (same origin, not a dependency) points into the
//               module the dev server served; that module carries an inline source map,
//               which takes the generated line:col back to the original file and line.
//               For a DOM element that line is checked against the source (see checked()).
//   Vue 3       __vueParentComponent -> component type.__file (a file, no line)
//   Svelte      __svelte_meta.loc {file, line, column}, both bases normalised to 1
// A React fiber is followed up its `.return` chain: a host element rendered inside a
// library component has no app-code source of its own, its nearest app ancestor does.
;(function (root) {
  var HOPS = 30      // DOM ancestors tried before giving up
  var FIBERS = 60    // fiber `.return` steps
  var maps = {}      // module url -> Promise<source map | null>, one fetch per url
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  var DEP = /\/node_modules\/|\/\.vite\/deps\/|\/@/   // dependency or dev-server internal
  var FRAME = /(https?:\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/
  var INLINE = /\/\/[#@] sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)\s*$/

  function up (el) { return el.parentElement || (el.getRootNode && el.getRootNode().host) || null }

  function reactKey (el, prefix) {
    var keys = Object.keys(el)
    for (var i = 0; i < keys.length; i++) if (keys[i].indexOf(prefix) === 0) return el[keys[i]]
    return null
  }
  function reactFiber (el) { return reactKey(el, '__reactFiber$') }

  // First frame of a V8/SpiderMonkey stack that is the app's own code.
  function appFrame (stack) {
    var lines = String(stack || '').split('\n')
    for (var i = 0; i < lines.length; i++) {
      var m = FRAME.exec(lines[i])
      if (!m) continue
      var u = new URL(m[1])
      if (u.origin !== root.location.origin || DEP.test(u.pathname)) continue
      return { url: m[1], line: +m[2], col: +m[3] }
    }
    return null
  }

  function inlineMap (text) {
    var m = INLINE.exec(text)
    if (!m) return null
    var bin = root.atob(m[1]), bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return JSON.parse(new root.TextDecoder().decode(bytes))
  }

  function sourceMap (url) {
    if (!maps[url]) {
      maps[url] = root.fetch(url)
        .then(function (r) { return r.text() })
        .then(inlineMap)
        .catch(function () { return null })
    }
    return maps[url]
  }

  // Source Map v3 `mappings`: the segment of generated `line` (0-based) with the greatest
  // generated column <= `col` (0-based) -> [sourceIndex, originalLine, originalColumn],
  // all 0-based. Source/line/column fields are deltas across the whole string; the
  // generated column restarts on every line.
  function lookup (mappings, line, col) {
    var gLine = 0, gCol = 0, src = 0, oLine = 0, oCol = 0, best = null
    var seg = [], val = 0, shift = 0
    for (var i = 0; i <= mappings.length; i++) {
      var c = i < mappings.length ? mappings.charAt(i) : ';'
      if (c === ',' || c === ';') {
        if (seg.length) {
          gCol += seg[0]
          if (seg.length >= 4) {
            src += seg[1]; oLine += seg[2]; oCol += seg[3]
            if (gLine === line && gCol <= col) best = [src, oLine, oCol]
          }
          seg = []
        }
        if (c === ';') {
          if (gLine === line) return best
          gLine++; gCol = 0
        }
        continue
      }
      var d = B64.indexOf(c)
      val += (d & 31) << shift
      if (d & 32) { shift += 5; continue }
      seg.push(val & 1 ? -(val >>> 1) : val >>> 1)
      val = 0; shift = 0
    }
    return null
  }

  function mapFrame (fr, fiber) {
    return sourceMap(fr.url).then(function (map) {
      if (!map) return ''
      var hit = lookup(map.mappings, fr.line - 1, fr.col - 1)
      if (!hit) return ''
      var file = sourcePath(map, hit[0], fr.url)
      var text = map.sourcesContent && map.sourcesContent[hit[0]]
      // The fiber's own DOM node, not `el`: the walk up `.return` may have reached an ancestor.
      var props = typeof fiber.type === 'string' && fiber.stateNode && reactKey(fiber.stateNode, '__reactProps$')
      if (!props || typeof text !== 'string') return file + ':' + (hit[1] + 1) + ':' + (hit[2] + 1)
      return checked(text, starts(map, hit[0]), hit[1], hit[2], fiber.type, props, file)
    })
  }

  // --- React 19: is the mapped JSX really this element's? ---
  //
  // React 19 keeps the FIRST element's _debugStack on a fiber it reuses: when a component
  // renders `<div className="loading">` and later `<div className="app">` at the same place,
  // the app div lives in the loading div's fiber and its stack points at the loading line
  // (react-dom updateElement refreshes _debugOwner, not _debugStack). The element's current
  // props are on its DOM node's __reactProps$, which commitUpdate refreshes on every update;
  // the fiber the node points at is one of an alternating pair and after an odd number of
  // updates still holds the previous render's props. So for a DOM element the tag at the
  // mapped position is checked against the node's props (contradiction()):
  //   none   -> the mapped line is kept;
  //   strong -> the one tag in the file whose literals give exactly these props (exact()),
  //             or the file without a line when there is none or several;
  //   weak   -> that tag too, but with none or several the mapped line is kept.
  // A capitalised tag is a host element written through a variable
  // (`const Comp = asChild ? Slot : "button"`), at the mapped position and in the search.
  function checked (text, lineStart, line, col, name, props, file) {
    var here = file + ':' + (line + 1) + ':' + (col + 1)
    var at = openTag(text, lineStart[line] + col)
    var c = at && (at.name === name || /^[A-Z]/.test(at.name)) ? contradiction(at, props) : STRONG
    if (!c) return here
    var re = new RegExp('<(?:' + name + '|[A-Z][\\w.:-]*)(?=[\\s/>])', 'g'), found = [], m
    while ((m = re.exec(text))) {
      // `useRef<HTMLDivElement>`: a "<" right after an identifier is a TS type argument;
      // formatted JSX never puts one there.
      if (/[\w$.]/.test(text.charAt(m.index - 1))) continue
      var t = openTag(text, m.index)
      if (t && exact(t, props)) found.push(m.index)
    }
    if (found.length !== 1) return c === WEAK ? here : file
    for (var l = lineStart.length - 1; lineStart[l] > found[0]; l--) {}
    return file + ':' + (l + 1) + ':' + (found[0] - lineStart[l] + 1)
  }

  // Offsets of every line start of a source, kept on the map (one source is asked often).
  function starts (map, i) {
    var cache = map.__starts || (map.__starts = {})
    if (!cache[i]) {
      var s = map.sourcesContent[i], out = [0]
      for (var k = 0; k < s.length; k++) if (s.charCodeAt(k) === 10) out.push(k + 1)
      cache[i] = out
    }
    return cache[i]
  }

  // The props, not the DOM: code adds classes to the DOM later, the props never have them.
  var CHECKED = ['className', 'id']
  var WEAK = 1, STRONG = 2
  function hasLiteral (tag, attr) { return Object.prototype.hasOwnProperty.call(tag.lit, attr) }

  // How the tag's className and id stand against the props. A computed value or a spread can
  // pass anything (a spread after a literal even overrides it): never a contradiction. A
  // literal that differs from the prop is a strong one. A prop the tag does not write is a
  // weak one — a parent that clones the child may have added it (Radix Slot merges its
  // className in, a Radix trigger adds an id).
  function contradiction (tag, props) {
    var c = 0
    CHECKED.forEach(function (a) {
      if (tag.spread || tag.dyn[a]) return
      if (hasLiteral(tag, a)) { if (props[a] !== tag.lit[a]) c = STRONG }
      else if (props[a] != null && c < WEAK) c = WEAK
    })
    return c
  }

  // A replacement is accepted on its literals alone: exactly these props, both ways (no
  // attribute, no prop).
  function exact (tag, props) {
    return CHECKED.every(function (a) {
      if (tag.dyn[a]) return false
      return hasLiteral(tag, a) ? props[a] === tag.lit[a] : props[a] == null
    })
  }

  // The JSX opening tag whose "<" is at `i`: its name, the attributes given as string
  // literals (`lit`), those given as {expressions} (`dyn`), and whether it spreads props.
  // Expressions are skipped whole — strings, template literals and comments inside them
  // included — so the `>` of an arrow function does not end the tag.
  function openTag (s, i) {
    var m = /^<([A-Za-z][\w.:-]*)/.exec(s.slice(i, i + 64))
    if (!m) return null
    var tag = { name: m[1], lit: {}, dyn: {}, spread: false }
    var depth = 0, attr = null
    for (var j = i + m[0].length; j < s.length;) {
      var c = s.charAt(j)
      if (c === '"' || c === "'" || c === '`') {
        var end = skipString(s, j)
        if (!depth && attr) tag.lit[attr] = s.slice(j + 1, end - 1)
        attr = null; j = end; continue
      }
      if (depth && c === '/' && (s.charAt(j + 1) === '/' || s.charAt(j + 1) === '*')) {
        var close = s.charAt(j + 1) === '/' ? s.indexOf('\n', j) : s.indexOf('*/', j) + 1
        j = close > 0 ? close + 1 : s.length; continue
      }
      if (c === '{') {
        if (!depth) {
          if (attr) tag.dyn[attr] = 1
          else if (/^\{\s*\.\.\./.test(s.slice(j, j + 16))) tag.spread = true
          attr = null
        }
        depth++; j++; continue
      }
      if (c === '}') { depth--; j++; continue }
      if (!depth) {
        if (c === '>') return tag
        var a = /^([A-Za-z_][\w:-]*)\s*=\s*/.exec(s.slice(j, j + 64))
        if (a) { attr = a[1]; j += a[0].length; continue }
      }
      j++
    }
    return null
  }
  function skipString (s, j) {
    for (var k = j + 1, q = s.charAt(j); k < s.length; k++) {
      if (s.charAt(k) === '\\') k++
      else if (s.charAt(k) === q) return k + 1
    }
    return s.length
  }

  // A source is relative to the map, and an inline map lives at the module's url, so a
  // relative source resolves against the module url; the path the dev server serves it
  // under is the project-relative path. An absolute filesystem path is kept as it is.
  function sourcePath (map, i, moduleUrl) {
    var s = (map.sourceRoot || '') + map.sources[i]
    if (s.charAt(0) === '/' || /^[a-z]+:/i.test(s)) return s
    return new URL(s, moduleUrl).pathname.replace(/^\//, '')
  }

  function fromReact (fiber) {
    for (var f = fiber, i = 0; f && i < FIBERS; f = f.return, i++) {
      var s = f._debugSource
      if (s && s.fileName && !DEP.test(s.fileName)) {
        return s.fileName + ':' + s.lineNumber + (s.columnNumber != null ? ':' + s.columnNumber : '')
      }
      var fr = f._debugStack && appFrame(f._debugStack.stack)
      if (fr) return mapFrame(fr, f)
    }
    return ''
  }

  function fromVue (inst) {
    for (var c = inst, i = 0; c && i < FIBERS; c = c.parent, i++) {
      if (c.type && c.type.__file) return c.type.__file
    }
    return ''
  }

  function find (el) {
    for (var cur = el, hops = 0; cur && hops < HOPS; cur = up(cur), hops++) {
      var fiber = reactFiber(cur)
      if (fiber) return fromReact(fiber)
      if (cur.__vueParentComponent) return fromVue(cur.__vueParentComponent)
      // Columns are 0-based in both Svelte 4 and 5. The line is 0-based in Svelte 4 — whose
      // loc also carries `char` — and 1-based in Svelte 5.
      var loc = cur.__svelte_meta && cur.__svelte_meta.loc
      if (loc && loc.file) return loc.file + ':' + (loc.line + ('char' in loc ? 1 : 0)) + ':' + (loc.column + 1)
    }
    return ''
  }

  function resolve (el) {
    return Promise.resolve()
      .then(function () { return find(el) })
      .then(function (v) { return v || '' }, function () { return '' })
  }

  var api = { resolve: resolve }
  if (typeof module === 'object' && module && module.exports) module.exports = api
  else root.__tackSource = api
})(typeof window !== 'undefined' ? window : globalThis)
