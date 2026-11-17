/**
 * 串行互斥锁（T18 / T22）。
 *
 * 回复驱动的状态推进与关停排空共用一把锁，二者不得同时改同一 run。
 * 并发 resume 同一件时，第一个进入者解除挂起，后续进入者看到已解除即不再推进。
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private locked = false;

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
      release();
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }
}
