// Shared per-room shell. SECURITY: this is remote code execution on the host by
// design. It is only active when ENABLE_TERMINAL=1 and only in password-protected
// rooms; index.js enforces both via isAvailable().
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as Y from 'yjs';

export const TERMINAL_ENABLED = process.env.ENABLE_TERMINAL === '1';

const IS_WIN = process.platform === 'win32';
const SCROLLBACK_MAX = 64 * 1024;
const MAX_INPUT = 10 * 1024;
const OUTPUT_BATCH_MS = 30;
const MIRROR_DEBOUNCE_MS = 500;
const FILE_NAME_RE = /^[\w.\-/]{1,100}$/;

/** @type {Set<RoomTerminal>} */
const live = new Set();

function findOnPath(cmd) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      /* not here */
    }
  }
  return null;
}

function shellCommand() {
  // cmd.exe: /D skips AutoRun registry hooks, /Q turns input echo off (with piped
  // stdin cmd would otherwise echo every line back), /K keeps it reading stdin.
  if (IS_WIN) return { file: process.env.ComSpec || 'cmd.exe', args: ['/D', '/Q', '/K'] };
  return { file: findOnPath('bash') ?? findOnPath('sh') ?? '/bin/sh', args: [] };
}

export class RoomTerminal {
  /**
   * @param {{name: string, doc: Y.Doc}} room
   * @param {string} workspaceRoot  e.g. data/workspaces
   * @param {(msg: object) => void} broadcast  sends a JSON message to every peer in the room
   */
  constructor(room, workspaceRoot, broadcast) {
    this.room = room;
    this.dir = path.resolve(workspaceRoot, room.name);
    this.broadcast = broadcast;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.proc = null;
    this.scrollback = '';
    this.pendingOut = '';
    this.outTimer = null;
    this.mirrorTimer = null;
    this.mirroring = false;
    /** @type {Map<string, string>} filename -> content we last wrote */
    this.written = new Map();
    this.onDocUpdate = () => {
      if (!this.mirrorTimer) this.mirrorTimer = setTimeout(() => this.mirror(), MIRROR_DEBOUNCE_MS);
    };
    live.add(this);
  }

  get running() {
    return this.proc !== null;
  }

  /** Begin keeping the workspace in sync with the doc (call once the room is locked). */
  startMirroring() {
    if (this.mirroring) return;
    this.mirroring = true;
    this.room.doc.on('update', this.onDocUpdate);
    this.mirror();
  }

  mirror() {
    if (this.mirrorTimer) clearTimeout(this.mirrorTimer);
    this.mirrorTimer = null;
    if (!this.mirroring) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      console.error(`[terminal] cannot create workspace ${this.dir}:`, err);
      return;
    }
    const files = this.room.doc.getMap('files');
    const seen = new Set();
    for (const [name, value] of files) {
      if (!(value instanceof Y.Text)) continue;
      const target = this.resolve(name);
      if (!target) continue;
      seen.add(name);
      const text = value.toString();
      if (this.written.get(name) === text && fs.existsSync(target)) continue;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
        this.written.set(name, text);
      } catch (err) {
        console.error(`[terminal] cannot write ${target}:`, err.message);
      }
    }
    for (const name of [...this.written.keys()]) {
      if (seen.has(name)) continue;
      this.written.delete(name);
      const target = this.resolve(name);
      if (!target) continue;
      try {
        fs.rmSync(target, { force: true });
      } catch (err) {
        console.error(`[terminal] cannot delete ${target}:`, err.message);
      }
    }
  }

  /** Maps a doc filename to an absolute path inside the workspace, or null if unsafe. */
  resolve(name) {
    if (typeof name !== 'string' || !FILE_NAME_RE.test(name)) return null;
    const target = path.resolve(this.dir, name);
    const rel = path.relative(this.dir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return target;
  }

  start() {
    if (this.proc) return;
    this.startMirroring();
    this.mirror(); // make sure the workspace is current before the shell sees it
    const { file, args } = shellCommand();
    let proc;
    try {
      proc = spawn(file, args, {
        cwd: this.dir,
        env: { ...process.env, TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group on POSIX so we can kill the whole tree.
        detached: !IS_WIN,
      });
    } catch (err) {
      this.broadcast({ type: 'term-output', data: `\r\n[failed to start shell: ${err.message}]\r\n` });
      this.broadcast({ type: 'term-exit', code: null });
      return;
    }
    this.proc = proc;
    this.scrollback = '';
    this.pendingOut = '';
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    proc.stdout.on('data', (chunk) => this.output(proc, outDec.write(chunk)));
    proc.stderr.on('data', (chunk) => this.output(proc, errDec.write(chunk)));
    proc.stdin.on('error', () => {}); // EPIPE after the shell exits
    let ended = false;
    const finish = (code) => {
      if (ended) return;
      ended = true;
      if (this.proc !== proc) return; // superseded or disposed
      this.output(proc, outDec.end() + errDec.end());
      this.flush();
      this.proc = null;
      this.broadcast({ type: 'term-exit', code: typeof code === 'number' ? code : null });
    };
    proc.on('error', (err) => {
      this.output(proc, `\r\n[shell error: ${err.message}]\r\n`);
      finish(null);
    });
    proc.on('exit', (code) => finish(code));
    console.log(`[terminal] room "${this.room.name}": started ${file} (pid ${proc.pid}) in ${this.dir}`);
    this.broadcast({ type: 'term-started' });
  }

  input(data) {
    if (!this.proc || typeof data !== 'string' || data.length > MAX_INPUT) return;
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT) return;
    this.proc.stdin.write(data);
  }

  output(proc, text) {
    if (!text || this.proc !== proc) return;
    this.pendingOut += text;
    if (!this.outTimer) this.outTimer = setTimeout(() => this.flush(), OUTPUT_BATCH_MS);
  }

  flush() {
    if (this.outTimer) clearTimeout(this.outTimer);
    this.outTimer = null;
    if (!this.pendingOut) return;
    const data = this.pendingOut;
    this.pendingOut = '';
    this.scrollback += data;
    if (this.scrollback.length > SCROLLBACK_MAX) this.scrollback = this.scrollback.slice(-SCROLLBACK_MAX);
    this.broadcast({ type: 'term-output', data });
  }

  /** Messages a newly joined peer needs to catch up (sent after welcome). */
  catchUp() {
    if (!this.proc) return [];
    this.flush();
    return [{ type: 'term-started' }, { type: 'term-output', data: this.scrollback }];
  }

  kill(sync = false) {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.pid === undefined) return;
    if (IS_WIN) {
      const args = ['/pid', String(proc.pid), '/T', '/F'];
      if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => proc.kill());
    } else {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    }
  }

  /** Room is closing (or server shutting down): stop everything. */
  dispose(sync = false) {
    this.kill(sync);
    this.proc = null;
    if (this.outTimer) clearTimeout(this.outTimer);
    this.outTimer = null;
    this.pendingOut = '';
    if (this.mirroring) {
      this.mirror(); // flush any pending doc changes to disk
      this.room.doc.off('update', this.onDocUpdate);
      this.mirroring = false;
    }
    if (this.mirrorTimer) clearTimeout(this.mirrorTimer);
    this.mirrorTimer = null;
    live.delete(this);
  }
}

/** Kill every shell synchronously (server shutdown). */
export function disposeAllTerminals() {
  for (const t of [...live]) t.dispose(true);
}
