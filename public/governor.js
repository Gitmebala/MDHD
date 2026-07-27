/* ═══════════════════════════════════════════════════════════════════════════
   The budget governor — pure math, no DOM, no WebRTC.

   Extracted so the central claim of this app ("it will not exceed N MB/hour")
   can be tested numerically against simulated call traces rather than trusted.
   See test/governor.test.js.

   HOW IT WORKS
   ------------
   A fixed bitrate cap cannot guarantee an hourly total, because the real cost
   depends on audio activity, packet headers, RTCP, and how much the peer sends.
   So we close the loop on the measured billed byte count instead:

     targetCombined = budget converted to kbps
     allowance      = budget prorated over elapsed time
     debt           = actualBytes - allowance
     correction     = -debt spread over CORRECTION_WINDOW seconds
     videoCap       = (targetSend + correction) - measuredNonVideoOverhead

   Because `debt` is derived from bytes that were actually observed on the wire,
   every cost we do not model explicitly is absorbed automatically.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

(function (root) {

  // 1 MB/hr == 1e6 bytes * 8 bits / 3600 s == 2.2222 kbps.
  const KBPS_PER_MB_PER_HOUR = 1e6 * 8 / 3600 / 1000;

  /** Debt is repaid over this many seconds. Longer = smoother picture. */
  const CORRECTION_WINDOW_S = 60;

  /** Ignore the first few seconds: ICE/DTLS setup skews the average. */
  const SETTLE_S = 4;

  /** Exponential smoothing on the cap, so the picture does not pulse. */
  const SMOOTHING = 0.7;

  const mbPerHourToKbps = (mb) => mb * KBPS_PER_MB_PER_HOUR;
  const kbpsToMbPerHour = (kbps) => kbps / KBPS_PER_MB_PER_HOUR;

  /**
   * Decide the video bitrate cap for this tick.
   *
   * @param {object} input
   * @param {number} input.budgetMbPerHour  Total billed budget: up + down, both people.
   * @param {number} input.elapsedS         Seconds since the call connected.
   * @param {number} input.billedBytes      Cumulative billed bytes (both directions,
   *                                        including IP/UDP header bytes).
   * @param {number} input.sendKbps         Measured total upload rate.
   * @param {number} input.videoSendKbps    Measured video-only upload rate.
   * @param {number} input.recvKbps         Measured total download rate.
   * @param {number} input.prevCapKbps      Cap we applied last tick (0 if none).
   * @param {{min:number,max:number}} input.videoKbps  Allowed cap range.
   * @param {boolean} [input.videoIdle]     True if camera off or peer's screen off.
   * @returns {{capKbps:number, hold:boolean, debtBytes:number,
   *            targetSendKbps:number, askPeerToCapAtKbps:number|null}}
   */
  function computeVideoCap(input) {
    const {
      budgetMbPerHour, elapsedS, billedBytes,
      sendKbps, videoSendKbps, recvKbps,
      prevCapKbps, videoKbps, videoIdle = false,
    } = input;

    const targetCombinedKbps = mbPerHourToKbps(budgetMbPerHour);
    // We only control our own upload. Assume a symmetric call: our fair share
    // is half of the combined budget.
    const targetSendKbps = targetCombinedKbps / 2;

    // Not enough history to judge: hold whatever we have.
    if (elapsedS < SETTLE_S) {
      return {
        capKbps: prevCapKbps || Math.round((videoKbps.min + videoKbps.max) / 2),
        hold: true,
        debtBytes: 0,
        targetSendKbps,
        askPeerToCapAtKbps: null,
      };
    }

    const allowedBytes = (budgetMbPerHour * 1e6) * (elapsedS / 3600);
    const debtBytes = billedBytes - allowedBytes;

    // Spread repayment across the correction window, and take our half of it.
    const correctionKbps = -((debtBytes * 8) / 1000) / CORRECTION_WINDOW_S / 2;
    const desiredSendKbps = targetSendKbps + correctionKbps;

    // Whatever our upload costs that is NOT video — audio, RTCP, STUN consent
    // checks, and every packet header. Measured, not modelled.
    const nonVideoKbps = Math.max(0, sendKbps - videoSendKbps);

    let cap = desiredSendKbps - nonVideoKbps;
    cap = Math.max(videoKbps.min, Math.min(videoKbps.max, cap));

    let smoothed = prevCapKbps
      ? prevCapKbps * SMOOTHING + cap * (1 - SMOOTHING)
      : cap;

    // Snap when we are within rounding distance of the target. Without this the
    // filter stalls one step short: with prev=41 and target=42, the blend gives
    // 41.3, which rounds back to 41 forever — so the top and bottom 1 kbps of
    // the configured range would be unreachable.
    if (Math.abs(cap - smoothed) < 1) smoothed = cap;

    const capKbps = videoIdle ? videoKbps.min : Math.round(smoothed);

    // If the peer's stream alone is busting our half of the budget, lowering our
    // own upload cannot fix it — we have to ask them to ease off. Both ends run
    // this code, so their governor honours the request.
    const askPeerToCapAtKbps = recvKbps > targetSendKbps * 1.3
      ? Math.round(targetSendKbps)
      : null;

    return { capKbps, hold: false, debtBytes, targetSendKbps, askPeerToCapAtKbps };
  }

  const api = {
    KBPS_PER_MB_PER_HOUR,
    CORRECTION_WINDOW_S,
    SETTLE_S,
    mbPerHourToKbps,
    kbpsToMbPerHour,
    computeVideoCap,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Governor = api;

})(typeof self !== 'undefined' ? self : globalThis);
