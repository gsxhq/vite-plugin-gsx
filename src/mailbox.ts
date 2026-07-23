// One in-memory command queue between the panel (ws) and gsx dev (long-poll).
// Cap + consecutive-dupe collapse keep a stuck consumer from accumulating junk.
const CAP = 16;

export class CommandMailbox {
  private queue: string[] = [];
  private waiter: { resolve: (cmds: string[]) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  push(cmd: string): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve([cmd]);
      return;
    }
    if (this.queue.length >= CAP) return;
    if (this.queue[this.queue.length - 1] === cmd) return;
    this.queue.push(cmd);
  }

  /** Resolve with all queued commands, waiting up to timeoutMs if empty. */
  waitTake(timeoutMs: number): Promise<string[]> {
    if (this.queue.length > 0) {
      const q = this.queue;
      this.queue = [];
      return Promise.resolve(q);
    }
    if (this.waiter) {
      // Single consumer (one gsx dev): a newer poll displaces the older one.
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve([]);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve([]);
      }, timeoutMs);
      this.waiter = { resolve, timer };
    });
  }
}
