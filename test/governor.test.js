/**
 * Governor tests.
 *
 * The point of these is to check the app's central promise — "will not exceed
 * N MB/hour" — by simulating full calls in closed loop rather than trusting the
 * arithmetic by inspection.
 *
 *   node --test test/governor.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/governor.js');

const SAVER = { budgetMbPerHour: 30, videoKbps: { min: 10, max: 42 }, audioKbps: 12 };

/* ───────────────────────────── unit conversions ──────────────────────────── */

test('MB/hr <-> kbps conversion is exact', () => {
  // 30 MB/hr = 30e6 bytes * 8 / 3600 s = 66666.7 bits/s = 66.67 kbps
  assert.ok(Math.abs(G.mbPerHourToKbps(30) - 66.6667) < 0.001);
  assert.ok(Math.abs(G.kbpsToMbPerHour(66.6667) - 30) < 0.001);
  // Round trip
  for (const mb of [10, 20, 30, 45, 90]) {
    assert.ok(Math.abs(G.kbpsToMbPerHour(G.mbPerHourToKbps(mb)) - mb) < 1e-9);
  }
});

/* ───────────────────────────── behaviour ─────────────────────────────────── */

test('holds the starting cap during the settle period', () => {
  const r = G.computeVideoCap({
    ...SAVER, elapsedS: 2, billedBytes: 0,
    sendKbps: 0, videoSendKbps: 0, recvKbps: 0, prevCapKbps: 26,
  });
  assert.equal(r.hold, true);
  assert.equal(r.capKbps, 26);
});

test('tightens video when over budget', () => {
  // 60 s elapsed, but we have already spent 90 s worth of allowance.
  const allowance = 30e6 * (60 / 3600);
  const r = G.computeVideoCap({
    ...SAVER, elapsedS: 60, billedBytes: allowance * 1.5,
    sendKbps: 50, videoSendKbps: 38, recvKbps: 50, prevCapKbps: 38,
  });
  assert.ok(r.debtBytes > 0, 'should be in debt');
  assert.ok(r.capKbps < 38, `cap should drop from 38, got ${r.capKbps}`);
});

test('relaxes video when under budget', () => {
  const allowance = 30e6 * (60 / 3600);
  const r = G.computeVideoCap({
    ...SAVER, elapsedS: 60, billedBytes: allowance * 0.4,
    sendKbps: 14, videoSendKbps: 8, recvKbps: 14, prevCapKbps: 12,
  });
  assert.ok(r.debtBytes < 0, 'should be in credit');
  assert.ok(r.capKbps > 12, `cap should rise from 12, got ${r.capKbps}`);
});

test('never leaves the configured cap range', () => {
  const allowance = 30e6 * (300 / 3600);
  // Wildly over budget -> must clamp at min, not go negative.
  const over = G.computeVideoCap({
    ...SAVER, elapsedS: 300, billedBytes: allowance * 20,
    sendKbps: 900, videoSendKbps: 880, recvKbps: 900, prevCapKbps: 10,
  });
  assert.equal(over.capKbps, SAVER.videoKbps.min);

  // Wildly under budget -> must clamp at max, converging over several ticks.
  let cap = SAVER.videoKbps.min;
  for (let i = 0; i < 40; i++) {
    cap = G.computeVideoCap({
      ...SAVER, elapsedS: 300, billedBytes: 0,
      sendKbps: 5, videoSendKbps: 2, recvKbps: 5, prevCapKbps: cap,
    }).capKbps;
  }
  assert.equal(cap, SAVER.videoKbps.max);
});

test('subtracts measured non-video overhead from the video allowance', () => {
  const allowance = 30e6 * (60 / 3600);
  const base = {
    ...SAVER, elapsedS: 60, billedBytes: allowance,
    recvKbps: 33, prevCapKbps: 0,
  };
  // Same total upload, but one case spends more of it on audio/headers.
  const cheapAudio = G.computeVideoCap({ ...base, sendKbps: 33, videoSendKbps: 28 });
  const dearAudio  = G.computeVideoCap({ ...base, sendKbps: 33, videoSendKbps: 15 });
  assert.ok(cheapAudio.capKbps > dearAudio.capKbps,
    'more non-video overhead must leave less room for video');
});

test('asks the peer to cap only when their download busts our half', () => {
  const allowance = 30e6 * (60 / 3600);
  const base = { ...SAVER, elapsedS: 60, billedBytes: allowance, sendKbps: 33, videoSendKbps: 25, prevCapKbps: 25 };

  assert.equal(G.computeVideoCap({ ...base, recvKbps: 33 }).askPeerToCapAtKbps, null);
  const hot = G.computeVideoCap({ ...base, recvKbps: 120 });
  assert.ok(hot.askPeerToCapAtKbps > 0);
  assert.ok(Math.abs(hot.askPeerToCapAtKbps - 33) <= 1, 'should ask for our fair share');
});

test('drops to the floor when nobody can see the video', () => {
  const allowance = 30e6 * (60 / 3600);
  const r = G.computeVideoCap({
    ...SAVER, elapsedS: 60, billedBytes: allowance * 0.2,
    sendKbps: 10, videoSendKbps: 1, recvKbps: 10, prevCapKbps: 40,
    videoIdle: true,
  });
  assert.equal(r.capKbps, SAVER.videoKbps.min);
});

/* ═══════════════════════════════════════════════════════════════════════════
   CLOSED-LOOP SIMULATION — the test that actually matters.

   Simulates an hour-long call at 2 s ticks. Each tick, both peers send at
   whatever the governor last allowed (plus modelled audio and packet-header
   overhead), and the billed byte counter accumulates. If the control loop is
   wrong, the hourly total will drift away from the budget and these fail.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {object} opts
 * @param {number} opts.budgetMbPerHour
 * @param {(tSec:number)=>number} opts.motion  0..1 scene activity over time;
 *   drives how much of the allowed cap the encoder actually spends.
 * @param {number} [opts.audioDutyCycle] Fraction of time this person is talking
 *   (DTX makes silence nearly free).
 */
function simulateCall({ budgetMbPerHour, motion, audioDutyCycle = 0.45,
                        videoKbps = { min: 10, max: 42 }, audioKbps = 12,
                        durationS = 3600, tickS = 2 }) {
  let billedBytes = 0;
  let cap = Math.round((videoKbps.min + videoKbps.max) / 2);
  let sendKbps = 0, videoSendKbps = 0, recvKbps = 0;
  const capHistory = [];

  for (let t = tickS; t <= durationS; t += tickS) {
    const r = G.computeVideoCap({
      budgetMbPerHour, elapsedS: t, billedBytes,
      sendKbps, videoSendKbps, recvKbps,
      prevCapKbps: cap, videoKbps,
    });
    cap = r.capKbps;
    capHistory.push(cap);

    // ── Model what the encoder actually spends this tick ──
    // A real encoder undershoots its cap on a static scene. Motion pushes it to
    // the ceiling.
    const m = motion(t);
    videoSendKbps = cap * (0.35 + 0.65 * m);

    // Audio: DTX means silence costs ~0.4 kbps instead of the full rate.
    const audioActive = audioKbps * audioDutyCycle + 0.4 * (1 - audioDutyCycle);

    // Packet headers: ~15 video pps + ~17 audio pps at ptime=60, 28 B each.
    const headerKbps = (15 + 17) * 28 * 8 / 1000;
    // RTCP + STUN consent freshness.
    const controlKbps = 2;

    sendKbps = videoSendKbps + audioActive + headerKbps + controlKbps;
    // Symmetric call: the peer runs the same governor, so download mirrors us.
    recvKbps = sendKbps;

    billedBytes += ((sendKbps + recvKbps) * 1000 / 8) * tickS;
  }

  const usedMb = billedBytes / 1e6;
  return {
    usedMb,
    mbPerHour: usedMb / (durationS / 3600),
    capMin: Math.min(...capHistory),
    capMax: Math.max(...capHistory),
    capAvg: capHistory.reduce((a, b) => a + b, 0) / capHistory.length,
  };
}

test('SIM: mostly-still talking-head call stays within a 30 MB/hr budget', () => {
  // 95% of a call is sitting and talking, with occasional movement.
  const r = simulateCall({
    budgetMbPerHour: 30,
    motion: (t) => (Math.sin(t / 240) > 0.9 ? 1 : 0.15),
  });
  assert.ok(r.mbPerHour <= 30.5, `used ${r.mbPerHour.toFixed(2)} MB/hr, budget 30`);
  assert.ok(r.mbPerHour > 24, `should USE most of the budget, got ${r.mbPerHour.toFixed(2)}`);
});

test('SIM: constant-maximum-motion call still respects the budget', () => {
  // Worst case: the encoder spends every bit it is allowed, all hour.
  const r = simulateCall({ budgetMbPerHour: 30, motion: () => 1, audioDutyCycle: 1 });
  assert.ok(r.mbPerHour <= 30.5, `used ${r.mbPerHour.toFixed(2)} MB/hr, budget 30`);
});

test('SIM: governor lets quality breathe rather than pinning one bitrate', () => {
  const r = simulateCall({
    budgetMbPerHour: 30,
    motion: (t) => (Math.sin(t / 120) + 1) / 2,   // slow motion sweep
  });
  assert.ok(r.capMax - r.capMin >= 8,
    `cap should vary with scene activity, saw ${r.capMin}-${r.capMax} kbps`);
  assert.ok(r.mbPerHour <= 30.5, `used ${r.mbPerHour.toFixed(2)} MB/hr`);
});

test('SIM: budget is honoured across every preset', () => {
  const presets = [
    { budgetMbPerHour: 20, videoKbps: { min: 8,  max: 28  }, audioKbps: 10 },
    { budgetMbPerHour: 30, videoKbps: { min: 10, max: 42  }, audioKbps: 12 },
    { budgetMbPerHour: 45, videoKbps: { min: 14, max: 70  }, audioKbps: 16 },
    { budgetMbPerHour: 90, videoKbps: { min: 24, max: 160 }, audioKbps: 24 },
  ];
  for (const p of presets) {
    const r = simulateCall({ ...p, motion: () => 0.8 });
    assert.ok(r.mbPerHour <= p.budgetMbPerHour * 1.02,
      `preset ${p.budgetMbPerHour}: used ${r.mbPerHour.toFixed(2)} MB/hr`);
  }
});

test('SIM: a 10-minute call is also within budget, not just a full hour', () => {
  // Short calls are the harder case: there is less time to repay early debt.
  const r = simulateCall({
    budgetMbPerHour: 30, durationS: 600,
    motion: (t) => (t < 60 ? 1 : 0.3),   // lively start, then settles
  });
  assert.ok(r.mbPerHour <= 31, `10-min call used ${r.mbPerHour.toFixed(2)} MB/hr`);
});

test('SIM: recovers the budget after an early overspend', () => {
  // Pretend the first 30 s blew 3x the allowance (bitrate ramp-up, keyframes).
  let billedBytes = 30e6 * (30 / 3600) * 3;
  let cap = 26, sendKbps = 90, videoSendKbps = 80, recvKbps = 90;

  for (let t = 32; t <= 600; t += 2) {
    const r = G.computeVideoCap({
      budgetMbPerHour: 30, elapsedS: t, billedBytes,
      sendKbps, videoSendKbps, recvKbps,
      prevCapKbps: cap, videoKbps: { min: 10, max: 42 },
    });
    cap = r.capKbps;
    videoSendKbps = cap * 0.9;
    sendKbps = videoSendKbps + 6 + 7.2 + 2;
    recvKbps = sendKbps;
    billedBytes += ((sendKbps + recvKbps) * 1000 / 8) * 2;
  }

  const mbPerHour = (billedBytes / 1e6) / (600 / 3600);
  // The early spike is repaid, bringing the 10-minute average back to target.
  assert.ok(mbPerHour <= 31,
    `after overspend, 10-min average was ${mbPerHour.toFixed(2)} MB/hr`);
});
