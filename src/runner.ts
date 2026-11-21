/**
 * runner.ts — execute room files in the browser, sandboxed.
 *
 *  - .js / .mjs  -> hidden `<iframe sandbox="allow-scripts">` (opaque origin, no access to the app),
 *                   console + errors bridged back with postMessage.
 *  - .ts         -> transpiled with Monaco's TypeScript worker, then run like JS.
 *  - .py         -> Pyodide 0.26.4 in a dedicated, cached Web Worker.
 *  - .html/.htm  -> not "run"; use {@link buildPreview} and show the result in a preview iframe.
 *
 * Only one program runs at a time: {@link runCode} stops the previous run first.
 *
 * JS completion detection: the iframe wraps setTimeout / setInterval / requestAnimationFrame / fetch and
 * counts pending work. After the top-level script has finished (for modules: after the entry module's
 * evaluation promise settles), the sandbox posts "idle"/"busy" transitions; the parent ends the run once
 * the sandbox has stayed idle for 60 ms (the grace timer runs in the parent because timers inside an
 * offscreen cross-origin frame can be throttled).
 * Promises waiting on untracked sources (WebSocket, XHR, a never-resolving promise, DOM events) do not
 * keep the run alive. A live setInterval keeps it alive until it is cleared, stopRun() or the 15 s timeout.
 */
import * as monaco from 'monaco-editor';

export type OutputStream = 'out' | 'err' | 'info';
export interface OutputLine {
  stream: OutputStream;
  text: string;
}

/** Hard wall-clock limit for JavaScript / TypeScript runs. */
const JS_TIMEOUT_MS = 15_000;
/** Execution limit for Python (counted after Pyodide and imported packages have loaded). */
const PY_TIMEOUT_MS = 30_000;
/** Limit for loading Pyodide + packages before the program starts. */
const PY_LOAD_TIMEOUT_MS = 180_000;
/** A JS run ends once the sandbox has reported "idle" (no pending timers/fetches) for this long. */
const IDLE_GRACE_MS = 60;
/** A run that prints more lines than this is stopped (protects the UI from print floods). */
const MAX_LINES_PER_RUN = 5_000;
/** Individual lines are truncated to this many characters. */
const MAX_LINE_CHARS = 10_000;

const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
/** Bare npm specifiers in JS modules (`import x from 'lodash-es'`) are loaded from here. */
const NPM_CDN = 'https://esm.sh/';

function extOf(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** 'preview' for .html/.htm, 'run' for .js/.mjs/.ts/.py, null otherwise. */
export function runKind(filename: string): 'run' | 'preview' | null {
  const ext = extOf(filename);
  if (ext === 'html' || ext === 'htm') return 'preview';
  if (ext === 'js' || ext === 'mjs' || ext === 'ts' || ext === 'py') return 'run';
  return null;
}

/** true if this filename can be executed or previewed. */
export function canRun(filename: string): boolean {
  return runKind(filename) !== null;
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------

interface ActiveRun {
  /** Ends the run (idempotent). `reason` is printed as the final info line. */
  finish(reason: string): void;
}

let active: ActiveRun | null = null;

/** Abort the currently running program, if any. Emits a final "Stopped" info line for that run. */
export function stopRun(): void {
  active?.finish('Stopped');
}

/**
 * Execute a file. `files` = all files in the room (name -> content); used to resolve JS/TS imports
 * (`./util.js`, `./util`) and, for Python, written into Pyodide's FS so `import other` / `open('data.txt')` work.
 * Streams console output through onOutput. Resolves when the program finishes, errors, times out or is stopped.
 * The last line emitted is always an 'info' line: "Finished in N ms", "Finished with errors in N ms",
 * "Stopped", "Timed out after 15s", ...
 */
export function runCode(
  filename: string,
  files: Record<string, string>,
  onOutput: (line: OutputLine) => void,
): Promise<void> {
  stopRun();
  const kind = runKind(filename);
  const ext = extOf(filename);
  if (kind === 'preview') {
    onOutput({ stream: 'info', text: `${filename} is an HTML page; open it in the Preview tab.` });
    return Promise.resolve();
  }
  if (kind !== 'run') {
    onOutput({ stream: 'info', text: `Don't know how to run ${filename}.` });
    return Promise.resolve();
  }
  const source = files[filename] ?? '';
  return ext === 'py' ? runPython(filename, source, files, onOutput) : runJsLike(filename, source, files, onOutput, ext === 'ts');
}

/** Wraps onOutput with truncation and a per-run line limit. */
function makeEmitter(onOutput: (line: OutputLine) => void, onFlood: () => void) {
  let count = 0;
  let flooded = false;
  return (line: OutputLine) => {
    if (flooded) return;
    if (++count > MAX_LINES_PER_RUN) {
      flooded = true;
      onOutput({ stream: 'err', text: `Output limit (${MAX_LINES_PER_RUN} lines) reached; stopping the program.` });
      onFlood();
      return;
    }
    const text = line.text.length > MAX_LINE_CHARS ? line.text.slice(0, MAX_LINE_CHARS) + ' …[truncated]' : line.text;
    try {
      onOutput({ stream: line.stream, text });
    } catch (e) {
      console.error('runner: onOutput threw', e);
    }
  };
}

// ---------------------------------------------------------------------------
// Path helpers / module graph for JS & TS
// ---------------------------------------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i + 1) : '';
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Resolve a relative/absolute reference from `fromFile` to a room filename, trying `exts` suffixes. */
function resolveFile(fromFile: string, ref: string, files: Record<string, string>, exts: string[] = ['']): string | null {
  const clean = ref.split(/[?#]/)[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  const base = clean.startsWith('/') ? clean : dirOf(fromFile) + clean;
  const p = normalizePath(base);
  for (const ext of exts) {
    if (Object.prototype.hasOwnProperty.call(files, p + ext)) return p + ext;
  }
  return null;
}

const IMPORT_RE = /(\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;
const MODULE_EXTS = ['', '.js', '.mjs', '.ts', '/index.js', '/index.mjs', '/index.ts'];

function moduleId(filename: string): string {
  return '@cocode/' + filename;
}

/** Data URL for a module; the `cocode=` parameter lets us map stack traces back to the filename. */
function moduleDataUrl(filename: string, code: string): string {
  return `data:text/javascript;cocode=${encodeURIComponent(filename)};charset=utf-8,${encodeURIComponent(code)}`;
}

/**
 * Walks the import graph from `entry`, rewriting relative imports to `@cocode/<file>` bare specifiers
 * and bare npm specifiers to esm.sh. Returns an import map `{ "@cocode/x": dataUrl }`.
 */
async function buildModuleGraph(
  entry: string,
  entryCode: string,
  files: Record<string, string>,
  transpile: (filename: string, code: string) => Promise<string>,
  emitErr: (text: string) => void,
): Promise<Record<string, string>> {
  const imports: Record<string, string> = {};
  const done = new Set<string>();
  const queue: Array<[string, string]> = [[entry, entryCode]];
  while (queue.length) {
    const [file, code] = queue.shift()!;
    if (done.has(file)) continue;
    done.add(file);
    const deps: string[] = [];
    const rewritten = code.replace(IMPORT_RE, (m, pre: string, q: string, spec: string) => {
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
        const target = resolveFile(file, spec, files, MODULE_EXTS);
        if (!target) {
          emitErr(`${file}: cannot resolve import '${spec}'`);
          return m;
        }
        deps.push(target);
        return `${pre}${q}${moduleId(target)}${q}`;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return m; // absolute URL (https:, data:, ...)
      return `${pre}${q}${NPM_CDN}${spec}${q}`; // bare npm package
    });
    imports[moduleId(file)] = moduleDataUrl(file, rewritten);
    for (const dep of deps) {
      if (done.has(dep)) continue;
      let depCode = files[dep] ?? '';
      if (extOf(dep) === 'ts') depCode = await transpile(dep, depCode);
      queue.push([dep, depCode]);
    }
  }
  return imports;
}

/** True if `code` cannot be a classic script (has import/export or top-level await, or a syntax error). */
function needsModule(code: string): boolean {
  try {
    // Compiles only; nothing is executed.
    new Function(code);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// TypeScript transpilation via Monaco's TS worker
// ---------------------------------------------------------------------------

/**
 * Monaco registers its TS language service lazily (when the first 'typescript' model appears), so
 * getTypeScriptWorker() rejects with "TypeScript not registered!" for a moment. Retry for up to 10 s.
 */
async function tsWorkerAccessor(): Promise<(...uris: monaco.Uri[]) => Promise<monaco.languages.typescript.TypeScriptWorker>> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    try {
      return await monaco.languages.typescript.getTypeScriptWorker();
    } catch (e) {
      if (performance.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function transpileTs(filename: string, code: string, emitErr: (text: string) => void): Promise<string> {
  const uri = monaco.Uri.parse(`file:///__cocode_run__${Date.now()}_${Math.random().toString(36).slice(2)}.ts`);
  const model = monaco.editor.createModel(code, 'typescript', uri);
  try {
    const getWorker = await tsWorkerAccessor();
    const worker = await getWorker(model.uri);
    const diags = await worker.getSyntacticDiagnostics(model.uri.toString());
    for (const d of diags) {
      const msg = typeof d.messageText === 'string' ? d.messageText : flattenDiag(d.messageText);
      let where = filename;
      if (typeof d.start === 'number') {
        const pos = model.getPositionAt(d.start);
        where += `:${pos.lineNumber}:${pos.column}`;
      }
      emitErr(`${where} - error TS${d.code}: ${msg}`);
    }
    const out = await worker.getEmitOutput(model.uri.toString());
    if (out.emitSkipped || !out.outputFiles.length) throw new Error(`TypeScript emit failed for ${filename}`);
    const js = out.outputFiles.find((f) => f.name.endsWith('.js')) ?? out.outputFiles[0];
    return js.text;
  } finally {
    model.dispose();
  }
}

function flattenDiag(chain: { messageText: string; next?: unknown[] } | undefined): string {
  if (!chain) return '';
  let s = chain.messageText;
  for (const n of (chain.next ?? []) as Array<{ messageText: string; next?: unknown[] }>) s += ' ' + flattenDiag(n);
  return s;
}

// ---------------------------------------------------------------------------
// JavaScript sandbox
// ---------------------------------------------------------------------------

/** Script injected into the sandbox before user code. `__TOKEN__` is replaced with a JSON string. */
const SANDBOX_RUNTIME = String.raw`(function () {
  var TOKEN = __TOKEN__;
  var P = parent;
  function post(m) { m.__cocode = TOKEN; try { P.postMessage(m, '*'); } catch (e) {} }
  var oST = setTimeout, oCT = clearTimeout, oSI = setInterval, oCI = clearInterval;
  var timeouts = new Set(), intervals = new Set(), inflight = 0, groupDepth = 0;
  // Idle reporting: after the top-level code ran, post "idle" whenever no tracked work is pending and
  // "busy" when work appears again. The parent ends the run after a short grace period of idleness.
  // (Timers in an offscreen cross-origin frame may be throttled, so the grace timer lives in the parent.)
  var ranOnce = false, reportedIdle = false;
  function check() {
    if (!ranOnce) return;
    Promise.resolve().then(function () {
      var idle = timeouts.size === 0 && intervals.size === 0 && inflight === 0;
      if (idle !== reportedIdle) { reportedIdle = idle; post({ type: idle ? 'idle' : 'busy' }); }
    });
  }

  window.setTimeout = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = oST(function () {
      timeouts.delete(id);
      try { if (typeof fn === 'function') fn.apply(window, args); else (0, eval)(String(fn)); }
      finally { check(); }
    }, ms);
    timeouts.add(id);
    check();
    return id;
  };
  window.clearTimeout = function (id) { timeouts.delete(id); intervals.delete(id); oCT(id); check(); };
  window.setInterval = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = oSI(function () { if (typeof fn === 'function') fn.apply(window, args); else (0, eval)(String(fn)); }, ms);
    intervals.add(id);
    check();
    return id;
  };
  window.clearInterval = window.clearTimeout;
  // Hidden iframes may never get animation frames; emulate with timers so they are tracked.
  window.requestAnimationFrame = function (cb) { return window.setTimeout(function () { cb(performance.now()); }, 16); };
  window.cancelAnimationFrame = function (id) { window.clearTimeout(id); };
  if (window.fetch) {
    var oFetch = window.fetch;
    window.fetch = function () {
      inflight++;
      check();
      var done = function () { inflight--; check(); };
      var p = oFetch.apply(this, arguments);
      p.then(done, done);
      return p;
    };
  }

  function json(v) {
    var stack = [];
    function rep(key, val) {
      if (typeof val === 'bigint') return val.toString() + 'n';
      if (typeof val === 'function') return '[Function' + (val.name ? ': ' + val.name : ' (anonymous)') + ']';
      if (typeof val === 'symbol') return val.toString();
      if (val === undefined) return '[undefined]';
      if (typeof val === 'number' && !isFinite(val)) return String(val);
      if (val && typeof val === 'object') {
        while (stack.length && stack[stack.length - 1] !== this) stack.pop();
        if (stack.indexOf(val) !== -1) return '[Circular]';
        stack.push(val);
        if (val instanceof Error) return { name: val.name, message: val.message };
        if (val instanceof Map) { var o = {}; val.forEach(function (x, k) { o[String(k)] = x; }); return { '[Map]': o }; }
        if (val instanceof Set) return { '[Set]': Array.from(val) };
        if (val instanceof Date) return val.toISOString();
        if (val instanceof RegExp) return val.toString();
        if (typeof Node !== 'undefined' && val instanceof Node) return '[' + val.nodeName + ']';
        if (ArrayBuffer.isView(val) && !(val instanceof DataView)) return Array.from(val);
      }
      return val;
    }
    try {
      var compact = JSON.stringify(v, rep);
      if (compact === undefined) return String(v);
      if (compact.length <= 80) return compact;
      stack = [];
      return JSON.stringify(v, rep, 2);
    } catch (e) {
      try { return String(v); } catch (e2) { return '[object]'; }
    }
  }
  function errText(e) {
    var head = (e && e.name ? e.name : 'Error') + ': ' + (e && e.message);
    var st = e && e.stack ? String(e.stack) : '';
    if (!st) return head;
    return st.indexOf(e.message) !== -1 ? st : head + '\n' + st;
  }
  function fmt1(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return errText(v);
    if (v === undefined) return 'undefined';
    if (typeof v === 'function') return v.toString().length < 200 ? v.toString() : '[Function' + (v.name ? ': ' + v.name : '') + ']';
    if (typeof v === 'symbol') return v.toString();
    if (typeof v === 'bigint') return v.toString() + 'n';
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
    return json(v);
  }
  function fmt(args) {
    args = Array.prototype.slice.call(args);
    var out = [];
    if (typeof args[0] === 'string' && args[0].indexOf('%') !== -1 && args.length > 1) {
      var f = args.shift();
      f = f.replace(/%([sdifoOjc%])/g, function (m, c) {
        if (c === '%') return '%';
        if (!args.length) return m;
        var a = args.shift();
        if (c === 'c') return '';
        if (c === 'd' || c === 'i') return String(parseInt(a, 10));
        if (c === 'f') return String(parseFloat(a));
        if (c === 's') return typeof a === 'string' ? a : fmt1(a);
        return json(a);
      });
      out.push(f);
    }
    for (var i = 0; i < args.length; i++) out.push(fmt1(args[i]));
    var s = out.join(' ');
    if (groupDepth) { var pad = new Array(groupDepth + 1).join('  '); s = pad + s.replace(/\n/g, '\n' + pad); }
    return s;
  }
  function line(stream, text) { post({ type: 'line', stream: stream, text: text }); }

  var c = window.console = window.console || {};
  var timers = {}, counts = {};
  c.log = c.info = c.debug = c.dir = c.dirxml = function () { line('out', fmt(arguments)); };
  c.warn = c.error = function () { line('err', fmt(arguments)); };
  c.trace = function () { line('err', 'Trace: ' + fmt(arguments) + '\n' + (new Error().stack || '').split('\n').slice(2).join('\n')); };
  c.assert = function (cond) { if (!cond) line('err', 'Assertion failed' + (arguments.length > 1 ? ': ' + fmt(Array.prototype.slice.call(arguments, 1)) : '')); };
  c.table = function (d) { line('out', json(d)); };
  c.group = c.groupCollapsed = function () { if (arguments.length) line('out', fmt(arguments)); groupDepth++; };
  c.groupEnd = function () { if (groupDepth) groupDepth--; };
  c.time = function (l) { timers[l === undefined ? 'default' : l] = performance.now(); };
  c.timeLog = function (l) { l = l === undefined ? 'default' : l; if (l in timers) line('out', l + ': ' + (performance.now() - timers[l]).toFixed(3) + ' ms'); };
  c.timeEnd = function (l) { l = l === undefined ? 'default' : l; c.timeLog(l); delete timers[l]; };
  c.count = function (l) { l = l === undefined ? 'default' : l; counts[l] = (counts[l] || 0) + 1; line('out', l + ': ' + counts[l]); };
  c.countReset = function (l) { counts[l === undefined ? 'default' : l] = 0; };
  c.clear = function () {};

  window.onerror = function (msg, src, ln, col, err) {
    line('err', err ? 'Uncaught ' + errText(err) : String(msg) + (ln ? ' (at ' + src + ':' + ln + ':' + col + ')' : ''));
    return true;
  };
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    line('err', 'Uncaught (in promise) ' + (r instanceof Error ? errText(r) : fmt1(r)));
    ev.preventDefault();
  });

  window.__cocode_report = function (e) { line('err', 'Uncaught ' + (e instanceof Error ? errText(e) : fmt1(e))); };
  window.__cocode_ran = function () {
    if (ranOnce) return;
    ranOnce = true;
    check();
  };
})();`;

/** `</script` inside inline script text would close the element early. */
function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function newToken(): string {
  const a = new Uint32Array(4);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => n.toString(36)).join('');
}

async function runJsLike(
  filename: string,
  source: string,
  files: Record<string, string>,
  onOutput: (l: OutputLine) => void,
  isTs: boolean,
): Promise<void> {
  let finished = false;
  let iframe: HTMLIFrameElement | null = null;
  let timer = 0;
  let idleTimer = 0;
  let start = performance.now();
  let hadError = false;
  let resolveRun!: () => void;
  const runDone = new Promise<void>((r) => (resolveRun = r));
  let srcdocLineOffset = 0;

  const run: ActiveRun = {
    finish(reason: string) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      window.removeEventListener('message', onMessage);
      iframe?.remove();
      iframe = null;
      if (active === run) active = null;
      try {
        onOutput({ stream: 'info', text: reason });
      } catch {
        /* ignore */
      }
      resolveRun();
    },
  };
  active = run;
  const emit = makeEmitter(onOutput, () => run.finish('Stopped (output limit)'));
  const emitErr = (text: string) => {
    hadError = true;
    emit({ stream: 'err', text });
  };

  /** Map sandbox locations back to filenames / line numbers. */
  const cleanText = (text: string) =>
    text
      .replace(/data:text\/javascript;cocode=([^;,]+)[^,]*,[^:\s]*:(\d+):(\d+)/g, (_m, f: string, l: string, c: string) => {
        let name = f;
        try {
          name = decodeURIComponent(f);
        } catch {
          /* keep */
        }
        return `${name}:${l}:${c}`;
      })
      .replace(/about:srcdoc:(\d+):(\d+)/g, (_m, l: string, c: string) => {
        const n = Number(l) - srcdocLineOffset;
        return n > 0 ? `${filename}:${n}:${c}` : `<runtime>:${l}:${c}`;
      });

  function onMessage(ev: MessageEvent) {
    if (finished || !iframe || ev.source !== iframe.contentWindow) return;
    const d = ev.data as { __cocode?: unknown; type?: unknown; stream?: unknown; text?: unknown } | null;
    if (!d || typeof d !== 'object' || d.__cocode !== token) return;
    if (d.type === 'line') {
      const stream: OutputStream = d.stream === 'err' ? 'err' : d.stream === 'info' ? 'info' : 'out';
      const text = cleanText(String(d.text ?? ''));
      if (stream === 'err') emitErr(text);
      else emit({ stream, text });
    } else if (d.type === 'busy') {
      clearTimeout(idleTimer);
    } else if (d.type === 'idle') {
      clearTimeout(idleTimer);
      idleTimer = window.setTimeout(finishOk, IDLE_GRACE_MS);
    }
  }
  function finishOk() {
    const ms = Math.round(performance.now() - start);
    run.finish(hadError ? `Finished with errors in ${ms} ms` : `Finished in ${ms} ms`);
  }

  const token = newToken();
  try {
    const transpile = (name: string, code: string) => transpileTs(name, code, emitErr);
    let code = source;
    if (isTs) code = await transpile(filename, source);
    if (finished) return runDone;

    const head = '<!doctype html>\n<html><head><meta charset="utf-8">\n';
    const runtime = `<script>${SANDBOX_RUNTIME.replace('__TOKEN__', JSON.stringify(token))}</script>\n`;
    let html: string;
    if (extOf(filename) === 'mjs' || needsModule(code)) {
      const imports = await buildModuleGraph(filename, code, files, transpile, emitErr);
      if (finished) return runDone;
      const map = escapeInlineScript(JSON.stringify({ imports }));
      html =
        head +
        `<script type="importmap">${map}</script>\n` +
        runtime +
        `<script type="module">import(${JSON.stringify(moduleId(filename))}).then(function () { __cocode_ran(); }, function (e) { __cocode_report(e); __cocode_ran(); });</script>\n` +
        '</head><body></body></html>';
    } else {
      const before = head + runtime + '<script>\n';
      srcdocLineOffset = before.split('\n').length - 1;
      html = before + escapeInlineScript(code) + '\n</script>\n<script>__cocode_ran();</script>\n</head><body></body></html>';
    }

    window.addEventListener('message', onMessage);
    iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.title = 'CoCode runner';
    iframe.style.cssText =
      'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;z-index:-1;';
    iframe.srcdoc = html;
    start = performance.now();
    timer = window.setTimeout(() => run.finish(`Timed out after ${JS_TIMEOUT_MS / 1000}s`), JS_TIMEOUT_MS);
    document.body.appendChild(iframe);
  } catch (e) {
    emitErr(e instanceof Error ? e.message : String(e));
    run.finish('Failed');
  }
  return runDone;
}

// ---------------------------------------------------------------------------
// Python (Pyodide in a Web Worker)
// ---------------------------------------------------------------------------

const PY_WORKER_SRC = `
const BASE = ${JSON.stringify(PYODIDE_BASE)};
let pyodide = null;
let written = [];
const out = (stream, text) => postMessage({ type: 'line', stream, text });
const ready = (async () => {
  importScripts(BASE + 'pyodide.js');
  pyodide = await loadPyodide({ indexURL: BASE });
  pyodide.setStdout({ batched: (s) => out('out', s) });
  pyodide.setStderr({ batched: (s) => out('err', s) });
  pyodide.setStdin({ stdin: () => null });
  pyodide.runPython("import sys, os\\nif os.getcwd() not in sys.path: sys.path.insert(0, os.getcwd())");
})();
ready.then(() => postMessage({ type: 'ready' }), (e) => postMessage({ type: 'loadError', text: String((e && e.message) || e) }));

function mkdirs(path) {
  const parts = path.split('/').slice(0, -1);
  let cur = '';
  for (const p of parts) {
    cur += (cur ? '/' : '') + p;
    try { pyodide.FS.mkdir(cur); } catch (e) { /* exists */ }
  }
}

onmessage = async (ev) => {
  const { id, filename, files } = ev.data;
  try { await ready; } catch (e) { return; }
  let globals = null;
  try {
    for (const f of written) { try { pyodide.FS.unlink(f); } catch (e) {} }
    written = [];
    for (const name of Object.keys(files)) {
      if (!name || name.startsWith('/') || name.split('/').includes('..')) continue;
      mkdirs(name);
      pyodide.FS.writeFile(name, files[name]);
      written.push(name);
    }
    const mods = Object.keys(files).filter((n) => n.endsWith('.py')).map((n) => n.slice(0, -3).replace(/\\//g, '.'));
    pyodide.globals.set('__cocode_mods', pyodide.toPy(mods));
    pyodide.runPython("import sys, importlib\\nfor _m in __cocode_mods:\\n    sys.modules.pop(_m, None)\\nimportlib.invalidate_caches()\\ndel __cocode_mods");
    const code = files[filename] || '';
    await pyodide.loadPackagesFromImports(code, {
      messageCallback: (m) => out('info', m),
      errorCallback: (m) => out('err', m),
    });
    postMessage({ type: 'started', id });
    globals = pyodide.toPy({ __name__: '__main__', __file__: filename });
    await pyodide.runPythonAsync(code, { globals, filename });
    postMessage({ type: 'done', id });
  } catch (e) {
    postMessage({ type: 'done', id, error: String((e && e.message) || e) });
  } finally {
    try { if (globals) globals.destroy(); } catch (e) {}
  }
};
`;

/** Drop Pyodide-internal frames (`File "/lib/python3…"`) from a traceback. */
function trimPyTraceback(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.replace(/\n+$/, '').split('\n')) {
    if (/^ {2}File "/.test(line)) skipping = line.startsWith('  File "/lib/python');
    else if (!line.startsWith('    ')) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

let pyWorker: Worker | null = null;
let pyReady = false;
let pyRunId = 0;

function getPyWorker(emitInfo: (t: string) => void): Worker {
  if (pyWorker) return pyWorker;
  emitInfo('Loading Python…');
  const url = URL.createObjectURL(new Blob([PY_WORKER_SRC], { type: 'text/javascript' }));
  pyWorker = new Worker(url);
  URL.revokeObjectURL(url);
  pyReady = false;
  return pyWorker;
}

function killPyWorker(): void {
  pyWorker?.terminate();
  pyWorker = null;
  pyReady = false;
}

function runPython(
  filename: string,
  _source: string,
  files: Record<string, string>,
  onOutput: (l: OutputLine) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false;
    let start = performance.now();
    let timer = 0;
    let hadError = false;
    const id = ++pyRunId;
    const loadStart = performance.now();

    const run: ActiveRun = {
      finish(reason: string) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (reason !== '__ok__') killPyWorker(); // stop / timeout / crash: worker is recreated next run
        if (active === run) active = null;
        try {
          onOutput({ stream: 'info', text: reason === '__ok__' ? okText() : reason });
        } catch {
          /* ignore */
        }
        resolve();
      },
    };
    const okText = () => {
      const ms = Math.round(performance.now() - start);
      return hadError ? `Finished with errors in ${ms} ms` : `Finished in ${ms} ms`;
    };
    active = run;
    const emit = makeEmitter(onOutput, () => run.finish('Stopped (output limit)'));
    const worker = getPyWorker((t) => emit({ stream: 'info', text: t }));

    function onMessage(ev: MessageEvent) {
      if (finished) return;
      const d = ev.data as { type: string; id?: number; stream?: OutputStream; text?: string; error?: string };
      if (d.id !== undefined && d.id !== id) return;
      switch (d.type) {
        case 'ready':
          if (!pyReady) emit({ stream: 'info', text: `Python ready (${((performance.now() - loadStart) / 1000).toFixed(1)}s)` });
          pyReady = true;
          break;
        case 'loadError':
          hadError = true;
          emit({ stream: 'err', text: `Failed to load Python: ${d.text ?? ''}` });
          run.finish('Failed');
          break;
        case 'line': {
          const stream: OutputStream = d.stream === 'err' ? 'err' : d.stream === 'info' ? 'info' : 'out';
          if (stream === 'err') hadError = true;
          emit({ stream, text: String(d.text ?? '') });
          break;
        }
        case 'started':
          start = performance.now();
          clearTimeout(timer);
          timer = window.setTimeout(() => run.finish(`Timed out after ${PY_TIMEOUT_MS / 1000}s`), PY_TIMEOUT_MS);
          break;
        case 'done':
          if (d.error) {
            hadError = true;
            emit({ stream: 'err', text: trimPyTraceback(d.error) });
          }
          run.finish('__ok__');
          break;
      }
    }
    function onError(ev: ErrorEvent) {
      ev.preventDefault();
      hadError = true;
      emit({ stream: 'err', text: `Python worker error: ${ev.message || 'unknown error'}` });
      run.finish('Failed');
    }

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    timer = window.setTimeout(
      () => run.finish(`Timed out loading Python after ${PY_LOAD_TIMEOUT_MS / 1000}s`),
      PY_LOAD_TIMEOUT_MS,
    );
    worker.postMessage({ id, filename, files: { ...files } });
  });
}

// ---------------------------------------------------------------------------
// HTML preview
// ---------------------------------------------------------------------------

const IMAGE_MIME: Record<string, string> = { svg: 'image/svg+xml' };

/**
 * Build a self-contained HTML document for previewing an .html file: inlines
 * `<link rel="stylesheet" href="x.css">` and `<script src="x.js">` that refer to files in `files`
 * (paths relative to the HTML file; `./` and `/` prefixes OK), and `.svg` images referenced by `<img src>`.
 * External URLs are left untouched. Render the result in a sandboxed iframe (no allow-same-origin).
 */
export function buildPreview(filename: string, files: Record<string, string>): string {
  const html = files[filename] ?? '';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.querySelectorAll('link[href]').forEach((link) => {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) return;
    const target = resolveFile(filename, link.getAttribute('href') ?? '', files);
    if (!target) return;
    const style = doc.createElement('style');
    const media = link.getAttribute('media');
    if (media) style.setAttribute('media', media);
    style.setAttribute('data-cocode-src', target);
    style.textContent = (files[target] ?? '').replace(/<\/(style)/gi, '<\\/$1');
    link.replaceWith(style);
  });

  doc.querySelectorAll('script[src]').forEach((el) => {
    const target = resolveFile(filename, el.getAttribute('src') ?? '', files, ['', '.js']);
    if (!target) return;
    const script = doc.createElement('script');
    for (const attr of Array.from(el.attributes)) {
      if (attr.name !== 'src' && attr.name !== 'defer' && attr.name !== 'async') script.setAttribute(attr.name, attr.value);
    }
    script.setAttribute('data-cocode-src', target);
    let code = files[target] ?? '';
    // An inline classic script runs immediately, unlike the deferred external one it replaces.
    if (el.hasAttribute('defer') && (script.getAttribute('type') ?? '') !== 'module') {
      code = `document.addEventListener('DOMContentLoaded', function () {\n${code}\n});`;
    }
    script.textContent = escapeInlineScript(code);
    el.replaceWith(script);
  });

  doc.querySelectorAll('img[src]').forEach((img) => {
    const target = resolveFile(filename, img.getAttribute('src') ?? '', files);
    if (!target) return;
    const mime = IMAGE_MIME[extOf(target)];
    if (mime) img.setAttribute('src', `data:${mime};charset=utf-8,${encodeURIComponent(files[target] ?? '')}`);
  });

  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : '<!DOCTYPE html>';
  return `${doctype}\n${doc.documentElement.outerHTML}`;
}
