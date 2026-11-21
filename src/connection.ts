// WebSocket link to the server with automatic reconnect.
// Binary frames carry Yjs/awareness updates; text frames carry JSON control messages.

export const MSG_DOC = 0;
export const MSG_AWARENESS = 1;

export type Status = 'connecting' | 'online' | 'offline';

export interface ServerMessage {
  type: string;
  id?: number;
  from?: number;
  data?: unknown;
  code?: unknown;
}

export interface WelcomeInfo {
  locked: boolean;
  terminal: boolean;
}

interface Handlers {
  onStatus(status: Status): void;
  /** Called once the server has sent the full document and accepted us. */
  onWelcome(info: WelcomeInfo): void;
  onBinary(type: number, payload: Uint8Array): void;
  onJson(msg: ServerMessage): void;
  /** The server refused us for good (e.g. wrong password). No more reconnects. */
  onFatal(code: string): void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private joined = false;
  private retries = 0;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly myId: number,
    private password: string,
    private readonly handlers: Handlers,
  ) {
    this.connect();
  }

  /** Use a new password for future (re)connects. */
  setPassword(password: string) {
    this.password = password;
  }

  private connect() {
    this.handlers.onStatus('connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      ws.send(JSON.stringify({ type: 'join', id: this.myId, password: this.password || undefined }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'welcome') {
          this.joined = true;
          this.handlers.onStatus('online');
          const info = msg as ServerMessage & Partial<WelcomeInfo>;
          this.handlers.onWelcome({ locked: !!info.locked, terminal: !!info.terminal });
        } else if (msg.type === 'error' && !this.joined) {
          // Errors before welcome mean the join was refused (e.g. wrong password).
          // Errors after joining (e.g. set-password failures) go to onJson.
          this.stopped = true;
          this.handlers.onFatal(String(msg.code ?? 'error'));
        } else {
          this.handlers.onJson(msg);
        }
      } else {
        const buf = new Uint8Array(event.data as ArrayBuffer);
        this.handlers.onBinary(buf[0], buf.subarray(1));
      }
    };

    ws.onclose = (event) => {
      this.ws = null;
      this.joined = false;
      this.handlers.onStatus('offline');
      if (this.stopped || event.code === 4001) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retries++);
      setTimeout(() => this.connect(), delay);
    };
  }

  sendBinary(type: number, payload: Uint8Array) {
    if (!this.joined || !this.ws) return;
    const out = new Uint8Array(payload.length + 1);
    out[0] = type;
    out.set(payload, 1);
    this.ws.send(out);
  }

  sendJson(msg: object) {
    if (this.joined && this.ws) this.ws.send(JSON.stringify(msg));
  }
}
