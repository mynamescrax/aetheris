// Bounds both running work and its waiting queue. A busy key cannot block
// unrelated keys, and cancelled/expired queue entries never start work.
export function createWorkLimiter({
  maxConcurrent = 12,
  maxPerKey = 8,
  maxQueued = 128,
  maxQueuedPerKey = 64,
  queueTimeoutMs = 10000,
} = {}) {
  for (const value of [maxConcurrent, maxPerKey, queueTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError("Work limits must be positive integers.");
  }
  for (const value of [maxQueued, maxQueuedPerKey]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError("Queue limits must be non-negative integers.");
  }
  const queue = [];
  const activeByKey = new Map();
  const queuedByKey = new Map();
  let active = 0;

  function change(map, key, delta) {
    const count = (map.get(key) || 0) + delta;
    if (count) map.set(key, count);
    else map.delete(key);
  }

  function busy() {
    return Object.assign(new Error("Upstream work queue is busy."), {
      code: "WORK_BUSY",
    });
  }

  function canStart(key) {
    return active < maxConcurrent && (activeByKey.get(key) || 0) < maxPerKey;
  }

  function remove(job) {
    const index = queue.indexOf(job);
    if (index === -1) return false;
    queue.splice(index, 1);
    change(queuedByKey, job.key, -1);
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    return true;
  }

  function drain() {
    for (let i = 0; i < queue.length && active < maxConcurrent;) {
      const job = queue[i];
      if (!canStart(job.key)) {
        i++;
        continue;
      }
      remove(job);
      active++;
      change(activeByKey, job.key, 1);
      const finish = () => {
        active--;
        change(activeByKey, job.key, -1);
        drain();
      };
      Promise.resolve()
        .then(() => {
          job.signal?.throwIfAborted();
          return job.task();
        })
        .then(
          (value) => {
            finish();
            job.resolve(value);
          },
          (error) => {
            finish();
            job.reject(error);
          },
        );
    }
  }

  return function run(key, task, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (
      !canStart(key) &&
      (queue.length >= maxQueued ||
        (queuedByKey.get(key) || 0) >= maxQueuedPerKey)
    )
      return Promise.reject(busy());

    return new Promise((resolve, reject) => {
      const job = { key, task, signal, resolve, reject };
      job.abort = () => {
        if (remove(job)) reject(signal.reason);
      };
      job.timer = setTimeout(() => {
        if (remove(job)) reject(busy());
      }, queueTimeoutMs);
      job.timer.unref?.();
      queue.push(job);
      change(queuedByKey, key, 1);
      signal?.addEventListener("abort", job.abort, { once: true });
      drain();
    });
  };
}
