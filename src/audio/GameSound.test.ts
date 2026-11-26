import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameSound } from './GameSound';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const idle = () => new Promise<void>(resolve => setImmediate(resolve));

function setup(getStorage?: () => Pick<Storage, 'getItem' | 'setItem'>) {
  const bytesByAsset = new WeakMap<ArrayBuffer, string>();
  const fetchAsset = vi.fn(async (url: string) => {
    const bytes = new ArrayBuffer(1);
    bytesByAsset.set(bytes, url.split('/').at(-1)!);
    return { ok: true, arrayBuffer: async () => bytes };
  });
  const voice = () => ({
    buffer: { name: '' }, onended: null as (() => void) | null,
    connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
  });

  const context = {
    state: 'running', destination: {},
    resume: vi.fn(async () => { context.state = 'running'; }),
    close: vi.fn(async () => { context.state = 'closed'; }),
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => ({ name: bytesByAsset.get(bytes)! })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    createBufferSource: vi.fn(voice),
  };
  const createContext = vi.fn(function () { return context; });
  vi.stubGlobal('fetch', fetchAsset);
  vi.stubGlobal('AudioContext', createContext);
  const sound = new GameSound(getStorage);
  const voices = () => context.createBufferSource.mock.results.map(result => result.value as ReturnType<typeof voice>);
  return { sound, context, createContext, fetchAsset, voices };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GameSound', () => {
  it('starts silent and plays independent same-buffer cues at their semantic gains', async () => {
    const { sound, createContext, fetchAsset, context, voices } = setup();
    sound.match('red');
    expect(createContext).not.toHaveBeenCalled();
    expect(fetchAsset).not.toHaveBeenCalled();

    sound.activate();
    await idle();
    expect(fetchAsset).toHaveBeenCalledTimes(8);
    expect(voices()).toHaveLength(0);

    sound.landing('choco');
    sound.match('gray');
    sound.match('gray');
    sound.match('gold');
    sound.landing('joker');
    sound.levelUp();
    expect(voices().map(source => source.buffer.name)).toEqual([
      'pop-gray.m4a', 'pop-gray.m4a', 'pop-gray.m4a', 'pop-orange.m4a', 'pop-blue.m4a', 'icy-jingle.wav',
    ]);
    expect(voices().every(source => source.start.mock.calls.length === 1)).toBe(true);
    const gains = context.createGain.mock.results.map(result => result.value.gain.value);
    expect(gains[0]).toBeLessThan(gains[1]);
    expect(gains[1]).toBe(gains[2]);
    expect(gains[0]).toBe(gains[4]);
  });

  it('plays a fresh cue after decoding and drops cues whose presentation has expired', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { sound, context, voices } = setup();
    const decode = context.decodeAudioData.getMockImplementation()!;
    const ready = deferred();
    context.decodeAudioData.mockImplementation(async bytes => {
      await ready.promise;
      return decode(bytes);
    });
    sound.activate();
    sound.match('red');
    now = 130;
    sound.landing('blue');
    ready.resolve();
    await idle();

    expect(voices().map(source => source.buffer.name)).toEqual(['pop-blue.m4a']);
  });

  it('recovers from independent resume, fetch and decode failures on a later gesture', async () => {
    const { sound, context, fetchAsset, voices } = setup();
    context.state = 'suspended';
    context.resume.mockRejectedValueOnce(new Error('resume denied'));
    fetchAsset.mockImplementationOnce(async () => { throw new Error('offline'); });
    context.decodeAudioData.mockImplementationOnce(async () => { throw new Error('bad file'); });
    sound.activate();
    await idle();
    expect(context.state).toBe('suspended');
    expect(voices()).toHaveLength(0);

    sound.activate();
    await idle();
    expect(fetchAsset).toHaveBeenCalledTimes(10);
    expect(context.resume).toHaveBeenCalledTimes(2);
    sound.landing('blue');
    sound.match('gray');
    expect(voices().map(source => source.buffer.name)).toEqual(['pop-blue.m4a', 'pop-gray.m4a']);
  });

  it('cancels deferred and active cues and disposes the audio context', async () => {
    const { sound, context, fetchAsset, voices } = setup();
    const resume = deferred();
    context.state = 'suspended';
    context.resume.mockImplementationOnce(async () => {
      await resume.promise;
      context.state = 'running';
    });
    sound.activate();
    sound.match('blue');
    sound.stop();
    resume.resolve();
    await idle();
    expect(voices()).toHaveLength(0);

    sound.match('blue');
    const [active] = voices();
    sound.destroy();
    expect(active.stop).toHaveBeenCalledOnce();
    expect(active.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(fetchAsset.mock.calls).toHaveLength(8);
    sound.activate();
    sound.levelUp();
    expect(voices()).toHaveLength(1);
  });

  it('restores mute across instances and keeps sound usable if browser storage fails', async () => {
    let saved: string | null = null;
    const storage = { getItem: vi.fn(() => saved), setItem: vi.fn((_key: string, value: string) => { saved = value; }) };
    const first = new GameSound(() => storage);
    first.toggle(false);
    expect(first.enabled).toBe(false);

    const { sound, createContext, voices } = setup(() => storage);
    expect(sound.enabled).toBe(false);
    sound.activate();
    sound.match('red');
    expect(createContext).not.toHaveBeenCalled();
    sound.toggle(true);
    expect(createContext).toHaveBeenCalledOnce();
    await idle();
    sound.match('red');
    expect(voices()).toHaveLength(1);
    expect(new GameSound(() => storage).enabled).toBe(true);

    const { sound: unavailable } = setup(() => { throw new Error('Storage denied'); });
    expect(unavailable.enabled).toBe(true);
    unavailable.toggle(false);
    expect(unavailable.enabled).toBe(false);
    unavailable.toggle(true);
    expect(unavailable.enabled).toBe(true);
  });

  it('stops active cues and discards queued and muted cues while an old resume is pending', async () => {
    const { sound, context, voices } = setup();
    sound.activate();
    await idle();
    sound.landing('blue');
    const [active] = voices();

    context.state = 'suspended';
    const resume = deferred();
    context.resume.mockImplementationOnce(async () => {
      await resume.promise;
      context.state = 'running';
    });
    sound.activate();
    sound.levelUp();
    sound.toggle(false);
    expect(active.stop).toHaveBeenCalledOnce();
    expect(active.disconnect).toHaveBeenCalledOnce();
    sound.match('purple');

    sound.toggle(true);
    expect(context.resume).toHaveBeenCalledTimes(2);
    resume.resolve();
    await idle();
    expect(voices()).toHaveLength(1);
    sound.match('green');
    expect(voices().map(source => source.buffer.name)).toEqual(['pop-blue.m4a', 'pop-green.m4a']);
  });

  it('reuses decoding across a mute cycle and plays only a fresh audible cue', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const { sound, context, fetchAsset, voices } = setup();
    const decode = context.decodeAudioData.getMockImplementation()!;
    const ready = deferred();
    context.decodeAudioData.mockImplementation(async bytes => {
      await ready.promise;
      return decode(bytes);
    });
    sound.activate();
    sound.match('red');
    sound.toggle(false);
    sound.match('blue');
    sound.toggle(true);
    sound.match('green');
    ready.resolve();
    await idle();
    expect(fetchAsset).toHaveBeenCalledTimes(8);
    expect(voices().map(source => source.buffer.name)).toEqual(['pop-green.m4a']);
  });

  it('bounds overlapping voices and preserves a celebration during a burst', async () => {
    const { sound, voices } = setup();
    sound.activate();
    await idle();
    sound.levelUp();
    for (let i = 0; i < 12; i++) sound.landing('red');
    const [level, ...pops] = voices();
    expect(level.stop).not.toHaveBeenCalled();
    expect(pops.filter(source => source.stop.mock.calls.length === 0)).toHaveLength(7);
  });
});
