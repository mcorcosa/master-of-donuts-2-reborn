const POP_ASSETS = ['blue', 'gray', 'green', 'orange', 'purple', 'red', 'yellow'] as const;
const ASSETS = [...POP_ASSETS, 'level'] as const;
type Asset = typeof ASSETS[number];
type PopAsset = typeof POP_ASSETS[number];

const POP_BY_COLOR: Readonly<Partial<Record<string, PopAsset>>> = {
  blue: 'blue', choco: 'gray', gold: 'orange', gray: 'gray', green: 'green',
  joker: 'blue', purple: 'purple', red: 'red', yellow: 'yellow',
};
const LANDING_GAIN = 0.32;
const MATCH_GAIN = 0.78;
// The original jingle peaks about 16 dB below the pops.
const LEVEL_GAIN = 3.2;
const MAX_VOICES = 8;
const READY_GRACE_MS = 100;
const SOUND_KEY = 'master-of-donuts-2-reborn.sound.v1';

interface Cue {
  asset: Asset;
  gain: number;
  expires: number;
}

export class GameSound {
  private context?: AudioContext;
  private readonly buffers = new Map<Asset, AudioBuffer>();
  private readonly loading = new Set<Asset>();
  private readonly abort = new AbortController();
  private readonly voices = new Map<AudioBufferSourceNode, { gain: GainNode; asset: Asset }>();
  private pending: Cue[] = [];
  private audible = true;

  constructor(private readonly getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => globalThis.localStorage) {
    try {
      this.audible = this.getStorage().getItem(SOUND_KEY) !== 'off';
    } catch {
      // Sound defaults to on when storage is unavailable.
    }
  }

  get enabled(): boolean {
    return this.audible;
  }

  toggle(activate: boolean): void {
    if (this.abort.signal.aborted) return;
    this.audible = !this.audible;
    if (!this.audible) this.stop();
    else if (activate) this.activate();
    try {
      this.getStorage().setItem(SOUND_KEY, this.audible ? 'on' : 'off');
    } catch {
      // The preference still applies for this session.
    }
  }

  activate(): void {
    if (!this.audible || this.abort.signal.aborted || typeof AudioContext === 'undefined') return;
    try {
      const context = this.context ??= new AudioContext();
      if (context.state !== 'running') {
        // Call resume in the trusted event itself, including after a browser interruption.
        void context.resume().then(() => this.flush(), () => {});
      }
      for (const asset of ASSETS) {
        if (!this.buffers.has(asset) && !this.loading.has(asset)) void this.load(context, asset);
      }
    } catch {
      // Audio is optional. A later gesture can retry an unavailable device.
    }
  }

  landing(color: string): void {
    this.play(POP_BY_COLOR[color], LANDING_GAIN);
  }

  match(color: string): void {
    this.play(POP_BY_COLOR[color], MATCH_GAIN);
  }

  levelUp(): void {
    this.play('level', LEVEL_GAIN);
  }

  stop(): void {
    this.pending = [];
    for (const source of this.voices.keys()) this.stopVoice(source);
  }

  destroy(): void {
    this.abort.abort();
    this.stop();
    this.buffers.clear();
    if (this.context) void this.context.close().catch(() => {});
    this.context = undefined;
  }

  private async load(context: AudioContext, asset: Asset): Promise<void> {
    this.loading.add(asset);
    try {
      const path = asset === 'level' ? 'icy-jingle.wav' : `color-pops-v3/pop-${asset}.m4a`;
      const response = await fetch(`${import.meta.env.BASE_URL}assets/audio/${path}`, { signal: this.abort.signal });
      if (!response.ok || this.abort.signal.aborted) return;
      const bytes = await response.arrayBuffer();
      if (this.abort.signal.aborted) return;
      const buffer = await context.decodeAudioData(bytes);
      if (this.abort.signal.aborted) return;
      this.buffers.set(asset, buffer);
      this.flush();
    } catch {
      // A missing or undecodable asset has no effect on gameplay or other cues.
    } finally {
      this.loading.delete(asset);
    }
  }

  private play(asset: Asset | undefined, gain: number): void {
    if (!this.audible || !asset || !this.context) return;
    const now = performance.now();
    this.pending.push({ asset, gain, expires: now + READY_GRACE_MS });
    this.flush();
    if (this.pending.length > MAX_VOICES) this.pending.shift();
  }

  private flush(): void {
    if (!this.audible || this.abort.signal.aborted) return;
    const now = performance.now();
    const context = this.context;
    // Give an initial decode/resume a short chance to catch up to the visible event.
    this.pending = this.pending.filter(cue => {
      if (cue.expires < now) return false;
      const buffer = this.buffers.get(cue.asset);
      if (context?.state !== 'running' || !buffer) return true;
      this.startVoice(context, buffer, cue);
      return false;
    });
  }

  private startVoice(context: AudioContext, buffer: AudioBuffer, cue: Cue): void {
    if (this.voices.size >= MAX_VOICES) {
      // Keep the longer celebration intact when there is a burst of landings.
      const oldestPop = [...this.voices].find(([, voice]) => voice.asset !== 'level');
      if (!oldestPop) return;
      this.stopVoice(oldestPop[0]);
    }

    let source: AudioBufferSourceNode | undefined;
    let gain: GainNode | undefined;
    try {
      source = context.createBufferSource();
      gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = cue.gain;
      source.connect(gain);
      gain.connect(context.destination);
      const playing = source;
      source.onended = () => this.release(playing);
      this.voices.set(source, { gain, asset: cue.asset });
      source.start();
    } catch {
      if (source && this.voices.has(source)) this.release(source);
      else {
        source?.disconnect();
        gain?.disconnect();
      }
    }
  }

  private release(source: AudioBufferSourceNode): void {
    const voice = this.voices.get(source);
    if (!voice) return;
    this.voices.delete(source);
    source.onended = null;
    source.disconnect();
    voice.gain.disconnect();
  }

  private stopVoice(source: AudioBufferSourceNode): void {
    try { source.stop(); } catch { /* A voice can end before cancellation. */ }
    this.release(source);
  }
}
