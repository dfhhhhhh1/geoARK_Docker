/**
 * Token-bucket rate limiting, per identity.
 *
 * The thing being protected is not CPU, it is a single GPU running a 14B model
 * for ~19 seconds per analysis. One unauthenticated client can occupy it
 * indefinitely, so the limit is expressed in requests per minute rather than
 * per second, and the expensive endpoints get a much smaller bucket than the
 * cheap ones.
 *
 * In-memory on purpose: this is a single-instance deployment behind one nginx.
 * A shared store would be required the moment there are two API containers, and
 * that is the point at which this file should be replaced rather than extended.
 */

/**
 * @param capacity  burst size -- how many requests can arrive at once
 * @param perMinute sustained refill rate
 */
function createLimiter({ capacity, perMinute, name }) {
  const buckets = new Map();
  const refillPerMs = perMinute / 60_000;

  // Buckets for idle clients are dropped so the map cannot grow without bound
  // under a stream of distinct source addresses.
  const IDLE_MS = 10 * 60_000;
  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [key, b] of buckets) if (b.last < cutoff) buckets.delete(key);
  }, 60_000);
  sweep.unref?.();

  return {
    name,
    /** @returns {{allowed: boolean, retryAfter: number, remaining: number}} */
    take(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, last: now };
        buckets.set(key, b);
      }
      b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
      b.last = now;

      if (b.tokens < 1) {
        return {
          allowed: false,
          retryAfter: Math.ceil((1 - b.tokens) / refillPerMs / 1000),
          remaining: 0,
        };
      }
      b.tokens -= 1;
      return { allowed: true, retryAfter: 0, remaining: Math.floor(b.tokens) };
    },
    size() { return buckets.size; },
  };
}

/**
 * Express middleware. `identify` is passed in rather than imported so that a
 * signed-in user is limited as a user and an anonymous one as an address --
 * otherwise everyone behind one NAT shares a bucket.
 */
function rateLimit(limiter, identify) {
  return (req, res, next) => {
    const { allowed, retryAfter, remaining } = limiter.take(identify(req));
    res.set("X-RateLimit-Remaining", String(remaining));
    if (allowed) return next();

    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: "too many requests",
      detail: `This endpoint is limited. Try again in ${retryAfter}s.`,
      retry_after_seconds: retryAfter,
    });
  };
}

module.exports = { createLimiter, rateLimit };
