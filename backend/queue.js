/**
 * A concurrency-limited FIFO for the expensive path.
 *
 * WHY THIS EXISTS: an analysis is ~19s of a single GPU running a 14B planner,
 * and Ollama serializes generation for one model anyway. Without a queue, ten
 * simultaneous visitors produce ten in-flight requests that interleave badly,
 * every one of them slower than if they had simply waited, and no way to tell
 * anyone what is happening. With it, the tenth is told it is tenth.
 *
 * Concurrency defaults to 1 because that is what the hardware actually is:
 * 15.8 of 16.4 GB of VRAM is already committed to two resident models, so there
 * is no room to run two generations at once. Raising it is a config change for
 * a bigger box, not a code change.
 *
 * Waiting jobs get a position callback, so the UI can show "3rd in queue"
 * rather than an unexplained delay. Jobs abandoned before they start are
 * dropped without ever running -- a browser that navigated away should not cost
 * the GPU 19 seconds.
 */

class QueueFullError extends Error {
  constructor(depth) {
    super(`queue is full (${depth} waiting)`);
    this.depth = depth;
  }
}

function createQueue({ concurrency = 1, maxDepth = 20, name = "queue" } = {}) {
  const waiting = [];
  let active = 0;

  /** Tell everyone still waiting where they now stand. */
  function notifyPositions() {
    waiting.forEach((job, i) => {
      const position = i + 1;
      if (job.lastPosition === position) return;   // only on change
      job.lastPosition = position;
      try { job.onPosition?.(position, waiting.length); } catch { /* never fatal */ }
    });
  }

  function pump() {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift();
      if (job.abandoned) continue;          // gave up before reaching the front
      active++;
      notifyPositions();
      Promise.resolve()
        .then(() => job.run())
        .then(job.resolve, job.reject)
        .finally(() => { active--; pump(); });
    }
  }

  return {
    name,
    /**
     * @param run          the work, returning a promise
     * @param onPosition   (position, total) called while queued, on change only
     * @param isAbandoned  polled at dequeue; skip the job if the caller has gone
     */
    submit(run, { onPosition, isAbandoned } = {}) {
      if (waiting.length >= maxDepth) {
        return Promise.reject(new QueueFullError(waiting.length));
      }
      return new Promise((resolve, reject) => {
        const job = {
          run, resolve, reject, onPosition, lastPosition: null,
          get abandoned() { return isAbandoned ? isAbandoned() : false; },
        };
        waiting.push(job);
        // Report an initial position only when the job will actually wait.
        if (active >= concurrency) {
          job.lastPosition = waiting.length;
          try { onPosition?.(waiting.length, waiting.length); } catch { /* ignore */ }
        }
        pump();
      });
    },
    stats() { return { active, waiting: waiting.length, concurrency, maxDepth }; },
  };
}

module.exports = { createQueue, QueueFullError };
