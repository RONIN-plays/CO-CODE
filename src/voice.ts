// Mesh voice chat (plus screen sharing) over WebRTC. Every pair of people in
// voice gets one peer connection.
//
// Negotiation follows the "perfect negotiation" pattern (MDN): either side may
// send an offer at any time (e.g. when a screen track is added or removed),
// and offer collisions are resolved by the polite peer (higher id) rolling
// back. To avoid both sides creating a connection at once, only the lower id
// *creates* the initial connection; the higher id sends a `hello` so the lower
// id knows to (re)connect even if its view of presence is stale.
//
// Every connection has a random tag. Messages carry the sender's tag
// (`session`) and, once known, the receiver's tag (`target`). That lets each
// side discard messages meant for a connection that no longer exists and
// detect when the other side has started over (left and rejoined, or
// reconnected after a failure), in which case the old connection is replaced.

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

const SPEAK_POLL_MS = 100;
const SPEAK_THRESHOLD = 0.02; // RMS of the time-domain signal
const SPEAK_HOLD_MS = 300;

export interface SignalData {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  /** sender started (true) or stopped (false) sharing its screen */
  screen?: boolean;
  /** sender is in voice but has no connection to the receiver; please connect */
  hello?: boolean;
  /** tag of the sender's connection */
  session?: string;
  /** tag of the receiver's connection, when the sender knows it */
  target?: string;
}

export interface VoiceEvents {
  /** a remote peer started (stream) or stopped (null) sharing their screen */
  onRemoteScreen?: (peerId: number, stream: MediaStream | null) => void;
  /** speaking state changed for a peer; peerId === myId for the local user */
  onSpeaking?: (peerId: number, speaking: boolean) => void;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  polite: boolean;
  localTag: string;
  remoteTag?: string;
  pending: RTCIceCandidateInit[];
  audio: HTMLAudioElement;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  screenSender: RTCRtpSender | null;
  remoteScreen: MediaStream | null;
}

interface Meter {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Float32Array;
  lastLoud: number;
  speaking: boolean;
}

const newTag = () => Math.random().toString(36).slice(2, 12);

export class Voice {
  stream: MediaStream | null = null;
  localScreen: MediaStream | null = null;
  muted = false;
  private peers = new Map<number, PeerEntry>();
  private lastVoicePeers = new Set<number>();
  private helloSent = new Set<number>();
  private queue: Promise<void> = Promise.resolve();
  private audioCtx: AudioContext | null = null;
  private meters = new Map<number, Meter>();
  private meterTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly myId: number,
    private readonly signal: (to: number, data: SignalData) => void,
    private readonly onChange: () => void,
    private readonly events: VoiceEvents = {},
  ) {}

  get active() {
    return this.stream !== null;
  }

  get sharing() {
    return this.localScreen !== null;
  }

  async start() {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    this.muted = false;
    try {
      this.audioCtx = new AudioContext();
      this.audioCtx.resume().catch(() => {});
      this.addMeter(this.myId, stream);
      this.meterTimer = setInterval(() => this.pollMeters(), SPEAK_POLL_MS);
    } catch (err) {
      console.warn('Speaking detection unavailable', err);
    }
    this.onChange();
    this.sync(this.lastVoicePeers);
  }

  stop() {
    if (!this.stream) return;
    this.endScreenShare();
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const id of [...this.meters.keys()]) this.removeMeter(id);
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.helloSent.clear();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.muted = false;
    this.onChange();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.onChange();
  }

  async startScreenShare() {
    if (!this.active) throw new Error('Join voice before sharing your screen');
    if (this.localScreen) return;
    // Throws if the user cancels the picker.
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = screen.getVideoTracks()[0];
    if (!this.active || this.localScreen || !track) {
      // Voice ended (or another share started) while the picker was open.
      screen.getTracks().forEach((t) => t.stop());
      if (!this.active) throw new Error('Voice ended before screen sharing started');
      return;
    }
    if ('contentHint' in track) track.contentHint = 'detail';
    // The browser's own "Stop sharing" button ends the track.
    track.addEventListener('ended', () => {
      if (this.localScreen === screen) this.stopScreenShare();
    });
    this.localScreen = screen;
    for (const [id, entry] of this.peers) {
      this.attachScreen(entry);
      this.send(id, entry, { screen: true });
    }
    this.onChange();
  }

  stopScreenShare() {
    if (this.endScreenShare()) this.onChange();
  }

  /** Reconcile connections with the set of people currently in voice. */
  sync(voicePeers: Set<number>) {
    this.lastVoicePeers = voicePeers;
    for (const id of this.helloSent) if (!voicePeers.has(id)) this.helloSent.delete(id);
    if (!this.active) return;
    for (const id of [...this.peers.keys()]) {
      if (!voicePeers.has(id)) this.closePeer(id);
    }
    for (const id of voicePeers) {
      if (id === this.myId || this.peers.has(id)) continue;
      if (this.myId < id) {
        this.createPeer(id); // negotiationneeded sends the offer
      } else if (!this.helloSent.has(id)) {
        this.helloSent.add(id);
        this.signal(id, { hello: true });
      }
    }
  }

  handleSignal(from: number, data: SignalData): Promise<void> {
    // Process signals strictly in arrival order; main.ts doesn't await us.
    const run = this.queue.then(() => this.processSignal(from, data));
    this.queue = run.catch(() => {});
    return run;
  }

  isConnected(id: number) {
    return this.peers.get(id)?.pc.connectionState === 'connected';
  }

  // ----- signaling -----

  private send(id: number, entry: PeerEntry, data: SignalData) {
    if (this.peers.get(id) !== entry) return; // connection was replaced or closed
    this.signal(id, { ...data, session: entry.localTag, target: entry.remoteTag });
  }

  private async processSignal(from: number, data: SignalData) {
    if (!this.active || from === this.myId || !data) return;
    let entry = this.peers.get(from);

    // Addressed to one of our connections that has since been closed/replaced.
    if (data.target !== undefined && data.target !== entry?.localTag) return;

    if (data.hello) {
      // The peer is in voice and has no connection to us: anything we hold is
      // stale (or an offer they never saw). Start over.
      if (this.myId < from) {
        this.closePeer(from);
        this.createPeer(from);
      }
      return;
    }

    const isOffer = data.sdp?.type === 'offer';
    if (
      isOffer &&
      (!entry ||
        (entry.remoteTag !== undefined && data.session !== undefined && entry.remoteTag !== data.session) ||
        entry.pc.signalingState === 'closed' ||
        entry.pc.connectionState === 'closed' ||
        entry.pc.connectionState === 'failed')
    ) {
      // A fresh session from the peer: replace whatever we had.
      if (entry) this.closePeer(from);
      entry = this.createPeer(from);
    }
    if (!entry) return;

    if (data.session !== undefined) {
      if (entry.remoteTag === undefined) entry.remoteTag = data.session;
      else if (entry.remoteTag !== data.session) return; // from a connection of theirs that is gone
    }

    const { pc } = entry;

    if (data.sdp) {
      // NB: no await before setRemoteDescription when the pc was just created,
      // so its own negotiationneeded can't race ahead of the incoming offer.
      const readyForOffer =
        !entry.makingOffer && (pc.signalingState === 'stable' || entry.isSettingRemoteAnswerPending);
      const offerCollision = isOffer && !readyForOffer;
      entry.ignoreOffer = !entry.polite && offerCollision;
      if (entry.ignoreOffer) return;

      entry.isSettingRemoteAnswerPending = data.sdp.type === 'answer';
      try {
        await pc.setRemoteDescription(data.sdp); // implicit rollback when polite and colliding
      } finally {
        entry.isSettingRemoteAnswerPending = false;
      }
      await this.flushCandidates(entry);
      if (isOffer) {
        await pc.setLocalDescription();
        this.send(from, entry, { sdp: pc.localDescription!.toJSON() });
      }
    }

    if (data.candidate) {
      if (!pc.remoteDescription) {
        entry.pending.push(data.candidate);
      } else {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!entry.ignoreOffer) console.warn('Voice: bad ICE candidate', err);
        }
      }
    }

    if (data.screen === false) this.setRemoteScreen(from, entry, null);
  }

  private async flushCandidates(entry: PeerEntry) {
    for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  }

  // ----- connections -----

  private createPeer(id: number): PeerEntry {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const audio = new Audio();
    audio.autoplay = true;
    const entry: PeerEntry = {
      pc,
      polite: this.myId > id,
      localTag: newTag(),
      pending: [],
      audio,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      screenSender: null,
      remoteScreen: null,
    };
    this.peers.set(id, entry);
    this.helloSent.delete(id);

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        this.send(id, entry, { sdp: pc.localDescription!.toJSON() });
      } catch (err) {
        if (this.peers.get(id) === entry) console.error('Voice: negotiation failed', err);
      } finally {
        entry.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send(id, entry, { candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      if (this.peers.get(id) !== entry) return;
      const track = e.track;
      const stream = e.streams[0] ?? new MediaStream([track]);
      if (track.kind === 'audio') {
        if (audio.srcObject !== stream) {
          audio.srcObject = stream;
          audio.play().catch(() => {});
          this.addMeter(id, stream);
        }
        return;
      }
      if (track.kind !== 'video') return;
      const clearIfCurrent = () => {
        if (entry.remoteScreen === stream && !stream.getVideoTracks().some((t) => t.readyState === 'live' && t !== track)) {
          this.setRemoteScreen(id, entry, null);
        }
      };
      track.addEventListener('ended', clearIfCurrent);
      stream.addEventListener('removetrack', (ev) => {
        if (ev.track === track) clearIfCurrent();
      });
      this.setRemoteScreen(id, entry, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.peers.get(id) === entry) {
        this.closePeer(id);
        // Reconnect once things settle: the lower id calls again, the higher
        // id says hello; the other side replaces its dead connection.
        setTimeout(() => this.sync(this.lastVoicePeers), 2000);
      }
      this.onChange();
    };

    for (const track of this.stream!.getTracks()) pc.addTrack(track, this.stream!);
    this.attachScreen(entry);
    return entry;
  }

  private closePeer(id: number) {
    const entry = this.peers.get(id);
    if (!entry) return;
    this.peers.delete(id);
    this.helloSent.delete(id);
    entry.pc.close();
    entry.audio.srcObject = null;
    this.removeMeter(id);
    this.setRemoteScreen(id, entry, null);
  }

  // ----- screen sharing -----

  private attachScreen(entry: PeerEntry) {
    const track = this.localScreen?.getVideoTracks()[0];
    if (!track || entry.screenSender || entry.pc.signalingState === 'closed') return;
    entry.screenSender = entry.pc.addTrack(track, this.localScreen!);
  }

  /** Stops the local share without notifying onChange. Returns whether one was active. */
  private endScreenShare(): boolean {
    const screen = this.localScreen;
    if (!screen) return false;
    this.localScreen = null;
    for (const [id, entry] of this.peers) {
      if (entry.screenSender && entry.pc.signalingState !== 'closed') {
        try {
          entry.pc.removeTrack(entry.screenSender);
        } catch (err) {
          console.warn('Voice: removeTrack failed', err);
        }
      }
      entry.screenSender = null;
      this.send(id, entry, { screen: false });
    }
    screen.getTracks().forEach((t) => t.stop());
    return true;
  }

  private setRemoteScreen(id: number, entry: PeerEntry, stream: MediaStream | null) {
    if (entry.remoteScreen === stream) return;
    entry.remoteScreen = stream;
    this.events.onRemoteScreen?.(id, stream);
  }

  // ----- speaking detection -----

  private addMeter(id: number, stream: MediaStream) {
    const ctx = this.audioCtx;
    if (!ctx || stream.getAudioTracks().length === 0) return;
    const old = this.meters.get(id);
    if (old?.stream === stream) return;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser); // not routed to destination; <audio> handles playback
      if (old) this.disconnectMeter(old);
      this.meters.set(id, {
        stream,
        source,
        analyser,
        buf: new Float32Array(analyser.fftSize),
        lastLoud: -Infinity,
        speaking: old?.speaking ?? false,
      });
    } catch (err) {
      console.warn('Voice: could not analyse audio', err);
    }
  }

  private removeMeter(id: number) {
    const meter = this.meters.get(id);
    if (!meter) return;
    this.meters.delete(id);
    this.disconnectMeter(meter);
    if (meter.speaking) this.events.onSpeaking?.(id, false);
  }

  private disconnectMeter(meter: Meter) {
    try {
      meter.source.disconnect();
      meter.analyser.disconnect();
    } catch {
      /* already disconnected */
    }
  }

  private pollMeters() {
    const ctx = this.audioCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = performance.now();
    for (const [id, m] of this.meters) {
      m.analyser.getFloatTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
      const rms = Math.sqrt(sum / m.buf.length);
      const silenced = id === this.myId && this.muted;
      if (rms > SPEAK_THRESHOLD && !silenced) m.lastLoud = now;
      const speaking = !silenced && now - m.lastLoud < SPEAK_HOLD_MS;
      if (speaking !== m.speaking) {
        m.speaking = speaking;
        this.events.onSpeaking?.(id, speaking);
      }
    }
  }
}
