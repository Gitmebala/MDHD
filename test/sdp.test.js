/**
 * Tests for the SDP tuner, run against a realistic Chrome offer including the
 * Opus RED payload and video FEC entries we need to strip.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { tuneSdpForLowBandwidth, parseSdp } = require('../public/sdp-tuner.js');

const CFG = { audioKbps: 12, audioPtimeMs: 60, videoKbps: { min: 10, max: 42 } };

/** Abridged but structurally faithful Chrome offer (AV1 + VP9 + VP8, Opus + RED). */
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=msid-semantic: WMS stream',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=mid:0',
  'a=sendrecv',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:13 CN/8000',
  'a=rtpmap:110 telephone-event/48000',
  'a=rtpmap:126 telephone-event/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 45 46 116 117 118',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=sendrecv',
  'a=rtcp-mux',
  'a=rtpmap:96 VP8/90000',
  'a=rtcp-fb:96 nack',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000',
  'a=fmtp:98 profile-id=0',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  'a=rtpmap:45 AV1/90000',
  'a=fmtp:45 level-idx=5;profile=0;tier=0',
  'a=rtpmap:46 rtx/90000',
  'a=fmtp:46 apt=45',
  'a=rtpmap:116 red/90000',
  'a=rtpmap:117 rtx/90000',
  'a=fmtp:117 apt=116',
  'a=rtpmap:118 ulpfec/90000',
].join('\r\n') + '\r\n';

/** Helper: pull the audio / video m= sections out of a tuned SDP. */
function sections(sdp) {
  const { sections } = parseSdp(sdp);
  return {
    audio: sections.find((s) => s.kind === 'audio'),
    video: sections.find((s) => s.kind === 'video'),
  };
}

test('opus fmtp gains every data-saving parameter', () => {
  const out = tuneSdpForLowBandwidth(CHROME_OFFER, CFG);
  const fmtp = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111 '));
  assert.ok(fmtp, 'opus fmtp line must exist');

  const params = new Map(
    fmtp.slice('a=fmtp:111 '.length).split(';').map((p) => {
      const i = p.indexOf('=');
      return i === -1 ? [p, null] : [p.slice(0, i), p.slice(i + 1)];
    })
  );

  assert.equal(params.get('maxaveragebitrate'), '12000');
  assert.equal(params.get('usedtx'), '1');
  assert.equal(params.get('cbr'), '0');
  assert.equal(params.get('stereo'), '0');
  assert.equal(params.get('sprop-stereo'), '0');
  assert.equal(params.get('maxplaybackrate'), '16000');
  assert.equal(params.get('sprop-maxcapturerate'), '16000');
  // Pre-existing params must be preserved, not clobbered.
  assert.equal(params.get('minptime'), '10');
  assert.equal(params.get('useinbandfec'), '1');
});

test('audio ptime is set to 60ms to cut packet-header overhead', () => {
  const out = tuneSdpForLowBandwidth(CHROME_OFFER, CFG);
  const { audio, video } = sections(out);
  assert.ok(audio.lines.includes('a=ptime:60'));
  assert.ok(audio.lines.includes('a=maxptime:120'));
  // ptime is an audio concern only — it must not leak into the video section.
  assert.ok(!video.lines.some((l) => l.startsWith('a=ptime:')));
});

test('opus RED is removed from the audio m-line and its attributes', () => {
  const out = tuneSdpForLowBandwidth(CHROME_OFFER, CFG);
  const { audio } = sections(out);

  const payloads = audio.lines[0].split(' ').slice(3);
  assert.ok(!payloads.includes('63'), 'RED payload 63 must be gone from m= line');
  assert.ok(payloads.includes('111'), 'opus must survive');
  assert.ok(!audio.lines.some((l) => l.startsWith('a=rtpmap:63')));
  assert.ok(!audio.lines.some((l) => l.startsWith('a=fmtp:63')));
});

test('video FEC (red + ulpfec) and its rtx are removed, but real rtx survives', () => {
  const out = tuneSdpForLowBandwidth(CHROME_OFFER, CFG);
  const { video } = sections(out);
  const payloads = video.lines[0].split(' ').slice(3);

  // 116 = red, 118 = ulpfec, 117 = rtx pointing at red -> all must go.
  for (const pt of ['116', '117', '118']) {
    assert.ok(!payloads.includes(pt), `payload ${pt} must be removed`);
    assert.ok(!video.lines.some((l) => l.includes(`:${pt} `)),
      `attributes for payload ${pt} must be removed`);
  }

  // The real codecs must survive regardless.
  for (const pt of ['96', '98', '45']) {
    assert.ok(payloads.includes(pt), `payload ${pt} must survive`);
  }
  assert.ok(video.lines.includes('a=rtpmap:45 AV1/90000'), 'AV1 intact');
});

test('output is valid CRLF-terminated SDP with no blank lines', () => {
  const out = tuneSdpForLowBandwidth(CHROME_OFFER, CFG);
  assert.ok(out.endsWith('\r\n'));
  assert.ok(!out.includes('\r\n\r\n'), 'no empty lines');
  assert.ok(out.startsWith('v=0\r\n'));
  // Session-level lines must stay ahead of the first m= line.
  assert.ok(out.indexOf('a=group:BUNDLE') < out.indexOf('m=audio'));
});

test('is idempotent — re-tuning an already-tuned SDP changes nothing', () => {
  const once = tuneSdpForLowBandwidth(CHROME_OFFER, CFG);
  const twice = tuneSdpForLowBandwidth(once, CFG);
  assert.equal(twice, once);
});

test('a different preset produces different audio parameters', () => {
  const out = tuneSdpForLowBandwidth(CHROME_OFFER,
    { audioKbps: 24, audioPtimeMs: 20, videoKbps: { min: 24, max: 160 } });
  assert.ok(out.includes('maxaveragebitrate=24000'));
  assert.ok(out.includes('a=ptime:20'));
  // maxptime floors at 120ms so the peer may still lengthen packets.
  assert.ok(out.includes('a=maxptime:120'));
});

test('b=AS bandwidth ceilings are set on both media sections', () => {
  const out = tuneSdpForLowBandwidth(CHROME_OFFER, CFG);
  const { audio, video } = sections(out);

  // Video: governor max (42) + 25% headroom = 52.
  assert.ok(video.lines.includes('b=AS:53') || video.lines.includes('b=AS:52'),
    `expected a video b=AS near 52, got ${video.lines.filter(l => l.startsWith('b='))}`);
  // Audio: max(24, 12*2) = 24.
  assert.ok(audio.lines.includes('b=AS:24'),
    `expected audio b=AS:24, got ${audio.lines.filter(l => l.startsWith('b='))}`);
});

test('b=AS is placed after c= and before the first a= line', () => {
  // SDP line order is normative: m=, i=, c=, b=, then a=. Chrome will reject a
  // b= line that appears after the attributes.
  const out = tuneSdpForLowBandwidth(CHROME_OFFER, CFG);
  for (const section of [sections(out).audio, sections(out).video]) {
    const bIdx = section.lines.findIndex((l) => l.startsWith('b=AS:'));
    const cIdx = section.lines.findIndex((l) => l.startsWith('c='));
    const aIdx = section.lines.findIndex((l) => l.startsWith('a='));
    assert.ok(bIdx > 0, 'b= line must exist');
    if (cIdx !== -1) assert.ok(bIdx > cIdx, 'b= must come after c=');
    if (aIdx !== -1) assert.ok(bIdx < aIdx, 'b= must come before the first a=');
  }
});

test('b=AS tracks the preset rather than being hardcoded', () => {
  const cheap = tuneSdpForLowBandwidth(CHROME_OFFER,
    { audioKbps: 10, audioPtimeMs: 60, videoKbps: { min: 8, max: 28 } });
  const rich = tuneSdpForLowBandwidth(CHROME_OFFER,
    { audioKbps: 24, audioPtimeMs: 20, videoKbps: { min: 24, max: 160 } });
  assert.ok(rich.includes('b=AS:200'), 'sharp preset video ceiling is 160*1.25');
  assert.ok(cheap.includes('b=AS:35'), 'featherweight video ceiling is 28*1.25');
  assert.ok(rich.includes('b=AS:48'), 'sharp audio ceiling is 24*2');
});

test('rtx is preserved when dropRtx is off', () => {
  const kept = tuneSdpForLowBandwidth(CHROME_OFFER, { ...CFG, dropRtx: false });
  assert.ok(kept.includes('a=fmtp:46 apt=45'), 'AV1 rtx mapping intact');
  assert.ok(kept.includes('rtx/90000'));
});

test('dropRtx removes every rtx payload but keeps the real codecs', () => {
  const dropped = tuneSdpForLowBandwidth(CHROME_OFFER, { ...CFG, dropRtx: true });
  const { video } = sections(dropped);
  const payloads = video.lines[0].split(' ').slice(3);
  for (const pt of ['97', '99', '46']) {
    assert.ok(!payloads.includes(pt), `rtx payload ${pt} should be gone`);
  }
  assert.ok(!dropped.includes('rtx/90000'), 'no rtx rtpmap should remain');
  // The real codecs must survive the surgery.
  assert.ok(payloads.includes('45') && payloads.includes('96') && payloads.includes('98'));
  assert.ok(dropped.includes('a=rtpmap:45 AV1/90000'));
});

test('a missing videoKbps range is skipped, not fatal', () => {
  // Negotiation must never fail outright over an incomplete config.
  const out = tuneSdpForLowBandwidth(CHROME_OFFER, { audioKbps: 12, audioPtimeMs: 60 });
  assert.ok(out.includes('maxaveragebitrate=12000'), 'audio tuning still applied');
  assert.ok(out.includes('a=rtpmap:45 AV1/90000'), 'video section still intact');
});

test('handles an SDP with no audio section without throwing', () => {
  const videoOnly = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 45',
    'a=rtpmap:45 AV1/90000',
  ].join('\r\n') + '\r\n';
  const out = tuneSdpForLowBandwidth(videoOnly, CFG);
  assert.ok(out.includes('a=rtpmap:45 AV1/90000'));
});
