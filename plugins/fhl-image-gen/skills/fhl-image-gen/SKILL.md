---
name: "fhl-image-gen"
description: "Generate or edit images using the FHL Image Gen plugin. Trigger when the user wants AI images through FHL Responses API, multi-worker image generation, batch image generation, continuous image generation, images saved to disk, or edits to existing images."
---

# FHL Image Gen

Use this skill to generate or edit raster images through FHL. Text-to-image and image-to-image are fixed to FHL Responses API. Do not route image edits to `/v1/images/edits` in this plugin.

## Script

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs"
```

On Windows PowerShell:

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs"
```

## Entry Check

Every time this skill is triggered, run:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --get-config
```

The output is JSON with masked worker key previews. Never display a full API key.

- If `workerCount` is `0`, ask the user for their FHL API key and save it with:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --set-key "<USER_KEY>"
```

- If the user wants multiple independent FHL workers, add more keys with:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --add-worker-key "<USER_KEY>" --worker-name "<NAME>"
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --list-workers
```

Do not exceed 10 workers in this plugin.

## Worker Pool Rules

This plugin now supports one plugin with many independent API workers.

- Each worker is one API key with the same FHL base URL, model settings, and fixed 2K ratio matrix
- The worker pool is capped at 10 API workers
- Single tasks use one worker only
- Multiple independent tasks run in parallel across multiple workers
- The plugin does **not** infer prompt difficulty and does **not** split one image request into many workers
- The plugin only scales out when there are many independent tasks, such as:
  - `--count`
  - `--repeat`
  - `--batch`
  - `--batch-inline`
  - `--batch-edit`
  - `--edit --count N`

Important image-edit rule:

- `--edit --image a --image b --prompt ...` without `--batch-edit` is still one combined multi-reference edit request and must stay on one worker
- `--batch-edit --edit --image a --image b ...` means each source image is its own task and may be distributed across many workers

If a retryable worker error occurs (`429`, `502`, `503`, `504`, `524`, rate limit, no available account, account pool busy, temporarily unavailable), that worker is cooled temporarily and queued work is retried on another healthy worker when possible.

If an auth/key error occurs, that worker is disabled for the current run. Other healthy workers continue.

## Codex Display Rule

This plugin must immediately show every successful saved image in the Codex conversation with an absolute-path Markdown image tag such as `![result](C:\absolute\path.png)`.

Apply this to all successful outputs from text-to-image, edit, `--count`, `--repeat`, batch, and batch edit runs. If multiple images succeed, show all successful images in the same reply and separately report any failed items. Include the worker label in the text summary when useful for troubleshooting.

Special case for large workflow batch-edit runs:

- Do not dump hundreds of images into one Codex reply
- Show the summary, failures, and only a small sample such as the first 8 successful images or one sample per scene
- The full result set stays on disk under the generated output folder

## Generate

For clear text-to-image requests, do not ask for confirmation:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --prompt "<PROMPT>"
```

Generation requests are fixed to the 2K preset matrix. Do not offer 1K or 4K choices. If the user asks for 1K, 4K, or an exact pixel size, map the request to the nearest supported fixed aspect preset and tell them: `鐢变簬瀹樻柟璇锋眰闄愬埗FHL鍙兘鎺ユ敹1K鍥惧儚锛岃缁嗚璐逛互鍚庡彴涓哄噯銆俙

Pass only `--ratio` or `--aspect` when the user asks for a shape. Do not use `--size` for normal generation or edit requests.

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --aspect 16:9
```

Supported aspects are fixed to `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `2:1`, `1:2`, `7:4`, and `4:7`. Aliases are `square=1:1`, `landscape=4:3`, and `portrait=3:4`.

The ratios `5:4`, `4:5`, `3:1`, and `1:3` are disabled in this plugin because repeated real FHL tests returned upstream `502` for them. Do not request them, and do not re-enable them unless new real tests prove they are stable.

FHL may return a near-aspect image with non-exact pixels. On Windows, the script center-crops/resizes the saved PNG to the requested `WIDTHxHEIGHT` and reports `resized from <original>`. Use `--no-resize` when testing the true upstream raster.

For same-prompt multi-image requests, use `--count 1..9`. For longer continuous runs, use `--repeat 1..50`. Each image is a separate Responses request and can be distributed to different workers:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --prompt "涓€鍙挀楸肩殑灏忕尗" --count 9 --concurrency 3 --aspect 16:9
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --prompt "涓€鍙挀楸肩殑灏忕尗" --repeat 50 --concurrency 4 --adaptive
```

## Batch Generate

Use batch mode for multiple different prompts:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --batch-inline "<PROMPT_1>" "<PROMPT_2>" "<PROMPT_3>"
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --batch "<FILE.json>"
```

If batch config is missing, ask for ratio/aspect and concurrency, then save it:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --set-batch-mode --ratio 4:3 --concurrency 3
```

## 閫氱敤鎵归噺鍥剧敓鍥?Workflow

鐪熷疄鐢熶骇浠诲姟涓嶈鎶婃煇涓骇鍝佺被鍨嬪啓姝汇€備紭鍏堜娇鐢ㄩ€氱敤 `--workflow-batch-edit`锛?
```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<鍥哄畾鍙傝€冨浘.png>" --item-dir "<鍙橀噺鍥剧墖鐩綍>" --templates "<templates.json>" --limit 100 --concurrency 10 --aspect 9:16
```

杩欎釜 workflow 鐨勬ā鍨嬫槸锛?
- `--fixed-ref` 鍙噸澶嶏紝鐢ㄤ簬鍥哄畾浜虹墿銆佸搧鐗屻€佸満鏅€侀鏍笺€佸晢鍝佸熀鍑嗗浘
- `--item-dir` 鏄壒閲忓彉閲忓浘鐩綍锛屼緥濡備骇鍝併€佹湇瑁呫€侀亾鍏枫€佸寘瑁呫€佸鍏风瓑
- `--templates` 鎴?`--template-inline` 鍐冲畾姣忎釜鍙橀噺鍥捐鐢熸垚鍝簺鍦烘櫙
- 姣忎釜鍙橀噺鍥炬槸涓€涓换鍔＄粍锛屾瘡涓ā鏉挎槸涓€寮犵嫭绔?Responses edit 鍥?- 鍙傝€冨浘椤哄簭鍥哄畾涓猴細鎵€鏈?fixed refs 鍦ㄥ墠锛屽綋鍓嶅彉閲忓浘鍦ㄦ渶鍚?- 鎻掍欢涓嶅亣璁句骇鍝佺被鍨嬶紱浜у搧璇箟蹇呴』鏉ヨ嚜鐢ㄦ埛妯℃澘鍜屽弬鑰冨浘

妯℃澘 JSON 鏀寔鏁扮粍鎴?`{ "templates": [...] }`锛?
```json
{
  "templates": [
    {
      "key": "catalog_scene",
      "label": "Catalog Scene",
      "prompt": "Use the variable item as the main reference and create a clean catalog-style scene. Do not assume product category."
    },
    {
      "key": "lifestyle_scene",
      "label": "Lifestyle Scene",
      "prompt": "Place the variable item naturally into a lifestyle environment based on the fixed references."
    }
  ]
}
```

涔熷彲浠ヤ笉鐢?JSON锛岀洿鎺ヤ紶涓€涓垨澶氫釜 inline 妯℃澘锛?
```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<鍥哄畾鍙傝€冨浘.png>" --item-dir "<鍙橀噺鍥剧墖鐩綍>" --template-inline "<鍦烘櫙鎻愮ず璇?" --limit 20 --concurrency 5 --aspect 9:16
```

鐢熶骇缁忛獙宸茬粡鍥哄寲鍦?workflow 涓細

- 鑷姩鏂偣缁窇锛氬悓涓€杈撳嚭鐩綍閲屽凡鏈夋湁鏁?PNG 浼氳烦杩?- 鑷姩琛ユ礊锛氫富鎵规缁撴潫鍚庢壂鎻忕己鍥撅紝榛樿浣庡苟鍙戣ˉ璺戠己澶遍」
- 杈撳嚭瀹屾暣鎶ュ憡锛歚manifest.json`銆乣summary.csv`銆乣failures.json`銆乣sessions.json`
- 澶辫触鍒嗙被锛歚timeout_524`銆乣no_image_result`銆乣network`銆乣content_policy`銆乣auth`銆乣retryable`銆乣fatal`
- 榛樿鎸変换鍔＄粍缁戝畾 worker锛屼紭鍏堜繚璇佺ǔ瀹氾紱鍚屼竴涓彉閲忓浘鐨勫涓満鏅敖閲忎繚鎸佽皟搴︿竴鑷?
鍐呯疆缇庣敳璇曟埓鍙槸涓€涓?preset锛屼笉鏄簳灞傞粯璁ょ瓥鐣ワ細

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<人物参考图.png>" --item-dir "<产品图目录>" --preset nail-tryon --limit 100 --concurrency 10 --aspect 9:16
```

浣跨敤鍓嶅厛 dry-run锛岀‘璁ゅ浘鐗囨暟閲忋€佹ā鏉挎暟閲忓拰鎬讳换鍔℃暟锛?
```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<鍥哄畾鍙傝€冨浘.png>" --item-dir "<鍙橀噺鍥剧墖鐩綍>" --templates "<templates.json>" --limit 10 --concurrency 10 --aspect 9:16 --dry-run
```

## Edit Existing Images

The image-to-image chain is fixed in this plugin:

- Endpoint: `POST https://www.fhl.mom/v1/responses`
- Text model: `gpt-5.5`
- Image tool: `gpt-image-2`
- Tool action: `edit`
- Input method: first one `input_text`, then one `input_image` block per source image, in order
- Output policy: `output_format:"png"`, `moderation:"low"`, `partial_images:0`, `stream:true`
- This is not a collage step and not legacy multipart edit

Default image-to-image edits use Responses API with `input_image` and the image tool `action:"edit"`:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16
```

For multiple edit variations of one source, each variation is a separate Responses request and may be scheduled to different workers:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --count 3 --concurrency 3
```

For multi-reference image-to-image, pass multiple `--image` flags. The plugin follows the desktop FHL behavior: each source image becomes its own `input_image` block inside one Responses edit request, in the same order as the CLI arguments:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --edit --image "<PATH_1>" --image "<PATH_2>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16
```

To force per-source batch behavior instead of one combined multi-reference request, opt in explicitly:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --batch-edit --edit --image "<PATH_1>" --image "<PATH_2>" --prompt "<EDIT_INSTRUCTION>" --concurrency 3
```

Do not use `--legacy-edit` or `--edit-api images` here. They are disabled so the image-edit chain stays fixed to Responses API.

## Nail Try-On Preset / Legacy Stress Test

The old `--nail-stress-test` command is kept as a compatibility shortcut for the successful nail try-on production test. For new production tasks, prefer `--workflow-batch-edit` with a custom template or `--preset nail-tryon`.

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --nail-stress-test --persona "<人物参考图.png>" --product-dir "<产品图目录>" --limit 100 --concurrency 10
```

Compatibility rules for this command:

- Fixed to `9:16` only
- Uses exactly two reference images per task, in this order:
  - reference 1: persona image
  - reference 2: one nail product image
- Selects the first `N` product images by natural numeric sort
- Generates 4 independent scene prompts per product:
  - hands closeup
  - hand half face
  - half body pose
  - full body scene
- Each scene is one independent Responses edit request and may go to a different healthy worker
- The persona image is loaded once; product images are loaded on demand task by task
- Output root defaults to:
  - `~/Pictures/fhl-image-gen/nail-stress-test_<timestamp>`
- Per-product output files are fixed to:
  - `01_hands_closeup.png`
  - `02_hand_half_face.png`
  - `03_half_body_pose.png`
  - `04_full_body_scene.png`
- The root output folder also includes:
  - `manifest.json`
  - `summary.csv`
  - `failures.json`
  - `sessions.json` in the generic workflow path

Equivalent generic workflow form:

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<人物参考图.png>" --item-dir "<产品图目录>" --preset nail-tryon --limit 100 --concurrency 10 --aspect 9:16
```

Use `--dry-run` first to verify product selection and total task count without calling FHL:

```powershell
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --nail-stress-test --persona "<人物参考图.png>" --product-dir "<产品图目录>" --limit 100 --concurrency 10 --dry-run
```

## API Contract

- Text-to-image: `POST https://www.fhl.mom/v1/responses`
- Image edit: `POST https://www.fhl.mom/v1/responses`
- Responses text model: `gpt-5.5`
- Image generation tool model: `gpt-image-2`
- Request size policy: always use the fixed 2K preset matrix and the supported aspect list above; do not request 1K, 4K, disabled ratios, or arbitrary `--size`
- Auth: `Authorization: Bearer <FHL API Key>`
- Responses body: JSON with `model`, `input`, `tools`, `tool_choice`, `reasoning`, `store:false`, and `stream:true`
- Edit Responses input: `input_text` plus one `input_image` data URL per source image, in order
- Edit Responses tool: `type:"image_generation"`, `action:"edit"`, `output_format:"png"`, `moderation:"low"`, `partial_images:0`
- Responses result parsing: final image comes from SSE event `response.output_item.done` where `item.type` is `image_generation_call` and `item.result` is base64 image data
- Worker routing rule: single task = single worker; multiple independent tasks = many workers when available
- Workflow batch edit: generic fixed refs + variable item ref + user templates. Do not assume product type.
- Workflow reliability: resume existing PNG outputs, auto repair missing outputs, and write `manifest.json`, `summary.csv`, `failures.json`, and `sessions.json`.

## Verification

After changing the script or FHL contract, run:

```powershell
node --check "$HOME\plugins\fhl-image-gen\scripts\generate.mjs"
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --help
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --get-config
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --list-workers
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --resolve-size --aspect 9:16
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --self-test-adaptive
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --self-test-edit-responses
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --self-test-workflow
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --workflow-batch-edit --fixed-ref "<人物参考图.png>" --item-dir "<产品图目录>" --preset nail-tryon --limit 10 --concurrency 10 --aspect 9:16 --dry-run
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --nail-stress-test --persona "<人物参考图.png>" --product-dir "<产品图目录>" --limit 100 --concurrency 10 --dry-run
```

When real generation or edit requests succeed, always show the successful saved images in Codex immediately with absolute-path Markdown image tags.

## Limits

- Quick same-prompt generation: 1 to 9 images
- Continuous generation: `--repeat 1..50`
- Request quality: fixed 2K
- Edit variations: 1 to 4 images
- Batch prompts: up to 20
- Batch edit source images: up to 10
- Workflow batch edit default limit: first 100 item images unless `--limit` is provided
- Workflow repair passes: default 2, configurable with `--repair-passes 0..5` or disabled with `--no-repair`
- Worker count: 1 to 10
- Worker pool concurrency: 1 to 10
- Generation timeout: 180 seconds
- Edit timeout: 180 seconds


