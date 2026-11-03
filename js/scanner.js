// Live barcode scanner: native BarcodeDetector (Chrome Android) with a ZXing-WASM ponyfill elsewhere.
// Scans a centre crop matching the on-screen reticle and requires two identical, checksum-valid reads.

const PONYFILL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/dist/es/ponyfill.js/+esm';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

let detectorPromise;
function getDetector() {
  detectorPromise ??= (async () => {
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = FORMATS.filter(f => supported.includes(f));
        if (formats.length) return { detector: new window.BarcodeDetector({ formats }), native: true };
      } catch { /* fall through to ponyfill */ }
    }
    const mod = await import(PONYFILL);
    return { detector: new mod.BarcodeDetector({ formats: FORMATS }), native: false };
  })().catch(e => { detectorPromise = null; throw e; });
  return detectorPromise;
}

// GTIN-8/12/13/14 mod-10 check digit.
export function validBarcode(code, format = '') {
  code = String(code || '').trim();
  if (format === 'upc_e') return /^\d{6,8}$/.test(code);
  if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length)) {
    const d = code.split('').map(Number);
    const check = d.pop();
    const s = d.reverse().reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 3 : 1), 0);
    return (10 - (s % 10)) % 10 === check;
  }
  return code.length >= 6;
}

export async function startScanner(video, { onCode }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera not available in this browser');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});

  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  try {
    if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch { /* optional */ }

  const { detector, native } = await getDetector();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: !native });
  let running = true, paused = false, last = '', hits = 0, timer = 0, torch = false;

  const loop = async () => {
    if (!running) return;
    if (!paused && video.readyState >= 2 && video.videoWidth) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const cw = Math.round(vw * 0.8), ch = Math.round(vh * 0.5);
      canvas.width = Math.min(cw, 1280);
      canvas.height = Math.round(canvas.width * (ch / cw));
      ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
      try {
        const codes = await detector.detect(canvas);
        const c = codes.find(b => validBarcode(b.rawValue, b.format));
        if (c) {
          hits = c.rawValue === last ? hits + 1 : 1;
          last = c.rawValue;
          if (hits >= 2) { paused = true; hits = 0; last = ''; onCode(c.rawValue, c.format); }
        }
      } catch { /* transient decode errors */ }
    }
    if (running) timer = setTimeout(loop, native ? 90 : 140);
  };
  loop();

  return {
    native,
    hasTorch: !!caps.torch,
    async toggleTorch() {
      torch = !torch;
      await track.applyConstraints({ advanced: [{ torch }] });
      return torch;
    },
    pause() { paused = true; },
    resume() { paused = false; },
    stop() {
      running = false;
      clearTimeout(timer);
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    },
  };
}

// Preload the decoder while the user is still aiming.
export function warmScanner() { getDetector().catch(() => {}); }
