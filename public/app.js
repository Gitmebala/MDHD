/* ═══════════════════════════════════════════════════════════════════════════
   MDHD — low-data 2-person WebRTC call.

   THE CENTRAL IDEA
   ----------------
   A fixed bitrate cap is the wrong tool. At 50 kbps you waste bits while two
   people sit still (most of a call) and starve when someone moves. Worse, a
   per-direction cap tells you nothing about the number your carrier actually
   bills, which is upload + download, both people, plus IP/UDP headers that
   getStats() does not report.

   So instead we run a closed-loop BUDGET GOVERNOR:
     1. every 2 s, measure the real billed bytes (transport bytes + 28 B/packet)
     2. compare cumulative usage against the allowance for the elapsed time
     3. retune the video sender's maxBitrate to erase any debt over the next 60 s

   The result is a hard guarantee on MB/hour with quality floating underneath:
   ~40 kbps during motion, ~10 kbps when the picture is static. It also holds if
   AV1 negotiation fails — on VP8 you get a softer picture at the same budget
   rather than a blown budget.

   The supporting savings, in rough order of impact:
     · P2P, never relayed         — halves bytes vs. a TURN relay
     · AV1                        — 30-50% better than VP9 at these bitrates
     · Opus DTX                   — silence costs ~0.4 kbps instead of 12
     · ptime=60                   — 17 packets/s instead of 50; saves ~10 kbps
                                    of pure IP/UDP header overhead
     · strip Opus RED + video FEC — Chrome's redundancy can double audio bytes
     · maintain-resolution        — drops fps under pressure, keeps 480p
     · peer-screen-off detection  — stop encoding when nobody can see us
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/* ───────────────────────────── Configuration ───────────────────────────── */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  // max-bundle puts audio + video on ONE port/transport. Fewer ICE candidate
  // pairs to keep alive, one DTLS handshake, one set of STUN consent checks.
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceCandidatePoolSize: 2,
};

/**
 * Presets. `budgetMbPerHour` is the TOTAL billed figure: upload + download,
 * both people combined. That is what shows up on your phone bill.
 *
 * `videoKbps` is the range the governor is allowed to move the video cap
 * within — it is not a fixed target.
 */
const PRESETS = {
  featherweight: {
    label: 'Featherweight — 20 MB/hr (360p)',
    budgetMbPerHour: 20,
    shortSide: 360, fps: 12,
    audioKbps: 10, audioPtimeMs: 60,
    videoKbps: { min: 10, max: 34 },
  },
  saver: {
    // DEFAULT. Ranges widened from the original 10-42 after real-call feedback
    // that AV1 at the bottom of that range looked blurry/blocky and laggy on a
    // real mobile link. The governor still closes the loop on the SAME
    // budgetMbPerHour average over the call — this only widens how far it is
    // allowed to swing above the floor, not the hourly target.
    label: 'Saver — 30 MB/hr (480p15)',
    budgetMbPerHour: 30,
    shortSide: 480, fps: 15,
    audioKbps: 12, audioPtimeMs: 60,
    videoKbps: { min: 14, max: 55 },
  },
  balanced: {
    label: 'Balanced — 45 MB/hr (480p15)',
    budgetMbPerHour: 45,
    shortSide: 480, fps: 15,
    audioKbps: 16, audioPtimeMs: 40,
    videoKbps: { min: 18, max: 85 },
  },
  sharp: {
    label: 'Sharp — 90 MB/hr (480p15)',
    budgetMbPerHour: 90,
    shortSide: 480, fps: 15,
    audioKbps: 24, audioPtimeMs: 20,
    videoKbps: { min: 28, max: 170 },
  },
};

const DEFAULT_PRESET = 'saver';

const STATS_INTERVAL_MS = 2000;
// Rolling window for the "right now" bitrate readout.
const RATE_WINDOW_MS = 30000;
// How long to tolerate 'disconnected' before forcing an ICE restart.
const ICE_RESTART_DELAY_MS = 6000;

/* ───────────────────────────── Element handles ──────────────────────────── */

const $ = (id) => document.getElementById(id);

const el = {
  joinScreen: $('join-screen'),
  callScreen: $('call-screen'),
  roomInput: $('room-input'),
  joinPreset: $('join-preset'),
  joinBtn: $('join-btn'),
  joinBtnLabel: $('join-btn-label'),
  joinStatus: $('join-status'),
  joinTitle: $('join-title'),
  joinTagline: $('join-tagline'),
  installBtn: $('install-btn'),
  installFallback: $('install-fallback'),
  bouquet: $('bouquet'),
  petals: document.querySelector('.petals'),

  remoteVideo: $('remote-video'),
  localVideo: $('local-video'),
  unmuteOverlay: $('unmute-overlay'),
  callStatus: $('call-status'),
  callStatusText: $('call-status-text'),

  meterToggle: $('meter-toggle'),
  meterBody: $('meter-body'),
  headline: $('meter-headline'),
  codecChip: $('meter-codec'),
  mTotal: $('m-total'),
  mAvg: $('m-avg'),
  mUp: $('m-up'),
  mDown: $('m-down'),
  mRes: $('m-res'),
  mCap: $('m-cap'),
  mAudio: $('m-audio'),
  mLoss: $('m-loss'),
  budgetFill: $('budget-fill'),
  mNote: $('m-note'),

  presetSelect: $('preset-select'),
  btnMic: $('btn-mic'),
  btnCam: $('btn-cam'),
  btnFlip: $('btn-flip'),
  btnEnd: $('btn-end'),
};

/* ═══════════════════════════════════════════════════════════════════════════
   ROLES AND COPY

   Two views of the same app:
     guest — her phone. Soft, minimal, no numbers at all.
     host  — your phone. The full data meter and the budget control.

   How your phone becomes the host: open the app once with `?me=1` and the role
   is remembered in localStorage on that device. If you ever need to undo it (or
   set it up on a new phone without editing the URL), triple-tap the bouquet.
   ═══════════════════════════════════════════════════════════════════════════ */

const ROLE_KEY = 'mdhd.role';

function detectRole() {
  const params = new URLSearchParams(location.search);
  if (params.has('me') || params.has('host')) {
    localStorage.setItem(ROLE_KEY, 'host');
  } else if (params.has('her') || params.has('guest')) {
    localStorage.setItem(ROLE_KEY, 'guest');
  }
  return localStorage.getItem(ROLE_KEY) === 'host' ? 'host' : 'guest';
}

/**
 * Pet names, used in place of generic "him"/"her" pronouns so each side feels
 * written for the two of you specifically rather than a generic template.
 */
const PET_NAME = { host: 'Moonstone', guest: 'Sunstone' };

/**
 * All user-facing text, per role. Hers is warm and short; yours is plain, so
 * the meter stays readable at a glance.
 */
const COPY = {
  guest: {
    title: 'Heyy babyy',
    tagline: 'just us two 💗',
    roomPlaceholder: 'type the room name here babyy',
    joinButton: `call ${PET_NAME.guest}`,
    askingMedia: 'one sec babyy…',
    joining: 'putting you through…',
    accepted: 'good girl 💗',
    waitingForPeer: `waiting for ${PET_NAME.guest} to join, babyy…`,
    connecting: 'connecting you two…',
    reconnecting: 'hold on babyy, one sec…',
    reconnectFailed: `lost ${PET_NAME.guest} 💔 tap the heart to try again`,
    peerLeft: `${PET_NAME.guest} went quiet for a sec 💗 hang tight, babyy…`,
    roomFull: "hmm, that room's busy babyy — check the name?",
    permissionDenied: 'let me see you babyy — allow the camera 💗',
    noDevice: "can't find your camera, babyy",
    notSecure: 'this link needs to start with https, babyy',
    unsupported: "this browser won't work babyy — try Chrome",
    needRoom: 'type the room name first, babyy 💗',
    ended: (mb, mins) => `miss you already, ${PET_NAME.guest} 💗`,
  },
  host: {
    title: 'us',
    tagline: 'private call · budget enforced',
    roomPlaceholder: 'room name',
    joinButton: `call ${PET_NAME.host}`,
    askingMedia: 'requesting camera and mic…',
    joining: 'connecting to signaling…',
    accepted: 'joined',
    waitingForPeer: `waiting for ${PET_NAME.host} to join…`,
    connecting: 'connecting…',
    reconnecting: 'reconnecting…',
    reconnectFailed: 'could not reconnect — end and rejoin',
    peerLeft: `lost ${PET_NAME.host} — waiting for her to rejoin…`,
    roomFull: 'that room already has 2 people.',
    permissionDenied: 'camera/mic permission denied.',
    noDevice: 'no camera or microphone found.',
    notSecure: 'must be served over HTTPS for the camera to work.',
    unsupported: 'this browser does not support WebRTC.',
    needRoom: 'enter a room name — you both need the same one.',
    ended: (mb, mins) => `ended — ${mb} MB in ${mins} min.`,
  },
};

/** The active copy set. Assigned during init(). */
let T = COPY.guest;

/* ───────────────────────────── Mutable state ───────────────────────────── */

const state = {
  role: 'guest',
  socket: null,
  pc: null,
  localStream: null,
  room: null,
  wakeLock: null,
  deferredInstallPrompt: null,

  // Perfect-negotiation bookkeeping (see negotiation section below).
  polite: false,
  makingOffer: false,
  ignoreOffer: false,
  isSettingRemoteAnswerPending: false,

  presetKey: DEFAULT_PRESET,
  facingMode: 'user',

  micOn: true,
  camOn: true,
  peerHidden: false,      // peer's screen is off → skip encoding video
  pendingSignals: [],     // signals that arrived before the PC existed

  // Governor + meter
  videoCapKbps: 0,
  callStartedAt: 0,
  billedBytesTotal: 0,
  rateSamples: [],        // { t, billedBytes, sentBytes, recvBytes }
  prevRaw: null,          // previous getStats() snapshot
  ipHeaderBytes: 28,      // IPv4 + UDP; bumped to 48 if the pair is IPv6
  statsTimer: null,
  iceRestartTimer: null,
  restartAttempts: 0,
  codecTx: '—',
  codecRx: '—',
};

const preset = () => PRESETS[state.presetKey];

/* ═══════════════════════════════════════════════════════════════════════════
   1. CODEC PREFERENCE — AV1 first, then VP9, then VP8
   ═══════════════════════════════════════════════════════════════════════════ */

const VIDEO_CODEC_ORDER = [
  'video/av1',     // modern Chrome / Edge
  'video/av1x',    // legacy Chrome spelling, still seen in the wild
  'video/vp9',
  'video/vp8',
  'video/h264',    // last resort; hardware-accelerated but bit-hungry at 480p
];

/**
 * Reorder the m-section's codec list so our preferred codecs come first.
 *
 * We use RECEIVER capabilities because setCodecPreferences shapes what we
 * ADVERTISE (i.e. what we are willing to receive). Since both ends run this
 * same code, both advertise AV1 first, so both directions land on AV1.
 *
 * Non-media entries (rtx, red, ulpfec) are preserved at the end — dropping rtx
 * would disable retransmission, which we actively want on a mobile link.
 */
function preferVideoCodecs(transceiver) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
  if (!window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;

  const caps = RTCRtpReceiver.getCapabilities('video');
  if (!caps || !caps.codecs) return;

  const rank = (codec) => {
    const i = VIDEO_CODEC_ORDER.indexOf(codec.mimeType.toLowerCase());
    return i === -1 ? VIDEO_CODEC_ORDER.length : i;
  };

  // Stable sort by rank; equal ranks keep the browser's original order.
  const sorted = caps.codecs
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.c);

  try {
    transceiver.setCodecPreferences(sorted);
  } catch (err) {
    console.warn('[codec] setCodecPreferences rejected:', err);
    return;
  }

  const canEncodeAv1 = (RTCRtpSender.getCapabilities('video')?.codecs || [])
    .some((c) => c.mimeType.toLowerCase().startsWith('video/av1'));
  const canDecodeAv1 = caps.codecs
    .some((c) => c.mimeType.toLowerCase().startsWith('video/av1'));

  console.log('[codec] preference order:', sorted.slice(0, 4).map((c) => c.mimeType).join(' > '));
  console.log(`[codec] AV1 encode=${canEncodeAv1} decode=${canDecodeAv1}`);
  if (canDecodeAv1 && !canEncodeAv1) {
    console.warn('[codec] This device can DECODE AV1 but not ENCODE it — we will ' +
                 'send VP9/VP8 and receive AV1. Budget still holds; our picture ' +
                 'will just be softer than theirs.');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. SDP TUNING

   The Opus bitrate / DTX / packet-size edits and the FEC stripping live in
   sdp-tuner.js so they can be unit-tested outside a browser. See that file for
   the reasoning behind each parameter.
   ═══════════════════════════════════════════════════════════════════════════ */

const tuneSdp = (sdp) =>
  SdpTuner.tuneSdpForLowBandwidth(
    sdp,
    // RTX (retransmission) is KEPT by default. It was dropped by default in an
    // earlier build based on a loopback measurement (127.0.0.1 has ~0 real
    // packet loss, so RTX there was only carrying congestion-probe padding).
    // On a real mobile network packets actually get lost, and without RTX a
    // lost video packet is never repaired — it smears and blocks until the next
    // keyframe, which is exactly the "blurry, bad, laggy" picture reported on
    // a real call. Add ?nortx=1 to go back to the more aggressive (and
    // riskier) data-saving mode. See sdp-tuner.js.
    { ...preset(), dropRtx: new URLSearchParams(location.search).has('nortx') },
    (msg) => console.log(msg)
  );

/* ═══════════════════════════════════════════════════════════════════════════
   3. MEDIA CAPTURE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Orientation-aware capture dimensions.
 *
 * getUserMedia's width/height are absolute, not relative to how the phone is
 * held. Requesting a fixed "640 wide x 480 tall" LANDSCAPE frame while the
 * phone is held upright — the near-universal way to hold it for a call —
 * forces the browser to either crop a landscape buffer hard to fit our
 * portrait preview box, or otherwise hand back a picture that looks visibly
 * different from apps (WhatsApp, FaceTime) that request dimensions matching
 * the device's actual orientation. Swapping ideal width/height when portrait
 * fixes this at the capture source instead of fighting it with CSS.
 *
 * This does not change the data budget: the governor's scaleResolutionDownBy
 * math already uses Math.min(width, height) as the "480p" reference, so it
 * treats a 480x640 portrait frame exactly the same as a 640x480 landscape one.
 */
function videoCaptureConstraints(fps) {
  const portrait = window.innerHeight >= window.innerWidth;
  return portrait
    ? { width: { ideal: 480, max: 720 }, height: { ideal: 640, max: 1280 }, frameRate: { ideal: fps, max: fps } }
    : { width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: fps, max: fps } };
}

async function startLocalMedia() {
  const p = preset();

  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      // 16 kHz capture. Often ignored by the browser, but when honoured it
      // avoids resampling work and matches our Opus maxplaybackrate.
      sampleRate: 16000,
    },
    // Capture at 480p (short side) and never higher. Capturing 1080p then
    // downscaling burns battery and gives the encoder noise to waste bits on.
    video: { facingMode: state.facingMode, ...videoCaptureConstraints(p.fps) },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    // contentHint tells the encoder what to protect when bits run short.
    // 'detail' biases toward spatial fidelity (drop frames, keep sharpness),
    // which is what you want for a face. 'motion' would do the opposite.
    videoTrack.contentHint = 'detail';
  }
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) audioTrack.contentHint = 'speech';

  state.localStream = stream;
  el.localVideo.srcObject = stream;
  el.localVideo.classList.toggle('rear', state.facingMode !== 'user');

  const s = videoTrack ? videoTrack.getSettings() : {};
  console.log(`[media] capture ${s.width}x${s.height} @ ${s.frameRate}fps`);

  return stream;
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. SENDER PARAMETERS — the live bitrate levers

   setParameters() applies immediately with NO renegotiation, which is why
   preset switching and the governor never interrupt the call.
   ═══════════════════════════════════════════════════════════════════════════ */

function videoSender() {
  return state.pc?.getSenders().find((s) => s.track?.kind === 'video') || null;
}
function audioSender() {
  return state.pc?.getSenders().find((s) => s.track?.kind === 'audio') || null;
}

async function applyVideoParams(capKbps) {
  const sender = videoSender();
  if (!sender) return;

  const p = preset();
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  const enc = params.encodings[0];

  // ── The cap the governor controls ──
  enc.maxBitrate = Math.round(capKbps * 1000);

  // ── Hold resolution, sacrifice smoothness ──
  // With 'maintain-resolution' the encoder responds to congestion by dropping
  // framerate rather than downscaling, so the picture stays 480p and goes
  // choppy instead of going blurry. This is the explicit tradeoff for keeping
  // 480p at a very low bitrate.
  params.degradationPreference = 'maintain-resolution';

  enc.maxFramerate = p.fps;

  // Downscale from the capture resolution if the preset asks for less than we
  // captured. Doing it here rather than via applyConstraints means it takes
  // effect on the next frame with no camera restart.
  const track = sender.track;
  const st = track ? track.getSettings() : {};
  if (st.width && st.height) {
    const shortSide = Math.min(st.width, st.height);
    enc.scaleResolutionDownBy = Math.max(1, +(shortSide / p.shortSide).toFixed(3));
  }

  try {
    await sender.setParameters(params);
    state.videoCapKbps = capKbps;
  } catch (err) {
    console.warn('[params] video setParameters failed:', err);
  }
}

async function applyAudioParams() {
  const sender = audioSender();
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];

  // Belt and braces alongside the SDP maxaveragebitrate: this one can be
  // changed live, the SDP one cannot.
  params.encodings[0].maxBitrate = preset().audioKbps * 1000;
  // Chrome-only: lets the stack lengthen packets further when the network is
  // constrained, saving more header overhead. Harmless where unsupported.
  params.encodings[0].adaptivePtime = true;

  try {
    await sender.setParameters(params);
  } catch (err) {
    console.warn('[params] audio setParameters failed:', err);
  }
}

/** Switch preset live. No renegotiation, so the call does not drop. */
async function applyPreset(key, { renegotiateAudio = false } = {}) {
  if (!PRESETS[key]) return;
  state.presetKey = key;
  const p = preset();

  el.presetSelect.value = key;
  el.joinPreset.value = key;

  // Start the governor mid-range so it converges from a sensible place.
  const start = Math.round((p.videoKbps.min + p.videoKbps.max) / 2);
  state.videoCapKbps = start;

  if (state.pc) {
    await applyVideoParams(start);
    await applyAudioParams();

    // Framerate is also constrained at the camera so the encoder is not handed
    // frames it will only throw away.
    const track = state.localStream?.getVideoTracks()[0];
    if (track) {
      try {
        await track.applyConstraints({ frameRate: { ideal: p.fps, max: p.fps } });
      } catch { /* some cameras refuse live constraint changes; harmless */ }
    }

    // Tell the peer our budget so both governors aim at the same total.
    state.socket?.emit('peer-state', { budgetMbPerHour: p.budgetMbPerHour });

    // Audio ptime/maxaveragebitrate live in SDP, so changing them needs a
    // renegotiation. Only worth it on an explicit user preset change.
    if (renegotiateAudio && !state.polite) {
      try {
        await negotiate();
      } catch (err) {
        console.warn('[preset] renegotiation failed, audio SDP unchanged:', err);
      }
    }
  }

  console.log(`[preset] ${key}: budget ${p.budgetMbPerHour} MB/hr, ` +
              `${p.shortSide}p@${p.fps}, video ${p.videoKbps.min}-${p.videoKbps.max} kbps, ` +
              `audio ${p.audioKbps} kbps`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. PEER CONNECTION + PERFECT NEGOTIATION

   The "perfect negotiation" pattern lets either side start a renegotiation at
   any time without glare. The server assigns polite/impolite roles: the polite
   peer rolls back on collision, the impolite peer ploughs on. This is what
   makes ICE restart safe to trigger from either end.
   ═══════════════════════════════════════════════════════════════════════════ */

function createPeerConnection() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.pc = pc;

  // Explicit transceivers, audio first, in the same order on both ends so the
  // m-line mapping is deterministic.
  const audioTrack = state.localStream.getAudioTracks()[0];
  const videoTrack = state.localStream.getVideoTracks()[0];

  if (audioTrack) pc.addTransceiver(audioTrack, { direction: 'sendrecv', streams: [state.localStream] });
  const videoTx = videoTrack
    ? pc.addTransceiver(videoTrack, { direction: 'sendrecv', streams: [state.localStream] })
    : null;

  if (videoTx) preferVideoCodecs(videoTx);

  pc.ontrack = ({ track, streams }) => {
    console.log(`[pc] remote ${track.kind} track`);
    if (el.remoteVideo.srcObject !== streams[0]) {
      el.remoteVideo.srcObject = streams[0];
      attemptRemotePlayback();
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit('signal', { candidate });
  };

  pc.onnegotiationneeded = async () => {
    try {
      await negotiate();
    } catch (err) {
      console.error('[pc] negotiationneeded failed:', err);
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[pc] connectionState =', s);

    if (s === 'connected') {
      state.restartAttempts = 0;
      clearTimeout(state.iceRestartTimer);
      setCallStatus(null);
      logNegotiatedCodec();
    } else if (s === 'disconnected') {
      // Do NOT tear down. A phone switching Wi-Fi→LTE, or a brief screen lock,
      // shows up as 'disconnected' and very often recovers on its own.
      setCallStatus(T.reconnecting);
      scheduleIceRestart(ICE_RESTART_DELAY_MS);
    } else if (s === 'failed') {
      setCallStatus(T.reconnecting);
      scheduleIceRestart(0);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[pc] iceConnectionState =', pc.iceConnectionState);
  };

  return pc;
}

/** Create and send an offer, applying our SDP tuning on the way out. */
async function negotiate() {
  const pc = state.pc;
  if (!pc) return;
  try {
    state.makingOffer = true;
    const offer = await pc.createOffer();
    offer.sdp = tuneSdp(offer.sdp);
    // Guard against a state change while we were awaiting createOffer.
    if (pc.signalingState !== 'stable') return;
    await pc.setLocalDescription(offer);
    state.socket.emit('signal', { description: pc.localDescription });
  } finally {
    state.makingOffer = false;
  }
}

async function handleSignal(payload) {
  const pc = state.pc;

  // A signal can legitimately arrive before we have built our peer connection —
  // the other side may start offering the instant they learn we exist. Dropping
  // it deadlocks the call: they wait for an answer that will never come, and our
  // own later offer gets ignored as a collision. So queue and drain instead.
  if (!pc) {
    state.pendingSignals.push(payload);
    console.log('[nego] signal queued (no peer connection yet)');
    return;
  }

  const { description, candidate } = payload;

  try {
    if (description) {
      // Standard perfect-negotiation collision test.
      const readyForOffer =
        !state.makingOffer &&
        (pc.signalingState === 'stable' || state.isSettingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;

      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) {
        console.log('[nego] impolite peer ignoring colliding offer');
        return;
      }

      state.isSettingRemoteAnswerPending = description.type === 'answer';
      // Implicit rollback: in modern browsers setRemoteDescription(offer) while
      // in have-local-offer automatically rolls back our pending offer.
      await pc.setRemoteDescription(description);
      state.isSettingRemoteAnswerPending = false;

      if (description.type === 'offer') {
        // Set codec preferences on any transceiver the remote description just
        // created, so our ANSWER also puts AV1 first.
        for (const tx of pc.getTransceivers()) {
          if (tx.receiver?.track?.kind === 'video' || tx.sender?.track?.kind === 'video') {
            preferVideoCodecs(tx);
          }
        }
        const answer = await pc.createAnswer();
        answer.sdp = tuneSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        state.socket.emit('signal', { description: pc.localDescription });
      }

      // Encoder limits are reset by renegotiation, so reassert them.
      await applyVideoParams(state.videoCapKbps || Math.round(
        (preset().videoKbps.min + preset().videoKbps.max) / 2));
      await applyAudioParams();
    }

    if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        // Candidates that arrive for an offer we chose to ignore are expected.
        if (!state.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error('[nego] error handling signal:', err);
  }
}

/**
 * ICE restart. Re-gathers candidates over the existing connection — much
 * cheaper and faster than rebuilding the RTCPeerConnection, and it keeps the
 * media tracks alive so there is no black frame.
 */
function scheduleIceRestart(delayMs) {
  clearTimeout(state.iceRestartTimer);
  state.iceRestartTimer = setTimeout(async () => {
    const pc = state.pc;
    if (!pc || pc.connectionState === 'connected') return;
    if (state.restartAttempts >= 5) {
      setCallStatus(T.reconnectFailed);
      return;
    }
    state.restartAttempts++;
    console.log(`[ice] restart attempt ${state.restartAttempts}`);

    try {
      if (typeof pc.restartIce === 'function') {
        // Triggers onnegotiationneeded with iceRestart semantics.
        pc.restartIce();
        // Only the impolite peer drives the restart offer, to avoid glare.
        if (!state.polite) await negotiate();
      } else if (!state.polite) {
        const offer = await pc.createOffer({ iceRestart: true });
        offer.sdp = tuneSdp(offer.sdp);
        await pc.setLocalDescription(offer);
        state.socket.emit('signal', { description: pc.localDescription });
      }
    } catch (err) {
      console.warn('[ice] restart failed:', err);
    }

    // Exponential-ish backoff for the next attempt.
    scheduleIceRestart(Math.min(20000, 4000 * state.restartAttempts));
  }, delayMs);
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. STATS, THE DATA METER, AND THE BUDGET GOVERNOR
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Collect one honest snapshot of data usage.
 *
 * The subtlety that most WebRTC data meters get wrong: getStats() reports bytes
 * at the transport layer, which EXCLUDES the IP and UDP headers your carrier
 * counts. At 15 fps video plus 17 pps audio that is ~32 packets/s × 28 bytes =
 * ~7 kbps of real, billed traffic that never appears in bytesSent. We add it
 * back from the packet counters.
 */
async function sampleStats() {
  const pc = state.pc;
  if (!pc) return null;

  const report = await pc.getStats();

  let transportSent = 0, transportRecv = 0;
  let pairSent = 0, pairRecv = 0;
  let packetsSent = 0, packetsRecv = 0;
  let isIPv6 = false;
  // RTP header + PADDING bytes. Chrome's congestion controller pads to probe for
  // spare capacity; on an uncongested path that padding can dwarf the payload.
  // Surfacing it is the only way to tell "my video is expensive" apart from
  // "my browser is probing the network with filler".
  let rtpOverheadSent = 0, payloadSent = 0;

  const out = { video: null, audio: null };
  const inb = { video: null, audio: null };
  let remoteInboundVideo = null;
  const codecs = new Map();

  report.forEach((r) => {
    switch (r.type) {
      case 'codec':
        codecs.set(r.id, r);
        break;
      case 'outbound-rtp':
        if (r.kind === 'video' || r.mediaType === 'video') out.video = r;
        else if (r.kind === 'audio' || r.mediaType === 'audio') out.audio = r;
        packetsSent += r.packetsSent || 0;
        rtpOverheadSent += r.headerBytesSent || 0;
        payloadSent += r.bytesSent || 0;
        break;
      case 'inbound-rtp':
        if (r.kind === 'video' || r.mediaType === 'video') inb.video = r;
        else if (r.kind === 'audio' || r.mediaType === 'audio') inb.audio = r;
        packetsRecv += r.packetsReceived || 0;
        break;
      case 'remote-inbound-rtp':
        if (r.kind === 'video') remoteInboundVideo = r;
        break;
      case 'transport':
        transportSent += r.bytesSent || 0;
        transportRecv += r.bytesReceived || 0;
        break;
      case 'candidate-pair':
        if (r.state === 'succeeded' && r.nominated) {
          pairSent += r.bytesSent || 0;
          pairRecv += r.bytesReceived || 0;
        }
        break;
      case 'local-candidate':
        if (r.address && r.address.includes(':')) isIPv6 = true;
        break;
    }
  });

  // IPv6 headers are 40 bytes vs. IPv4's 20; UDP adds 8 either way.
  state.ipHeaderBytes = isIPv6 ? 48 : 28;

  // Prefer transport totals; fall back to the nominated candidate pair.
  const rawSent = transportSent || pairSent;
  const rawRecv = transportRecv || pairRecv;

  const headerSent = packetsSent * state.ipHeaderBytes;
  const headerRecv = packetsRecv * state.ipHeaderBytes;

  return {
    t: performance.now(),
    sentBytes: rawSent + headerSent,
    recvBytes: rawRecv + headerRecv,
    billedBytes: rawSent + rawRecv + headerSent + headerRecv,
    rtpOverheadSent, payloadSent,
    out, inb, remoteInboundVideo, codecs,
  };
}

function codecNameOf(report, codecs) {
  if (!report || !report.codecId) return null;
  const c = codecs.get(report.codecId);
  if (!c || !c.mimeType) return null;
  return c.mimeType.replace(/^(video|audio)\//i, '').toUpperCase();
}

/**
 * Run one governor tick. The decision math lives in governor.js (pure, tested);
 * this function only feeds it measurements and applies its verdict.
 */
function runGovernor(sample) {
  const p = preset();
  const rates = state.lastRates || {};

  const result = Governor.computeVideoCap({
    budgetMbPerHour: p.budgetMbPerHour,
    elapsedS: (sample.t - state.callStartedAt) / 1000,
    billedBytes: sample.billedBytes,
    sendKbps: rates.sendKbps ?? 0,
    videoSendKbps: rates.videoSendKbps ?? 0,
    recvKbps: rates.recvKbps ?? 0,
    prevCapKbps: state.videoCapKbps,
    videoKbps: p.videoKbps,
    // Nobody can see our video if their screen is off or our camera is down.
    videoIdle: state.peerHidden || !state.camOn,
  });

  state.lastDebtBytes = result.debtBytes;

  if (!result.hold && Math.abs(result.capKbps - state.videoCapKbps) >= 1) {
    applyVideoParams(result.capKbps);
  }

  if (result.askPeerToCapAtKbps !== null) {
    state.socket?.emit('peer-state', { requestMaxSendKbps: result.askPeerToCapAtKbps });
  }
}

/** Compute rolling rates from the sample history. */
function computeRates(sample) {
  state.rateSamples.push(sample);
  while (state.rateSamples.length > 2 &&
         sample.t - state.rateSamples[0].t > RATE_WINDOW_MS) {
    state.rateSamples.shift();
  }

  const first = state.rateSamples[0];
  const dt = (sample.t - first.t) / 1000;

  const kbps = (bytes) => (dt > 0 ? (bytes * 8) / dt / 1000 : 0);

  const rates = {
    sendKbps: kbps(sample.sentBytes - first.sentBytes),
    recvKbps: kbps(sample.recvBytes - first.recvBytes),
    combinedKbps: kbps(sample.billedBytes - first.billedBytes),
    videoSendKbps: 0,
    audioSendKbps: 0,
  };

  // Per-stream rates need the immediately previous raw snapshot.
  const prev = state.prevRaw;
  if (prev) {
    const pdt = (sample.t - prev.t) / 1000;
    const d = (a, b, key) => (pdt > 0 && a && b ? ((a[key] || 0) - (b[key] || 0)) * 8 / pdt / 1000 : 0);
    rates.videoSendKbps = d(sample.out.video, prev.out.video, 'bytesSent');
    rates.audioSendKbps = d(sample.out.audio, prev.out.audio, 'bytesSent');
    rates.audioPacketsPerSec = pdt > 0 && sample.out.audio && prev.out.audio
      ? ((sample.out.audio.packetsSent || 0) - (prev.out.audio.packetsSent || 0)) / pdt
      : 0;
  }

  state.prevRaw = sample;
  state.lastRates = rates;
  return rates;
}

function renderMeter(sample, rates) {
  const p = preset();
  const elapsedS = Math.max(1, (sample.t - state.callStartedAt) / 1000);

  const usedMb = sample.billedBytes / 1e6;
  const avgMbPerHour = usedMb / (elapsedS / 3600);
  // "Right now" projection from the rolling window.
  const nowMbPerHour = Governor.kbpsToMbPerHour(rates.combinedKbps);

  // Headline shows the projection, because that is the actionable number.
  el.headline.textContent = `${nowMbPerHour.toFixed(1)} MB/hr`;
  el.headline.classList.toggle('warn', nowMbPerHour > p.budgetMbPerHour * 1.05);
  el.headline.classList.toggle('bad', nowMbPerHour > Math.max(40, p.budgetMbPerHour * 1.3));

  // Codec chip: what is ACTUALLY negotiated, in each direction.
  const tx = codecNameOf(sample.out.video, sample.codecs) || '—';
  const rx = codecNameOf(sample.inb.video, sample.codecs) || '—';
  state.codecTx = tx;
  state.codecRx = rx;
  el.codecChip.textContent = tx === rx ? tx : `${tx}↑ ${rx}↓`;
  el.codecChip.classList.toggle('av1', tx.startsWith('AV1'));

  el.mTotal.textContent = usedMb < 10
    ? `${usedMb.toFixed(2)} MB`
    : `${usedMb.toFixed(1)} MB`;
  el.mAvg.textContent = `${avgMbPerHour.toFixed(1)} MB/hr`;
  el.mUp.textContent = `${rates.sendKbps.toFixed(0)} kbps`;
  el.mDown.textContent = `${rates.recvKbps.toFixed(0)} kbps`;

  const ov = sample.out.video;
  el.mRes.textContent = ov && ov.frameWidth
    ? `${ov.frameWidth}×${ov.frameHeight} @ ${Math.round(ov.framesPerSecond || 0)}`
    : (state.camOn ? '—' : 'video off');

  el.mCap.textContent = `${Math.round(state.videoCapKbps)} kbps`;

  el.mAudio.textContent = rates.audioSendKbps
    ? `${rates.audioSendKbps.toFixed(1)} kbps · ${Math.round(rates.audioPacketsPerSec || 0)}/s`
    : '—';

  // Loss on our UPLOAD as reported back by the receiver — the number that
  // explains why our picture looks bad on their phone.
  const ri = sample.remoteInboundVideo;
  const lossFrac = ri && typeof ri.fractionLost === 'number' ? ri.fractionLost : null;
  el.mLoss.textContent = lossFrac === null ? '—' : `${(lossFrac * 100).toFixed(1)}%`;

  // Budget bar: cumulative spend against the allowance for elapsed time.
  const allowedMb = p.budgetMbPerHour * (elapsedS / 3600);
  const pct = allowedMb > 0 ? Math.min(140, (usedMb / allowedMb) * 100) : 0;
  el.budgetFill.style.width = `${Math.min(100, pct)}%`;
  el.budgetFill.classList.toggle('warn', pct > 100);
  el.budgetFill.classList.toggle('bad', pct > 120);

  // Fraction of our upload that is RTP header + congestion-probe padding rather
  // than actual picture and sound. Above ~40% means the browser is spending your
  // data probing the network, not sending you — see the README.
  const overheadFrac = sample.payloadSent + sample.rtpOverheadSent > 0
    ? sample.rtpOverheadSent / (sample.payloadSent + sample.rtpOverheadSent)
    : 0;

  // Contextual note explaining what the governor is doing right now.
  let note;
  if (overheadFrac > 0.4 && state.camOn) {
    note = `${Math.round(overheadFrac * 100)}% of upload is padding/headers — see README.`;
  } else if (!state.camOn) {
    note = 'Audio only — the cheapest mode by far.';
  } else if (state.peerHidden) {
    note = "Their screen is off — video encoding paused.";
  } else if (ov && ov.qualityLimitationReason === 'bandwidth') {
    note = 'Network-limited: holding 480p, dropping frames.';
  } else if (ov && ov.qualityLimitationReason === 'cpu') {
    note = 'CPU-limited — AV1 encoding is expensive on older phones.';
  } else if (pct > 105) {
    note = 'Over budget — governor is tightening video.';
  } else if (pct < 85) {
    note = 'Under budget — governor is allowing more detail.';
  } else {
    note = `On budget (${p.budgetMbPerHour} MB/hr, upload + download).`;
  }
  el.mNote.textContent = note;
}

function startStatsLoop() {
  stopStatsLoop();
  state.callStartedAt = performance.now();
  state.rateSamples = [];
  state.prevRaw = null;

  state.statsTimer = setInterval(async () => {
    try {
      const sample = await sampleStats();
      if (!sample) return;
      state.billedBytesTotal = sample.billedBytes;
      const rates = computeRates(sample);
      renderMeter(sample, rates);
      runGovernor(sample);
    } catch (err) {
      console.warn('[stats] tick failed:', err);
    }
  }, STATS_INTERVAL_MS);
}

function stopStatsLoop() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
}

/** One-shot log after connect so codec negotiation is easy to verify. */
async function logNegotiatedCodec() {
  await new Promise((r) => setTimeout(r, 1500));   // let stats populate
  const sample = await sampleStats();
  if (!sample) return;
  const tx = codecNameOf(sample.out.video, sample.codecs);
  const rx = codecNameOf(sample.inb.video, sample.codecs);
  const atx = codecNameOf(sample.out.audio, sample.codecs);

  // Which kind of ICE candidate pair actually won: 'host' (direct LAN),
  // 'srflx' (STUN — the normal P2P case), or 'relay' (TURN engaged, because
  // STUN alone could not find a path — see RTC_CONFIG for why that server is
  // there and what it costs).
  let pairType = 'unknown';
  const report = await state.pc.getStats();
  report.forEach((r) => {
    if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
      const local = report.get(r.localCandidateId);
      pairType = local ? local.candidateType : pairType;
    }
  });

  console.log('════════ NEGOTIATION RESULT ════════');
  console.log(`  video send : ${tx || 'n/a'}`);
  console.log(`  video recv : ${rx || 'n/a'}`);
  console.log(`  audio      : ${atx || 'n/a'}`);
  console.log(`  connection : ${pairType}` + (pairType === 'relay' ? ' (via TURN — see README)' : ''));
  console.log(`  IP overhead accounted at ${state.ipHeaderBytes} B/packet`);
  if (tx && !tx.startsWith('AV1')) {
    console.warn(`  ⚠ Not using AV1 (got ${tx}). The MB/hr budget still holds — ` +
                 'the picture will just be softer at the same data cost.');
  }
  console.log('════════════════════════════════════');
}

/* ═══════════════════════════════════════════════════════════════════════════
   6b. GETTING RID OF THE BROWSER CHROME, AND KEEPING THE SCREEN ON

   Three separate mechanisms, because no single one does the whole job:

   1. Fullscreen API — must be called from inside a user gesture (the tap on
      "call him"). On Android Chrome this hides the URL bar and tab strip
      completely. This is the immediate fix.
   2. Web App Manifest with display:standalone — if she uses "Add to Home
      screen", the app launches with no browser UI at all, permanently. This is
      the better fix, which is why the join screen tells her how.
   3. Screen Wake Lock — stops Android dimming and locking the screen during a
      call. Without it the screen sleeps after ~30 s of not being touched, which
      on a video call is constant and maddening.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Must be called synchronously from a user gesture to be allowed. */
function goFullscreen() {
  const target = document.documentElement;
  const req = target.requestFullscreen
    || target.webkitRequestFullscreen
    || target.mozRequestFullScreen;
  if (!req) return;
  try {
    // navigationUI:'hide' asks Android Chrome to drop the nav hint bar too.
    const p = req.call(target, { navigationUI: 'hide' });
    if (p && p.catch) p.catch((err) => console.log('[fullscreen] declined:', err.name));
  } catch (err) {
    console.log('[fullscreen] unavailable:', err.name);
  }

  // Portrait is the natural way to hold a phone on a video call. Best-effort:
  // this only works while fullscreen and is unsupported on some devices.
  try {
    screen.orientation?.lock?.('portrait').catch(() => {});
  } catch { /* not supported; harmless */ }
}

/** Keep the screen awake for the duration of the call. */
async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    console.log('[wakelock] screen will stay on');
  } catch (err) {
    console.log('[wakelock] unavailable:', err.name);
  }
}

function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch { /* already gone */ }
  state.wakeLock = null;
}

/** Scatter the drifting petals. Decorative only; skipped if motion is reduced. */
function spawnPetals(count = 11) {
  if (!el.petals) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const colors = ['#e6cbf6', '#f7c6dc', '#d9bdf0', '#ffd9e8', '#c9a9e8'];
  const svgNS = 'http://www.w3.org/2000/svg';

  for (let i = 0; i < count; i++) {
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '-50 -50 100 100');
    const use = document.createElementNS(svgNS, 'use');
    use.setAttribute('href', i % 3 === 0 ? '#s-tiny' : '#s-petal');
    use.setAttribute('x', '-50'); use.setAttribute('y', '-50');
    use.setAttribute('width', '100'); use.setAttribute('height', '100');
    svg.appendChild(use);

    const size = 14 + Math.random() * 20;
    svg.style.color = colors[i % colors.length];
    svg.style.left = `${Math.random() * 100}%`;
    svg.style.width = `${size}px`;
    svg.style.height = `${size}px`;
    svg.style.opacity = String(0.28 + Math.random() * 0.4);
    svg.style.setProperty('--sway', `${-70 + Math.random() * 140}px`);
    svg.style.animationDuration = `${13 + Math.random() * 16}s`;
    // Negative delay starts each petal partway through its fall, so the screen
    // is already populated on first paint instead of starting empty.
    svg.style.animationDelay = `${-Math.random() * 26}s`;

    el.petals.appendChild(svg);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   6c. ADD TO HOME SCREEN — a real button, not just instructions

   Android Chrome fires 'beforeinstallprompt' when the page qualifies for
   installation. Capturing it lets us trigger the native install dialog from
   our own button instead of waiting for Chrome's own menu item. iOS Safari and
   some desktop browsers never fire that event — for those, tapping the button
   falls back to on-screen manual instructions instead of doing nothing.
   ═══════════════════════════════════════════════════════════════════════════ */

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    console.log('[install] native prompt available');
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    el.installBtn.classList.add('hidden');
    el.installFallback.classList.add('hidden');
  });

  el.installBtn.addEventListener('click', async () => {
    if (state.deferredInstallPrompt) {
      state.deferredInstallPrompt.prompt();
      const { outcome } = await state.deferredInstallPrompt.userChoice;
      console.log('[install] user choice:', outcome);
      state.deferredInstallPrompt = null;
      if (outcome === 'accepted') el.installBtn.classList.add('hidden');
    } else {
      // No native prompt on this browser (iOS Safari, or Chrome decided we
      // don't qualify yet) — show her how to do it by hand instead of the
      // button silently doing nothing.
      el.installFallback.classList.toggle('hidden');
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   6d. PIP INTERACTIONS — drag to reposition, tap to swap

   Whichever video is currently the small "pip" can be dragged anywhere on
   screen — including mostly off any edge, so it is out of the way entirely —
   then dragged back. A sliver (MIN_VISIBLE px) always stays on-screen so it
   can never end up somewhere ungrabbable.

   A TAP instead of a drag (pointerdown -> pointerup with barely any movement)
   swaps which feed is full-screen and which is the small pip. Tap your own
   preview and you become the big view, with the other person now the small
   one; tap again (now tapping whichever feed is the pip) to swap back. Both
   video elements share the same listeners and each checks whether IT is
   currently the pip before reacting, so nothing needs to be re-bound when a
   swap happens.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Swap which feed is full-screen and which is the small, draggable pip. */
function toggleVideoSwap() {
  for (const node of [el.remoteVideo, el.localVideo]) {
    node.classList.toggle('video-big');
    node.classList.toggle('video-pip');
  }
}

/** Force the default layout: remote full-screen, local the small pip. */
function resetVideoSwap() {
  el.remoteVideo.classList.remove('video-pip');
  el.remoteVideo.classList.add('video-big');
  el.localVideo.classList.remove('video-big');
  el.localVideo.classList.add('video-pip');
}

function setupPipInteractions() {
  const MIN_VISIBLE = 28;
  // Pointer movement under this, in px, is treated as a tap rather than a drag.
  const TAP_MAX_MOVE = 8;

  function attach(node) {
    let dragging = false, moved = 0;
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

    function clamp(left, top) {
      const w = node.offsetWidth || 120, h = node.offsetHeight || 160;
      return {
        left: Math.min(window.innerWidth - MIN_VISIBLE, Math.max(-(w - MIN_VISIBLE), left)),
        top: Math.min(window.innerHeight - MIN_VISIBLE, Math.max(-(h - MIN_VISIBLE), top)),
      };
    }

    // The CSS default positions the pip with top/right so it looks right with
    // no JS. On the first drag we freeze that computed position into explicit
    // left/top pixels so it can be moved freely without fighting the
    // stylesheet. Each element remembers its own position independently, so
    // swapping back later restores wherever this one was last left.
    function switchToExplicitPosition() {
      if (node.style.left) return;
      const r = node.getBoundingClientRect();
      node.style.left = `${r.left}px`;
      node.style.top = `${r.top}px`;
      node.style.right = 'auto';
    }

    node.addEventListener('pointerdown', (e) => {
      if (!node.classList.contains('video-pip')) return;   // only the small one moves
      switchToExplicitPosition();
      dragging = true;
      moved = 0;
      node.setPointerCapture(e.pointerId);
      node.classList.add('dragging');
      startX = e.clientX;
      startY = e.clientY;
      baseLeft = parseFloat(node.style.left) || 0;
      baseTop = parseFloat(node.style.top) || 0;
    });

    node.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
      const { left, top } = clamp(baseLeft + dx, baseTop + dy);
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      node.classList.remove('dragging');
      try { node.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      // Barely moved -> that was a tap, not a drag: swap big <-> pip.
      if (moved < TAP_MAX_MOVE) toggleVideoSwap();
    };
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);

    // Keep it reachable if the viewport changes (rotation, keyboard, etc).
    window.addEventListener('resize', () => {
      if (!node.style.left) return;
      const { left, top } = clamp(parseFloat(node.style.left), parseFloat(node.style.top));
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
    });
  }

  attach(el.localVideo);
  attach(el.remoteVideo);
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. MOBILE REALITIES — autoplay, backgrounding, screen lock
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * iOS Safari and Chrome both refuse to play unmuted media without a user
 * gesture. The Start-call tap normally satisfies this, but if playback is still
 * blocked we surface a tap target rather than leaving a silent call.
 */
async function attemptRemotePlayback() {
  el.remoteVideo.muted = false;
  try {
    await el.remoteVideo.play();
    el.unmuteOverlay.classList.add('hidden');
  } catch (err) {
    console.warn('[autoplay] blocked, showing unmute prompt:', err.name);
    el.remoteVideo.muted = true;
    try { await el.remoteVideo.play(); } catch { /* still blocked; overlay covers it */ }
    el.unmuteOverlay.classList.remove('hidden');
  }
}

el.unmuteOverlay.addEventListener('click', async () => {
  el.remoteVideo.muted = false;
  try { await el.remoteVideo.play(); } catch { /* ignore */ }
  el.unmuteOverlay.classList.add('hidden');
});

/**
 * Screen lock / tab switch.
 *
 * Critically we do NOT close the connection — a brief lock is normal and the
 * call must survive it. What we DO is tell the peer, so they can stop spending
 * bytes encoding video that nobody is looking at. That is a genuine saving:
 * a phone face-down on the table for ten minutes of an audio conversation
 * costs audio-only rates.
 */
document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  console.log(`[visibility] ${hidden ? 'hidden' : 'visible'} — connection kept alive`);
  state.socket?.emit('peer-state', { hidden });

  if (!hidden) {
    // Video elements are commonly paused by the OS on resume.
    el.remoteVideo.play().catch(() => {});
    el.localVideo.play().catch(() => {});
  }
});

// Best-effort cleanup. 'pagehide' fires on iOS where 'unload' does not.
window.addEventListener('pagehide', () => {
  if (state.socket?.connected) state.socket.disconnect();
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. UI WIRING
   ═══════════════════════════════════════════════════════════════════════════ */

function setCallStatus(text) {
  if (!text) {
    el.callStatus.classList.add('hidden');
  } else {
    el.callStatusText.textContent = text;
    el.callStatus.classList.remove('hidden');
  }
}

/**
 * @param {string} text
 * @param {'plain'|'error'|'sweet'} [tone] 'sweet' gets the little bounce — used
 *   for the "good girl" moment when she gets the room name right.
 */
function setJoinStatus(text, tone = 'plain') {
  el.joinStatus.textContent = text || '';
  el.joinStatus.classList.toggle('err', tone === 'error');
  // Re-trigger the animation by removing and forcing a reflow.
  el.joinStatus.classList.remove('sweet');
  if (tone === 'sweet') {
    void el.joinStatus.offsetWidth;
    el.joinStatus.classList.add('sweet');
  }
}

function populatePresetSelects() {
  for (const sel of [el.presetSelect, el.joinPreset]) {
    sel.innerHTML = '';
    for (const [key, p] of Object.entries(PRESETS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
    sel.value = state.presetKey;
  }
}

el.joinPreset.addEventListener('change', () => {
  state.presetKey = el.joinPreset.value;
});

// Live preset change during a call. Audio fmtp changes need renegotiation;
// video changes take effect instantly via setParameters.
// Only the host has this control, and it pushes the budget to her phone too, so
// one dropdown governs both directions of the call.
el.presetSelect.addEventListener('change', () => {
  const key = el.presetSelect.value;
  applyPreset(key, { renegotiateAudio: true });
  state.socket?.emit('peer-state', { setPreset: key });
});

el.btnMic.addEventListener('click', () => {
  state.micOn = !state.micOn;
  for (const t of state.localStream?.getAudioTracks() || []) t.enabled = state.micOn;
  el.btnMic.setAttribute('aria-pressed', String(!state.micOn));
  // Note: a disabled track still sends silence packets (DTX makes them tiny),
  // so muting saves a little data but not much. Turning off VIDEO is the win.
});

el.btnCam.addEventListener('click', async () => {
  state.camOn = !state.camOn;
  for (const t of state.localStream?.getVideoTracks() || []) t.enabled = state.camOn;
  el.btnCam.setAttribute('aria-pressed', String(!state.camOn));
  el.localVideo.classList.toggle('off', !state.camOn);

  // A disabled video track still sends a trickle of packets. Dropping the cap
  // to the floor makes audio-only genuinely cheap — roughly 8-10 MB/hr total.
  await applyVideoParams(state.camOn
    ? Math.round((preset().videoKbps.min + preset().videoKbps.max) / 2)
    : preset().videoKbps.min);
});

el.btnFlip.addEventListener('click', async () => {
  state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
  try {
    const old = state.localStream.getVideoTracks()[0];
    const fresh = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode, ...videoCaptureConstraints(preset().fps) },
    });
    const track = fresh.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.enabled = state.camOn;

    // replaceTrack swaps the camera with NO renegotiation and no SDP churn.
    await videoSender()?.replaceTrack(track);
    old?.stop();
    state.localStream.removeTrack(old);
    state.localStream.addTrack(track);
    el.localVideo.srcObject = state.localStream;
    el.localVideo.classList.toggle('rear', state.facingMode !== 'user');

    await applyVideoParams(state.videoCapKbps);
  } catch (err) {
    console.warn('[flip] failed:', err);
    state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
  }
});

el.btnEnd.addEventListener('click', endCall);

el.meterToggle.addEventListener('click', () => {
  const open = el.meterToggle.getAttribute('aria-expanded') === 'true';
  el.meterToggle.setAttribute('aria-expanded', String(!open));
  el.meterBody.classList.toggle('hidden', open);
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. CALL LIFECYCLE
   ═══════════════════════════════════════════════════════════════════════════ */

async function joinCall() {
  const room = (el.roomInput.value || '').trim();
  if (!room) {
    setJoinStatus(T.needRoom, 'error');
    return;
  }

  // Both must happen inside this gesture or the browser refuses them.
  goFullscreen();

  el.joinBtn.disabled = true;
  setJoinStatus(T.askingMedia);

  try {
    await startLocalMedia();
  } catch (err) {
    el.joinBtn.disabled = false;
    const msg = err.name === 'NotAllowedError' ? T.permissionDenied
      : err.name === 'NotFoundError' ? T.noDevice
      : `${T.notSecure} (${err.name})`;
    setJoinStatus(msg, 'error');
    return;
  }

  acquireWakeLock();
  setJoinStatus(T.joining);
  state.room = room;

  // Keep the room in the URL so it can be shared / bookmarked.
  const url = new URL(location.href);
  url.searchParams.set('room', room);
  history.replaceState(null, '', url);

  state.socket = io({ transports: ['websocket', 'polling'] });
  wireSocket();
  // The initial join, and every rejoin after a network blip, both happen from
  // inside the socket's 'connect' handler below — see the comment there for why.
}

function wireSocket() {
  const socket = state.socket;

  socket.on('connect', () => {
    console.log('[sig] connected', socket.id);
    // Socket.IO auto-reconnects after a network blip (WiFi<->cell handoff,
    // brief signal loss, the app being backgrounded) — but the SERVER treats
    // that reconnect as a brand-new session and has already evicted this
    // client from the room (server.js's disconnect handler runs the instant
    // the old transport drops). Without re-joining here, a transient hiccup
    // — routine on mobile data, much more so than on a stable connection —
    // leaves the client stuck outside the room forever, showing "reconnecting"
    // while nothing is actually happening. Emitting 'join' from inside this
    // handler covers BOTH the very first connection and every reconnect with
    // one code path, since state.room is already set before the socket exists.
    if (state.room) socket.emit('join', state.room);
  });

  socket.on('joined', async ({ polite, peerPresent }) => {
    state.polite = polite;
    console.log(`[sig] joined room "${state.room}" as ${polite ? 'polite' : 'impolite'} peer`);

    // The little reward for getting the room name right.
    setJoinStatus(T.accepted, 'sweet');
    setCallStatus(peerPresent ? T.connecting : T.waitingForPeer);

    // Start negotiating IMMEDIATELY. The screen transition below is cosmetic and
    // must never gate this: if we sleep here, the other side's offer arrives
    // before we have a peer connection and the call deadlocks.
    const connecting = peerPresent ? beginPeerConnection() : Promise.resolve();

    // Purely visual: hold the "good girl" message long enough to read.
    setTimeout(() => {
      el.joinScreen.classList.add('hidden');
      el.callScreen.classList.remove('hidden');
      document.body.classList.add('in-call');
    }, 850);

    await connecting;
  });

  socket.on('peer-joined', async () => {
    console.log('[sig] peer joined');
    setCallStatus(T.connecting);
    if (!state.pc) await beginPeerConnection();
  });

  socket.on('signal', handleSignal);

  socket.on('peer-state', ({ hidden, budgetMbPerHour, requestMaxSendKbps, setPreset }) => {
    if (typeof hidden === 'boolean') {
      state.peerHidden = hidden;
      console.log(`[peer] screen ${hidden ? 'off — pausing our video encode' : 'on'}`);
    }
    if (typeof budgetMbPerHour === 'number') {
      console.log(`[peer] their budget: ${budgetMbPerHour} MB/hr`);
    }
    // Only the host has a preset control, so accept a pushed preset only when we
    // are the guest. This keeps one dropdown governing both directions.
    if (setPreset && PRESETS[setPreset] && state.role === 'guest') {
      console.log(`[peer] host set our budget to ${setPreset}`);
      applyPreset(setPreset);
    }
    if (typeof requestMaxSendKbps === 'number') {
      // They are over budget on their download. Honour the lower of the two.
      const cap = Math.max(preset().videoKbps.min,
                           Math.min(state.videoCapKbps, requestMaxSendKbps));
      console.log(`[peer] asked us to cap upload at ${requestMaxSendKbps} kbps`);
      applyVideoParams(cap);
    }
  });

  socket.on('peer-left', () => {
    console.log('[sig] peer left');
    teardownPeerConnection();
    setCallStatus(T.peerLeft);
    el.remoteVideo.srcObject = null;
  });

  socket.on('room-full', () => {
    setJoinStatus(T.roomFull, 'error');
    el.joinBtn.disabled = false;
    stopLocalMedia();
    releaseWakeLock();
    socket.disconnect();
  });

  socket.on('join-error', ({ reason }) => {
    setJoinStatus(state.role === 'host' ? `could not join: ${reason}` : T.roomFull, 'error');
    el.joinBtn.disabled = false;
  });

  socket.on('disconnect', (reason) => {
    console.warn('[sig] signaling disconnected:', reason);
    // Tear down unconditionally, even if our own pc still looks healthy at
    // this exact instant. The SERVER always treats a socket disconnect as
    // "this peer left the room" and tells our partner so (see server.js),
    // which makes THEM unconditionally tear down and rebuild their
    // RTCPeerConnection from scratch the moment we rejoin. If we kept our own
    // pc around just because it happened to still be 'connected' when the
    // socket dropped, the two sides end up with mismatched SDP structures —
    // confirmed in testing as a real failure: a fresh offer's m-line order
    // does not match our old answer's, and setRemoteDescription throws
    // InvalidAccessError, leaving the call stuck in "reconnecting" forever.
    // Staying in lockstep with what the other side is about to do means
    // always rebuilding here too.
    teardownPeerConnection();
    setCallStatus(T.reconnecting);
  });
}

async function beginPeerConnection() {
  if (state.pc) return;
  resetVideoSwap();   // every new call starts remote-big / local-pip
  createPeerConnection();
  await applyPreset(state.presetKey);
  startStatsLoop();

  // Drain anything that arrived while we were still setting up.
  const queued = state.pendingSignals;
  state.pendingSignals = [];
  for (const payload of queued) {
    console.log('[nego] replaying queued signal');
    await handleSignal(payload);
  }

  // Both peers fire onnegotiationneeded; perfect negotiation resolves the glare.
  state.socket.emit('peer-state', {
    budgetMbPerHour: preset().budgetMbPerHour,
    hidden: document.visibilityState === 'hidden',
  });
}

function teardownPeerConnection() {
  stopStatsLoop();
  clearTimeout(state.iceRestartTimer);
  if (state.pc) {
    state.pc.ontrack = null;
    state.pc.onicecandidate = null;
    state.pc.onnegotiationneeded = null;
    state.pc.onconnectionstatechange = null;
    state.pc.close();
    state.pc = null;
  }
  state.restartAttempts = 0;
  state.prevRaw = null;
  state.rateSamples = [];
}

function stopLocalMedia() {
  for (const t of state.localStream?.getTracks() || []) t.stop();
  state.localStream = null;
  el.localVideo.srcObject = null;
}

function endCall() {
  const usedMb = state.billedBytesTotal / 1e6;
  const mins = (performance.now() - state.callStartedAt) / 60000;
  console.log(`[call] ended: ${usedMb.toFixed(2)} MB over ${mins.toFixed(1)} min ` +
              `(${(usedMb / (mins / 60) || 0).toFixed(1)} MB/hr)`);

  teardownPeerConnection();
  stopLocalMedia();
  releaseWakeLock();
  state.socket?.disconnect();
  state.socket = null;

  // Leave fullscreen so she is not stuck with no way back to the browser.
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  el.callScreen.classList.add('hidden');
  el.joinScreen.classList.remove('hidden');
  document.body.classList.remove('in-call');
  el.joinBtn.disabled = false;
  setJoinStatus(
    mins > 0.2 ? T.ended(usedMb.toFixed(1), mins.toFixed(0)) : '',
    state.role === 'guest' ? 'sweet' : 'plain'
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   10. BOOT
   ═══════════════════════════════════════════════════════════════════════════ */

/** Apply the role: swap in its copy and set the class the CSS keys off. */
function applyRole(role) {
  state.role = role;
  T = COPY[role];

  document.body.classList.toggle('role-host', role === 'host');
  document.body.classList.toggle('role-guest', role === 'guest');

  el.joinTitle.textContent = T.title;
  el.joinTagline.textContent = T.tagline;
  el.roomInput.placeholder = T.roomPlaceholder;
  el.joinBtnLabel.textContent = T.joinButton;

  // The install button is for her; you already know how to add a home-screen
  // icon. It is also pointless once the app IS installed and running standalone.
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  el.installBtn.classList.toggle('hidden', role === 'host' || standalone);

  console.log(`[boot] role = ${role}`);
}

(function init() {
  const role = detectRole();
  applyRole(role);

  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    setJoinStatus(T.unsupported, 'error');
    el.joinBtn.disabled = true;
    return;
  }

  // getUserMedia requires a secure context. localhost is exempt.
  if (!window.isSecureContext) {
    setJoinStatus(T.notSecure, 'error');
  }

  populatePresetSelects();
  spawnPetals();
  setupInstallPrompt();
  setupPipInteractions();

  const params = new URLSearchParams(location.search);
  el.roomInput.value = params.get('room') || '';
  if (params.get('preset') && PRESETS[params.get('preset')]) {
    state.presetKey = params.get('preset');
    populatePresetSelects();
  }

  el.joinBtn.addEventListener('click', joinCall);
  el.roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinCall();
  });

  // Escape hatch for setting up the host role without editing the URL:
  // triple-tap the bouquet.
  let taps = 0, tapTimer = null;
  el.bouquet.addEventListener('click', () => {
    taps++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 700);
    if (taps >= 3) {
      taps = 0;
      const next = state.role === 'host' ? 'guest' : 'host';
      localStorage.setItem(ROLE_KEY, next);
      applyRole(next);
      setJoinStatus(next === 'host' ? 'host mode on' : 'her view', 'plain');
    }
  });

  // Re-acquire the wake lock after a screen lock releases it, so the screen does
  // not start sleeping again halfway through a long call.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.pc) acquireWakeLock();
  });

  console.log('[boot] ready. AV1 encode support:',
    (RTCRtpSender.getCapabilities?.('video')?.codecs || [])
      .some((c) => c.mimeType.toLowerCase().startsWith('video/av1')));
})();
