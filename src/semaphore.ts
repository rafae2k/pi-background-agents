export interface Slot {
  ready: Promise<void>;
  /** Leave the queue; `ready` rejects with `why`. No effect once the slot was granted. */
  cancel(why: string): void;
}

/** Callers over the limit wait in order instead of failing. */
export class Semaphore {
  readonly max: number;
  live = 0;
  private readonly waiters: { go: () => void }[] = [];

  constructor(max: number) {
    this.max = max;
  }

  acquire(): Slot {
    if (this.live < this.max) {
      this.live++;
      return { ready: Promise.resolve(), cancel() {} };
    }
    let cancel: (why: string) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      const entry = {
        go: () => {
          this.live++;
          resolve();
        },
      };
      cancel = (why) => {
        const i = this.waiters.indexOf(entry);
        if (i < 0) return;
        this.waiters.splice(i, 1);
        reject(new Error(why));
      };
      this.waiters.push(entry);
    });
    return { ready, cancel: (why) => cancel(why) };
  }

  release(): void {
    this.live--;
    this.waiters.shift()?.go();
  }
}
