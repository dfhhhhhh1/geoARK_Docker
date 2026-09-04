/**
 * Tests for the access-control layer: sessions, rate limiting, the work queue.
 *
 * These guard a boundary that is exposed to the internet, so the cases that
 * matter are the negative ones -- a forged signature, an expired session, a
 * bucket that refills too fast, a queue that runs an abandoned job.
 *
 * Run: node backend/test_access.js
 */

const assert = require("node:assert");

// Auth reads its configuration at require() time, so it must be set first.
process.env.ACCESS_CODE = "test-code-one,test-code-two";
process.env.SESSION_SECRET = "unit-test-secret";
process.env.SESSION_TTL_HOURS = "1";

const auth = require("./auth");
const { createLimiter } = require("./ratelimit");
const { createQueue, QueueFullError } = require("./queue");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ------------------------------------------------------------------ auth
  await test("a freshly issued token verifies", () => {
    const claims = auth.verifyToken(auth.issueToken("alice"));
    assert.strictEqual(claims.sub, "alice");
  });

  await test("a tampered payload is rejected", () => {
    const token = auth.issueToken("alice");
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({
      sub: "admin", exp: Date.now() + 3600_000,
    })).toString("base64url");
    // Same signature, different claims -- the classic forgery.
    assert.strictEqual(auth.verifyToken(`${forged}.${mac}`), null);
    assert.ok(auth.verifyToken(`${payload}.${mac}`), "the untampered token should still pass");
  });

  await test("a token with a garbage signature is rejected", () => {
    const [payload] = auth.issueToken("alice").split(".");
    assert.strictEqual(auth.verifyToken(`${payload}.not-a-real-mac`), null);
  });

  await test("an expired token is rejected", () => {
    const expired = Buffer.from(JSON.stringify({
      sub: "alice", exp: Date.now() - 1000,
    })).toString("base64url");
    const crypto = require("crypto");
    const mac = crypto.createHmac("sha256", "unit-test-secret")
      .update(expired).digest("base64url");
    assert.strictEqual(auth.verifyToken(`${expired}.${mac}`), null);
  });

  await test("malformed input does not throw", () => {
    for (const bad of [null, undefined, "", "no-dot", ".", "a.b.c", 42, {}]) {
      assert.strictEqual(auth.verifyToken(bad), null, `threw or accepted: ${String(bad)}`);
    }
  });

  await test("every configured access code is accepted, others are not", () => {
    assert.ok(auth.checkCode("test-code-one"));
    assert.ok(auth.checkCode("test-code-two"));
    assert.ok(!auth.checkCode("test-code-thre"));   // shorter
    assert.ok(!auth.checkCode("test-code-onex"));   // longer
    assert.ok(!auth.checkCode(""));
    assert.ok(!auth.checkCode(null));
  });

  await test("cookies are parsed out of a realistic header", () => {
    const req = { headers: { cookie: "other=1; geoark_session=abc%3Ddef; x=2" } };
    assert.strictEqual(auth.readCookie(req, "geoark_session"), "abc=def");
    assert.strictEqual(auth.readCookie(req, "absent"), null);
    assert.strictEqual(auth.readCookie({ headers: {} }, "geoark_session"), null);
  });

  await test("requireAuth blocks an anonymous request when codes are configured", () => {
    let status = null, body = null;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; } };
    auth.requireAuth({ headers: {} }, res, () => { throw new Error("should not pass"); });
    assert.strictEqual(status, 401);
    assert.strictEqual(body.auth_required, true);
  });

  await test("requireAuth admits a request carrying a valid session", () => {
    let passed = false;
    const req = { headers: { cookie: `geoark_session=${auth.issueToken("alice")}` } };
    auth.requireAuth(req, {}, () => { passed = true; });
    assert.ok(passed);
  });

  await test("identity is the session when present, the address otherwise", () => {
    const anon = auth.identify({ headers: {}, ip: "203.0.113.7" });
    assert.strictEqual(anon, "ip:203.0.113.7");
    const signed = auth.identify({
      headers: { cookie: `geoark_session=${auth.issueToken("alice")}` }, ip: "203.0.113.7",
    });
    assert.strictEqual(signed, "s:alice");
  });

  // ------------------------------------------------------------ rate limit
  await test("a bucket allows its burst then refuses", () => {
    const l = createLimiter({ name: "t", capacity: 3, perMinute: 60 });
    assert.ok(l.take("k").allowed);
    assert.ok(l.take("k").allowed);
    assert.ok(l.take("k").allowed);
    const denied = l.take("k");
    assert.ok(!denied.allowed);
    assert.ok(denied.retryAfter >= 0);
  });

  await test("buckets are per identity", () => {
    const l = createLimiter({ name: "t", capacity: 1, perMinute: 60 });
    assert.ok(l.take("alice").allowed);
    assert.ok(!l.take("alice").allowed);
    assert.ok(l.take("bob").allowed, "bob must not inherit alice's exhaustion");
  });

  await test("a bucket refills over time", async () => {
    // 600/min = 10/s, so ~120ms should return one token.
    const l = createLimiter({ name: "t", capacity: 1, perMinute: 600 });
    assert.ok(l.take("k").allowed);
    assert.ok(!l.take("k").allowed);
    await sleep(150);
    assert.ok(l.take("k").allowed, "the bucket did not refill");
  });

  // ----------------------------------------------------------------- queue
  await test("concurrency 1 serializes overlapping work", async () => {
    const q = createQueue({ concurrency: 1 });
    let active = 0, peak = 0;
    const job = async () => {
      active++; peak = Math.max(peak, active);
      await sleep(20);
      active--;
    };
    await Promise.all([q.submit(job), q.submit(job), q.submit(job)]);
    assert.strictEqual(peak, 1, `two jobs ran at once (peak ${peak})`);
  });

  await test("waiting jobs are told their position", async () => {
    const q = createQueue({ concurrency: 1 });
    const seen = [];
    const slow = () => sleep(30);
    const p1 = q.submit(slow);
    const p2 = q.submit(slow, { onPosition: (pos) => seen.push(pos) });
    await Promise.all([p1, p2]);
    assert.ok(seen.length > 0, "a queued job was never given a position");
    assert.ok(seen.includes(1), `expected to reach position 1, saw ${seen}`);
  });

  await test("an abandoned job never runs", async () => {
    const q = createQueue({ concurrency: 1 });
    let ran = false;
    const blocker = q.submit(() => sleep(40));
    // Queued behind the blocker, and gone by the time it reaches the front.
    const abandoned = q.submit(async () => { ran = true; }, { isAbandoned: () => true });
    await blocker;
    await sleep(60);
    assert.ok(!ran, "an abandoned job consumed the GPU anyway");
    // The promise stays pending by design -- nobody is listening for it.
    void abandoned;
  });

  await test("a full queue is refused rather than growing without bound", async () => {
    const q = createQueue({ concurrency: 1, maxDepth: 2 });
    const slow = () => sleep(40);
    q.submit(slow);                       // runs
    q.submit(slow);                       // waits (1)
    q.submit(slow);                       // waits (2)
    await assert.rejects(() => q.submit(slow), QueueFullError);
  });

  await test("a failing job releases its slot", async () => {
    const q = createQueue({ concurrency: 1 });
    await assert.rejects(() => q.submit(async () => { throw new Error("boom"); }));
    const after = await q.submit(async () => "recovered");
    assert.strictEqual(after, "recovered", "the queue stalled after a failure");
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
