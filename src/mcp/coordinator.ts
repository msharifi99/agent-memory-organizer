type QueueEntry = {
  kind: "read" | "write";
  resolve: (release: () => void) => void;
};

export class ReadWriteCoordinator {
  private activeReaders = 0;
  private activeWriter = false;
  private readonly queue: QueueEntry[] = [];

  async read<T>(
    operation: () => Promise<T>,
    onAcquired?: (queueMilliseconds: number) => void,
  ): Promise<T> {
    const queuedAt = performance.now();
    const release = await this.acquire("read");
    onAcquired?.(performance.now() - queuedAt);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async write<T>(
    operation: () => Promise<T>,
    onAcquired?: (queueMilliseconds: number) => void,
  ): Promise<T> {
    const queuedAt = performance.now();
    const release = await this.acquire("write");
    onAcquired?.(performance.now() - queuedAt);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(kind: "read" | "write"): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({ kind, resolve });
      this.drain();
    });
  }

  private drain(): void {
    if (this.activeWriter || this.queue.length === 0) {
      return;
    }

    if (this.activeReaders > 0) {
      while (this.queue[0]?.kind === "read") {
        this.startReader();
      }
      return;
    }

    if (this.queue[0].kind === "write") {
      const next = this.queue.shift();
      if (!next) return;
      this.activeWriter = true;
      next.resolve(() => {
        this.activeWriter = false;
        this.drain();
      });
      return;
    }

    while (this.queue[0]?.kind === "read") {
      this.startReader();
    }
  }

  private startReader(): void {
    const next = this.queue.shift();
    if (!next) return;
    this.activeReaders += 1;
    next.resolve(() => {
      this.activeReaders -= 1;
      if (this.activeReaders === 0) this.drain();
    });
  }
}
