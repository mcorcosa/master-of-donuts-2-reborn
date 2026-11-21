interface FrameDriver {
  // Queue the callback for a future frame, using the same clock for each request.
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
}

export class FrameLoop {
  private requestId: number | undefined;
  private suspended = false;
  private disposed = false;

  constructor(
    private readonly driver: FrameDriver,
    private readonly frame: (time: number) => boolean,
  ) {}

  invalidate(): void {
    if (this.disposed || this.suspended || this.requestId !== undefined) return;
    const id = this.driver.request(time => {
      if (this.requestId !== id) return;
      this.requestId = undefined;
      if (!this.disposed && !this.suspended && this.frame(time)) this.invalidate();
    });
    this.requestId = id;
  }

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) this.cancel();
    else this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private cancel(): void {
    if (this.requestId !== undefined) this.driver.cancel(this.requestId);
    this.requestId = undefined;
  }
}
