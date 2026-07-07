---
name: "fhl-image-gen"
description: "Generate or edit images using the FHL Image Gen plugin. Trigger when the user wants AI images through FHL Responses API, batch image generation, continuous or adaptive image generation, images saved to disk, or edits to existing images."
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

The output is JSON with a masked key preview. Never display the full API key. If `hasKey` is false, ask the user for their FHL API key and save it with:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --set-key "<USER_KEY>"
```

## Codex Display Rule

This plugin must immediately show every successful saved image in the Codex conversation with an absolute-path Markdown image tag such as `![result](C:\absolute\path.png)`.

Apply this to all successful outputs from text-to-image, edit, `--count`, `--repeat`, batch, and batch edit runs. If multiple images succeed, show all successful images in the same reply and separately report any failed items.

## Generate

For clear text-to-image requests, do not ask for confirmation:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --prompt "<PROMPT>"
```

Generation requests are fixed to the 2K preset matrix. Do not offer 1K or 4K choices. If the user asks for 1K, 4K, or an exact pixel size, map the request to the nearest supported fixed aspect preset and tell them: `由于官方请求限制FHL只能接收1K图像，详细计费以后台为准。`

Pass only `--ratio`/`--aspect` when the user asks for a shape. Do not use `--size` for normal generation or edit requests.

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --aspect 16:9
```

Supported aspects are fixed to `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `2:1`, `1:2`, `7:4`, and `4:7`. Aliases are `square=1:1`, `landscape=4:3`, and `portrait=3:4`.

The ratios `5:4`, `4:5`, `3:1`, and `1:3` are disabled in this plugin because repeated real FHL tests returned upstream `502` for them. Do not request them, and do not re-enable them unless new real tests prove they are stable.

FHL may return a near-aspect image with non-exact pixels. On Windows, the script center-crops/resizes the saved PNG to the requested `WIDTHxHEIGHT` and reports `resized from <original>`. Use `--no-resize` when testing the true upstream raster.

For same-prompt multi-image requests, use `--count 1..9`. For longer continuous runs, use `--repeat 1..50`. Each image is a separate Responses request:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --prompt "一只钓鱼的小猫" --count 9 --concurrency 3 --aspect 16:9
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --prompt "一只钓鱼的小猫" --repeat 50 --concurrency 4 --adaptive
```

Adaptive concurrency is enabled by default. If retryable upstream errors occur (`502`, `503`, `504`, `524`, rate limits, no available account, account pool busy, temporarily unavailable), the failed item retries up to 3 times and future queued work drops to `concurrency=1`.

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

For multiple edit variations of one source, each variation is a separate Responses request with independent retry:

```bash
node "$HOME/plugins/fhl-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --count 3
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
- Saved PNG dimensions are normalized locally to the requested `size` unless `--no-resize` is used

## Verification

After changing the script or FHL contract, run:

```powershell
node --check "$HOME\plugins\fhl-image-gen\scripts\generate.mjs"
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --help
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --get-config
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --resolve-size --aspect 9:16
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --self-test-adaptive
node "$HOME\plugins\fhl-image-gen\scripts\generate.mjs" --self-test-edit-responses
```

When real generation or edit requests succeed, always show the successful saved images in Codex immediately with absolute-path Markdown image tags.

## Limits

- Quick same-prompt generation: 1 to 9 images
- Continuous generation: `--repeat 1..50`
- Request quality: fixed 2K
- Edit variations: 1 to 4 images
- Batch prompts: up to 20
- Batch edit source images: up to 10
- Concurrency: 1 to 9
- Generation timeout: 180 seconds
- Edit timeout: 180 seconds
