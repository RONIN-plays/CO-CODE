import './monaco-workers';
import './style.css';
import * as monaco from 'monaco-editor';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { Connection, MSG_AWARENESS, MSG_DOC, type Status, type WelcomeInfo } from './connection';
import { Voice, type SignalData } from './voice';
import { BottomPanel } from './panels';
import { buildPreview, canRun, runCode, runKind, stopRun, type OutputLine } from './runner';

interface UserInfo {
  name: string;
  color: string;
}

interface PresenceState {
  user?: UserInfo;
  file?: string | null;
  voice?: boolean;
  muted?: boolean;
  screen?: boolean;
}

interface ChatMessage {
  name: string;
  color: string;
  text: string;
  ts: number;
}

interface OutputEntry extends OutputLine {
  who?: string;
  color?: string;
}

const COLORS = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#eab308', '#14b8a6', '#ef4444'];
const FALLBACK_COLOR = '#888888';
const MAX_CHAT = 500;
const MAX_OUTPUT = 1000;
const FILE_NAME_RE = /^[\w.\-/]{1,100}$/;

const FATAL_MESSAGES: Record<string, string> = {
  'password-required': 'This room is locked. Enter its password.',
  'bad-password': 'Wrong password.',
  'too-many-attempts': 'Too many wrong passwords. Try again in a few minutes.',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function storageGet(key: string, store: 'local' | 'session' = 'local') {
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string | null, store: 'local' | 'session' = 'local') {
  try {
    const s = store === 'local' ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

const safeColor = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : FALLBACK_COLOR);
const safeName = (n: unknown) => (typeof n === 'string' ? n.replace(/[\u0000-\u001f]/g, '').slice(0, 32) : '?') || '?';

const LANGUAGES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', html: 'html', htm: 'html', css: 'css', scss: 'scss', json: 'json', md: 'markdown',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust',
  rb: 'ruby', php: 'php', sh: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql', kt: 'kotlin',
  swift: 'swift', lua: 'lua', xml: 'xml',
};
const languageFor = (file: string) => LANGUAGES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';

// ---------------- join screen ----------------
const nameInput = $<HTMLInputElement>('name');
const roomInput = $<HTMLInputElement>('room');
const passwordInput = $<HTMLInputElement>('password');
nameInput.value = storageGet('cocode:name') ?? '';
roomInput.value = new URLSearchParams(location.search).get('room') ?? `room-${Math.random().toString(36).slice(2, 8)}`;

const previousError = storageGet('cocode:error', 'session');
if (previousError) {
  storageSet('cocode:error', null, 'session');
  const el = $('join-error');
  el.textContent = previousError;
  el.hidden = false;
  passwordInput.focus();
} else {
  (nameInput.value ? roomInput : nameInput).focus();
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const room = roomInput.value.trim().toLowerCase();
  if (!name || !room) return;
  storageSet('cocode:name', name);
  startApp(name, room, passwordInput.value);
});

// ---------------- the app ----------------
function startApp(name: string, room: string, password: string) {
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
  $('join').hidden = true;
  $('app').hidden = false;
  $('room-name').textContent = room;

  const doc = new Y.Doc();
  const myId = doc.clientID;
  const color = COLORS[myId % COLORS.length];
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { name, color }, file: null, voice: false, muted: false, screen: false } satisfies PresenceState);

  const files = doc.getMap<Y.Text>('files');
  const chat = doc.getArray<ChatMessage>('chat');
  const output = doc.getArray<OutputEntry>('output');

  const states = () => awareness.getStates() as Map<number, PresenceState>;
  const nameOf = (id: number) => safeName(states().get(id)?.user?.name ?? 'Someone');
  const speaking = new Set<number>();

  // Late-bound so handlers below can reference them safely.
  let conn: Connection;
  let voice: Voice;

  // ----- bottom panel -----
  const panel = new BottomPanel($('bottom-panel'));
  // The server shell runs without a TTY, so it doesn't echo typed input back.
  panel.terminalLocalEcho = true;
  $('panel-btn').addEventListener('click', () => panel.toggle());

  // ----- editor -----
  const editor = monaco.editor.create($('editor'), {
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    model: null,
  });
  let binding: MonacoBinding | null = null;
  let currentFile: string | null = null;

  const sortedFiles = () => [...files.keys()].sort();
  const fileContents = () => {
    const out: Record<string, string> = {};
    files.forEach((text, file) => (out[file] = text.toString()));
    return out;
  };

  function openFile(file: string | null) {
    binding?.destroy();
    binding = null;
    const oldModel = editor.getModel();
    currentFile = file && files.has(file) ? file : null;
    if (currentFile) {
      const model = monaco.editor.createModel('', languageFor(currentFile));
      editor.setModel(model);
      binding = new MonacoBinding(files.get(currentFile)!, model, new Set([editor]), awareness);
      editor.focus();
    } else {
      editor.setModel(null);
    }
    oldModel?.dispose();
    awareness.setLocalStateField('file', currentFile);
    $('current-file').textContent = currentFile ?? 'No file open';
    updateRunButton();
    renderFiles();
  }

  files.observe((event) => {
    // Re-bind if our file was deleted or replaced by someone else.
    if (currentFile && event.keysChanged.has(currentFile)) {
      openFile(files.has(currentFile) ? currentFile : (sortedFiles()[0] ?? null));
    } else if (!currentFile && files.size > 0) {
      openFile(sortedFiles()[0]);
    }
    renderFiles();
  });

  function askFileName(message: string, initial = '') {
    const file = prompt(message, initial)?.trim();
    if (!file) return null;
    if (!FILE_NAME_RE.test(file)) {
      alert('Use letters, numbers, dots, dashes, underscores or slashes (max 100 characters).');
      return null;
    }
    return file;
  }

  $('new-file').addEventListener('click', () => {
    const file = askFileName('New file name (e.g. app.js, main.py, index.html):');
    if (!file) return;
    if (!files.has(file)) files.set(file, new Y.Text());
    openFile(file);
  });

  function renameFile(from: string) {
    const to = askFileName(`Rename ${from} to:`, from);
    if (!to || to === from) return;
    if (files.has(to)) {
      alert(`${to} already exists.`);
      return;
    }
    const content = files.get(from)?.toString() ?? '';
    doc.transact(() => {
      files.set(to, new Y.Text(content));
      files.delete(from);
    });
    openFile(to);
  }

  // ----- presence / rendering -----
  function renderFiles() {
    const list = $('files');
    list.replaceChildren();
    const viewers = new Map<string, string[]>();
    states().forEach((s, id) => {
      if (id !== myId && s.file && s.user) {
        viewers.set(s.file, [...(viewers.get(s.file) ?? []), safeColor(s.user.color)]);
      }
    });
    for (const file of sortedFiles()) {
      const li = document.createElement('li');
      li.className = file === currentFile ? 'active' : '';
      const label = document.createElement('span');
      label.className = 'grow';
      label.textContent = file;
      label.title = file;
      li.append(label);
      for (const c of viewers.get(file) ?? []) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = c;
        li.append(dot);
      }
      const ren = document.createElement('button');
      ren.className = 'icon ren';
      ren.title = `Rename ${file}`;
      ren.textContent = '✎';
      ren.addEventListener('click', (e) => {
        e.stopPropagation();
        renameFile(file);
      });
      const del = document.createElement('button');
      del.className = 'icon del';
      del.title = `Delete ${file}`;
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete ${file} for everyone?`)) files.delete(file);
      });
      li.append(ren, del);
      li.addEventListener('click', () => openFile(file));
      list.append(li);
    }
  }

  function renderPeople() {
    const list = $('people');
    list.replaceChildren();
    const entries = [...states()].filter(([, s]) => s.user);
    entries.sort(([a], [b]) => (a === myId ? -1 : b === myId ? 1 : 0));
    for (const [id, s] of entries) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot' + (speaking.has(id) ? ' speaking' : '');
      dot.style.background = safeColor(s.user!.color);
      const label = document.createElement('span');
      label.className = 'grow';
      label.textContent = safeName(s.user!.name) + (id === myId ? ' (you)' : '');
      if (s.file) label.title = `Editing ${s.file}`;
      li.append(dot, label);
      const badges: [string, string][] = [];
      if (s.screen) badges.push(['sharing', 'badge share']);
      if (s.voice) badges.push(s.muted ? ['muted', 'badge muted'] : ['voice', 'badge']);
      for (const [text, cls] of badges) {
        const badge = document.createElement('span');
        badge.className = cls;
        badge.textContent = text;
        li.append(badge);
      }
      list.append(li);
    }
  }

  // y-monaco draws remote cursors with per-client class names; colour them here.
  const cursorStyles = document.createElement('style');
  document.head.append(cursorStyles);
  function renderCursorStyles() {
    let css = '';
    states().forEach((s, id) => {
      if (id === myId || !s.user) return;
      const c = safeColor(s.user.color);
      css += `.yRemoteSelection-${id}{background:${c}40}`;
      css += `.yRemoteSelectionHead-${id}{border-left:2px solid ${c}}`;
      css += `.yRemoteSelectionHead-${id}::after{content:${JSON.stringify(safeName(s.user.name))};background:${c}}`;
    });
    cursorStyles.textContent = css;
  }

  const voicePeers = () => {
    const ids = new Set<number>();
    states().forEach((s, id) => s.voice && ids.add(id));
    return ids;
  };

  awareness.on('change', () => {
    renderPeople();
    renderFiles();
    renderCursorStyles();
    renderScreenLabels();
    voice.sync(voicePeers());
  });

  // ----- running code (output is shared with the whole room) -----
  const runBtn = $<HTMLButtonElement>('run-btn');
  const stopBtn = $<HTMLButtonElement>('stop-btn');
  let running = false;

  function updateRunButton() {
    const kind = currentFile ? runKind(currentFile) : null;
    runBtn.disabled = running || !currentFile || !canRun(currentFile);
    runBtn.textContent = kind === 'preview' ? 'Preview' : 'Run';
    runBtn.hidden = running;
    stopBtn.hidden = !running;
  }

  let pendingOutput: OutputEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function flushOutput() {
    flushTimer = null;
    if (pendingOutput.length === 0) return;
    const batch = pendingOutput;
    pendingOutput = [];
    doc.transact(() => {
      output.push(batch);
      if (output.length > MAX_OUTPUT * 1.5) output.delete(0, output.length - MAX_OUTPUT);
    });
  }
  function emitOutput(line: OutputEntry) {
    pendingOutput.push({ ...line, text: String(line.text).slice(0, 5000) });
    if (!flushTimer) flushTimer = setTimeout(flushOutput, 100);
  }

  async function run() {
    if (!currentFile || running || !canRun(currentFile)) return;
    const file = currentFile;
    if (runKind(file) === 'preview') {
      panel.setPreview(buildPreview(file, fileContents()));
      panel.setCollapsed(false);
      panel.showTab('preview');
      return;
    }
    running = true;
    updateRunButton();
    panel.setCollapsed(false);
    panel.showTab('output');
    emitOutput({ stream: 'info', text: `▶ ${name} ran ${file}`, who: name, color });
    try {
      await runCode(file, fileContents(), (line) => emitOutput({ ...line, who: name, color }));
    } catch (err) {
      emitOutput({ stream: 'err', text: String(err), who: name, color });
    } finally {
      flushOutput();
      running = false;
      updateRunButton();
    }
  }
  runBtn.addEventListener('click', run);
  stopBtn.addEventListener('click', () => stopRun());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '`') {
      e.preventDefault();
      panel.toggle();
    }
  });

  let renderedOutput = 0;
  function renderOutput(full: boolean) {
    if (full) {
      panel.clearOutput();
      renderedOutput = 0;
    }
    const items = output.toArray();
    for (let i = renderedOutput; i < items.length; i++) {
      const o = items[i];
      panel.appendOutput({ stream: o.stream, text: String(o.text), who: o.who ? safeName(o.who) : undefined, color: safeColor(o.color) });
    }
    renderedOutput = items.length;
  }
  output.observe((event) => renderOutput(event.changes.deleted.size > 0 || output.length < renderedOutput));
  panel.onClearOutput = () => output.delete(0, output.length);

  // ----- terminal (server-side shell, only if the server allows it) -----
  let terminalInfo = { available: false, running: false };
  const terminalReason = () =>
    lockedRoom
      ? 'The terminal is turned off on this server. Start it with ENABLE_TERMINAL=1 to allow it.'
      : 'Lock the room with a password to use the shared terminal (and start the server with ENABLE_TERMINAL=1).';
  function updateTerminal() {
    panel.setTerminalState({ ...terminalInfo, reason: terminalInfo.available ? undefined : terminalReason() });
  }
  panel.onTerminalInput = (data) => conn.sendJson({ type: 'term-input', data });
  panel.onTerminalStart = () => conn.sendJson({ type: 'term-start' });
  panel.onTerminalKill = () => conn.sendJson({ type: 'term-kill' });

  // ----- chat -----
  const messages = $('messages');
  function renderChat() {
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
    messages.replaceChildren();
    for (const m of chat.toArray().slice(-200)) {
      const row = document.createElement('div');
      row.className = 'msg';
      const who = document.createElement('span');
      who.className = 'who';
      who.style.color = safeColor(m.color);
      who.textContent = safeName(m.name);
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = String(m.text);
      row.append(who, time, text);
      messages.append(row);
    }
    if (nearBottom) messages.scrollTop = messages.scrollHeight;
  }
  chat.observe(renderChat);

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('chat-input');
    const text = input.value.trim().slice(0, 2000);
    if (!text) return;
    doc.transact(() => {
      chat.push([{ name, color, text, ts: Date.now() }]);
      if (chat.length > MAX_CHAT) chat.delete(0, chat.length - MAX_CHAT);
    });
    input.value = '';
    messages.scrollTop = messages.scrollHeight;
  });

  // ----- room lock -----
  const lockBtn = $<HTMLButtonElement>('lock');
  let lockedRoom = false;
  function setLocked(locked: boolean) {
    lockedRoom = locked;
    lockBtn.textContent = locked ? 'Locked' : 'Lock';
    lockBtn.disabled = locked;
    lockBtn.title = locked ? 'This room has a password' : 'Set a room password';
    updateTerminal();
  }
  lockBtn.addEventListener('click', () => {
    const pw = prompt('Set a password for this room. Everyone joining later will need it.');
    if (!pw) return;
    if (pw.length > 128) {
      alert('Password is too long (max 128 characters).');
      return;
    }
    conn.setPassword(pw);
    conn.sendJson({ type: 'set-password', password: pw });
  });

  // ----- connection -----
  const statusEl = $('status');
  function setStatus(status: Status) {
    statusEl.className = `status ${status}`;
    statusEl.title = status[0].toUpperCase() + status.slice(1);
    if (status === 'offline') {
      // Forget other people until we are back; they re-announce on reconnect.
      const others = [...awareness.getStates().keys()].filter((id) => id !== myId);
      removeAwarenessStates(awareness, others, 'remote');
    }
  }

  const sendMyPresence = () => conn.sendBinary(MSG_AWARENESS, encodeAwarenessUpdate(awareness, [myId]));
  let seeded = false;

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(room)}`;
  conn = new Connection(wsUrl, myId, password, {
    onStatus: setStatus,
    onWelcome(info: WelcomeInfo) {
      setLocked(info.locked);
      terminalInfo = { available: info.terminal, running: false };
      panel.clearTerminal(); // the server re-sends scrollback if a shell is running
      updateTerminal();
      // The server already sent its copy of the document, so we're in sync now.
      if (!seeded) {
        seeded = true;
        if (files.size === 0) {
          files.set('main.js', new Y.Text(`// Welcome to ${room}!\n// Share the invite link and start coding together.\n// Press Ctrl+Enter (or the Run button) to run this file.\n\nconsole.log('hello, friends');\n`));
        }
        if (!currentFile) openFile(sortedFiles()[0] ?? null);
        renderOutput(true);
      }
      // Push anything we typed while offline, and announce ourselves.
      conn.sendBinary(MSG_DOC, Y.encodeStateAsUpdate(doc));
      sendMyPresence();
    },
    onFatal(code) {
      storageSet('cocode:error', FATAL_MESSAGES[code] ?? `Could not join the room (${code}).`, 'session');
      location.reload();
    },
    onBinary(type, payload) {
      if (type === MSG_DOC) Y.applyUpdate(doc, payload, 'remote');
      else if (type === MSG_AWARENESS) applyAwarenessUpdate(awareness, payload, 'remote');
    },
    onJson(msg) {
      switch (msg.type) {
        case 'peer-joined':
          sendMyPresence();
          break;
        case 'peer-left':
          if (typeof msg.id === 'number') removeAwarenessStates(awareness, [msg.id], 'remote');
          break;
        case 'signal':
          if (typeof msg.from === 'number') {
            voice.handleSignal(msg.from, msg.data as SignalData).catch((err) => console.error('Signal error', err));
          }
          break;
        case 'room-locked':
          if (typeof (msg as { terminal?: unknown }).terminal === 'boolean') {
            terminalInfo.available = (msg as { terminal?: boolean }).terminal!;
          }
          setLocked(true);
          break;
        case 'error':
          // Non-fatal errors after joining, e.g. from set-password.
          alert(
            msg.code === 'already-locked'
              ? 'This room already has a password.'
              : msg.code === 'password-too-long'
                ? 'Password is too long (max 128 characters).'
                : `Server error: ${String(msg.code)}`,
          );
          break;
        case 'term-started':
          terminalInfo.running = true;
          updateTerminal();
          break;
        case 'term-output':
          if (typeof msg.data === 'string') panel.appendTerminal(msg.data);
          break;
        case 'term-exit':
          terminalInfo.running = false;
          updateTerminal();
          panel.appendTerminal(`\n[shell exited${msg.code != null ? ` with code ${msg.code}` : ''}]\n`);
          break;
      }
    },
  });

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') conn.sendBinary(MSG_DOC, update);
  });
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin !== 'remote' && [...added, ...updated, ...removed].includes(myId)) sendMyPresence();
  });

  // ----- screen shares -----
  const screensEl = $('screens');
  const screenTiles = new Map<number, { tile: HTMLElement; label: HTMLElement }>();

  function addScreenTile(id: number, stream: MediaStream, isLocal: boolean) {
    removeScreenTile(id);
    const tile = document.createElement('div');
    tile.className = 'screen';
    const bar = document.createElement('div');
    bar.className = 'screen-bar';
    const label = document.createElement('span');
    label.className = 'grow';
    const sizeBtn = document.createElement('button');
    sizeBtn.className = 'small';
    sizeBtn.textContent = 'Enlarge';
    sizeBtn.addEventListener('click', () => {
      tile.classList.toggle('big');
      sizeBtn.textContent = tile.classList.contains('big') ? 'Shrink' : 'Enlarge';
    });
    bar.append(label, sizeBtn);
    if (isLocal) {
      const stop = document.createElement('button');
      stop.className = 'small danger';
      stop.textContent = 'Stop';
      stop.addEventListener('click', () => voice.stopScreenShare());
      bar.append(stop);
    }
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    video.addEventListener('dblclick', () => video.requestFullscreen?.().catch(() => {}));
    tile.append(bar, video);
    screensEl.append(tile);
    screenTiles.set(id, { tile, label });
    renderScreenLabels();
  }
  function removeScreenTile(id: number) {
    const entry = screenTiles.get(id);
    if (!entry) return;
    const video = entry.tile.querySelector('video');
    if (video) video.srcObject = null;
    entry.tile.remove();
    screenTiles.delete(id);
  }
  function renderScreenLabels() {
    screenTiles.forEach(({ label }, id) => {
      label.textContent = id === myId ? 'You are sharing your screen' : `${nameOf(id)}'s screen`;
    });
  }

  // ----- voice -----
  const voiceBtn = $<HTMLButtonElement>('voice-btn');
  const muteBtn = $<HTMLButtonElement>('mute-btn');
  const screenBtn = $<HTMLButtonElement>('screen-btn');
  let wasSharing = false;
  voice = new Voice(
    myId,
    (to, data) => conn.sendJson({ type: 'signal', to, data }),
    () => {
      voiceBtn.textContent = voice.active ? 'Leave voice' : 'Join voice';
      voiceBtn.classList.toggle('primary', !voice.active);
      voiceBtn.classList.toggle('danger', voice.active);
      muteBtn.hidden = !voice.active;
      muteBtn.textContent = voice.muted ? 'Unmute' : 'Mute';
      muteBtn.classList.toggle('danger', voice.muted);
      screenBtn.hidden = !voice.active || !navigator.mediaDevices?.getDisplayMedia;
      screenBtn.textContent = voice.sharing ? 'Stop sharing' : 'Share screen';
      screenBtn.classList.toggle('danger', voice.sharing);
      if (voice.sharing !== wasSharing) {
        wasSharing = voice.sharing;
        awareness.setLocalStateField('screen', voice.sharing);
        if (voice.sharing && voice.localScreen) addScreenTile(myId, voice.localScreen, true);
        else removeScreenTile(myId);
      }
    },
    {
      onRemoteScreen(peerId, stream) {
        if (stream) addScreenTile(peerId, stream, false);
        else removeScreenTile(peerId);
      },
      onSpeaking(peerId, isSpeaking) {
        if (isSpeaking) speaking.add(peerId);
        else speaking.delete(peerId);
        renderPeople();
      },
    },
  );

  voiceBtn.addEventListener('click', async () => {
    if (voice.active) {
      voice.stop();
      awareness.setLocalState({ ...awareness.getLocalState(), voice: false, muted: false, screen: false });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Voice needs a secure connection. Open the app via https:// or http://localhost.');
      return;
    }
    try {
      await voice.start();
    } catch {
      alert('Could not access your microphone. Check the browser permission and try again.');
      return;
    }
    awareness.setLocalState({ ...awareness.getLocalState(), voice: true, muted: false });
  });

  muteBtn.addEventListener('click', () => {
    voice.setMuted(!voice.muted);
    awareness.setLocalStateField('muted', voice.muted);
  });

  screenBtn.addEventListener('click', async () => {
    if (voice.sharing) {
      voice.stopScreenShare();
      return;
    }
    try {
      await voice.startScreenShare();
    } catch (err) {
      // Cancelling the browser's picker throws NotAllowedError; that's fine.
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
        alert('Could not share your screen.');
      }
    }
  });

  $('invite').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('invite');
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = 'Copied!';
    } catch {
      prompt('Copy this invite link:', location.href);
    }
    setTimeout(() => (btn.textContent = 'Invite'), 1500);
  });

  window.addEventListener('beforeunload', () => {
    awareness.setLocalState(null);
  });

  updateRunButton();
  updateTerminal();
  renderPeople();
  renderChat();
}
