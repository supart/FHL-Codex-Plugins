#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const API_ROOT = "https://www.fhl.mom";
const RESPONSES_URL = `${API_ROOT}/v1/responses`;
const TEXT_MODEL = "gpt-5.5";
const IMAGE_MODEL = "gpt-image-2";
const CONFIG_PATH = join(homedir(), ".codex", "fhl-image-gen-config.json");
const NO_PROMPT_REVISION_INSTRUCTIONS = "You are a tool runner. Pass the user prompt to image_generation VERBATIM. DO NOT rewrite, expand, polish, or revise it in any way. Use the exact text the user gave.";

const MAX_GENERATION_COUNT = 9;
const MAX_REPEAT = 50;
const MAX_CONCURRENCY = 9;
const MAX_EDIT_COUNT = 4;
const MAX_BATCH_PROMPTS = 20;
const MAX_EDIT_SOURCES = 10;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = 180_000;
const SUPPORTED_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "7:4",
  "4:7",
];
const DISABLED_RATIOS = new Set(["5:4", "4:5", "3:1", "1:3"]);

const SIZE_MATRIX = {
  "1K": {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1536x1152",
    "3:4": "1152x1536",
    "5:4": "1520x1216",
    "4:5": "1216x1520",
    "16:9": "1536x864",
    "9:16": "864x1536",
    "2:1": "1536x768",
    "1:2": "768x1536",
    "3:1": "1536x512",
    "1:3": "512x1536",
    "7:4": "1664x944",
    "4:7": "944x1664",
  },
  "2K": {
    "1:1": "2048x2048",
    "3:2": "2048x1360",
    "2:3": "1360x2048",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
    "5:4": "2040x1632",
    "4:5": "1632x2040",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "2:1": "2048x1024",
    "1:2": "1024x2048",
    "3:1": "2040x680",
    "1:3": "680x2040",
    "7:4": "2208x1264",
    "4:7": "1264x2208",
  },
  "4K": {
    "1:1": "2880x2880",
    "3:2": "3520x2352",
    "2:3": "2352x3520",
    "4:3": "3840x2880",
    "3:4": "2880x3840",
    "5:4": "3840x3072",
    "4:5": "3072x3840",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "2:1": "3840x1920",
    "1:2": "1920x3840",
    "3:1": "3840x1280",
    "1:3": "1280x3840",
    "7:4": "3808x2176",
    "4:7": "2176x3808",
  },
};

const DEFAULTS = {
  quality: "2K",
  ratio: "1:1",
  count: 1,
  concurrency: 3,
};
const FIXED_REQUEST_QUALITY = "2K";
const FHL_SIZE_LIMIT_NOTICE = "由于官方请求限制FHL只能接收1K图像，详细计费以后台为准。";

const RATIO_ALIASES = {
  square: "1:1",
  landscape: "4:3",
  portrait: "3:4",
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getApiKey() {
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error("ERROR: FHL API key is not configured. Run --set-key <key> first.");
    process.exit(1);
  }
  return config.apiKey;
}

function previewKey(key) {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 4)}...${key.slice(-2)}`;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function normalizeQuality(quality) {
  return FIXED_REQUEST_QUALITY;
}

function shouldWarnFixedQuality(quality) {
  const normalized = String(quality || "").trim().toUpperCase();
  return normalized && normalized !== FIXED_REQUEST_QUALITY;
}

function normalizeRatio(ratio) {
  const normalized = String(ratio || "").trim().toLowerCase();
  return RATIO_ALIASES[normalized] || normalized;
}

function ratioLabel(ratio) {
  const canonical = normalizeRatio(ratio);
  const alias = Object.entries(RATIO_ALIASES).find(([, value]) => value === canonical)?.[0];
  return alias ? `${canonical} (${alias})` : canonical;
}

function supportedRatioText() {
  return SUPPORTED_RATIOS.join(", ");
}

function normalizeSizeString(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return null;
  return `${parsed.width}x${parsed.height}`;
}

function aspectRatioForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return null;
  const divisor = gcd(parsed.width, parsed.height);
  if (!divisor) return null;
  return `${parsed.width / divisor}:${parsed.height / divisor}`;
}

function supportedAspectFromSize(size) {
  const aspect = aspectRatioForSize(size);
  return SUPPORTED_RATIOS.includes(aspect) ? aspect : null;
}

function isDisabledRatio(ratio) {
  return DISABLED_RATIOS.has(normalizeRatio(ratio));
}

function resolveSize(quality, ratio, explicitSize = null) {
  if (explicitSize) return normalizeSizeString(explicitSize);
  const normalizedQuality = normalizeQuality(quality);
  const normalizedRatio = normalizeRatio(ratio);
  if (!normalizedQuality) return null;
  return SIZE_MATRIX[normalizedQuality]?.[normalizedRatio] || null;
}

function clampInteger(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function timestamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
}

function resolveOutputDir(userDir) {
  const dir = userDir || join(homedir(), "Pictures", "fhl-image-gen");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function imageMimeTypeFromPath(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function imageExtensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function imageDataURLFromBuffer(buffer, mimeType) {
  return `data:${mimeType || "image/png"};base64,${buffer.toString("base64")}`;
}

function normalizeBase64Image(value) {
  if (!value || typeof value !== "string") return "";
  const comma = value.indexOf(",");
  return comma >= 0 ? value.slice(comma + 1) : value;
}

async function parseErrorResponse(res) {
  const body = await res.text().catch(() => "");
  if (!body) return `HTTP ${res.status}`;
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed?.cloudflare_error || parsed?.error_code || parsed?.error_name) {
    const title = parsed.title || parsed.error_name || "Cloudflare error";
    const retryAfter = parsed.retry_after ? ` retry_after=${parsed.retry_after}s` : "";
    return `HTTP ${res.status}: ${title}${retryAfter}`;
  }
  const lower = body.toLowerCase();
  if (lower.includes("bad gateway") || lower.includes("error code 502")) return `HTTP ${res.status}: Cloudflare Bad Gateway`;
  if (lower.includes("gateway time-out") || lower.includes("error code 504")) return `HTTP ${res.status}: Cloudflare Gateway Timeout`;
  if (lower.includes("a timeout occurred") || lower.includes("error code 524")) return `HTTP ${res.status}: Cloudflare Timeout`;
  if (parsed) {
    const message = parsed?.error?.message || parsed?.message || body;
    return `HTTP ${res.status}: ${message}`;
  }
  return `HTTP ${res.status}: ${body}`;
}

async function requestWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const text = String(error || "").toLowerCase();
  return [
    "http 429",
    "http 502",
    "http 503",
    "http 504",
    "http 524",
    "timeout",
    "rate limit",
    "too many requests",
    "no available account",
    "account pool busy",
    "please retry later",
    "temporarily unavailable",
    "overloaded",
    "fetch failed",
    "socket hang up",
    "econnreset",
    "terminated",
    "no image_generation_call result",
  ].some((pattern) => text.includes(pattern));
}

function isFatalError(error) {
  const text = String(error || "").toLowerCase();
  if (isRetryableError(text)) return false;
  return [
    "http 400",
    "http 401",
    "http 403",
    "http 404",
    "http 422",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "incorrect api key",
    "missing api key",
    "invalid parameter",
    "invalid_request",
    "unsupported",
    "model not found",
    "content policy",
    "safety policy",
    "moderation",
  ].some((pattern) => text.includes(pattern));
}

function saveBase64Image(base64, outputDir, prefix, index = null, targetSize = null) {
  const clean = normalizeBase64Image(base64);
  if (!clean) return null;
  const buffer = Buffer.from(clean, "base64");
  const suffix = Math.random().toString(36).slice(2, 6);
  const numbered = index == null ? "" : `_${index}`;
  const filename = `${prefix}_${timestamp()}${numbered}_${suffix}.png`;
  const path = join(outputDir, filename);
  writeFileSync(path, buffer);
  const resizeInfo = ensurePngTargetSize(path, targetSize);
  const finalBuffer = resizeInfo?.resized ? readFileSync(path) : buffer;
  const dimensions = readPngDimensions(finalBuffer);
  return {
    path,
    fileSize: `${(finalBuffer.length / 1024 / 1024).toFixed(2)}MB`,
    width: dimensions?.width || resizeInfo?.width || null,
    height: dimensions?.height || resizeInfo?.height || null,
    dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
    resized: !!resizeInfo?.resized,
    originalDimensions: resizeInfo?.originalWidth ? `${resizeInfo.originalWidth}x${resizeInfo.originalHeight}` : null,
    resizeError: resizeInfo?.error || null,
  };
}

function formatImageResult(result) {
  const parts = [result.fileSize].filter(Boolean);
  if (result.dimensions) parts.push(result.dimensions);
  if (result.resized && result.originalDimensions) parts.push(`resized from ${result.originalDimensions}`);
  if (result.resizeError) parts.push(`resize warning: ${result.resizeError}`);
  return parts.join(", ");
}

function extractImagesFromResponse(data) {
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .map((item) => item?.b64_json || item?.image?.b64_json || item?.base64)
    .filter((item) => typeof item === "string" && item.trim());
}

function parseSSEEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return null;
  const payload = trimmed.slice(6).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function walkForImageGenerationCall(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walkForImageGenerationCall(child);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (value.type === "image_generation_call" && value.result) return value;
    for (const child of Object.values(value)) {
      const found = walkForImageGenerationCall(child);
      if (found) return found;
    }
  }
  return null;
}

function extractImagesFromResponses(raw) {
  const images = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const event = parseSSEEventLine(line);
    if (!event) continue;
    if (event?.type === "response.output_item.done" && event?.item?.type === "image_generation_call" && event.item.result) {
      images.push(event.item.result);
      continue;
    }
    const found = walkForImageGenerationCall(event);
    if (found?.result) images.push(found.result);
  }

  if (images.length > 0) return images;
  try {
    const parsed = JSON.parse(raw);
    const found = walkForImageGenerationCall(parsed);
    if (found?.result) return [found.result];
  } catch {
    // The normal Responses path is SSE, so raw JSON is only a fallback.
  }
  return [];
}

function parseSizeForAspect(size) {
  const match = /^(\d+)x(\d+)$/i.exec(String(size || "").trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const hasSignature = buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
  if (!hasSignature || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resizePngWithPowerShell(path, width, height) {
  const command = `
$ErrorActionPreference = 'Stop'
$Path = ${powershellSingleQuoted(path)}
$TargetWidth = ${width}
$TargetHeight = ${height}
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($Path)
$bitmap = $null
$graphics = $null
$tmp = "$Path.tmp.png"
try {
  $sourceWidth = $image.Width
  $sourceHeight = $image.Height
  $targetRatio = $TargetWidth / $TargetHeight
  $sourceRatio = $sourceWidth / $sourceHeight
  if ($sourceRatio -gt $targetRatio) {
    $cropHeight = $sourceHeight
    $cropWidth = [int][Math]::Round($sourceHeight * $targetRatio)
    $cropX = [int][Math]::Floor(($sourceWidth - $cropWidth) / 2)
    $cropY = 0
  } else {
    $cropWidth = $sourceWidth
    $cropHeight = [int][Math]::Round($sourceWidth / $targetRatio)
    $cropX = 0
    $cropY = [int][Math]::Floor(($sourceHeight - $cropHeight) / 2)
  }
  $bitmap = New-Object System.Drawing.Bitmap $TargetWidth, $TargetHeight
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $dest = New-Object System.Drawing.Rectangle 0, 0, $TargetWidth, $TargetHeight
  $source = New-Object System.Drawing.Rectangle $cropX, $cropY, $cropWidth, $cropHeight
  $graphics.DrawImage($image, $dest, $source, [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Dispose(); $graphics = $null
  $image.Dispose(); $image = $null
  $bitmap.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose(); $bitmap = $null
  Move-Item -LiteralPath $tmp -Destination $Path -Force
} finally {
  if ($graphics -ne $null) { $graphics.Dispose() }
  if ($bitmap -ne $null) { $bitmap.Dispose() }
  if ($image -ne $null) { $image.Dispose() }
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
}
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], { encoding: "utf8" });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    return { ok: false, error: details || `PowerShell exited with ${result.status}` };
  }
  return { ok: true };
}

function ensurePngTargetSize(path, targetSize) {
  const target = parseSizeForAspect(targetSize);
  if (!target) return null;

  const beforeBuffer = readFileSync(path);
  const before = readPngDimensions(beforeBuffer);
  if (!before) return { resized: false, error: "Saved image is not a readable PNG" };
  if (before.width === target.width && before.height === target.height) {
    return { resized: false, width: before.width, height: before.height };
  }
  if (process.platform !== "win32") {
    return {
      resized: false,
      width: before.width,
      height: before.height,
      error: `Resize to ${targetSize} is only implemented on Windows`,
    };
  }

  const resized = resizePngWithPowerShell(path, target.width, target.height);
  if (!resized.ok) {
    return {
      resized: false,
      width: before.width,
      height: before.height,
      error: `Resize to ${targetSize} failed: ${resized.error}`,
    };
  }
  const after = readPngDimensions(readFileSync(path));
  return {
    resized: true,
    width: after?.width || target.width,
    height: after?.height || target.height,
    originalWidth: before.width,
    originalHeight: before.height,
  };
}

function gcd(left, right) {
  let a = Math.abs(Math.trunc(Number(left) || 0));
  let b = Math.abs(Math.trunc(Number(right) || 0));
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function aspectInstructionForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return "";
  const divisor = gcd(parsed.width, parsed.height);
  if (!divisor) return "";
  const aspect = `${parsed.width / divisor}:${parsed.height / divisor}`;
  const orientation = parsed.width === parsed.height
    ? "square"
    : parsed.width > parsed.height
      ? "landscape"
      : "portrait";
  return `The selected output aspect ratio is ${aspect} (${orientation}). The image_generation result MUST use a ${aspect} canvas and must not return any other aspect ratio.`;
}

function aspectPromptSuffixForSize(size) {
  const parsed = parseSizeForAspect(size);
  if (!parsed) return "";
  const divisor = gcd(parsed.width, parsed.height);
  if (!divisor) return "";
  const aspect = `${parsed.width / divisor}:${parsed.height / divisor}`;
  if (parsed.width === parsed.height) {
    return `请严格按照 ${aspect} 正方形画幅生成最终图片，整张图片必须为 ${aspect} 比例。`;
  }
  if (parsed.height > parsed.width) {
    return `请严格按照 ${aspect} 竖版画幅生成最终图片，整张图片必须为 ${aspect} 竖向构图，不要正方形，不要横版。`;
  }
  return `请严格按照 ${aspect} 横版画幅生成最终图片，整张图片必须为 ${aspect} 横向构图，不要正方形，不要竖版。`;
}

function buildResponsesImageBody(prompt, size, action, sourceDataURLs = []) {
  const aspectInstruction = aspectInstructionForSize(size);
  const aspectPromptSuffix = aspectPromptSuffixForSize(size);
  const promptText = aspectPromptSuffix ? `${prompt}\n\n${aspectPromptSuffix}` : prompt;
  const content = [{ type: "input_text", text: promptText }];
  for (const dataURL of sourceDataURLs) {
    if (dataURL) content.push({ type: "input_image", image_url: dataURL });
  }
  return {
    model: TEXT_MODEL,
    input: [{
      role: "user",
      content,
    }],
    tools: [{
      type: "image_generation",
      model: IMAGE_MODEL,
      action,
      size,
      quality: "auto",
      output_format: "png",
      moderation: "low",
      partial_images: parseSizeForAspect(size) ? 0 : 1,
    }],
    tool_choice: { type: "image_generation" },
    reasoning: { effort: "xhigh" },
    store: false,
    stream: true,
    instructions: [NO_PROMPT_REVISION_INSTRUCTIONS, aspectInstruction].filter(Boolean).join(" "),
  };
}

function buildResponsesGenerationBody(prompt, size) {
  return buildResponsesImageBody(prompt, size, "generate");
}

function buildResponsesEditBody(prompt, size, sourceDataURLs) {
  return buildResponsesImageBody(prompt, size, "edit", sourceDataURLs);
}

async function generateImage(apiKey, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const start = Date.now();
  try {
    const res = await requestWithTimeout(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildResponsesGenerationBody(prompt, size)),
    }, REQUEST_TIMEOUT_MS);
    if (!res.ok) return { ok: false, elapsed: Date.now() - start, error: await parseErrorResponse(res) };

    const raw = await res.text();
    const [base64] = extractImagesFromResponses(raw);
    const saved = saveBase64Image(base64, outputDir, "img", null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "No image_generation_call result in Responses stream" };
    return { ok: true, elapsed, ...saved };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
    };
  }
}

function loadSourceImage(imagePath) {
  if (!existsSync(imagePath)) {
    return { ok: false, elapsed: 0, error: `File does not exist: ${imagePath}`, sourceName: basename(imagePath) };
  }

  const sourceName = basename(imagePath);
  const sourceBuffer = readFileSync(imagePath);
  const mimeType = imageMimeTypeFromPath(imagePath);
  const ext = imageExtensionForMimeType(mimeType);
  return {
    ok: true,
    imagePath,
    sourceName,
    sourceBuffer,
    mimeType,
    ext,
    dataURL: imageDataURLFromBuffer(sourceBuffer, mimeType),
  };
}

function summarizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "unknown source";
  if (sources.length === 1) return sources[0].sourceName;
  return `${sources.length} refs: ${sources.map((item) => item.sourceName).join(", ")}`;
}

function loadSourceImages(imagePaths) {
  const sources = [];
  for (const imagePath of imagePaths) {
    const source = loadSourceImage(imagePath);
    if (!source.ok) return source;
    sources.push(source);
  }
  return {
    ok: true,
    sources,
    sourceName: summarizeSources(sources),
  };
}

async function editImageViaResponsesOnce(apiKey, sources, prompt, size, outputDir, options = {}) {
  const resize = options.resize !== false;
  const start = Date.now();
  const sourceDataURLs = sources.map((item) => item.dataURL).filter(Boolean);
  const sourceName = summarizeSources(sources);
  try {
    const res = await requestWithTimeout(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildResponsesEditBody(prompt, size, sourceDataURLs)),
    }, REQUEST_TIMEOUT_MS);
    if (!res.ok) return { ok: false, elapsed: Date.now() - start, error: await parseErrorResponse(res), sourceName };

    const raw = await res.text();
    const [base64] = extractImagesFromResponses(raw);
    const saved = saveBase64Image(base64, outputDir, "edit", options.saveIndex ?? null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "No image_generation_call result in Responses stream", sourceName };
    return { ok: true, elapsed, ...saved, sourceName };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
      sourceName,
    };
  }
}

async function editImage(apiKey, imagePaths, prompt, size, outputDir, count = 1, silent = false, options = {}) {
  const resize = options.resize !== false;
  const paths = Array.isArray(imagePaths) ? imagePaths : [imagePaths];
  const sourceGroup = loadSourceImages(paths);
  if (!sourceGroup.ok) return sourceGroup;
  const { sources, sourceName } = sourceGroup;

  if (!silent) {
    if (sources.length === 1) {
      console.log(`Loaded ${sources[0].sourceName} (${(sources[0].sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
    } else {
      const totalMb = sources.reduce((sum, item) => sum + item.sourceBuffer.length, 0) / 1024 / 1024;
      console.log(`Loaded ${sources.length} source images (${totalMb.toFixed(2)}MB total)`);
      for (const source of sources) {
        console.log(`- ${source.sourceName} (${(source.sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
      }
    }
  }

  const started = Date.now();
  const results = [];
  const failures = [];
  let retryCount = 0;
  for (let index = 0; index < count; index += 1) {
    const result = await generateWithRetry(apiKey, prompt, size, outputDir, {
      index,
      total: count,
      maxRetries: options.maxRetries ?? MAX_RETRIES,
      retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
      resize,
      generator: (_apiKey, _prompt, _size, _outputDir, context) => editImageViaResponsesOnce(apiKey, sources, prompt, size, outputDir, {
        resize,
        saveIndex: count > 1 ? context.index + 1 : null,
      }),
    });
    retryCount += result.retries || 0;
    if (result.ok) {
      results.push(result);
    } else {
      failures.push(result);
      break;
    }
  }

  const elapsed = Date.now() - started;
  if (failures.length > 0) {
    return {
      ok: false,
      elapsed,
      sourceName,
      results,
      failures,
      retries: retryCount,
      error: failures[0]?.error || "Edit failed",
    };
  }
  if (count > 1) return { ok: true, elapsed, results, sourceName, retries: retryCount };
  return { ok: true, elapsed, ...results[0], sourceName, retries: retryCount };
}

async function generateWithRetry(apiKey, prompt, size, outputDir, options = {}) {
  const {
    index = 0,
    total = 1,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BACKOFF_MS,
    generator = generateImage,
    resize = true,
    onRetryableFailure = () => {},
  } = options;
  let retries = 0;
  let attempts = 0;

  while (true) {
    attempts += 1;
    const result = await generator(apiKey, prompt, size, outputDir, { index, total, attempt: attempts, resize });
    if (result.ok) return { ...result, attempts, retries };

    const retryable = isRetryableError(result.error);
    const fatal = isFatalError(result.error);
    if (retryable && retries < maxRetries) {
      retries += 1;
      onRetryableFailure(result.error);
      console.log(`[${index + 1}/${total}] RETRY ${retries}/${maxRetries}: ${result.error}`);
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      continue;
    }

    return { ...result, attempts, retries, retryable, fatal };
  }
}

async function runBatch(apiKey, prompts, size, concurrency, outputDir, options = {}) {
  if (typeof options === "boolean") options = { isVariation: options };
  const {
    isVariation = false,
    adaptive = true,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BACKOFF_MS,
    generator = generateImage,
    resize = true,
    returnReport = false,
  } = options;
  const total = prompts.length;
  const results = new Array(total);
  let nextIndex = 0;
  let retryCount = 0;
  let downgraded = false;
  let fatalError = null;
  const started = Date.now();
  const initialConcurrency = Math.max(1, Math.min(Number(concurrency) || DEFAULTS.concurrency, total, MAX_CONCURRENCY));

  function triggerDowngrade(error) {
    if (!adaptive || downgraded) return;
    downgraded = true;
    console.log(`[adaptive] Retryable error detected; future queued requests will run with concurrency=1. Cause: ${error}`);
  }

  async function worker(workerId) {
    while (true) {
      if (fatalError) return;
      if (adaptive && downgraded && workerId > 0) return;
      if (nextIndex >= total) return;
      const index = nextIndex++;
      const prompt = prompts[index];
      if (!isVariation) {
        console.log(`[${index + 1}/${total}] Generating: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"`);
      }
      const result = await generateWithRetry(apiKey, prompt, size, outputDir, {
        index,
        total,
        maxRetries,
        retryDelayMs,
        generator,
        resize,
        onRetryableFailure: triggerDowngrade,
      });
      retryCount += result.retries || 0;
      results[index] = { prompt, ...result };
      console.log(result.ok
        ? `[${index + 1}/${total}] OK ${(result.elapsed / 1000).toFixed(1)}s attempts=${result.attempts}`
        : `[${index + 1}/${total}] FAILED attempts=${result.attempts} ${result.error}`);
      if (result.fatal) {
        fatalError = result.error;
        console.log(`[fatal] ${result.error}. No more queued requests will be started.`);
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: initialConcurrency }, (_, workerId) => worker(workerId)));

  for (let index = 0; index < total; index += 1) {
    if (!results[index]) {
      results[index] = {
        prompt: prompts[index],
        ok: false,
        skipped: true,
        error: fatalError ? `Skipped after fatal error: ${fatalError}` : "Not started",
      };
    }
  }

  const ok = results.filter((item) => item?.ok);
  const failed = results.filter((item) => item && !item.ok);
  const elapsed = Date.now() - started;
  const finalConcurrency = downgraded ? 1 : initialConcurrency;

  console.log("");
  if (isVariation) {
    console.log(`Prompt: "${prompts[0]}" x ${total}`);
    for (const [index, result] of ok.entries()) {
      console.log(`${index + 1}. ${basename(result.path)} ${formatImageResult(result)}`);
    }
    for (const result of failed) console.log(`FAILED: ${result.error}`);
  } else {
    for (const result of results) {
      if (result.ok) {
        console.log(`Prompt: "${result.prompt}"`);
        console.log(`Path: ${result.path}`);
        console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s, ${formatImageResult(result)}`);
      } else {
        console.log(`Prompt: "${result.prompt}"`);
        console.log(`FAILED: ${result.error}`);
      }
      console.log("");
    }
  }
  console.log(`Total: ${total}`);
  console.log(`Success: ${ok.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Retries: ${retryCount}`);
  console.log(`Adaptive downgraded: ${downgraded ? "yes" : "no"}`);
  console.log(`Final concurrency: ${finalConcurrency}`);
  console.log(`Done: ${ok.length}/${total} in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputDir}`);
  if (ok.length > 0) {
    console.log("Successful paths:");
    for (const result of ok) console.log(result.path);
  }

  const report = {
    total,
    success: ok.length,
    failed: failed.length,
    retryCount,
    downgraded,
    initialConcurrency,
    finalConcurrency,
    outputDir,
    paths: ok.map((item) => item.path),
    fatalError,
    exitCode: failed.length > 0 ? 1 : 0,
  };
  return returnReport ? report : report.exitCode;
}

async function runBatchEdit(apiKey, imagePaths, prompt, size, concurrency, outputDir, options = {}) {
  const total = imagePaths.length;
  const results = new Array(total);
  let nextIndex = 0;
  const started = Date.now();

  async function worker() {
    while (nextIndex < total) {
      const index = nextIndex++;
      const imagePath = imagePaths[index];
      console.log(`[${index + 1}/${total}] Editing: ${basename(imagePath)}`);
      const result = await editImage(apiKey, imagePath, prompt, size, outputDir, 1, true, options);
      results[index] = result;
      console.log(result.ok
        ? `[${index + 1}/${total}] OK ${(result.elapsed / 1000).toFixed(1)}s`
        : `[${index + 1}/${total}] FAILED ${result.error}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  const ok = results.filter((item) => item?.ok);
  const failed = results.filter((item) => item && !item.ok);
  const elapsed = Date.now() - started;

  console.log("");
  console.log(`Edit prompt: "${prompt}"`);
  for (const result of ok) {
    console.log(`${basename(result.path)} <- ${result.sourceName} ${formatImageResult(result)}`);
  }
  for (const result of failed) console.log(`FAILED ${result.sourceName}: ${result.error}`);
  console.log(`Done: ${ok.length}/${total} in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputDir}`);
  return failed.length > 0 ? 1 : 0;
}

async function runAdaptiveSelfTest() {
  console.log("Adaptive self-test: retryable error should retry and downgrade.");
  const retryCalls = new Map();
  const retryableReport = await runBatch("mock-key", [
    "mock retryable 1",
    "mock retryable 2",
    "mock retryable 3",
    "mock retryable 4",
    "mock retryable 5",
  ], "2048x1152", 3, "(mock-output)", {
    adaptive: true,
    isVariation: true,
    maxRetries: MAX_RETRIES,
    retryDelayMs: 0,
    returnReport: true,
    generator: async (_apiKey, _prompt, _size, _outputDir, context) => {
      const count = (retryCalls.get(context.index) || 0) + 1;
      retryCalls.set(context.index, count);
      await sleep(10);
      if (context.index === 1 && count === 1) {
        return { ok: false, elapsed: 10, error: "HTTP 502: Cloudflare Bad Gateway" };
      }
      return { ok: true, elapsed: 10, path: `mock://retryable-${context.index + 1}.png`, fileSize: "1.00KB" };
    },
  });

  const retryableOk = retryableReport.exitCode === 0
    && retryableReport.success === 5
    && retryableReport.retryCount === 1
    && retryableReport.downgraded
    && retryableReport.finalConcurrency === 1;

  console.log("");
  console.log("Adaptive self-test: fatal error should stop queued work.");
  const fatalReport = await runBatch("mock-key", [
    "mock fatal 1",
    "mock fatal 2",
    "mock fatal 3",
    "mock fatal 4",
  ], "2048x1152", 3, "(mock-output)", {
    adaptive: true,
    isVariation: true,
    retryDelayMs: 0,
    returnReport: true,
    generator: async (_apiKey, _prompt, _size, _outputDir, context) => {
      await sleep(context.index === 1 ? 5 : 20);
      if (context.index === 1) {
        return { ok: false, elapsed: 5, error: "HTTP 401: Invalid API key" };
      }
      return { ok: true, elapsed: 20, path: `mock://fatal-${context.index + 1}.png`, fileSize: "1.00KB" };
    },
  });

  const fatalOk = fatalReport.exitCode === 1
    && fatalReport.fatalError
    && fatalReport.failed >= 1;

  if (!retryableOk || !fatalOk) {
    console.error("Adaptive self-test FAILED.");
    console.error(JSON.stringify({ retryableReport, fatalReport }, null, 2));
    return 1;
  }

  console.log("");
  console.log("Adaptive self-test OK.");
  return 0;
}

async function runEditResponsesSelfTest() {
  console.log("Edit Responses self-test: payload shape and SSE extraction.");
  const sources = [
    {
      sourceName: "mock-a.png",
      sourceBuffer: Buffer.from("mock-source-a"),
      mimeType: "image/png",
      ext: "png",
      dataURL: "data:image/png;base64,bW9jay1zb3VyY2UtYQ==",
    },
    {
      sourceName: "mock-b.jpg",
      sourceBuffer: Buffer.from("mock-source-b"),
      mimeType: "image/jpeg",
      ext: "jpg",
      dataURL: "data:image/jpeg;base64,bW9jay1zb3VyY2UtYg==",
    },
  ];
  const payload = buildResponsesEditBody("mock edit prompt", "1152x2048", sources.map((item) => item.dataURL));
  const content = payload.input?.[0]?.content || [];
  const tool = payload.tools?.[0] || {};
  const payloadOk = payload.model === TEXT_MODEL
    && payload.stream === true
    && payload.store === false
    && content[0]?.type === "input_text"
    && content[1]?.type === "input_image"
    && content[1]?.image_url === sources[0].dataURL
    && content[2]?.type === "input_image"
    && content[2]?.image_url === sources[1].dataURL
    && tool.type === "image_generation"
    && tool.model === IMAGE_MODEL
    && tool.action === "edit"
    && tool.size === "1152x2048"
    && tool.output_format === "png"
    && tool.partial_images === 0
    && payload.tool_choice?.type === "image_generation";

  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const raw = `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${pngB64}"}}\n`;
  const [base64] = extractImagesFromResponses(raw);
  const outputDir = resolveOutputDir(join(tmpdir(), "fhl-image-gen-self-test"));
  const saved = saveBase64Image(base64, outputDir, "self_test_edit");
  const savedOk = !!saved?.path && existsSync(saved.path) && saved.width === 1 && saved.height === 1;

  if (!payloadOk || !savedOk) {
    console.error("Edit Responses self-test FAILED.");
    console.error(JSON.stringify({
      payloadOk,
      savedOk,
      saved,
    }, null, 2));
    return 1;
  }

  console.log("Edit Responses self-test OK.");
  console.log(`Saved: ${saved.path}`);
  return 0;
}

function parseArgs(argv) {
  const args = { prompts: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const value = argv[i];
    if (value === "--get-config") args.flags.getConfig = true;
    else if (value === "--set-key" && argv[i + 1]) args.flags.setKey = argv[++i];
    else if (value === "--set-quick-mode") args.flags.setQuickMode = true;
    else if (value === "--set-batch-mode") args.flags.setBatchMode = true;
    else if (value === "--prompt" && argv[i + 1]) args.prompts.push(argv[++i]);
    else if (value === "--quality" && argv[i + 1]) args.flags.quality = argv[++i];
    else if (value === "--ratio" && argv[i + 1]) args.flags.ratio = argv[++i];
    else if (value === "--aspect" && argv[i + 1]) args.flags.aspect = argv[++i];
    else if (value === "--size" && argv[i + 1]) args.flags.size = argv[++i];
    else if (value === "--count" && argv[i + 1]) args.flags.count = Number.parseInt(argv[++i], 10);
    else if (value === "--repeat" && argv[i + 1]) args.flags.repeat = Number.parseInt(argv[++i], 10);
    else if (value === "--output-dir" && argv[i + 1]) args.flags.outputDir = argv[++i];
    else if (value === "--concurrency" && argv[i + 1]) args.flags.concurrency = Number.parseInt(argv[++i], 10);
    else if (value === "--adaptive") args.flags.adaptive = true;
    else if (value === "--no-adaptive") args.flags.adaptive = false;
    else if (value === "--resize") args.flags.resize = true;
    else if (value === "--no-resize" || value === "--raw-output") args.flags.resize = false;
    else if (value === "--batch" && argv[i + 1]) args.flags.batchFile = argv[++i];
    else if (value === "--batch-inline") {
      args.flags.batchInline = true;
      i++;
      while (i < argv.length && !argv[i].startsWith("--")) {
        args.prompts.push(argv[i++]);
      }
      continue;
    } else if (value === "--edit") args.flags.edit = true;
    else if (value === "--batch-edit") args.flags.batchEdit = true;
    else if (value === "--legacy-edit") {
      args.flags.edit = true;
      args.flags.unsupportedEditRoute = "legacy-edit";
    } else if (value === "--edit-api" && argv[i + 1]) {
      const route = String(argv[++i]).trim().toLowerCase();
      if (route && route !== "responses") args.flags.unsupportedEditRoute = `edit-api:${route}`;
    }
    else if (value === "--image" && argv[i + 1]) {
      if (!args.flags.images) args.flags.images = [];
      args.flags.images.push(argv[++i]);
    } else if (value === "--resolve-size") args.flags.resolveSize = true;
    else if (value === "--self-test-adaptive") args.flags.selfTestAdaptive = true;
    else if (value === "--self-test-edit-responses") args.flags.selfTestEditResponses = true;
    else if (value === "--help" || value === "-h") args.flags.help = true;
    i++;
  }
  return args;
}

function printUsage() {
  console.log(`FHL Image Gen

CONFIG
  --get-config
  --set-key <key>
  --set-quick-mode --ratio R --count 1..${MAX_GENERATION_COUNT}
  --set-batch-mode --ratio R --concurrency 1..${MAX_CONCURRENCY}

GENERATE
  --prompt "..." [--ratio R|--aspect R] [--count 1..${MAX_GENERATION_COUNT}] [--no-resize]
  --prompt "..." --repeat 1..${MAX_REPEAT} [--concurrency 1..${MAX_CONCURRENCY}] [--adaptive|--no-adaptive]
  --batch prompts.json [--ratio R|--aspect R] [--concurrency N] [--no-resize]
  --batch-inline "prompt 1" "prompt 2" ... [--ratio R|--aspect R] [--concurrency N] [--no-resize]

EDIT
  --edit --image path.png --prompt "..." [--ratio R|--aspect R] [--count 1..${MAX_EDIT_COUNT}]
  --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R] [--count 1..${MAX_EDIT_COUNT}]    combine all sources in one Responses edit request
  --batch-edit --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R] [--concurrency N]
  image-to-image route is fixed to Responses API; --legacy-edit and --edit-api images are disabled

TOOLS
  --resolve-size --quality 2K --aspect 16:9
  --self-test-adaptive
  --self-test-edit-responses

DEFAULTS
  API root: ${API_ROOT}
  responses text model: ${TEXT_MODEL}
  image model: ${IMAGE_MODEL}
  edit API: responses only
  request quality: fixed ${FIXED_REQUEST_QUALITY}
  output: ~/Pictures/fhl-image-gen
  adaptive: on, concurrency ${DEFAULTS.concurrency}, retries ${MAX_RETRIES}, retry backoff ${RETRY_BACKOFF_MS / 1000}s
  notice: ${FHL_SIZE_LIMIT_NOTICE}

RATIOS
  ${supportedRatioText()}
  aliases: square=1:1, landscape=4:3, portrait=3:4
  disabled after repeated real FHL 502 tests: 5:4, 4:5, 3:1, 1:3

SIZE MATRIX
  2K: 1:1 2048x2048, 3:2 2048x1360, 2:3 1360x2048, 4:3 2048x1536, 3:4 1536x2048, 16:9 2048x1152, 9:16 1152x2048, 2:1 2048x1024, 1:2 1024x2048, 7:4 2208x1264, 4:7 1264x2208
  --size WxH is disabled. Use only --ratio/--aspect from the fixed supported list above.`);
}

function resolveGenerationParams(flags, modeConfig) {
  const requestedQuality = flags.quality || modeConfig?.quality || DEFAULTS.quality;
  const quality = normalizeQuality(requestedQuality);
  if (shouldWarnFixedQuality(requestedQuality)) {
    console.warn(`NOTICE: FHL Codex image generation is fixed to ${FIXED_REQUEST_QUALITY}; ignoring requested quality="${requestedQuality}". ${FHL_SIZE_LIMIT_NOTICE}`);
  }

  if (flags.size) {
    console.error(`ERROR: --size is disabled in this plugin. Use only --aspect/--ratio. Supported ratios: ${supportedRatioText()}. Disabled ratios: 5:4, 4:5, 3:1, 1:3.`);
    process.exit(1);
  }

  const requestedRatio = flags.aspect ?? flags.ratio ?? modeConfig?.ratio ?? DEFAULTS.ratio;
  let ratio = normalizeRatio(requestedRatio);
  if (isDisabledRatio(ratio)) {
    console.error(`ERROR: Ratio="${requestedRatio}" is disabled in this plugin because repeated real FHL tests returned upstream 502 for 5:4, 4:5, 3:1, and 1:3. Use one of: ${supportedRatioText()}.`);
    process.exit(1);
  }
  const size = resolveSize(quality, ratio);
  if (!size) {
    console.error(`ERROR: Invalid ratio="${requestedRatio}". Supported ratios: ${supportedRatioText()}. Aliases: square, landscape, portrait.`);
    process.exit(1);
  }
  return { quality, ratio, size, explicitSize: false, requestedSize: flags.size || null };
}

async function main() {
  const { prompts, flags } = parseArgs(process.argv.slice(2));

  if (flags.getConfig) {
    const config = loadConfig();
    console.log(JSON.stringify({
      hasKey: !!config?.apiKey,
      keyPreview: config?.apiKey ? previewKey(config.apiKey) : null,
      quickMode: config?.quickMode || null,
      batchMode: config?.batchMode || null,
    }, null, 2));
    return;
  }

  if (flags.setKey) {
    const config = loadConfig() || {};
    config.apiKey = flags.setKey;
    saveConfig(config);
    console.log(`FHL API key saved: ${previewKey(flags.setKey)}`);
    return;
  }

  if (flags.setQuickMode) {
    const config = loadConfig() || {};
    const previous = config.quickMode || {};
    const requestedQuality = flags.quality || previous.quality || DEFAULTS.quality;
    const quality = normalizeQuality(requestedQuality);
    if (shouldWarnFixedQuality(requestedQuality)) {
      console.warn(`NOTICE: Quick mode is fixed to ${FIXED_REQUEST_QUALITY}; ignoring requested quality="${requestedQuality}". ${FHL_SIZE_LIMIT_NOTICE}`);
    }
    const ratio = normalizeRatio(flags.aspect ?? flags.ratio ?? previous.ratio ?? DEFAULTS.ratio);
    const count = clampInteger(flags.count ?? previous.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
    const size = resolveSize(quality, ratio);
    if (!size) {
      console.error(`ERROR: Invalid ratio="${ratio}". Supported ratios: ${supportedRatioText()}.`);
      process.exit(1);
    }
    config.quickMode = { quality, ratio, count };
    saveConfig(config);
    console.log(`Quick mode saved: ${quality}, ${ratioLabel(ratio)} (${size}), count ${count}`);
    return;
  }

  if (flags.setBatchMode) {
    const config = loadConfig() || {};
    const previous = config.batchMode || {};
    const requestedQuality = flags.quality || previous.quality || DEFAULTS.quality;
    const quality = normalizeQuality(requestedQuality);
    if (shouldWarnFixedQuality(requestedQuality)) {
      console.warn(`NOTICE: Batch mode is fixed to ${FIXED_REQUEST_QUALITY}; ignoring requested quality="${requestedQuality}". ${FHL_SIZE_LIMIT_NOTICE}`);
    }
    const ratio = normalizeRatio(flags.aspect ?? flags.ratio ?? previous.ratio ?? DEFAULTS.ratio);
    const concurrency = clampInteger(flags.concurrency ?? previous.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const size = resolveSize(quality, ratio);
    if (!size) {
      console.error(`ERROR: Invalid ratio="${ratio}". Supported ratios: ${supportedRatioText()}.`);
      process.exit(1);
    }
    config.batchMode = { quality, ratio, concurrency };
    saveConfig(config);
    console.log(`Batch mode saved: ${quality}, ${ratioLabel(ratio)} (${size}), concurrency ${concurrency}`);
    return;
  }

  if (flags.resolveSize) {
    const config = loadConfig() || {};
    const { quality, ratio, size, explicitSize } = resolveGenerationParams(flags, config.quickMode);
    console.log(JSON.stringify({ quality, ratio, size, explicitSize }, null, 2));
    return;
  }

  if (flags.selfTestAdaptive) {
    process.exitCode = await runAdaptiveSelfTest();
    return;
  }

  if (flags.selfTestEditResponses) {
    process.exitCode = await runEditResponsesSelfTest();
    return;
  }

  if (flags.help || (prompts.length === 0 && !flags.batchFile && !flags.edit)) {
    printUsage();
    return;
  }

  const apiKey = getApiKey();
  const config = loadConfig() || {};
  const outputDir = resolveOutputDir(flags.outputDir);

  if (flags.edit) {
    const images = flags.images || [];
    if (images.length === 0) {
      console.error("ERROR: --edit requires at least one --image <path>.");
      process.exit(1);
    }
    if (prompts.length === 0) {
      console.error("ERROR: --edit requires --prompt <text>.");
      process.exit(1);
    }
    if (images.length > MAX_EDIT_SOURCES) {
      console.error(`ERROR: Edit supports up to ${MAX_EDIT_SOURCES} source images.`);
      process.exit(1);
    }
    if (flags.unsupportedEditRoute) {
      console.error("ERROR: Image-to-image is fixed to Responses API with input_image blocks. --legacy-edit and --edit-api images are disabled in this plugin.");
      process.exit(1);
    }
    const { size } = resolveGenerationParams(flags, config.quickMode);
    if (images.length > 1 && flags.batchEdit) {
      const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
      process.exitCode = await runBatchEdit(apiKey, images, prompts[0], size, concurrency, outputDir, {
        resize: flags.resize !== false,
      });
      return;
    }
    const count = clampInteger(flags.count, 1, MAX_EDIT_COUNT, 1);
    const result = await editImage(apiKey, images, prompts[0], size, outputDir, count, false, {
      resize: flags.resize !== false,
    });
    if (!result.ok) {
      if (result.results?.length > 0) {
        console.error("Partial edit successes:");
        for (const [index, item] of result.results.entries()) {
          console.error(`${index + 1}. ${item.path} ${formatImageResult(item)}`);
        }
      }
      console.error(`Edit failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Edit prompt: "${prompts[0]}"`);
    if (count > 1) {
      for (const [index, item] of result.results.entries()) {
        console.log(`${index + 1}. ${item.path} ${formatImageResult(item)}`);
      }
    } else {
      console.log(`Path: ${result.path}`);
      console.log(`Size: ${formatImageResult(result)}`);
    }
    console.log(`Source: ${result.sourceName}`);
    console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s`);
    return;
  }

  const isBatch = !!flags.batchFile || !!flags.batchInline;
  const modeConfig = isBatch ? config.batchMode : config.quickMode;
  const { size } = resolveGenerationParams(flags, modeConfig);

  if (flags.batchFile) {
    const raw = readFileSync(flags.batchFile, "utf8");
    const parsed = JSON.parse(raw);
    const batchPrompts = Array.isArray(parsed) ? parsed : parsed?.prompts;
    if (!Array.isArray(batchPrompts) || batchPrompts.length === 0) {
      console.error("ERROR: Batch file must be a JSON array of prompt strings or { \"prompts\": [...] }.");
      process.exit(1);
    }
    if (batchPrompts.length > MAX_BATCH_PROMPTS) {
      console.error(`ERROR: Batch generation supports up to ${MAX_BATCH_PROMPTS} prompts.`);
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(apiKey, batchPrompts.map(String), size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
    }));
  }

  if (flags.batchInline) {
    if (prompts.length > MAX_BATCH_PROMPTS) {
      console.error(`ERROR: Batch generation supports up to ${MAX_BATCH_PROMPTS} prompts.`);
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(apiKey, prompts, size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      resize: flags.resize !== false,
    }));
  }

  const prompt = prompts[0];
  const total = flags.repeat != null
    ? clampInteger(flags.repeat, 1, MAX_REPEAT, DEFAULTS.count)
    : clampInteger(flags.count ?? config.quickMode?.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
  if (total > 1) {
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(apiKey, Array(total).fill(prompt), size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      isVariation: true,
      resize: flags.resize !== false,
    }));
  }

  console.log("Generating...");
  const result = await generateImage(apiKey, prompt, size, outputDir, {
    resize: flags.resize !== false,
  });
  if (!result.ok) {
    console.error(`Generation failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`Prompt: "${prompt}"`);
  console.log(`Path: ${result.path}`);
  console.log(`Size: ${formatImageResult(result)}`);
  console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
