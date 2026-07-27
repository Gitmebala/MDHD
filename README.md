# us 💜

A private video call for exactly two people, built around one hard requirement:
**it must not eat your mobile data.** Target is 30 MB/hour total, at 480p / 15fps,
using AV1.

Media is peer-to-peer. The server only introduces the two browsers to each other;
your video never passes through it.

---

## Two views of the same app

| | her phone (default) | your phone |
|---|---|---|
| look | soft lilac, bouquet, drifting petals | same, plus instruments |
| copy | "hi baby", "type the room name here babyy", "good girl 💜" | plain and technical |
| numbers | none at all | full data meter |
| budget control | none — follows yours | preset dropdown, pushes to her phone |

**To make a phone the host:** open it once with `?me=1` — for example
`https://your-app.onrender.com/?me=1`. The role is remembered in that device's
local storage, so you only do it once. If you ever need to change it without
editing the URL, **triple-tap the bouquet** on the join screen.

She just opens `https://your-app.onrender.com/?room=ourroom` and taps **call him**.

> One gotcha: the role lives in `localStorage`, which is per-device *and*
> per-browser. If you ever open her plain link on your own phone it stays host
> (the link carries no role). Only `?her=1` would demote you, and nothing sends
> that by accident.

---

## Getting rid of the browser bar

Three mechanisms, because no single one covers everything:

1. **Add to Home screen** — the real fix. `manifest.json` declares
   `display: standalone`, so once installed the app launches with no URL bar and
   no tab strip, permanently. The join screen shows her how, and the hint
   disappears once it is installed.
2. **Fullscreen API** — requested the instant she taps "call him" (it only works
   from inside a user gesture). Hides Chrome's UI immediately, even without
   installing. Exiting the call leaves fullscreen so she is never trapped.
3. **Screen Wake Lock** — stops Android dimming and locking the screen mid-call.
   Without it the screen sleeps after ~30 seconds of not being touched, which on
   a video call is constant. It is re-acquired automatically after any
   interruption.

---

## The number that actually matters

A call sends *and* receives simultaneously, and your carrier bills both, plus the
IP/UDP headers on every packet that `getStats()` does not report. So the usual
advice — "cap video at 50 kbps" — is:

| | per direction | billed (up + down) |
|---|---|---|
| video 50 kbps + audio 24 kbps | 74 kbps | ~67 MB/hr |
| + packet headers | 81 kbps | ~73 MB/hr |

To land at 30 MB/hour you have about **33 kbps per direction for everything**.
Every number in the meter is the billed figure: both directions, headers included.

## How the budget is enforced

A fixed bitrate cap cannot guarantee an hourly total — it wastes bits while you
sit still and starves when you move. Instead [`public/governor.js`](public/governor.js)
runs a closed loop every 2 seconds:

1. Measure real billed bytes — transport bytes **plus** 28 B/packet of IPv4+UDP
   header (48 B on IPv6), both directions.
2. Compare against the allowance prorated for elapsed time.
3. Retune the video `maxBitrate` to erase any debt over the next 60 seconds.

Because step 1 observes bytes actually on the wire, costs not modelled explicitly
— RTCP, STUN, keyframes — are absorbed automatically.

Simulated over full-length calls (`npm test`):

| Preset | still scene | mixed | constant motion | video cap range |
|---|---|---|---|---|
| Featherweight (20) | 19.9 MB/hr | 19.9 | 20.0 | 8–19 kbps |
| **Saver (30)** ← default | **29.7 MB/hr** | **29.8** | **30.0** | 18–42 kbps |
| Balanced (45) | 42.8 MB/hr | 44.7 | 45.0 | 33–70 kbps |
| Sharp (90) | 81.9 MB/hr | 89.2 | 90.1 | 79–160 kbps |

The video cap moves *opposite* to scene activity: on a static shot it opens to
42 kbps (the encoder undershoots anyway), under constant motion it clamps to
~18 kbps. That averaging is what makes 480p viable at this data rate.

### Where the headroom comes from

| Technique | Effect | Cost |
|---|---|---|
| P2P, never relayed | halves bytes vs. a TURN relay | needs a workable NAT path |
| AV1 | 30–50% better than VP9 at these rates | CPU on older phones |
| Opus DTX | **measured 0.1 kbps during silence** vs 12 talking | none worth mentioning |
| `ptime=60` | 50 → **measured 5–11 packets/s**, saving ~10 kbps of header | +40 ms latency |
| Drop RTX (default) | **measured 96.9 → 37.4 kbps** total upload | lost packets aren't repaired |
| Strip Opus RED | audio can otherwise nearly double | in-band FEC covers most of it |
| Strip video FEC | removes continuous redundancy | same |
| `b=AS:` ceilings | bounds the congestion controller, not just the encoder | none |
| `maintain-resolution` | keeps 480p under pressure | drops framerate instead |
| Peer-screen-off detection | video encoding stops entirely | none |

---

## ⚠️ Padding: read this before your first real call

This is the one thing I could not verify for you, and it is the thing most likely
to blow the budget.

`setParameters({maxBitrate})` caps the **encoder**, not the **transport**.
Chrome's congestion controller continuously probes for spare bandwidth by sending
**padding** — filler bytes that cost you real money and carry no picture.

Measured here on a loopback connection, at the Saver preset:

| | video payload | header + padding | total upload |
|---|---|---|---|
| RTX kept | 14.8 kbps | 61.4 kbps | 96.9 kbps |
| **RTX dropped (now default)** | 5.5 kbps | 16.4 kbps | **37.4 kbps** |

Chrome uses RTX packets as its padding vehicle, so dropping RTX cut total upload
by 61%. That is why `?rtx=1` is now needed to *restore* retransmission rather than
to disable it.

**The honest caveat:** those measurements are from two browser tabs talking over
127.0.0.1. On loopback the bandwidth estimator sees zero loss, zero jitter and
effectively infinite capacity, so it probes upward forever. On real 4G there is
finite capacity and genuine RTT and loss signals, so it converges and padding
should be far smaller. **The loopback numbers do not transfer, in either
direction.** I could not measure a real mobile path from here.

So the meter now reports it directly. If the note says something like
*"72% of upload is padding/headers"* during a real call on mobile data, that is
the problem, and:

- padding high **and** you are on `?rtx=1` → drop the `?rtx=1`, it is the default
  for a reason;
- padding high on the default already → drop to the Featherweight preset, which
  lowers the `b=AS:` ceiling the controller is probing against;
- padding low (under ~30%) → the budget is behaving, ignore this section.

The tradeoff of no RTX is real: a lost video packet is not retransmitted, so the
picture smears until the next keyframe rather than being repaired. Audio is
unaffected — Opus in-band FEC handles its own losses. If her picture looks torn
rather than merely soft, try `?rtx=1` and accept more data.

---

## Run it locally

```bash
npm install
```

```bash
npm start
```

Open <http://localhost:3000/?room=ourroom> in two tabs. `localhost` counts as a
secure context, so the camera works without HTTPS.

```bash
npm test
```

28 tests: SDP munging against a realistic Chrome offer, and closed-loop
simulations of the governor over full-length calls.

---

## Deploy

`getUserMedia` only works in a secure context, so over the internet **HTTPS is
mandatory** — on plain HTTP the camera silently refuses. Both options below
provision a certificate automatically.

### Render

1. Push this folder to a GitHub repo.
2. Render → **New → Web Service** → connect the repo.
3. Runtime **Node**, build `npm install`, start `npm start`.
4. Leave the port alone — the server reads `process.env.PORT`.
5. The free tier idles after ~15 minutes; the next load takes 30–60 s to wake.
   This does not affect an established call, since media is P2P.

### Railway

1. **New Project → Deploy from GitHub repo** — it detects Node automatically.
2. **Settings → Networking → Generate Domain** for an HTTPS URL.

The room name is the only secret, so pick something unguessable.

---

## AV1

You are both on Android, so AV1 should negotiate in both directions — this build
confirmed AV1 end-to-end at 640×480/15fps in Chromium. The codec chip in the
meter shows what was actually negotiated (`AV1↑ VP9↓` means we send AV1 and
receive VP9), and the console prints a `NEGOTIATION RESULT` block on connect.

If the meter says **CPU-limited**, AV1 software encoding is too expensive for that
phone — switch to Featherweight or accept the lower framerate. If either of you
ever calls from an iPhone, Safari has no WebRTC AV1 *encoder* and will fall back
to VP9/VP8; the budget still holds, the picture is just softer.

---

## What it will look like

At Saver the video budget averages ~18–25 kbps.

- **Sitting and talking** — nearly all of a call — looks genuinely fine. 480p is
  held, stable, sharp enough to read expressions.
- **Fast movement** smears for a beat, then recovers.
- Resolution stays 480p by design (`maintain-resolution`): under pressure you
  lose *smoothness*, not sharpness. To invert that, change
  `degradationPreference` to `'balanced'` in [`public/app.js`](public/app.js).

Audio stays consistently good — Opus at 12 kbps mono wideband is clear for speech.

## Controls

- **🎙️** mute. Saves little on its own; DTX already makes silence nearly free.
- **📹** audio-only. The big lever: roughly **8–10 MB/hour**.
- **🔄** flip camera, via `replaceTrack` — no renegotiation, no interruption.
- **💔** end call.
- Preset dropdown (yours only) changes live and pushes the budget to her phone.
- Tap the meter to collapse it.

---

## Test checklist

Everything below needs two real phones on mobile data — none of it can be
verified from a development machine.

1. **AV1 both ways.** Connect and read the codec chip; open the console for the
   full `NEGOTIATION RESULT`.
2. **Check the padding note first.** See the padding section above. Do this before
   trusting any MB/hr figure.
3. **10-minute call.** Watch **"call avg"**, not the headline — the headline is a
   30-second rolling projection and will swing. The average should settle at or
   just under 30.
4. **Verify the packet-size saving.** The Audio row shows `kbps · packets/s`. It
   should read roughly 11–17/s, not 50/s. Measured 5/s here during silence.
5. **Screen lock.** Lock her phone 30 seconds. The call must survive, your note
   should read *"Their screen is off — video encoding paused"*, and your upload
   should collapse to audio-only rates.
6. **Audio-only mode.** Both tap 📹 off; the average should fall toward 8–10 MB/hr.
7. **Third-person rejection.** A third device should be refused cleanly.
8. **Network switch.** Walk from Wi-Fi onto mobile data mid-call — expect
   "hold on baby, one sec…" then recovery via ICE restart, without rejoining.

---

## TURN: not included

Only Google's public STUN. If you consistently never connect, you are behind
symmetric NAT on both ends and need a relay — but a relayed call **doubles the
bytes** and wrecks the budget. If you get there, add credentials to `RTC_CONFIG`
in [`public/app.js`](public/app.js) and drop a preset to compensate.

---

## Files

| File | What it does |
|---|---|
| [`server.js`](server.js) | Signaling relay + static host. Two per room, hard limit. Assigns polite/impolite roles. |
| [`public/app.js`](public/app.js) | Capture, codec preference, perfect negotiation, ICE restart, roles and copy, fullscreen, wake lock, meter. |
| [`public/governor.js`](public/governor.js) | The budget control loop. Pure math — tested. |
| [`public/sdp-tuner.js`](public/sdp-tuner.js) | Opus DTX/ptime/bitrate, RED/FEC/RTX stripping, `b=AS:` ceilings. Pure text — tested. |
| [`public/manifest.json`](public/manifest.json) | Home-screen install, `display: standalone`. |
| [`test/`](test) | 28 tests. |

## Verified vs. not

**Verified against real Chromium:**

- Munged SDP accepted by `setLocalDescription`/`setRemoteDescription` on both
  offer and answer — the usual way SDP munging fails silently.
- AV1 negotiated end-to-end, 640×480 @ 15fps, `maintain-resolution` and
  `adaptivePtime` both accepted.
- Opus DTX and `ptime` working: 0.1 kbps at 5 packets/s during silence.
- Two-peer call connects, remote video renders, 0% loss, meter populates, the
  guest/host split and the "good girl" copy sequence fire correctly.
- Server room logic: role assignment, third-joiner rejection, relay scoped to the
  room, slot freed on disconnect.
- Governor budget adherence, in simulation across all four presets.

**Not verified — this is what your first real call is for:**

- Actual MB/hour on a mobile network. The loopback figure is dominated by
  congestion-probe padding and does not transfer. See the padding section.
- AV1 between two real phones, and the CPU cost of encoding it on yours.
- Screen-lock recovery and Wi-Fi→4G ICE restart on real hardware.
