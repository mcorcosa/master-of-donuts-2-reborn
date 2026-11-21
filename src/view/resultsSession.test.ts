import { describe, expect, it, vi } from 'vitest';
import type { FriendScore } from '../platform/friendsScores';
import type { CompletedResults } from '../platform/personalScores';
import { ResultsSession } from './resultsSession';

const personal: CompletedResults = { run: { score: 321, level: 4, bestCombo: 3 },
  rows: [{ rank: 1, score: 321, current: true }], isPersonalBest: true };
const player = { rank: 1, name: 'Player', score: 321, current: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('completed results tabs', () => {
  it('loads only on demand, renders the active tab and reuses settled reads on return', async () => {
    const firstRead = deferred<readonly FriendScore[]>();
    const board = { list: vi.fn(() => firstRead.promise), submit: vi.fn(async () => {}) };
    const render = vi.fn();
    const session = new ResultsSession(personal, board, render);
    expect(session.view).toMatchObject({ tab: 'personal', friends: { list: { status: 'idle' } } });
    await session.submit();
    expect(board.list).not.toHaveBeenCalled();
    expect(board.submit).not.toHaveBeenCalled();

    session.select('friends');
    session.select('friends');
    expect(board.list).toHaveBeenCalledTimes(1);
    expect(render.mock.lastCall?.[0]).toMatchObject({ tab: 'friends', friends: { list: { status: 'loading' } } });
    session.select('personal');
    const renders = render.mock.calls.length;
    firstRead.resolve([player]);
    await firstRead.promise;
    expect(render).toHaveBeenCalledTimes(renders);
    session.select('friends');
    expect(board.list).toHaveBeenCalledTimes(1);
    expect(render.mock.lastCall?.[0]).toMatchObject({ tab: 'friends', friends: { list: { status: 'ready', scores: [player] } } });
    expect(board.submit).not.toHaveBeenCalled();
  });

  it('supports deliberate retry after a list or score error and only submits the final numeric score', async () => {
    const send = deferred<void>();
    const list = vi.fn<() => Promise<readonly FriendScore[]>>()
      .mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue([]);
    const submit = vi.fn<(score: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Unavailable')).mockReturnValue(send.promise);
    const session = new ResultsSession(personal, { list, submit }, vi.fn());
    session.select('friends');
    await Promise.resolve();
    expect(session.view.friends?.list.status).toBe('error');
    session.select('friends');
    await Promise.resolve();
    expect(session.view.friends?.list).toEqual({ status: 'ready', scores: [] });

    await session.submit();
    expect(session.view.friends?.submission).toBe('error');
    const submitting = session.submit();
    await session.submit();
    expect(session.view.friends?.submission).toBe('submitting');
    expect(submit.mock.calls).toEqual([[321], [321]]);
    send.resolve();
    await submitting;
    await session.submit();
    expect(session.view.friends?.submission).toBe('sent');
    expect(submit).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('ignores a stale pre-submission list and avoids refreshing an inactive tab or closed run', async () => {
    const oldRead = deferred<readonly FriendScore[]>();
    const newRead = deferred<readonly FriendScore[]>();
    const send = deferred<void>();
    const list = vi.fn<() => Promise<readonly FriendScore[]>>()
      .mockReturnValueOnce(oldRead.promise).mockReturnValue(newRead.promise);
    const submit = vi.fn(() => send.promise);
    const render = vi.fn();
    const session = new ResultsSession(personal, { list, submit }, render);
    session.select('friends');
    const posting = session.submit();
    session.select('personal');
    send.resolve();
    await posting;
    expect(list).toHaveBeenCalledTimes(1);
    expect(render.mock.lastCall?.[0].tab).toBe('personal');
    session.select('friends');
    oldRead.resolve([]);
    await oldRead.promise;
    expect(session.view.friends?.list.status).toBe('loading');
    expect(session.view.friends?.submission).toBe('sent');
    session.close();
    const renders = render.mock.calls.length;
    newRead.resolve([player]);
    await newRead.promise;
    expect(render).toHaveBeenCalledTimes(renders);
  });
});
