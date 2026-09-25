/**
 * In-process LLM worker pool.
 * At most `MAX_IN_PROCESS_LLM_WORKERS` tasks run at once. The rest wait here.
 * This does not call another Grok bot or any other assistant. The task is a
 * function in this process (one Chat Completions request, or one tool round).
 */
export const MAX_IN_PROCESS_LLM_WORKERS = 5;

export class LlmWorkerPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent = MAX_IN_PROCESS_LLM_WORKERS) {
    if (maxConcurrent < 1) {
      throw new Error("LLM worker pool needs at least one slot");
    }
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Run `task` when a slot is free. The slot is released when `task` settles,
   * including when it throws.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
    else if (this.active < 0) this.active = 0;
  }
}
