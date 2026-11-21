import type { FriendScore, FriendsScores } from '../platform/friendsScores';
import type { CompletedResults } from '../platform/personalScores';

export type ResultsTab = 'personal' | 'friends';
export type FriendsList = { status: 'idle' | 'loading' | 'error' } |
  { status: 'ready'; scores: readonly FriendScore[] };
export type ScoreSubmission = 'idle' | 'submitting' | 'sent' | 'error';

export interface ResultsView {
  personal: CompletedResults;
  tab: ResultsTab;
  friends: { list: FriendsList; submission: ScoreSubmission } | null;
}

export class ResultsSession {
  private active = true;
  private tab: ResultsTab = 'personal';
  private list: FriendsList = { status: 'idle' };
  private submission: ScoreSubmission = 'idle';
  private listRequest = 0;

  constructor(
    private readonly personal: CompletedResults,
    private readonly board: FriendsScores | null,
    private readonly render: (view: ResultsView) => void,
  ) {}

  get view(): ResultsView {
    return { personal: this.personal, tab: this.tab,
      friends: this.board ? { list: this.list, submission: this.submission } : null };
  }

  select(tab: ResultsTab): void {
    if (!this.active || !this.board) return;
    const changed = tab !== this.tab;
    this.tab = tab;
    if (tab === 'friends' && (this.list.status === 'idle' || this.list.status === 'error')) {
      void this.loadFriends(this.board);
    } else if (changed) {
      this.render(this.view);
    }
  }

  async submit(): Promise<void> {
    if (!this.active || !this.board || this.tab !== 'friends' ||
        this.submission === 'submitting' || this.submission === 'sent') return;
    this.submission = 'submitting';
    this.render(this.view);
    try {
      await this.board.submit(this.personal.run.score);
    } catch {
      this.submission = 'error';
      this.renderFriends();
      return;
    }
    if (!this.active) return;

    this.submission = 'sent';
    this.listRequest++;
    this.list = { status: 'idle' };
    if (this.tab === 'friends') void this.loadFriends(this.board);
  }

  private async loadFriends(board: FriendsScores): Promise<void> {
    const request = ++this.listRequest;
    this.list = { status: 'loading' };
    this.renderFriends();
    let result: FriendsList;
    try {
      result = { status: 'ready', scores: await board.list() };
    } catch {
      result = { status: 'error' };
    }
    if (!this.active || request !== this.listRequest) return;
    this.list = result;
    this.renderFriends();
  }

  private renderFriends(): void {
    if (this.active && this.tab === 'friends') this.render(this.view);
  }

  close(): void {
    this.active = false;
  }
}
