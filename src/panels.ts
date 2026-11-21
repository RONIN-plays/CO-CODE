/**
 * panels.ts — the bottom dock under the editor: Output / Terminal / Preview tabs.
 *
 * Usage:
 *   const panel = new BottomPanel(document.getElementById('bottom-panel')!);
 *   panel.onClearOutput = () => ...;
 *   panel.appendOutput({ stream: 'out', text: 'hello', who: 'Ana', color: '#22c55e' });
 *
 * Sizing: the panel sets its own pixel height (resizable via its top edge, remembered in localStorage)
 * and fills the container's width. When collapsed only the header (~32px) is shown. Place the container
 * as a non-growing child (e.g. `flex: none` in a flex column, or an `auto` grid row) below the editor,
 * and let the editor take the remaining space. Use `onResize` to re-layout Monaco if needed.
 *
 * Security: program / user text is only ever inserted via textContent / DOM APIs.
 */
import './panels.css';

export type PanelTab = 'output' | 'terminal' | 'preview';

export interface PanelOutputLine {
  stream: 'out' | 'err' | 'info';
  text: string;
  /** Optional label (e.g. who ran the program). */
  who?: string;
  /** Label colour; only `#rrggbb` is accepted, anything else is ignored. */
  color?: string;
}

export interface TerminalState {
  available: boolean;
  running: boolean;
  /** Shown when `available` is false. */
  reason?: string;
}

const MIN_HEIGHT = 80;
const MAX_FRACTION = 0.7;
const DEFAULT_HEIGHT = 220;
const MAX_OUTPUT_LINES = 2000;
const MAX_TERM_CHARS = 200_000;
const TERM_TRIM_TO = 150_000;
const MAX_HISTORY = 100;
const LS_HEIGHT = 'cocode:panel-height';
const LS_COLLAPSED = 'cocode:panel-collapsed';
const LS_TAB = 'cocode:panel-tab';

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// CSI, OSC (BEL or ST terminated), and other 2-char escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x1b[ -/][@-~]/g;
// eslint-disable-next-line no-control-regex
const INCOMPLETE_ESC_RE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[P^_][^\x1b]*|[ -/])?$/;

export class BottomPanel {
  /** Called when the user clicks Clear on the Output tab (after the local output is cleared). */
  onClearOutput?: () => void;
  /** Terminal input: `line + '\n'` on Enter; `'\x03'` on Ctrl+C with an empty selection. */
  onTerminalInput?: (data: string) => void;
  onTerminalStart?: () => void;
  onTerminalKill?: () => void;
  /** Called after the panel's visible height changes (drag, collapse, expand). */
  onResize?: (height: number) => void;
  /** If true, submitted terminal lines are echoed locally (use when the backend does not echo). */
  terminalLocalEcho = false;

  private readonly root: HTMLDivElement;
  private readonly tabs = new Map<PanelTab, HTMLButtonElement>();
  private readonly views = new Map<PanelTab, HTMLElement>();
  private readonly btnClear: HTMLButtonElement;
  private readonly btnStart: HTMLButtonElement;
  private readonly btnKill: HTMLButtonElement;
  private readonly btnCollapse: HTMLButtonElement;
  private readonly outputEl: HTMLDivElement;
  private readonly termScreen: HTMLPreElement;
  private readonly termCommitted: Text;
  private readonly termCurrent: Text;
  private readonly termReason: HTMLDivElement;
  private readonly termInput: HTMLInputElement;
  private readonly previewWrap: HTMLDivElement;

  private active: PanelTab = 'output';
  private _collapsed = false;
  private height = DEFAULT_HEIGHT;
  private termState: TerminalState = { available: false, running: false };
  private termCommittedText = '';
  private termCurrentText = '';
  private termPendingCR = false;
  private termEscBuf = '';
  private history: string[] = [];
  private historyIdx = -1;
  private draft = '';

  constructor(container: HTMLElement) {
    container.classList.add('bp-host');
    this.root = el('div', 'bp-root');

    // --- resize handle
    const resizer = el('div', 'bp-resizer');
    resizer.title = 'Drag to resize';
    this.setupResize(resizer);

    // --- header
    const header = el('div', 'bp-header');
    const tabBar = el('div', 'bp-tabs');
    tabBar.setAttribute('role', 'tablist');
    const labels: Record<PanelTab, string> = { output: 'Output', terminal: 'Terminal', preview: 'Preview' };
    for (const tab of ['output', 'terminal', 'preview'] as PanelTab[]) {
      const b = el('button', 'bp-tab', labels[tab]);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => {
        if (this.active === tab && !this._collapsed) return;
        this.showTab(tab);
      });
      tabBar.appendChild(b);
      this.tabs.set(tab, b);
    }
    const actions = el('div', 'bp-actions');
    this.btnStart = el('button', 'bp-btn bp-btn-start', 'Start');
    this.btnStart.type = 'button';
    this.btnStart.title = 'Start terminal';
    this.btnStart.addEventListener('click', () => this.onTerminalStart?.());
    this.btnKill = el('button', 'bp-btn bp-btn-kill', 'Kill');
    this.btnKill.type = 'button';
    this.btnKill.title = 'Kill terminal process';
    this.btnKill.addEventListener('click', () => this.onTerminalKill?.());
    this.btnClear = el('button', 'bp-btn', 'Clear');
    this.btnClear.type = 'button';
    this.btnClear.addEventListener('click', () => {
      if (this.active === 'output') {
        this.clearOutput();
        this.onClearOutput?.();
      } else if (this.active === 'terminal') {
        this.clearTerminal();
      }
    });
    this.btnCollapse = el('button', 'bp-btn bp-chevron');
    this.btnCollapse.type = 'button';
    this.btnCollapse.addEventListener('click', () => this.toggle());
    actions.append(this.btnStart, this.btnKill, this.btnClear, this.btnCollapse);
    header.append(tabBar, actions);
    header.addEventListener('dblclick', (e) => {
      if (e.target === header || e.target === tabBar) this.toggle();
    });

    // --- body
    const body = el('div', 'bp-body');

    this.outputEl = el('div', 'bp-view bp-output');
    this.outputEl.setAttribute('role', 'log');
    this.outputEl.tabIndex = 0;

    const term = el('div', 'bp-view bp-terminal');
    this.termScreen = el('pre', 'bp-term-screen');
    this.termScreen.tabIndex = 0;
    this.termCommitted = document.createTextNode('');
    this.termCurrent = document.createTextNode('');
    this.termScreen.append(this.termCommitted, this.termCurrent);
    this.termReason = el('div', 'bp-term-reason');
    const form = el('form', 'bp-term-inputrow');
    const prompt = el('span', 'bp-term-prompt', '>');
    this.termInput = el('input', 'bp-term-input');
    this.termInput.type = 'text';
    this.termInput.autocomplete = 'off';
    this.termInput.spellcheck = false;
    this.termInput.setAttribute('aria-label', 'Terminal input');
    form.append(prompt, this.termInput);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitTerminalLine();
    });
    this.termInput.addEventListener('keydown', (e) => this.onTermKey(e));
    this.termScreen.addEventListener('click', () => {
      if (!this.termInput.disabled && !window.getSelection()?.toString()) this.termInput.focus();
    });
    term.append(this.termScreen, this.termReason, form);

    this.previewWrap = el('div', 'bp-view bp-preview');
    const empty = el('div', 'bp-empty', 'Nothing to preview yet. Open an .html file and press Run.');
    this.previewWrap.appendChild(empty);

    body.append(this.outputEl, term, this.previewWrap);
    this.views.set('output', this.outputEl);
    this.views.set('terminal', term);
    this.views.set('preview', this.previewWrap);

    this.root.append(resizer, header, body);
    container.appendChild(this.root);

    // --- restore persisted state
    const h = Number(lsGet(LS_HEIGHT));
    if (Number.isFinite(h) && h > 0) this.height = h;
    const tab = lsGet(LS_TAB);
    if (tab === 'output' || tab === 'terminal' || tab === 'preview') this.active = tab;
    this._collapsed = lsGet(LS_COLLAPSED) === '1';
    window.addEventListener('resize', () => {
      const clamped = this.clamp(this.height);
      if (clamped !== this.height) {
        this.height = clamped;
        this.applyLayout();
      }
    });
    this.setTerminalState(this.termState);
    this.applyLayout();
  }

  // ------------------------------------------------------------------ layout

  /** Whether the panel is collapsed to its header. */
  get collapsed(): boolean {
    return this._collapsed;
  }

  /** Switch to a tab (expands the panel if collapsed). */
  showTab(tab: PanelTab): void {
    this.active = tab;
    lsSet(LS_TAB, tab);
    this.tabs.get(tab)?.classList.remove('bp-unread');
    if (this._collapsed) this.setCollapsed(false);
    else this.applyLayout();
    if (tab === 'output') this.scrollToBottom(this.outputEl);
    if (tab === 'terminal') {
      this.scrollToBottom(this.termScreen);
      if (!this.termInput.disabled) this.termInput.focus({ preventScroll: true });
    }
  }

  setCollapsed(collapsed: boolean): void {
    this._collapsed = collapsed;
    lsSet(LS_COLLAPSED, collapsed ? '1' : '0');
    this.applyLayout();
  }

  toggle(): void {
    this.setCollapsed(!this._collapsed);
  }

  private clamp(h: number): number {
    const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_FRACTION));
    return Math.min(max, Math.max(MIN_HEIGHT, Math.round(h)));
  }

  private applyLayout(): void {
    this.height = this.clamp(this.height);
    this.root.classList.toggle('bp-collapsed', this._collapsed);
    this.root.style.height = this._collapsed ? '' : `${this.height}px`;
    for (const [tab, b] of this.tabs) {
      const on = tab === this.active;
      b.classList.toggle('bp-active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const [tab, v] of this.views) v.hidden = tab !== this.active;
    this.btnClear.hidden = this.active === 'preview';
    this.btnClear.title = this.active === 'output' ? 'Clear output for everyone' : 'Clear terminal';
    const termTab = this.active === 'terminal';
    this.btnStart.hidden = !(termTab && this.termState.available && !this.termState.running);
    this.btnKill.hidden = !(termTab && this.termState.available && this.termState.running);
    this.btnCollapse.textContent = this._collapsed ? '▴' : '▾';
    this.btnCollapse.title = this._collapsed ? 'Expand panel' : 'Collapse panel';
    this.btnCollapse.setAttribute('aria-expanded', String(!this._collapsed));
    this.onResize?.(this._collapsed ? this.root.offsetHeight : this.height);
  }

  private setupResize(handle: HTMLElement): void {
    let startY = 0;
    let startH = 0;
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = this._collapsed ? MIN_HEIGHT : this.height;
      if (this._collapsed) {
        this._collapsed = false;
        lsSet(LS_COLLAPSED, '0');
      }
      handle.setPointerCapture(e.pointerId);
      this.root.classList.add('bp-dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.height = this.clamp(startH + (startY - e.clientY));
      this.applyLayout();
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      this.root.classList.remove('bp-dragging');
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      lsSet(LS_HEIGHT, String(this.height));
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  private isNearBottom(e: HTMLElement): boolean {
    return e.scrollHeight - e.scrollTop - e.clientHeight < 40;
  }
  private scrollToBottom(e: HTMLElement): void {
    e.scrollTop = e.scrollHeight;
  }
  private markUnread(tab: PanelTab): void {
    if (this.active !== tab || this._collapsed) this.tabs.get(tab)?.classList.add('bp-unread');
  }

  // ------------------------------------------------------------------ output

  /** Append one line (multi-line text is fine) to the Output tab. */
  appendOutput(line: PanelOutputLine): void {
    const stick = this.isNearBottom(this.outputEl);
    const stream = line.stream === 'err' || line.stream === 'info' ? line.stream : 'out';
    const row = el('div', `bp-line bp-${stream}`);
    if (line.who) {
      const who = el('span', 'bp-who', line.who);
      if (typeof line.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(line.color)) who.style.color = line.color;
      row.appendChild(who);
    }
    row.appendChild(document.createTextNode(String(line.text ?? '')));
    this.outputEl.appendChild(row);
    while (this.outputEl.childElementCount > MAX_OUTPUT_LINES) this.outputEl.firstElementChild?.remove();
    if (stick) this.scrollToBottom(this.outputEl);
    this.markUnread('output');
  }

  /** Clear the Output tab locally (does not call onClearOutput). */
  clearOutput(): void {
    this.outputEl.replaceChildren();
  }

  // ------------------------------------------------------------------ preview

  /** Render a full HTML document into a fresh `<iframe sandbox="allow-scripts allow-modals">` via srcdoc. */
  setPreview(html: string): void {
    const frame = el('iframe', 'bp-preview-frame');
    frame.setAttribute('sandbox', 'allow-scripts allow-modals');
    frame.title = 'Preview';
    frame.srcdoc = html;
    this.previewWrap.replaceChildren(frame);
    this.markUnread('preview');
  }

  // ------------------------------------------------------------------ terminal

  /** Update availability / running state (controls Start/Kill buttons, input and reason text). */
  setTerminalState(state: TerminalState): void {
    this.termState = { available: !!state.available, running: !!state.running, reason: state.reason };
    const { available, running, reason } = this.termState;
    this.termReason.hidden = available && running;
    if (!available) {
      this.termReason.textContent = reason || 'Terminal is not available.';
      this.termReason.classList.add('bp-term-unavailable');
    } else {
      this.termReason.textContent = running ? '' : 'Terminal is not running. Press Start to launch a shell.';
      this.termReason.classList.remove('bp-term-unavailable');
    }
    this.termInput.disabled = !(available && running);
    this.termInput.placeholder = available ? (running ? 'Type a command and press Enter' : 'Press Start first') : 'Unavailable';
    this.applyLayout();
  }

  /** Append raw terminal output. ANSI escapes are stripped; \r\n, lone \r and \b are handled. */
  appendTerminal(data: string): void {
    if (!data) return;
    const stick = this.isNearBottom(this.termScreen);
    let s = this.termEscBuf + data;
    this.termEscBuf = '';
    const partial = INCOMPLETE_ESC_RE.exec(s);
    if (partial && partial[0].length <= 256) {
      this.termEscBuf = partial[0];
      s = s.slice(0, partial.index);
    }
    s = s.replace(ANSI_RE, '');

    let committed = this.termCommittedText;
    let cur = this.termCurrentText;
    let pendingCR = this.termPendingCR;
    let chunk = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\n') {
        chunk += cur + '\n';
        cur = '';
        pendingCR = false;
      } else if (ch === '\r') {
        pendingCR = true;
      } else if (ch === '\b') {
        cur = cur.slice(0, -1);
      } else if (ch < ' ' && ch !== '\t') {
        // drop other control characters (bell, etc.)
      } else {
        if (pendingCR) {
          // carriage return without newline: next text overwrites the line (approximation: replace it)
          cur = '';
          pendingCR = false;
        }
        cur += ch;
      }
    }
    committed += chunk;
    if (committed.length > MAX_TERM_CHARS) {
      let cut = committed.length - TERM_TRIM_TO;
      const nl = committed.indexOf('\n', cut);
      if (nl !== -1) cut = nl + 1;
      committed = committed.slice(cut);
    }
    this.termCommittedText = committed;
    this.termCurrentText = cur;
    this.termPendingCR = pendingCR;
    this.termCommitted.data = committed;
    this.termCurrent.data = cur;
    if (stick) this.scrollToBottom(this.termScreen);
    this.markUnread('terminal');
  }

  /** Clear the terminal scrollback (local only). */
  clearTerminal(): void {
    this.termCommittedText = '';
    this.termCurrentText = '';
    this.termPendingCR = false;
    this.termEscBuf = '';
    this.termCommitted.data = '';
    this.termCurrent.data = '';
  }

  private submitTerminalLine(): void {
    if (this.termInput.disabled) return;
    const line = this.termInput.value;
    this.termInput.value = '';
    if (line.trim() && this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.historyIdx = -1;
    this.draft = '';
    if (this.terminalLocalEcho) this.appendTerminal(`> ${line}\n`);
    this.onTerminalInput?.(line + '\n');
  }

  private onTermKey(e: KeyboardEvent): void {
    const input = this.termInput;
    if (e.key === 'ArrowUp') {
      if (!this.history.length) return;
      e.preventDefault();
      if (this.historyIdx === -1) {
        this.draft = input.value;
        this.historyIdx = this.history.length - 1;
      } else if (this.historyIdx > 0) {
        this.historyIdx--;
      }
      input.value = this.history[this.historyIdx];
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (e.key === 'ArrowDown') {
      if (this.historyIdx === -1) return;
      e.preventDefault();
      if (this.historyIdx < this.history.length - 1) {
        this.historyIdx++;
        input.value = this.history[this.historyIdx];
      } else {
        this.historyIdx = -1;
        input.value = this.draft;
      }
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (input.selectionStart === input.selectionEnd) {
        e.preventDefault();
        input.value = '';
        this.historyIdx = -1;
        this.onTerminalInput?.('\x03');
      }
    }
  }
}
