// Model runtime (Web Worker): MobileCLIP-S0 image + text encoders via Transformers.js / ONNX Runtime Web.
// Exposes only primitives (load, embedText, embedImages); all scoring logic lives in ai.js.
// The two towers load independently: photos only need the 43 MB vision tower; the text tower is
// fetched lazily for hints / custom foods (built-in prompts ship precomputed with the app).

import {
  env,
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
env.useBrowserCache = true; // model files persist in Cache Storage → offline after first download

const EXPECTED = { vision: 44e6, text: 43e6 }; // keeps the progress bar monotonic before sizes are known
const files = new Map();
let expected = 0;
let vision, text;

function onProgress(p) {
  if (!p.file) return;
  if (p.status === 'progress') files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
  if (p.status === 'done') { const f = files.get(p.file); if (f) f.loaded = f.total; }
  let loaded = 0, total = 0;
  for (const f of files.values()) { loaded += f.loaded; total += f.total; }
  postMessage({ type: 'progress', data: { status: p.status, file: p.file, loaded, progress: Math.min(1, loaded / Math.max(total, expected, 1)) } });
}

function loadVision(model) {
  if (!vision) {
    expected += EXPECTED.vision;
    vision = Promise.all([
      AutoProcessor.from_pretrained(model, { progress_callback: onProgress }),
      // The S0 image tower degrades when quantised, so it stays fp32.
      CLIPVisionModelWithProjection.from_pretrained(model, { progress_callback: onProgress, dtype: 'fp32', device: 'wasm' }),
    ]).catch(e => { vision = null; throw e; });
  }
  return vision;
}

function loadText(model) {
  if (!text) {
    expected += EXPECTED.text;
    text = Promise.all([
      AutoTokenizer.from_pretrained(model, { progress_callback: onProgress }),
      CLIPTextModelWithProjection.from_pretrained(model, { progress_callback: onProgress, dtype: 'q8', device: 'wasm' }),
    ]).catch(e => { text = null; throw e; });
  }
  return text;
}

async function embedText(model, texts) {
  const [tokenizer, textModel] = await loadText(model);
  const inputs = tokenizer(texts, { padding: 'max_length', truncation: true }); // the ONNX graph is fixed at 77 tokens
  const { text_embeds } = await textModel(inputs);
  const n = text_embeds.normalize(2, -1);
  return { dims: n.dims, data: new Float32Array(n.data) };
}

async function embedImages(model, blobs) {
  const [processor, visionModel] = await loadVision(model);
  const out = [];
  let d = 0;
  for (const blob of blobs) {
    const image = await RawImage.fromBlob(blob);
    const { image_embeds } = await visionModel(await processor(image));
    const n = image_embeds.normalize(2, -1);
    d = n.dims[1];
    out.push(new Float32Array(n.data));
  }
  const data = new Float32Array(out.length * d);
  out.forEach((v, i) => data.set(v, i * d));
  return { dims: [out.length, d], data };
}

self.onmessage = async e => {
  const { id, type, payload } = e.data;
  try {
    let data;
    if (type === 'load') {
      const parts = payload.parts || ['vision'];
      await Promise.all(parts.map(p => (p === 'text' ? loadText(payload.model) : loadVision(payload.model))));
      postMessage({ type: 'progress', data: { status: 'ready', progress: 1 } });
      data = { parts };
    } else if (type === 'embedText') data = await embedText(payload.model, payload.texts);
    else if (type === 'embedImages') data = await embedImages(payload.model, payload.blobs);
    else throw new Error(`Unknown task ${type}`);
    postMessage({ id, data }, data?.data ? [data.data.buffer] : []);
  } catch (err) {
    postMessage({ id, error: typeof err === 'object' && err?.message ? err.message : `Model error (${String(err)})` });
  }
};
