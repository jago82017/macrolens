# Macrolens: macro tracker PWA

An installable, offline-first calorie and macro tracker built to be hosted on **GitHub Pages** and installed on Android as a **WebAPK**. It needs no build step, framework or backend. It's plain ES modules plus IndexedDB.

## Features

- **Dashboard**: an animated calorie ring, protein/carb/fat rings with over-target laps, fiber, a water tracker, a logging streak, today's meals and a 7-day sparkline.
- **Diary**: a week strip with logged-day dots, a date picker, per-meal sections, tap to edit, long-press to delete (with undo), and "copy from yesterday".
- **Weekly overview**: a calorie bar chart against the target line, a macro adherence heat strip, an average macro-split donut, a body-weight trend (7-point moving average) and generated insights.
- **Automatic macro calculator**: Mifflin-St Jeor BMR × activity, a goal-based deficit or surplus (capped at safe limits), and a diet-style split (balanced, high protein, low carb, keto, endurance). It also runs as the first-run onboarding.
- **Barcode scanning**: uses the native `BarcodeDetector` on Chrome Android, with a ZXing-WASM fallback elsewhere. It scans a centre crop matching the reticle and requires two identical, checksum-valid reads. Torch toggle and manual entry are included.
- **Lookup chain**: local cache → **Open Food Facts** → **USDA FoodData Central** (branded UPC match). If nothing is found, a custom food is created with the barcode attached, so it scans instantly next time.
- **Search** covers your foods, ~175 built-in generic foods, Open Food Facts (branded) and USDA (Foundation / SR Legacy / FNDDS).
- **Custom foods**: per-serving or per-100 g entry, a calorie-vs-macro sanity check, and an emoji picker.
- **Snap AI**: estimates macros from a meal photo. It uses a large **NVIDIA-hosted vision model** (Nemotron 3.5 Super VL, Kimi K3.1 Pro and others) when connected, and a small **on-device model** offline (see below).
- **Coach (AI agent)**: a chat tab where a large NVIDIA-hosted model can work directly on your data. It logs food from a message or photo, searches your library and the online databases, edits or deletes entries, copies meals, creates and edits custom foods, sets targets, updates your profile, and logs weight and water. Risky actions ask first, and every change can be undone.
- **A–F food grades**: every food gets a diet-fit grade personalised to your goal and diet style. It covers protein, calorie density, fibre, sugar, saturated fat, salt, processing (NOVA) and additives (see below).
- **Celebrations**: confetti and a badge when you hit protein, calories (±5%), fiber or water, or get a "perfect macro day". Each fires once per goal per day, with haptics.
- **Storage**: persistent IndexedDB (it calls `navigator.storage.persist()`), plus JSON export/import and full reset.
- **PWA details**: a precached app shell, cache-first CDN/WASM assets, an update prompt, Android back-button support for sheets, manifest shortcuts (Scan / Snap / Diary), maskable icons, and dark/light themes.

## Cloud AI (NVIDIA) and Coach

Macrolens uses NVIDIA's free hosted models through their OpenAI-compatible API (`integrate.api.nvidia.com`). Pick models in *Profile → AI*. You can choose any vision model for photos and any chat model for Coach, and *Browse available models* shows the live catalog.

| Default | Model | Why |
|---|---|---|
| Photos | `nvidia/nemotron-3.5-super-vl-120b-a12b` | NVIDIA's flagship vision-language model |
| Coach | `moonshotai/kimi-k3.1-pro` | Vision plus tool calling, 1M context |
| Also listed | Nemotron 3 Nano Omni, GLM-5.3 Flash, Mistral Large 4, Gemma 4 31B, Nemotron 3 Ultra (text only) | |

**Cloud photo pipeline** (`js/vision.js`). The big model sees the plate; the numbers stay grounded:

1. **Library-aware prompt**: the model gets scale references (plate, cutlery, palm), density rules, your saved foods and your past corrections. It must return strict JSON per item: grams with a low/high range, count, cooking method, confidence and its own macro estimate.
2. **High accuracy** (optional): two independent passes, merged. Disagreement lowers confidence.
3. **Nutrition injection**: each item is matched to your library, the built-in database, then USDA (online). Per-100 g values come from there. The model's own numbers are only used when nothing matches, and those items are labelled *AI estimate*.
4. **Cross-checks**: the cooking method adds fat/carb deltas to plain base foods. The model's calorie estimate nudges mixed dishes richer or lighter, bounded to ±25%. Big disagreements are flagged for you to check.
5. **Learning**: when you change an item's food or weight, the correction is fed into future prompts.

If the chosen vision model is unavailable, the next vision model is tried automatically. Snap's engine switch is *Auto* (cloud when connected and online), *Cloud* or *On-device*.

**Coach harness** (`js/agent/`):
- **Loop**: the observe → act loop allows up to 12 tool rounds per message and streams replies. Reasoning is shown in a collapsible panel.
- **Tool calling**: native OpenAI-style tool calls where the model supports them. Otherwise it automatically falls back to a text protocol (`<tool_call>{…}</tool_call>`), so any chat model can drive the tools.
- **Tools**: `get_overview`, `get_diary`, `get_history`, `search_foods`, `get_food`, `lookup_barcode`, `list_my_foods`, `analyze_photo`, `log_food`, `quick_add`, `update_entry`, `delete_entry`, `copy_meal`, `create_food`, `update_food`, `delete_food`, `set_targets`, `update_profile`, `log_weight`, `log_water`.
- **Approvals**: *Profile → AI → Coach asks before*. The default asks before deletes and target/profile changes. Every change gets an **Undo** button.
- **Photos**: photos attached in chat go straight to vision-capable Coach models. `analyze_photo` runs the grounded pipeline above and returns loggable items.
- **Resilience**: a model that rejects an optional parameter (reasoning effort, thinking switch, tools, streaming) is retried without it, and the app remembers that for next time.

### Connect NVIDIA (about 3 minutes, free)

NVIDIA's API sends no CORS headers, so a browser app can't call it directly. A tiny Cloudflare Worker, `proxy/nvidia-proxy.js`, passes requests through and can hold your key. The same steps are in the app under *Profile → AI → Setup guide*, with a copy button for the code.

1. Get a key: sign in at <https://build.nvidia.com>, open any model, then **Get API Key** → **Generate**. The key starts with `nvapi-`.
2. Create the Worker: at <https://dash.cloudflare.com>, go to **Workers & Pages → Create → Create Worker** and deploy it. Then **Edit code**, paste `proxy/nvidia-proxy.js`, and **Deploy**.
3. Add the Worker variables under **Settings → Variables and Secrets**:
   - `NVIDIA_API_KEY`: type *Secret*, your key.
   - `ALLOWED_ORIGINS`: type *Text*, your site origin, e.g. `https://yourname.github.io`. Add `http://localhost:8080` for local testing.
   - Then deploy again.
4. In the app, open *Profile → AI*, paste the Worker URL as **Proxy URL**, leave the key empty, and tap **Test connection**.

Privacy: with cloud AI on, photos and Coach messages (including diary details Coach looks up) go to NVIDIA through your Worker. The key is never written into backups. Set Snap AI to *On-device* to keep photos on the phone.

## How the on-device AI works

The model is **MobileCLIP-S0** (Apple), run with **Transformers.js 3.8.1** / ONNX Runtime Web in a Web Worker. Photos never leave the phone. The model is never asked to invent numbers. It only answers multiple-choice questions about the photo, and nutrition values are **injected** from the reference database. Several runs refine the estimate:

1. **Identify**: zero-shot classification over the food vocabulary (built-ins plus your custom foods). It uses a **prompt ensemble** (4 templates per food) and **test-time augmentation**: a centre crop, a mirrored copy, a zoom onto the plate and the full uncropped frame are each embedded, then averaged.
2. **Hint injection** (optional): text like `chicken curry ~350 g` steers the label (semantic plus lexical match) and overrides the weight.
3. **Personal memory**: every photo you confirm is stored as an embedding. Future photos are matched with few-shot kNN, so the app learns your regular meals. That includes scanned products the vocabulary doesn't know, and your usual portion sizes.
4. **Portion run**: compares five portion-size prompts for the chosen food and gives a serving multiplier. It's shrunk toward a typical serving, because CLIP's size signal is weak.
5. **Preparation run** (meat, fish, veg, tofu…): steamed / grilled / pan-fried / deep-fried / creamy sauce. Each adds per-100 g fat/carb deltas, and you can override it.
6. **Calorie-density run** (mixed dishes): light versus rich, applied as a bounded ±12% adjustment to fat and carbs.
7. **Confidence**: combines top-1 probability, the margin to the runner-up, and agreement across the augmented views.

Detected candidates show as chips. Tap one to add it to a mixed plate, or search the database to correct a guess (the correction is remembered).

**Size and speed.** A photo only needs the **43 MB image tower**, which is downloaded once and cached for offline use. Text embeddings for all ~2,400 built-in prompts ship precomputed in `models/mcs0-text-v1.*` (1.3 MB, int8). The 43 MB text tower is fetched lazily, only for hints and custom foods, or when you tap *Profile → Download model now*. In testing it took about 3–7 s per photo on desktop, and phones will be slower.

## How the food grades work

Every food (search results, recents, scanned products, diary entries) shows an A–F badge. Tap a food to see the grade card and open **Why?** for every factor and its points. The diary also shows a calorie-weighted **food quality** grade for the day. Grades can be turned off in *Profile → Food grades*.

- **Personalised.** Protein is judged against *your* protein target (its share of calories). Calorie density is rewarded on a cut and neutral on a bulk. Keto checks net carbs, low-carb checks carb share, and endurance rewards starchy fuel.
- **Nutrition.** Fibre is rewarded. Sugar, saturated fat and salt use the UK FSA traffic-light thresholds (per 100 g, or per 100 ml for drinks). Natural sugar in whole fruit, veg and plain dairy isn't penalised; juice is.
- **Processing.** The NOVA group comes from Open Food Facts, is estimated from the ingredients list, or uses a typical value for generic foods.
- **Additives.** About 240 E-numbers are rated from *no known concern* to *high concern* in `js/grade-data.js`, each with a short note. Codes come from the Open Food Facts label or are parsed from ingredient text (E-numbers and names like "sucralose" or "sodium nitrite"). Custom foods have an optional ingredients box for this.
- **Caps.** Ultra-processed food can't score an A. A high-concern additive or processed meat caps at C. Alcohol, trans fats or several high-concern additives cap at D.

Products saved before grades existed are refreshed from Open Food Facts automatically when opened, or by tapping *Refresh product data*. Grades are a guide, not medical advice.

## Deploy to GitHub Pages and install on Android

1. Create a new GitHub repository (for example `macrolens`) and upload the **contents** of this folder to the repository root.
   ```bash
   git init
   ```
   ```bash
   git add .
   ```
   ```bash
   git commit -m "Macrolens PWA"
   ```
   ```bash
   git branch -M main
   ```
   ```bash
   git remote add origin https://github.com/<you>/macrolens.git
   ```
   ```bash
   git push -u origin main
   ```
2. On GitHub, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then branch `main` and folder `/ (root)`, and save. The included `.nojekyll` turns off Jekyll.
3. After a minute, open `https://<you>.github.io/macrolens/` in **Chrome on Android**.
4. Tap **⋮ → Install app**, or use the in-app *Install Macrolens* card. Chrome mints a **WebAPK**: a real launcher icon, a standalone window, app shortcuts on long-press, and it appears in Android's app list.

Every path is relative, so the app works from any sub-path. HTTPS from GitHub Pages is required for the camera, service worker and installability.

### Shipping updates

Bump `VERSION` in `sw.js` whenever you deploy changes. Installed apps detect the new worker and show an **Update** toast.

## Local development

You can serve the folder with any static server, for example:
```bash
npx serve .
```
The service worker is **skipped on `localhost`** so edits show up immediately. Add `?sw` to the URL to test offline caching. Camera access works on `localhost` and HTTPS only.

## Configuration

- **USDA API key**: the shared `DEMO_KEY` is heavily rate-limited. Get a free key at <https://fdc.nal.usda.gov/api-key-signup> and paste it in *Profile → Food databases*.
- **Open Food Facts** needs no key. Its text search sometimes sheds load with 503s, so the app retries and falls back to your country's OFF server.

## Editing the food database / AI vocabulary

The built-in foods live in `js/fooddb.js` (per-100 g values, a typical serving, a category, and whether cooking method applies). After you change them, or the prompt tables in `js/ai.js`, open `tools/build-embeddings.html` from a local server. Click **Build** and copy the two downloaded files into `models/`. Foods missing from the bundle still work, because the app encodes them on-device once the text tower is downloaded.

## Project layout

```
index.html              App shell
manifest.webmanifest    PWA / WebAPK manifest (icons, shortcuts)
sw.js                   Service worker (precache + runtime caches)
css/app.css             Design system (dark/light tokens, components)
js/app.js               Boot, hash router, theme, SW updates
js/db.js                IndexedDB wrapper + persistence
js/store.js             Domain layer + event bus (entries, foods, days, weights, backup)
js/nutrition.js         Scaling, totals, macro calculator
js/fooddb.js            Built-in reference foods (also the AI vocabulary)
js/grade.js             A–F diet-fit grading engine
js/grade-data.js        Additive ratings, ingredient aliases, typical values for generic foods
js/api.js               Open Food Facts + USDA clients and barcode lookup chain
js/scanner.js           Camera barcode scanner
js/ai.js                On-device AI estimation pipeline (scoring, injection, memory)
js/ai-worker.js         On-device model runtime (Transformers.js in a Worker)
js/cloud.js             NVIDIA client: streaming, tool calls, per-model params and fallbacks
js/vision.js            Cloud photo estimator with nutrition grounding
js/agent/agent.js       Coach harness: tool loop, approvals, undo, persistence
js/agent/tools.js       Coach tools over the diary, library, targets, weight and water
proxy/nvidia-proxy.js   Cloudflare Worker CORS proxy for NVIDIA's API
js/celebrate.js         Confetti + goal celebrations
js/views/*              Dashboard, Diary, Coach, Week, Profile
js/sheets/*             Add-food sheet, cloud Snap, food detail/forms, calculator, AI setup guide, onboarding
models/                 Precomputed MobileCLIP text embeddings
tools/                  Embedding bundle builder
```

## Data and licences

- Your data stays in your browser's IndexedDB on the device. Export a backup from *Profile*.
- Product data: © Open Food Facts contributors, [ODbL](https://opendatacommons.org/licenses/odbl/1-0/).
- USDA FoodData Central: public domain (CC0).
- MobileCLIP weights: Apple, see the [model card](https://huggingface.co/Xenova/mobileclip_s0) for licence terms.
- Transformers.js: Apache-2.0. barcode-detector / zxing-wasm: MIT.
- AI estimates are approximations. Check portion sizes for anything that matters.
