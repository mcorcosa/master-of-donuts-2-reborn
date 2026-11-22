const VISIT_IDLE_MS = 30 * 60_000;
export const AD_GAP_MS = 180_000;
const AUTO_LIMIT = 2;

export const AD_HISTORY_KEY = 'master-of-donuts-2-reborn.ad-history.v1';

interface History {
  version: 1;
  returning: boolean;
  lastActivityAt: number;
  runs: number;
  playedMs: number;
  gapMs: number;
  attempts: number;
  pendingExposure: boolean;
  writer: string;
}

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

function freshHistory(returning: boolean, now: number, writer: string): History {
  return { version: 1, returning, lastActivityAt: now, runs: 0, playedMs: 0, gapMs: 0, attempts: 0,
    pendingExposure: false, writer };
}

function decode(raw: string, now: number): History {
  const data = JSON.parse(raw) as History | null;
  if (!data || data.version !== 1 || typeof data.returning !== 'boolean' ||
      typeof data.pendingExposure !== 'boolean' || typeof data.writer !== 'string' || !data.writer ||
      !Number.isSafeInteger(data.lastActivityAt) || data.lastActivityAt < 0 || data.lastActivityAt > now ||
      !Number.isSafeInteger(data.runs) || data.runs < 0 || data.runs > 2 ||
      !Number.isSafeInteger(data.attempts) || data.attempts < 0 || data.attempts > AUTO_LIMIT ||
      (!data.returning && data.attempts !== 0) || data.attempts > data.runs ||
      !Number.isFinite(data.playedMs) || data.playedMs < 0 || data.playedMs > AD_GAP_MS ||
      (data.attempts !== 0 && data.playedMs < AD_GAP_MS) ||
      !Number.isFinite(data.gapMs) || data.gapMs < 0 || data.gapMs > data.playedMs ||
      (data.pendingExposure && data.gapMs !== 0)) {
    throw new Error('Unrecognized ad history.');
  }
  return data;
}

/** A separate, player-scoped record. Storage failures disable automatic ads for this launch. */
export class MonetizationHistory {
  private state?: History;
  private raw: string | null = null;
  private storage?: HistoryStorage;
  private key = '';

  constructor(private readonly getStorage: (() => HistoryStorage) | undefined,
    private readonly now: () => number, private readonly newWriter: () => string) {}

  initialize(playerId: string | null): void {
    if (!playerId?.trim()) return;
    try {
      this.key = `${AD_HISTORY_KEY}.${encodeURIComponent(playerId)}`;
      this.storage = this.getStorage?.();
      if (!this.storage) return;
      const now = this.now();
      const writer = this.newWriter();
      this.raw = this.storage.getItem(this.key);
      const saved = this.raw === null ? undefined : decode(this.raw, now);
      this.state = saved && now - saved.lastActivityAt < VISIT_IDLE_MS
        ? { ...saved, writer, pendingExposure: false }
        : freshHistory(!!saved, now, writer);
      this.save();
    } catch { this.state = undefined; }
  }

  get canPreload(): boolean { return !!this.state?.returning && this.state.attempts < AUTO_LIMIT; }
  get eligible(): boolean {
    const visit = this.state;
    return !!visit && this.canPreload && !visit.pendingExposure && visit.runs >= 2 &&
      visit.playedMs >= AD_GAP_MS && visit.gapMs >= AD_GAP_MS;
  }

  credit(ms: number): void {
    if (!this.state || this.state.pendingExposure || !Number.isFinite(ms) || ms <= 0) return;
    this.state.playedMs = Math.min(AD_GAP_MS, this.state.playedMs + ms);
    this.state.gapMs = Math.min(AD_GAP_MS, this.state.gapMs + ms);
  }

  runCompleted(): void {
    if (this.state) this.state.runs = Math.min(2, this.state.runs + 1);
    this.save();
  }

  beginExposure(automatic: boolean): boolean {
    if (automatic && !this.eligible) return false;
    if (!this.state) return !automatic;
    if (automatic) this.state.attempts++;
    this.state.pendingExposure = true;
    this.state.gapMs = 0;
    return this.save() || !automatic;
  }

  endExposure(): void {
    if (!this.state) return;
    this.state.pendingExposure = false;
    this.state.gapMs = 0;
    this.save();
  }

  save(): boolean {
    if (!this.state || !this.storage) return false;
    try {
      const now = this.now();
      if (now < this.state.lastActivityAt || this.storage.getItem(this.key) !== this.raw) {
        throw new Error('Ad history changed outside this launch.');
      }
      this.state.lastActivityAt = now;
      const raw = JSON.stringify(this.state);
      this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw new Error('Ad history write was not durable.');
      this.raw = raw;
      return true;
    } catch {
      this.state = undefined;
      return false;
    }
  }
}
