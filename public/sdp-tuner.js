/* ═══════════════════════════════════════════════════════════════════════════
   SDP tuning — the low-bandwidth edits that cannot be expressed via the JS API.

   Kept in its own file, with a dual browser/Node export, so the text
   manipulation can be unit-tested outside a browser (see test/sdp.test.js).
   SDP munging is exactly the kind of code that silently half-works, so it is
   worth testing rather than eyeballing.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

(function (root) {

  /** Split an SDP into { head, sections: [{ kind, lines }] } for safe editing. */
  function parseSdp(sdp) {
    const lines = sdp.split(/\r\n|\n/);
    const head = [];
    const sections = [];
    let cur = null;
    for (const line of lines) {
      if (line.startsWith('m=')) {
        cur = { kind: line.slice(2).split(' ')[0], lines: [line] };
        sections.push(cur);
      } else if (cur) {
        cur.lines.push(line);
      } else {
        head.push(line);
      }
    }
    return { head, sections };
  }

  function serializeSdp({ head, sections }) {
    const out = [...head];
    for (const s of sections) out.push(...s.lines);
    return out.filter((l) => l.length > 0).join('\r\n') + '\r\n';
  }

  /** Payload types in a section whose rtpmap name matches `name`. */
  function payloadTypesFor(section, name) {
    // Escape regex metacharacters — "flexfec-03" is fine but be safe.
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^a=rtpmap:(\\d+) ${safe}/`, 'i');
    const pts = [];
    for (const line of section.lines) {
      const m = line.match(re);
      if (m) pts.push(m[1]);
    }
    return pts;
  }

  /**
   * Remove a codec entirely from a media section: drop its payload type from
   * the m= line and delete its rtpmap / fmtp / rtcp-fb lines. Any rtx entry
   * whose `apt=` points at a removed payload type goes too, otherwise we would
   * leave a retransmission stream pointing at a codec that no longer exists.
   */
  function removeCodec(section, name) {
    const pts = payloadTypesFor(section, name);
    if (pts.length === 0) return 0;

    const doomed = new Set(pts);
    // Iterate to a fixed point in case of chained apt references.
    let grew = true;
    while (grew) {
      grew = false;
      for (const line of section.lines) {
        const m = line.match(/^a=fmtp:(\d+) apt=(\d+)\s*$/);
        if (m && doomed.has(m[2]) && !doomed.has(m[1])) {
          doomed.add(m[1]);
          grew = true;
        }
      }
    }

    // Rewrite the m= line's payload list. Tokens 0-2 are
    // "m=audio", port, proto — never payload types.
    section.lines[0] = section.lines[0]
      .split(' ')
      .filter((tok, i) => i < 3 || !doomed.has(tok))
      .join(' ');

    section.lines = section.lines.filter((line, i) => {
      if (i === 0) return true;
      const m = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)(?:[\s]|$)/);
      return !(m && doomed.has(m[1]));
    });

    return pts.length;
  }

  /** Merge key=value params into the a=fmtp line for payload type `pt`. */
  function upsertFmtp(section, pt, params) {
    const prefix = `a=fmtp:${pt} `;
    const idx = section.lines.findIndex((l) => l.startsWith(prefix));
    const merged = new Map();

    if (idx !== -1) {
      for (const part of section.lines[idx].slice(prefix.length).split(';')) {
        const t = part.trim();
        if (!t) continue;
        const eq = t.indexOf('=');
        if (eq === -1) merged.set(t, null);
        else merged.set(t.slice(0, eq), t.slice(eq + 1));
      }
    }
    for (const [k, v] of Object.entries(params)) merged.set(k, String(v));

    const line = prefix + [...merged.entries()]
      .map(([k, v]) => (v === null ? k : `${k}=${v}`))
      .join(';');

    if (idx !== -1) {
      section.lines[idx] = line;
    } else {
      // Insert right after the matching rtpmap so the SDP stays readable.
      const rIdx = section.lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
      section.lines.splice(rIdx === -1 ? section.lines.length : rIdx + 1, 0, line);
    }
  }

  /**
   * Set a session-level bandwidth limit on a media section: `b=AS:<kbps>`.
   *
   * This matters more than it looks. `sender.setParameters({maxBitrate})` caps
   * the ENCODER, but not the transport — Chrome's bandwidth estimator keeps
   * probing for spare capacity and sends padding packets to do it. Measured on a
   * loopback connection, a 15 kbps AV1 stream carried 74 kbps of RTP header and
   * padding: five times the payload. `b=AS:` is a limit the congestion
   * controller itself respects, so it bounds the total including padding.
   *
   * SDP line order is significant: b= must come after c= and before any a=.
   */
  function setBandwidth(section, kbps) {
    const line = `b=AS:${Math.round(kbps)}`;
    const existing = section.lines.findIndex((l) => l.startsWith('b=AS:'));
    if (existing !== -1) {
      section.lines[existing] = line;
      return;
    }
    // Insert after c= if present, else immediately after the m= line.
    let at = section.lines.findIndex((l) => l.startsWith('c='));
    at = at === -1 ? 1 : at + 1;
    // Skip any b= lines already there (b=TIAS etc.) to keep them grouped.
    while (at < section.lines.length && section.lines[at].startsWith('b=')) at++;
    section.lines.splice(at, 0, line);
  }

  /** Replace or append a plain attribute line (a=ptime:60 etc.). */
  function setAttribute(section, name, value) {
    const prefix = `a=${name}:`;
    const line = `${prefix}${value}`;
    const idx = section.lines.findIndex((l) => l.startsWith(prefix));
    if (idx !== -1) section.lines[idx] = line;
    else section.lines.push(line);
  }

  /**
   * Apply every low-bandwidth SDP edit.
   *
   * Called on BOTH our offers and our answers, because fmtp parameters are
   * directional: the values we send describe what we want to receive. Both
   * sides must munge for both directions to benefit.
   *
   * @param {string} sdp
   * @param {{audioKbps:number, audioPtimeMs:number,
   *          videoKbps:{min:number,max:number}}} cfg
   * @param {(msg:string)=>void} [log]
   */
  function tuneSdpForLowBandwidth(sdp, cfg, log) {
    const parsed = parseSdp(sdp);
    let removedAudioRed = 0;
    let removedVideoFec = 0;
    let removedRtx = 0;
    let opusTuned = 0;

    for (const section of parsed.sections) {
      if (section.kind === 'audio') {

        // ── Strip Opus RED ──
        // Chrome negotiates red/48000/2, where every packet carries a copy of
        // the previous payload. Genuine loss protection, but it can roughly
        // double audio bytes. At a 12 kbps audio budget that is unaffordable;
        // Opus in-band FEC (enabled below) gives most of the benefit for a few
        // percent instead of 100%.
        removedAudioRed += removeCodec(section, 'red');

        for (const pt of payloadTypesFor(section, 'opus')) {
          opusTuned++;
          upsertFmtp(section, pt, {
            // ── Bitrate ──
            maxaveragebitrate: cfg.audioKbps * 1000,
            // Variable rate: quiet passages genuinely cost less. cbr=1 would
            // pad every frame out to full size.
            cbr: 0,

            // ── DTX: discontinuous transmission ──
            // During silence Opus sends a ~2-byte "still quiet" frame every
            // 400 ms instead of a full packet every 60 ms. Each person in a
            // two-way conversation is silent well over half the time, so this
            // cuts average audio cost by roughly 40% on its own.
            usedtx: 1,

            // ── Resilience that is nearly free ──
            // In-band FEC embeds a low-bitrate copy of the previous frame in
            // the current packet, so an isolated loss is recoverable with no
            // extra packets sent.
            useinbandfec: 1,

            // ── Channels and bandwidth ──
            // Mono: stereo would spend bits on an image a phone speaker cannot
            // reproduce.
            stereo: 0,
            'sprop-stereo': 0,
            // Wideband ceiling. Full-band Opus spends bits on 16-20 kHz
            // content that carries no speech information.
            maxplaybackrate: 16000,
            'sprop-maxcapturerate': 16000,

            minptime: 10,
          });
        }

        // ── Packet size: the overlooked win ──
        // Default Opus framing is 20 ms → 50 packets/s. Each packet costs 28 B
        // of IPv4+UDP header plus 12 B of RTP, so at 50 pps headers alone are
        // ~16 kbps — more than the entire audio budget. At 60 ms framing that
        // falls to ~17 pps and ~5.4 kbps. Cost: +40 ms latency, imperceptible
        // on a personal call.
        setAttribute(section, 'ptime', cfg.audioPtimeMs);
        setAttribute(section, 'maxptime', Math.max(120, cfg.audioPtimeMs * 2));

        // Audio ceiling: the codec rate plus room for RTP/RTCP overhead. Opus
        // will normally sit far below this thanks to DTX.
        setBandwidth(section, Math.max(24, cfg.audioKbps * 2));

      } else if (section.kind === 'video') {
        // Video FEC sends redundant repair packets continuously. At ~20 kbps
        // that overhead is unaffordable. rtx (retransmit on request) is kept
        // deliberately — it only costs bytes when a packet is actually lost.
        removedVideoFec += removeCodec(section, 'ulpfec');
        removedVideoFec += removeCodec(section, 'flexfec-03');
        removedVideoFec += removeCodec(section, 'red');

        // Hard transport ceiling for video, a little above the governor's own
        // maximum so it still has room to manoeuvre underneath. Without this the
        // congestion controller's probing padding blows the data budget while
        // the governor, seeing the bytes, starves the encoder for nothing.
        // Skipped rather than fatal if no range was supplied — a missing config
        // field must not break negotiation outright.
        if (cfg.videoKbps && typeof cfg.videoKbps.max === 'number') {
          setBandwidth(section, Math.round(cfg.videoKbps.max * 1.25));
        }

        // ── Drop retransmission (ON by default) ──
        // Chrome uses RTX packets as the vehicle for congestion-probe padding.
        // Measured back-to-back on identical content, removing rtx cut total
        // upload from 96.9 kbps to 37.4 kbps — the padding, not the picture, was
        // the dominant cost.
        //
        // The tradeoff is real: without rtx a lost video packet is not
        // retransmitted, so the picture smears until the next keyframe instead
        // of being repaired. Audio is unaffected — Opus in-band FEC handles its
        // own losses. For a data-capped call this is the right default, but
        // ?rtx=1 restores it if loss hurts more than the bytes are worth.
        if (cfg.dropRtx) {
          removedRtx += removeCodec(section, 'rtx');
        }
      }
    }

    if (log) {
      log(`[sdp] opus×${opusTuned} @ ${cfg.audioKbps}kbps ptime=${cfg.audioPtimeMs}ms dtx=on; ` +
          `stripped ${removedAudioRed} audio-RED, ${removedVideoFec} video-FEC` +
          (removedRtx ? `, ${removedRtx} rtx (padding suppression)` : ''));
    }

    return serializeSdp(parsed);
  }

  const api = {
    parseSdp,
    serializeSdp,
    payloadTypesFor,
    removeCodec,
    upsertFmtp,
    setAttribute,
    setBandwidth,
    tuneSdpForLowBandwidth,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SdpTuner = api;

})(typeof self !== 'undefined' ? self : globalThis);
