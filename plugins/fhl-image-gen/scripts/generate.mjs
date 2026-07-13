#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const API_ROOT = "https://www.fhl.mom";
const RESPONSES_URL = `${API_ROOT}/v1/responses`;
const IMAGES_GENERATIONS_URL = `${API_ROOT}/v1/images/generations`;
const IMAGES_EDITS_URL = `${API_ROOT}/v1/images/edits`;
const TEXT_MODEL = "gpt-5.5";
const IMAGE_MODEL = "gpt-image-2";
const APIMART_API_ROOT = String(process.env.APIMART_BASE_URL || process.env.APIMART_API_ROOT || "https://api.apib.ai").replace(/\/+$/, "");
const APIMART_GENERATIONS_URL = `${APIMART_API_ROOT}/v1/images/generations`;
const APIMART_TASKS_URL = `${APIMART_API_ROOT}/v1/tasks`;
const APIMART_MODEL = "gpt-image-2";
const APIMART_RESOLUTION = "1k";
const APIMART_COST_NOTICE = "APIMart defaults to 1k because real backend billing changes with 1k/2k/4k size tiers.";
const CONFIG_PATH = join(homedir(), ".codex", "fhl-image-gen-config.json");
const NO_PROMPT_REVISION_INSTRUCTIONS = "You are a tool runner. Pass the user prompt to image_generation VERBATIM. DO NOT rewrite, expand, polish, or revise it in any way. Use the exact text the user gave.";

const MAX_GENERATION_COUNT = 9;
const MAX_REPEAT = 50;
const MAX_CONCURRENCY = 10;
const MAX_WORKERS = 10;
const MAX_EDIT_COUNT = 4;
const MAX_BATCH_PROMPTS = 20;
const MAX_EDIT_SOURCES = 10;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = 180_000;
const APIMART_SUBMIT_TIMEOUT_MS = 240_000;
const APIMART_DOWNLOAD_TIMEOUT_MS = 60_000;
const APIMART_TASK_TIMEOUT_MS = 1_800_000;
const APIMART_POLL_INTERVAL_MS = 4_000;
const APIMART_WORKER_CONCURRENCY = Math.max(1, Math.min(Number.parseInt(process.env.APIMART_ACTIVE_LIMIT || "6", 10) || 6, MAX_CONCURRENCY));
const PROVIDER_FHL = "fhl";
const PROVIDER_APIMART = "apimart";
const FHL_API_MODE_RESPONSES = "responses";
const FHL_API_MODE_IMAGES = "images";
const PROVIDER_ALIASES = {
  fhl: PROVIDER_FHL,
  responses: PROVIDER_FHL,
  apimart: PROVIDER_APIMART,
  "api-mart": PROVIDER_APIMART,
  "apimart.ai": PROVIDER_APIMART,
};
const SUPPORTED_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "3:1",
  "1:3",
  "7:4",
  "4:7",
];
const FHL_TESTED_RATIO_SUPPORT = {
  generate: {
    "1K": [...SUPPORTED_RATIOS],
    "2K": ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "2:1", "1:2", "7:4", "4:7"],
    "4K": ["1:1", "3:2", "2:3", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "7:4", "4:7"],
  },
  edit: {
    "1K": [...SUPPORTED_RATIOS],
    "2K": [...SUPPORTED_RATIOS],
    "4K": ["1:1", "3:2", "2:3", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "7:4", "4:7"],
  },
};

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
    "5:4": "2048x1632",
    "4:5": "1632x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "2:1": "2048x1024",
    "1:2": "1024x2048",
    "3:1": "2048x688",
    "1:3": "688x2048",
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
const FHL_SIZE_LIMIT_NOTICE = "Current public FHL requests stay on the tested 2K preset. Real 1K/2K/4K ratio results are recorded in the help text and skill.";
const WORKER_ID_PREFIX = "worker-";
const DEFAULT_WORKER_NAME = "default";
const DEFAULT_WORKER_COOLDOWN_MS = 60_000;
const SCHEDULER_IDLE_MS = 25;
const IMAGE_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const WORKFLOW_DEFAULT_LIMIT = 100;
const WORKFLOW_DEFAULT_REPAIR_PASSES = 2;
const WORKFLOW_REPAIR_CONCURRENCY = 1;
const WORKFLOW_NAIL_PRESET = "nail-tryon";
const NAIL_STRESS_DEFAULT_LIMIT = 100;
const NAIL_STRESS_SCENES = [
  {
    sceneIndex: 1,
    sceneKey: "hands_closeup",
    filename: "01_hands_closeup.png",
    label: "双手前伸特写",
    instruction: "伸出双手做近距离美甲展示，镜头重点聚焦双手和美甲细节，模特脸部可以弱化但仍要保持可识别。",
  },
  {
    sceneIndex: 2,
    sceneKey: "hand_half_face",
    filename: "02_hand_half_face.png",
    label: "手遮半眼面部特写",
    instruction: "一只手自然靠近脸颊或遮住一侧眼周，肩部以上近景，特写镜头同时展示眼镜、发型、脸部识别特征和手部美甲，姿态中性自然，不要性感化。",
  },
  {
    sceneIndex: 3,
    sceneKey: "half_body_pose",
    filename: "03_half_body_pose.png",
    label: "半身像手部姿态",
    instruction: "半身像构图，画面裁切到腰部以上，双手做不同展示姿态，既体现人物气质，也要让手部美甲足够清晰可见，整体像电商 lookbook 或商品试戴参考图，不强调身体曲线，不突出裙摆和腿部。",
  },
  {
    sceneIndex: 4,
    sceneKey: "full_body_scene",
    filename: "04_full_body_scene.png",
    label: "全身场景展示",
    instruction: "全身像构图，人物完整出现在独立场景中，同时仍能清楚看到双手和美甲展示，不要把手藏起来；站姿和镜头语言保持日常、中性、保守的商品展示风格，避免任何性感化姿态或对身体曲线的强调。",
  },
];

const RATIO_ALIASES = {
  square: "1:1",
  landscape: "4:3",
  portrait: "3:4",
};

function previewKey(key) {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 4)}...${key.slice(-2)}`;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function normalizeProvider(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] || null;
}

function normalizeApimartResolution(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "1k" || normalized === "2k" || normalized === "4k") return normalized;
  return null;
}

function normalizeFhlApiMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === FHL_API_MODE_RESPONSES) return FHL_API_MODE_RESPONSES;
  if (normalized === FHL_API_MODE_IMAGES) return FHL_API_MODE_IMAGES;
  return null;
}

function configuredFhlApiMode(config) {
  return normalizeFhlApiMode(config?.fhlApiMode) || FHL_API_MODE_IMAGES;
}

function resolveFhlApiMode(config, flags = {}) {
  return normalizeFhlApiMode(flags?.fhlApiMode) || configuredFhlApiMode(config);
}

function fhlModeLabel(mode) {
  return `FHL/${normalizeFhlApiMode(mode) || FHL_API_MODE_RESPONSES}`;
}

function providerLabel(provider) {
  const normalized = normalizeProvider(provider) || PROVIDER_FHL;
  return normalized === PROVIDER_APIMART ? "APIMart" : "FHL";
}

function workerProvider(worker) {
  return normalizeProvider(worker?.provider) || PROVIDER_FHL;
}

function routeLabelForWorker(worker, fhlApiMode) {
  return workerProvider(worker) === PROVIDER_APIMART ? "APIMart" : fhlModeLabel(fhlApiMode);
}

function nextWorkerId(workers) {
  let maxId = 0;
  for (const worker of workers || []) {
    const match = new RegExp(`^${WORKER_ID_PREFIX}(\\d+)$`).exec(String(worker?.id || "").trim());
    if (!match) continue;
    maxId = Math.max(maxId, Number(match[1]) || 0);
  }
  return `${WORKER_ID_PREFIX}${maxId + 1}`;
}

function workerFallbackName(id, index) {
  if (index === 0 && id === `${WORKER_ID_PREFIX}1`) return DEFAULT_WORKER_NAME;
  return id;
}

function normalizeWorkerRecord(rawWorker, normalizedWorkers, index, now) {
  if (!rawWorker || typeof rawWorker !== "object") return null;
  const apiKey = String(rawWorker.apiKey || "").trim();
  if (!apiKey) return null;
  const provider = normalizeProvider(rawWorker.provider) || PROVIDER_FHL;

  const existingIds = new Set(normalizedWorkers.map((worker) => worker.id));
  let id = String(rawWorker.id || "").trim();
  if (!id || existingIds.has(id)) id = nextWorkerId(normalizedWorkers);

  return {
    id,
    name: String(rawWorker.name || "").trim() || workerFallbackName(id, index),
    provider,
    apiKey,
    enabled: rawWorker.enabled !== false,
    createdAt: String(rawWorker.createdAt || "").trim() || now,
  };
}

function createWorkerRecord(apiKey, name, existingWorkers = [], provider = PROVIDER_FHL) {
  const id = nextWorkerId(existingWorkers);
  const normalizedProvider = normalizeProvider(provider) || PROVIDER_FHL;
  return {
    id,
    name: String(name || "").trim() || workerFallbackName(id, existingWorkers.length),
    provider: normalizedProvider,
    apiKey: String(apiKey || "").trim(),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

function normalizeConfigShape(config) {
  const source = config && typeof config === "object" ? { ...config } : {};
  const normalized = { ...source };
  let changed = false;
  const now = new Date().toISOString();
  const normalizedWorkers = [];
  const sourceWorkers = Array.isArray(source.workers) ? source.workers : [];

  if (source.apiKey && sourceWorkers.length === 0) {
    normalizedWorkers.push({
      id: `${WORKER_ID_PREFIX}1`,
      name: DEFAULT_WORKER_NAME,
      provider: PROVIDER_FHL,
      apiKey: String(source.apiKey).trim(),
      enabled: true,
      createdAt: now,
    });
    changed = true;
  }

  for (const rawWorker of sourceWorkers) {
    const worker = normalizeWorkerRecord(rawWorker, normalizedWorkers, normalizedWorkers.length, now);
    if (!worker) {
      changed = true;
      continue;
    }
    if (
      worker.id !== rawWorker.id
      || worker.name !== rawWorker.name
      || worker.provider !== (normalizeProvider(rawWorker.provider) || PROVIDER_FHL)
      || worker.enabled !== (rawWorker.enabled !== false)
      || worker.createdAt !== rawWorker.createdAt
      || worker.apiKey !== rawWorker.apiKey
    ) {
      changed = true;
    }
    normalizedWorkers.push(worker);
  }

  normalized.workers = normalizedWorkers;
  if (source.defaultProvider != null) {
    const defaultProvider = normalizeProvider(source.defaultProvider);
    if (defaultProvider) {
      normalized.defaultProvider = defaultProvider;
      if (source.defaultProvider !== defaultProvider) changed = true;
    } else {
      delete normalized.defaultProvider;
      changed = true;
    }
  }
  if (source.fhlApiMode != null) {
    const fhlApiMode = normalizeFhlApiMode(source.fhlApiMode);
    if (fhlApiMode) {
      normalized.fhlApiMode = fhlApiMode;
      if (source.fhlApiMode !== fhlApiMode) changed = true;
    } else {
      delete normalized.fhlApiMode;
      changed = true;
    }
  }
  if ("apiKey" in normalized) {
    delete normalized.apiKey;
    changed = true;
  }
  if (!Array.isArray(source.workers)) changed = true;
  return { config: normalized, changed };
}

function saveConfig(config) {
  const { config: normalized } = normalizeConfigShape(config);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return normalizeConfigShape({}).config;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const normalized = normalizeConfigShape(parsed);
    if (normalized.changed) saveConfig(normalized.config);
    return normalized.config;
  } catch {
    return normalizeConfigShape({}).config;
  }
}

function getConfiguredWorkers(config, options = {}) {
  const requireEnabled = options.requireEnabled === true;
  const provider = normalizeProvider(options.provider);
  let workers = Array.isArray(config?.workers) ? config.workers.filter((worker) => worker?.apiKey) : [];
  if (provider) workers = workers.filter((worker) => workerProvider(worker) === provider);
  return requireEnabled ? workers.filter((worker) => worker.enabled !== false) : workers;
}

function getEnabledWorkersOrExit(config) {
  const workers = getConfiguredWorkers(config, { requireEnabled: true });
  if (workers.length === 0) {
    console.error("ERROR: No enabled FHL API worker is configured. Run --set-key <key> first.");
    process.exit(1);
  }
  return workers;
}

function findDuplicateWorkerKey(workers, apiKey, ignoreId = null) {
  const normalizedKey = String(apiKey || "").trim();
  return workers.find((worker) => worker.apiKey === normalizedKey && worker.id !== ignoreId) || null;
}

function resolveWorkerReference(config, reference) {
  const workers = getConfiguredWorkers(config);
  const ref = String(reference || "").trim();
  if (!ref) return null;

  const byIndex = Number.parseInt(ref, 10);
  if (Number.isFinite(byIndex) && String(byIndex) === ref && byIndex >= 1 && byIndex <= workers.length) {
    return { worker: workers[byIndex - 1], index: byIndex - 1 };
  }

  const index = workers.findIndex((worker) => worker.id === ref || worker.name === ref);
  if (index >= 0) return { worker: workers[index], index };
  return null;
}

function workerLabel(worker) {
  if (!worker) return "unknown-worker";
  return String(worker.name || "").trim() || String(worker.id || "").trim() || "unknown-worker";
}

function summarizeWorker(worker, index) {
  return {
    index: index + 1,
    id: worker.id,
    name: worker.name,
    provider: workerProvider(worker),
    enabled: worker.enabled !== false,
    keyPreview: previewKey(worker.apiKey),
    createdAt: worker.createdAt || null,
  };
}

function workerLimitErrorMessage(count) {
  return `ERROR: Worker pool supports up to ${MAX_WORKERS} API workers. Current configured workers: ${count}. Remove extra workers before continuing.`;
}

function isWorkerLimitExceeded(config, options = {}) {
  return getConfiguredWorkers(config, { provider: options.provider }).length > MAX_WORKERS;
}

function buildConfigSummary(config, options = {}) {
  const internal = options.internal === true;
  const workers = getConfiguredWorkers(config);
  const fhlWorkers = workers.filter((worker) => workerProvider(worker) === PROVIDER_FHL);
  const visibleWorkers = internal ? workers : fhlWorkers;
  const enabledVisibleWorkers = visibleWorkers.filter((worker) => worker.enabled !== false);
  const fhlApiMode = configuredFhlApiMode(config);
  const summary = {
    hasKey: fhlWorkers.length > 0,
    keyPreview: fhlWorkers.length === 1 ? previewKey(fhlWorkers[0].apiKey) : null,
    defaultProvider: PROVIDER_FHL,
    fhlApiMode,
    workerCount: visibleWorkers.length,
    workerLimit: MAX_WORKERS,
    workerLimitExceeded: visibleWorkers.length > MAX_WORKERS,
    enabledWorkerCount: enabledVisibleWorkers.length,
    providers: {
      [PROVIDER_FHL]: {
        apiMode: fhlApiMode,
        workerCount: fhlWorkers.length,
        enabledWorkerCount: fhlWorkers.filter((worker) => worker.enabled !== false).length,
      },
    },
    workers: visibleWorkers.map(summarizeWorker),
    quickMode: config?.quickMode || null,
    batchMode: config?.batchMode || null,
  };
  if (internal) {
    const apimartWorkers = workers.filter((worker) => workerProvider(worker) === PROVIDER_APIMART);
    summary.defaultProvider = normalizeProvider(config?.defaultProvider) || null;
    summary.workerCount = workers.length;
    summary.workerLimitExceeded = workers.length > MAX_WORKERS;
    summary.enabledWorkerCount = workers.filter((worker) => worker.enabled !== false).length;
    summary.apimartWorkerConcurrency = APIMART_WORKER_CONCURRENCY;
    summary.providers[PROVIDER_APIMART] = {
      workerCount: apimartWorkers.length,
      enabledWorkerCount: apimartWorkers.filter((worker) => worker.enabled !== false).length,
    };
  }
  return summary;
}

function printWorkerList(config, options = {}) {
  const internal = options.internal === true;
  const workers = internal
    ? getConfiguredWorkers(config)
    : getConfiguredWorkers(config, { provider: PROVIDER_FHL });
  if (workers.length === 0) {
    console.log(`FHL workers: none configured (limit ${MAX_WORKERS})`);
    return;
  }
  const enabled = workers.filter((worker) => worker.enabled !== false).length;
  console.log(`${internal ? "Workers" : "FHL workers"}: ${workers.length} total, ${enabled} enabled, limit ${MAX_WORKERS}`);
  workers.forEach((worker, index) => {
    const providerText = internal ? ` provider=${workerProvider(worker)}` : "";
    console.log(`${index + 1}. ${worker.name} [${worker.id}]${providerText} ${worker.enabled !== false ? "enabled" : "disabled"} key=${previewKey(worker.apiKey)}`);
  });
  if (workers.length > MAX_WORKERS) console.log(workerLimitErrorMessage(workers.length));
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

function normalizeApiMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "responses" || normalized === "images" || normalized === "auto") return normalized;
  return null;
}

function ratioLabel(ratio) {
  const canonical = normalizeRatio(ratio);
  const alias = Object.entries(RATIO_ALIASES).find(([, value]) => value === canonical)?.[0];
  return alias ? `${canonical} (${alias})` : canonical;
}

function normalizeOperation(operation) {
  return String(operation || "").trim().toLowerCase() === "edit" ? "edit" : "generate";
}

function testedQualityLabel(quality) {
  const normalized = String(quality || "").trim().toUpperCase();
  if (normalized === "1K" || normalized === "2K" || normalized === "4K") return normalized;
  return FIXED_REQUEST_QUALITY;
}

function supportedRatiosForRequest(options = {}) {
  const provider = normalizeProvider(options.provider) || PROVIDER_FHL;
  if (provider === PROVIDER_APIMART) return SUPPORTED_RATIOS;
  const operation = normalizeOperation(options.operation);
  const quality = testedQualityLabel(options.quality);
  return FHL_TESTED_RATIO_SUPPORT[operation]?.[quality] || [];
}

function supportedRatioText(options = {}) {
  return supportedRatiosForRequest(options).join(", ");
}

function isRatioSupportedForRequest(ratio, options = {}) {
  const normalizedRatio = normalizeRatio(ratio);
  return supportedRatiosForRequest(options).includes(normalizedRatio);
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

function resolveSizeFromMatrix(matrixKey, ratio, explicitSize = null) {
  if (explicitSize) return normalizeSizeString(explicitSize);
  const normalizedRatio = normalizeRatio(ratio);
  if (!matrixKey) return null;
  return SIZE_MATRIX[matrixKey]?.[normalizedRatio] || null;
}

function resolveSize(quality, ratio, explicitSize = null) {
  const normalizedQuality = normalizeQuality(quality);
  if (!normalizedQuality) return null;
  return resolveSizeFromMatrix(normalizedQuality, ratio, explicitSize);
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

function fileStem(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}

function sanitizePathSegment(value) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "item";
}

function naturalTokens(value) {
  return String(value || "").match(/\d+|\D+/g) || [];
}

function compareNaturalNames(left, right) {
  const leftTokens = naturalTokens(left);
  const rightTokens = naturalTokens(right);
  const max = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < max; index += 1) {
    const a = leftTokens[index];
    const b = rightTokens[index];
    if (a == null) return -1;
    if (b == null) return 1;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff;
      if (a.length !== b.length) return a.length - b.length;
      continue;
    }
    const diff = a.localeCompare(b, "zh-Hans-CN", { sensitivity: "base" });
    if (diff !== 0) return diff;
  }
  return 0;
}

function listNaturalSortedImageFiles(dir) {
  if (!existsSync(dir)) {
    throw new Error(`Product directory does not exist: ${dir}`);
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => IMAGE_FILE_EXTENSIONS.has(String(entry.name || "").slice(String(entry.name || "").lastIndexOf(".")).toLowerCase()))
    .map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
      stem: fileStem(entry.name),
    }))
    .sort((left, right) => compareNaturalNames(left.name, right.name));
  return entries;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function writeTextFileAtomic(path, content, encoding = "utf8") {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content, encoding);
  if (existsSync(path)) unlinkSync(path);
  renameSync(tmpPath, path);
}

function saveTextArtifact(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeTextFileAtomic(path, String(content || ""), "utf8");
}

function writeCsvFile(path, rows) {
  const content = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  writeTextFileAtomic(path, `${content}\n`, "utf8");
}

function buildNailStressOutputRoot(userDir) {
  return resolveOutputDir(userDir || join(homedir(), "Pictures", "fhl-image-gen", `nail-stress-test_${timestamp()}`));
}

function buildWorkflowOutputRoot(userDir) {
  return resolveOutputDir(userDir || join(homedir(), "Pictures", "fhl-image-gen", `workflow_${timestamp()}`));
}

function buildApimartRoundtripOutputRoot(userDir, resolution = APIMART_RESOLUTION) {
  const suffix = normalizeApimartResolution(resolution) || APIMART_RESOLUTION;
  return resolveOutputDir(userDir || join(homedir(), "Pictures", "fhl-image-gen", `apimart_roundtrip_${suffix}_${timestamp()}`));
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
  return parseErrorBody(res.status, body);
}

function parseErrorBody(status, body) {
  if (!body) return `HTTP ${status}`;
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed?.cloudflare_error || parsed?.error_code || parsed?.error_name) {
    const title = parsed.title || parsed.error_name || "Cloudflare error";
    const retryAfter = parsed.retry_after ? ` retry_after=${parsed.retry_after}s` : "";
    return `HTTP ${status}: ${title}${retryAfter}`;
  }
  const lower = body.toLowerCase();
  if (lower.includes("bad gateway") || lower.includes("error code 502")) return `HTTP ${status}: Cloudflare Bad Gateway`;
  if (lower.includes("gateway time-out") || lower.includes("error code 504")) return `HTTP ${status}: Cloudflare Gateway Timeout`;
  if (lower.includes("a timeout occurred") || lower.includes("error code 524")) return `HTTP ${status}: Cloudflare Timeout`;
  if (parsed) {
    const message = parsed?.error?.message || parsed?.message || body;
    return `HTTP ${status}: ${message}`;
  }
  return `HTTP ${status}: ${body}`;
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

function powerShellJsonRequest(apiKey, method, url, body = null, timeoutMs = APIMART_SUBMIT_TIMEOUT_MS) {
  const script = `
$ErrorActionPreference = 'Stop'
$headers = @{
  Accept = 'application/json'
  Authorization = "Bearer $env:APIMART_API_KEY"
}
$uri = $env:APIMART_URL
$method = $env:APIMART_METHOD
if ($env:APIMART_HAS_BODY -eq '1') {
  $json = [Console]::In.ReadToEnd()
  $response = Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -ContentType 'application/json' -Body $json
} else {
  $response = Invoke-RestMethod -Uri $uri -Method $method -Headers $headers
}
$response | ConvertTo-Json -Depth 100
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    input: body ? JSON.stringify(body) : "",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      APIMART_API_KEY: apiKey,
      APIMART_URL: url,
      APIMART_METHOD: method,
      APIMART_HAS_BODY: body ? "1" : "0",
    },
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    let details = (result.stderr || result.stdout || "").trim();
    try {
      const parsed = JSON.parse(details);
      const status = parsed.status ? `HTTP ${parsed.status}: ` : "";
      details = `${status}${parsed.body || parsed.message || details}`;
    } catch {}
    return { ok: false, error: details || `PowerShell exited with ${result.status}` };
  }
  try {
    return { ok: true, json: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `Invalid APIMart JSON response: ${error?.message || String(error)}` };
  }
}

async function requestApimartJson(apiKey, method, url, body = null, timeoutMs = APIMART_SUBMIT_TIMEOUT_MS) {
  try {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    if (body) headers["Content-Type"] = "application/json";
    const res = await requestWithTimeout(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }, timeoutMs);
    if (!res.ok) return { ok: false, error: await parseErrorResponse(res) };
    return { ok: true, json: await res.json() };
  } catch (error) {
    if (process.platform === "win32") {
      return powerShellJsonRequest(apiKey, method, url, body, timeoutMs);
    }
    return { ok: false, error: error?.message || String(error) };
  }
}

function downloadWithPowerShell(url, timeoutMs = APIMART_DOWNLOAD_TIMEOUT_MS) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const tempPath = join(tmpdir(), `apimart_image_${timestamp()}_${suffix}.bin`);
  const script = `
$ErrorActionPreference = 'Stop'
Invoke-WebRequest -Uri $env:APIMART_URL -Method Get -OutFile $env:APIMART_OUT
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      APIMART_URL: url,
      APIMART_OUT: tempPath,
    },
  });
  try {
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) {
      const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      return { ok: false, error: details || `PowerShell exited with ${result.status}` };
    }
    return { ok: true, buffer: readFileSync(tempPath) };
  } finally {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {}
  }
}

function parseApimartData(json) {
  const data = json?.data;
  if (Array.isArray(data)) return data[0] || null;
  if (data && typeof data === "object") return data;
  return json && typeof json === "object" ? json : null;
}

function apimartJsonError(json) {
  if (!json || typeof json !== "object") return "";
  const message = json?.error?.message
    || json?.error
    || json?.message
    || json?.msg
    || json?.data?.message
    || json?.data?.error;
  if (message) return String(message);
  if (json.code != null && Number(json.code) !== 200) return `APIMart code ${json.code}`;
  return "";
}

function extractApimartTaskId(json) {
  const data = parseApimartData(json);
  return String(data?.task_id || data?.taskId || data?.id || "").trim();
}

function apimartTaskStatus(json) {
  const data = parseApimartData(json);
  return String(data?.status || json?.status || "").trim().toLowerCase();
}

function isApimartDoneStatus(status) {
  return ["completed", "succeeded", "success", "done"].includes(String(status || "").toLowerCase());
}

function isApimartFailedStatus(status) {
  return ["failed", "error", "cancelled", "canceled", "rejected", "timeout", "expired"].includes(String(status || "").toLowerCase());
}

function collectApimartImagePayloads(value, payloads = [], hint = "") {
  if (value == null) return payloads;
  if (typeof value === "string") {
    const text = value.trim();
    if (/^https?:\/\//i.test(text)) payloads.push({ type: "url", value: text });
    else if (/^data:image\//i.test(text)) payloads.push({ type: "base64", value: text });
    else if (hint && /(?:base64|b64)/i.test(hint) && text.length > 128) payloads.push({ type: "base64", value: text });
    return payloads;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectApimartImagePayloads(item, payloads, hint);
    return payloads;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["url", "image_url", "imageUrl", "b64_json", "base64", "image", "images", "result", "results", "output", "outputs"].includes(key)) {
        collectApimartImagePayloads(item, payloads, key);
      }
    }
  }
  return payloads;
}

function extractApimartImagePayload(json) {
  const data = parseApimartData(json);
  const candidates = [
    data?.result,
    data?.results,
    data?.output,
    data?.outputs,
    data?.images,
    data?.image,
    data?.image_url,
    data?.imageUrl,
    data?.url,
    data?.b64_json,
    data?.base64,
  ];
  const payloads = [];
  for (const candidate of candidates) collectApimartImagePayloads(candidate, payloads);
  return payloads[0] || null;
}

function buildApimartImageBody(prompt, size, sourceDataURLs = [], options = {}) {
  const aspect = supportedAspectFromSize(size) || aspectRatioForSize(size) || DEFAULTS.ratio;
  const resolution = normalizeApimartResolution(options.resolution) || APIMART_RESOLUTION;
  const body = {
    model: APIMART_MODEL,
    prompt: String(prompt || ""),
    n: 1,
    size: aspect,
    resolution,
    official_fallback: false,
  };
  if (sourceDataURLs.length > 0) body.image_urls = sourceDataURLs;
  return body;
}

function apimartSaveTargetSize(requestedSize) {
  const aspect = supportedAspectFromSize(requestedSize) || aspectRatioForSize(requestedSize);
  const quality = APIMART_RESOLUTION.toUpperCase();
  return aspect && SIZE_MATRIX[quality]?.[aspect] ? SIZE_MATRIX[quality][aspect] : requestedSize;
}

async function submitApimartImageTask(apiKey, body) {
  const response = await requestApimartJson(apiKey, "POST", APIMART_GENERATIONS_URL, body, APIMART_SUBMIT_TIMEOUT_MS);
  if (!response.ok) return { ok: false, error: response.error };
  const json = response.json;
  const apiError = apimartJsonError(json);
  if (apiError) return { ok: false, error: apiError };
  const taskId = extractApimartTaskId(json);
  if (!taskId) return { ok: false, error: "APIMart did not return task_id" };
  return { ok: true, taskId, json };
}

async function fetchApimartTask(apiKey, taskId) {
  const url = `${APIMART_TASKS_URL}/${encodeURIComponent(taskId)}?language=zh`;
  const response = await requestApimartJson(apiKey, "GET", url, null, APIMART_SUBMIT_TIMEOUT_MS);
  if (!response.ok) return { ok: false, error: response.error };
  const json = response.json;
  const apiError = apimartJsonError(json);
  if (apiError) return { ok: false, error: apiError, json };
  return { ok: true, json };
}

async function waitForApimartImage(apiKey, taskId, start) {
  while (Date.now() - start < APIMART_TASK_TIMEOUT_MS) {
    const task = await fetchApimartTask(apiKey, taskId);
    if (!task.ok) return task;
    const status = apimartTaskStatus(task.json);
    if (isApimartDoneStatus(status)) {
      const payload = extractApimartImagePayload(task.json);
      if (payload) return { ok: true, payload, status, json: task.json };
      return { ok: false, error: "APIMart task completed without an image result", status, json: task.json };
    }
    if (isApimartFailedStatus(status)) {
      return { ok: false, error: `APIMart task ${status || "failed"}`, status, json: task.json };
    }
    await sleep(APIMART_POLL_INTERVAL_MS);
  }
  return { ok: false, error: `APIMart task timeout (${APIMART_TASK_TIMEOUT_MS / 1000}s)` };
}

async function downloadApimartImagePayload(payload) {
  if (!payload) return { ok: false, error: "Missing APIMart image payload" };
  if (payload.type === "base64") {
    return { ok: true, base64: payload.value };
  }
  try {
    const res = await requestWithTimeout(payload.value, {
      method: "GET",
      headers: { Accept: "image/*,*/*" },
    }, APIMART_DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) return { ok: false, error: await parseErrorResponse(res) };
    const arrayBuffer = await res.arrayBuffer();
    return { ok: true, buffer: Buffer.from(arrayBuffer) };
  } catch (error) {
    if (process.platform === "win32") return downloadWithPowerShell(payload.value, APIMART_DOWNLOAD_TIMEOUT_MS);
    return { ok: false, error: error?.message || String(error) };
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
    "no b64_json image",
    "images api returned url instead of b64_json",
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

function isWorkerFatalError(error) {
  const text = String(error || "").toLowerCase();
  return [
    "http 401",
    "http 403",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "incorrect api key",
    "missing api key",
  ].some((pattern) => text.includes(pattern));
}

function isTaskFatalError(error) {
  const text = String(error || "").toLowerCase();
  return [
    "http 400",
    "http 404",
    "http 422",
    "invalid parameter",
    "invalid_request",
    "unsupported",
    "model not found",
    "content policy",
    "safety policy",
    "moderation",
  ].some((pattern) => text.includes(pattern));
}

function isRouteFallbackEligible(error) {
  const text = String(error || "").toLowerCase();
  if (!text) return false;
  if (isWorkerFatalError(text) || isTaskFatalError(text)) return false;
  if (isRetryableError(text)) return true;
  return [
    "no image_generation_call result",
    "no b64_json image",
    "images api returned url instead of b64_json",
    "invalid json",
    "unexpected end of json",
    "no image result",
  ].some((pattern) => text.includes(pattern));
}

function truncateText(text, max = 60) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function buildNailScenePrompt(scene) {
  return [
    "请把第1张参考图中的固定模特，与第2张参考图中的美甲产品组合，生成一张真实自然的模特试戴图。",
    "严格保持同一模特身份与穿着不变：同一张脸、同一发型和刘海、同一副眼镜、粉色针织开衫、碎花裙、斜挎包、凉鞋，年龄感和整体气质保持一致，不要换人，不要改发型，不要改穿搭。",
    "把第1张参考图中的人物明确视为 25 岁左右的成年女性，保留其五官、发型、眼镜和穿搭特征，但不要呈现未成年感。",
    "粉色针织开衫要以保守、完整、日常穿法呈现，覆盖胸口区域；碎花裙作为普通日常裙装处理，不要强调裙长、腿部或身体曲线。",
    "第2张参考图是美甲产品款式参考，请把其中的颜色、材质、装饰、图案准确映射到模特双手的整套可穿戴美甲上，优先保证产品特征保真和手部细节清晰。",
    "整体风格必须是电商商品试戴参考图或品牌 lookbook 风格，人物姿态保持中性、自然、日常、保守，不要性感化，不要强调胸部、腰臀、腿部或身体曲线，不要做成人化呈现。",
    scene.instruction,
    "输出必须是 9:16 竖构图，人物和手部都要真实自然，不要拼图，不要多面板，不要海报文字，不要水印。",
  ].join("\n\n");
}

function saveBase64Image(base64, outputDir, prefix, index = null, targetSize = null) {
  const clean = normalizeBase64Image(base64);
  if (!clean) return null;
  const buffer = Buffer.from(clean, "base64");
  const suffix = Math.random().toString(36).slice(2, 6);
  const numbered = index == null ? "" : `_${index}`;
  const filename = `${prefix}_${timestamp()}${numbered}_${suffix}.png`;
  const path = join(outputDir, filename);
  return savePngBuffer(path, buffer, targetSize);
}

function saveImageBuffer(buffer, outputDir, prefix, index = null, targetSize = null) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const suffix = Math.random().toString(36).slice(2, 6);
  const numbered = index == null ? "" : `_${index}`;
  const filename = `${prefix}_${timestamp()}${numbered}_${suffix}.png`;
  const path = join(outputDir, filename);
  return savePngBuffer(path, buffer, targetSize);
}

function buildDerivedResizePath(path, targetSize) {
  const parsed = parse(path);
  const normalizedTarget = normalizeSizeString(targetSize) || "target";
  return join(parsed.dir, `${parsed.name}__resized_${normalizedTarget}${parsed.ext || ".png"}`);
}

function savePngBuffer(path, buffer, targetSize = null) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  const dimensions = readPngDimensions(buffer);
  let resizedCopyPath = null;
  let resizedCopyBuffer = null;
  let resizedCopyDimensions = null;
  let resizeError = null;

  if (targetSize) {
    const target = parseSizeForAspect(targetSize);
    if (!target) {
      resizeError = `Invalid resize target: ${targetSize}`;
    } else if (!dimensions || dimensions.width !== target.width || dimensions.height !== target.height) {
      resizedCopyPath = buildDerivedResizePath(path, targetSize);
      writeFileSync(resizedCopyPath, buffer);
      const resizeInfo = ensurePngTargetSize(resizedCopyPath, targetSize);
      if (resizeInfo?.error) {
        resizeError = resizeInfo.error;
        try {
          if (existsSync(resizedCopyPath)) unlinkSync(resizedCopyPath);
        } catch {}
        resizedCopyPath = null;
      } else if (existsSync(resizedCopyPath)) {
        resizedCopyBuffer = readFileSync(resizedCopyPath);
        resizedCopyDimensions = readPngDimensions(resizedCopyBuffer);
      }
    }
  }

  return {
    path,
    rawPath: path,
    fileSize: `${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
    width: dimensions?.width || null,
    height: dimensions?.height || null,
    dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
    resized: false,
    originalDimensions: null,
    resizeError,
    resizedCopyPath,
    resizedCopyFileSize: resizedCopyBuffer ? `${(resizedCopyBuffer.length / 1024 / 1024).toFixed(2)}MB` : null,
    resizedCopyWidth: resizedCopyDimensions?.width || null,
    resizedCopyHeight: resizedCopyDimensions?.height || null,
    resizedCopyDimensions: resizedCopyDimensions ? `${resizedCopyDimensions.width}x${resizedCopyDimensions.height}` : null,
  };
}

function saveBase64ImageToPath(base64, path, targetSize = null) {
  const clean = normalizeBase64Image(base64);
  if (!clean) return null;
  const buffer = Buffer.from(clean, "base64");
  return savePngBuffer(path, buffer, targetSize);
}

function buildImagesPrompt(prompt, size) {
  const aspectPromptSuffix = aspectPromptSuffixForSize(size);
  return aspectPromptSuffix ? `${prompt}\n\n${aspectPromptSuffix}` : prompt;
}

function formatImageResult(result) {
  const parts = [result.fileSize].filter(Boolean);
  if (result.dimensions) parts.push(result.dimensions);
  if (result.resizedCopyPath && result.resizedCopyDimensions) parts.push(`resized copy ${result.resizedCopyDimensions}`);
  if (result.resizeError) parts.push(`resize copy warning: ${result.resizeError}`);
  return parts.join(", ");
}

function inspectExistingImage(path) {
  if (!existsSync(path)) return null;
  const buffer = readFileSync(path);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const dimensions = readPngDimensions(buffer);
  return {
    ok: true,
    path,
    fileSize: `${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
    width: dimensions?.width || null,
    height: dimensions?.height || null,
    dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
    resized: false,
    originalDimensions: null,
    resizeError: null,
    elapsed: 0,
    attempts: 0,
    retries: 0,
    reusedExisting: true,
  };
}

function extractImagesFromResponse(data) {
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .map((item) => item?.b64_json || item?.image?.b64_json || item?.base64)
    .filter((item) => typeof item === "string" && item.trim());
}

function buildImagesGenerationBody(prompt, size) {
  return {
    model: IMAGE_MODEL,
    prompt: buildImagesPrompt(prompt, size),
    n: 1,
    size,
    quality: "auto",
    output_format: "png",
    response_format: "b64_json",
  };
}

function diagnosticImageFieldName(fieldMode, index) {
  if (fieldMode === "repeat-image") return "image";
  if (fieldMode === "array") return "image[]";
  return index === 0 ? "image" : "image[]";
}

function buildImagesEditFormWithFieldMode(prompt, size, sources, fieldMode = "mixed") {
  const form = new FormData();
  const sourceList = Array.isArray(sources) ? sources : [];
  sourceList.forEach((source, index) => {
    const field = diagnosticImageFieldName(fieldMode, index);
    const filename = source?.sourceName || `source_${index + 1}.${source?.ext || "png"}`;
    form.append(field, new Blob([source.sourceBuffer], {
      type: source?.mimeType || "image/png",
    }), filename);
  });
  form.append("prompt", buildImagesPrompt(prompt, size));
  form.append("model", IMAGE_MODEL);
  form.append("n", "1");
  form.append("size", size);
  form.append("quality", "auto");
  form.append("output_format", "png");
  form.append("response_format", "b64_json");
  return form;
}

function buildImagesEditForm(prompt, size, sources) {
  return buildImagesEditFormWithFieldMode(prompt, size, sources, "mixed");
}

function extractImagesFromImagesApiResponse(data) {
  const images = extractImagesFromResponse(data);
  if (images.length > 0) return { ok: true, images };
  const items = Array.isArray(data?.data) ? data.data : [];
  if (items.some((item) => typeof item?.url === "string" && item.url.trim())) {
    return { ok: false, error: "Images API returned URL instead of b64_json" };
  }
  return { ok: false, error: "No b64_json image in Images API response" };
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

function walkForBase64Image(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walkForBase64Image(child);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (typeof value.b64_json === "string" && value.b64_json.trim()) return value.b64_json;
    if (typeof value.partial_image_b64 === "string" && value.partial_image_b64.trim()) return value.partial_image_b64;
    if (typeof value.base64 === "string" && value.base64.trim()) return value.base64;
    for (const child of Object.values(value)) {
      const found = walkForBase64Image(child);
      if (found) return found;
    }
  }
  return null;
}

function extractImagesFromResponses(raw) {
  const images = [];
  const partialImages = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const event = parseSSEEventLine(line);
    if (!event) continue;
    if (event?.type === "response.image_generation_call.partial_image" && typeof event.partial_image_b64 === "string" && event.partial_image_b64.trim()) {
      partialImages.push(event.partial_image_b64);
      continue;
    }
    if (event?.type === "image_generation.partial_image" && typeof event.b64_json === "string" && event.b64_json.trim()) {
      partialImages.push(event.b64_json);
      continue;
    }
    if (event?.type === "image_generation.completed" && typeof event.b64_json === "string" && event.b64_json.trim()) {
      images.push(event.b64_json);
      continue;
    }
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
    const base64 = walkForBase64Image(parsed);
    if (base64) return [base64];
  } catch {
    // The normal Responses path is SSE, so raw JSON is only a fallback.
  }
  if (partialImages.length > 0) return [partialImages[partialImages.length - 1]];
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
  const resize = options.resize === true;
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
    }, task.timeoutMs || REQUEST_TIMEOUT_MS);
    if (!res.ok) return { ok: false, elapsed: Date.now() - start, error: await parseErrorResponse(res), routeLabel: fhlModeLabel(FHL_API_MODE_RESPONSES) };

    const raw = await res.text();
    const [base64] = extractImagesFromResponses(raw);
    const saved = saveBase64Image(base64, outputDir, "img", null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "No image_generation_call result in Responses stream", routeLabel: fhlModeLabel(FHL_API_MODE_RESPONSES) };
    return { ok: true, elapsed, routeLabel: fhlModeLabel(FHL_API_MODE_RESPONSES), ...saved };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
        error: error?.name === "AbortError" ? `Timeout (${(task.timeoutMs || REQUEST_TIMEOUT_MS) / 1000}s)` : error?.message || String(error),
      routeLabel: fhlModeLabel(FHL_API_MODE_RESPONSES),
    };
  }
}

async function generateImageViaImages(apiKey, prompt, size, outputDir, options = {}) {
  const resize = options.resize === true;
  const start = Date.now();
  try {
    const res = await requestWithTimeout(IMAGES_GENERATIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildImagesGenerationBody(prompt, size)),
    }, REQUEST_TIMEOUT_MS);
    if (!res.ok) return { ok: false, elapsed: Date.now() - start, error: await parseErrorResponse(res), routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };

    const raw = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, elapsed: Date.now() - start, error: "Images API returned invalid JSON", routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };
    }
    const extracted = extractImagesFromImagesApiResponse(parsed);
    if (!extracted.ok) return { ok: false, elapsed: Date.now() - start, error: extracted.error, routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };

    const saved = saveBase64Image(extracted.images[0], outputDir, "img", null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "No b64_json image in Images API response", routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };
    return { ok: true, elapsed, routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES), ...saved };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
      routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES),
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

function normalizeDiagnosticFieldMode(value) {
  const normalized = String(value || "mixed").trim().toLowerCase();
  if (["mixed", "repeat-image", "array"].includes(normalized)) return normalized;
  return null;
}

function parseDiagnosticCsv(value, fallback) {
  if (value == null || value === "") return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDiagnosticRefCounts(value, fallback = [2, 3, 5, 10]) {
  const counts = parseDiagnosticCsv(value, fallback.map(String))
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= MAX_EDIT_SOURCES);
  return [...new Set(counts)].sort((a, b) => a - b);
}

function parseDiagnosticUploadEdges(value, fallback = ["native"]) {
  return parseDiagnosticCsv(value, fallback).map((item) => {
    const normalized = String(item).trim().toLowerCase();
    if (["native", "original", "raw"].includes(normalized)) return "native";
    const parsed = Number.parseInt(normalized, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }).filter((item) => item != null);
}

function normalizeDiagnosticCombinationMode(value) {
  const normalized = String(value || "first").trim().toLowerCase();
  if (["first", "sliding"].includes(normalized)) return normalized;
  return null;
}

function selectDiagnosticSources(sources, refCount, attempt, combinationMode) {
  if (combinationMode !== "sliding") return sources.slice(0, refCount);
  const selected = [];
  const start = Math.max(0, attempt - 1);
  for (let index = 0; index < refCount; index++) {
    selected.push(sources[(start + index) % sources.length]);
  }
  return selected;
}

function diagnosticSafeName(value) {
  return String(value || "item")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function fitWithinMaxEdge(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0 || longest <= maxEdge) return { width, height, changed: false };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    changed: true,
  };
}

function resizePngFitWithPowerShell(path, width, height) {
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
  $bitmap = New-Object System.Drawing.Bitmap $TargetWidth, $TargetHeight
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $dest = New-Object System.Drawing.Rectangle 0, 0, $TargetWidth, $TargetHeight
  $graphics.DrawImage($image, $dest)
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

function makeDiagnosticUploadSources(sources, uploadRoot, maxEdge, label) {
  if (maxEdge === "native") {
    return sources.map((source, index) => ({
      ...source,
      diagnosticUpload: {
        index: index + 1,
        sourcePath: source.imagePath,
        uploadPath: source.imagePath,
        mode: "native",
        originalBytes: source.sourceBuffer.length,
        uploadBytes: source.sourceBuffer.length,
        originalDimensions: readPngDimensions(source.sourceBuffer),
        uploadDimensions: readPngDimensions(source.sourceBuffer),
      },
    }));
  }

  mkdirSync(uploadRoot, { recursive: true });
  return sources.map((source, index) => {
    const originalDimensions = readPngDimensions(source.sourceBuffer);
    const outputName = `${String(index + 1).padStart(2, "0")}_${diagnosticSafeName(parse(source.sourceName).name)}_max${maxEdge}.png`;
    const outputPath = join(uploadRoot, outputName);
    writeFileSync(outputPath, source.sourceBuffer);
    let resizeError = null;
    if (originalDimensions) {
      const fitted = fitWithinMaxEdge(originalDimensions.width, originalDimensions.height, maxEdge);
      if (fitted.changed) {
        const resized = resizePngFitWithPowerShell(outputPath, fitted.width, fitted.height);
        if (!resized.ok) resizeError = resized.error;
      }
    } else {
      resizeError = "source is not a readable PNG; copied without resizing";
    }
    const uploadBuffer = readFileSync(outputPath);
    const uploadDimensions = readPngDimensions(uploadBuffer);
    return {
      ...source,
      imagePath: outputPath,
      sourceName: basename(outputPath),
      sourceBuffer: uploadBuffer,
      mimeType: "image/png",
      ext: "png",
      dataURL: imageDataURLFromBuffer(uploadBuffer, "image/png"),
      diagnosticUpload: {
        index: index + 1,
        sourcePath: source.imagePath,
        uploadPath: outputPath,
        mode: label,
        originalBytes: source.sourceBuffer.length,
        uploadBytes: uploadBuffer.length,
        originalDimensions,
        uploadDimensions,
        resizeError,
      },
    };
  });
}

function diagnosticErrorSummary(text, max = 260) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function runFhlDiagnosticEditTask(worker, task, outputRoot) {
  const started = Date.now();
  const resultName = `${String(task.refCount).padStart(2, "0")}refs_${task.fieldMode}_${task.uploadLabel}_${worker.name || worker.id}_a${task.attempt}`;
  const resultPath = join(outputRoot, "results", `${diagnosticSafeName(resultName)}.png`);
  try {
    const res = await requestWithTimeout(IMAGES_EDITS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${worker.apiKey}`,
      },
      body: buildImagesEditFormWithFieldMode(task.prompt, task.size, task.sources, task.fieldMode),
    }, REQUEST_TIMEOUT_MS);
    const raw = await res.text();
    const elapsed = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        elapsed,
        error: diagnosticErrorSummary(await parseErrorBody(res.status, raw)),
        workerId: worker.id,
        workerName: worker.name,
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        status: res.status,
        elapsed,
        error: "Images API returned invalid JSON",
        workerId: worker.id,
        workerName: worker.name,
      };
    }
    const extracted = extractImagesFromImagesApiResponse(parsed);
    if (!extracted.ok) {
      return {
        ok: false,
        status: res.status,
        elapsed,
        error: extracted.error,
        workerId: worker.id,
        workerName: worker.name,
      };
    }
    const saved = saveBase64ImageToPath(extracted.images[0], resultPath, null);
    if (!saved) {
      return {
        ok: false,
        status: res.status,
        elapsed,
        error: "No b64_json image in Images API response",
        workerId: worker.id,
        workerName: worker.name,
      };
    }
    return {
      ok: true,
      status: res.status,
      elapsed,
      workerId: worker.id,
      workerName: worker.name,
      path: saved.path,
      fileSize: saved.fileSize,
      width: saved.width,
      height: saved.height,
      dimensions: saved.dimensions,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsed: Date.now() - started,
      error: error?.name === "AbortError" ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
      workerId: worker.id,
      workerName: worker.name,
    };
  }
}

function csvValue(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeFhlDiagnosticReports(outputRoot, manifest) {
  mkdirSync(outputRoot, { recursive: true });
  const manifestPath = join(outputRoot, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const rows = [
    ["suite", "refCount", "fieldMode", "uploadLabel", "combinationMode", "attempt", "parallel", "worker", "ok", "status", "seconds", "dimensions", "bytes", "path", "error"],
    ...manifest.results.map((item) => [
      item.suite,
      item.refCount,
      item.fieldMode,
      item.uploadLabel,
      item.combinationMode,
      item.attempt,
      item.parallel,
      item.workerName,
      item.ok,
      item.status,
      Math.round((item.elapsed || 0) / 1000),
      item.dimensions || "",
      item.bytes || "",
      item.path || "",
      item.error || "",
    ]),
  ];
  const summaryPath = join(outputRoot, "summary.csv");
  writeFileSync(summaryPath, rows.map((row) => row.map(csvValue).join(",")).join("\n"), "utf8");
  const failuresPath = join(outputRoot, "failures.json");
  writeFileSync(failuresPath, JSON.stringify(manifest.results.filter((item) => !item.ok), null, 2), "utf8");
  return { manifestPath, summaryPath, failuresPath };
}

function buildFhlDiagnosticTasks(flags, prompts, size, sources, outputRoot) {
  const suite = String(flags.diagnosticSuite || "fields").trim().toLowerCase();
  const prompt = prompts[0];
  const fieldModes = suite === "fields"
    ? parseDiagnosticCsv(flags.fieldModes || flags.fieldMode, ["mixed", "repeat-image", "array"]).map(normalizeDiagnosticFieldMode).filter(Boolean)
    : [normalizeDiagnosticFieldMode(flags.fieldMode) || "mixed"];
  const defaultRefCounts = suite === "upload" ? [3, 5, 8, 10] : [2, 3, 5, 10];
  const refCounts = parseDiagnosticRefCounts(flags.refCounts, defaultRefCounts).filter((count) => count <= sources.length);
  const uploadEdges = suite === "upload"
    ? parseDiagnosticUploadEdges(flags.uploadMaxEdges || flags.uploadMaxEdge, ["native", "1536", "1024", "768"])
    : parseDiagnosticUploadEdges(flags.uploadMaxEdges || flags.uploadMaxEdge, ["native"]);
  const attempts = clampInteger(flags.diagnosticAttempts, 1, 20, 1);
  const timeoutMs = clampInteger(flags.diagnosticTimeoutMs, 30_000, 900_000, REQUEST_TIMEOUT_MS);
  const parallel = flags.diagnosticParallel === true || suite === "concurrency";
  const combinationMode = normalizeDiagnosticCombinationMode(flags.diagnosticCombinationMode) || "first";
  const tasks = [];
  for (const fieldMode of fieldModes) {
    for (const uploadEdge of uploadEdges) {
      const uploadLabel = uploadEdge === "native" ? "native" : `max${uploadEdge}`;
      for (const refCount of refCounts) {
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const taskSources = selectDiagnosticSources(sources, refCount, attempt, combinationMode);
          const uploadRoot = join(outputRoot, "uploads", `${fieldMode}_${uploadLabel}_${String(refCount).padStart(2, "0")}refs_a${attempt}`);
          const diagnosticSources = flags.dryRun
            ? taskSources.map((source, index) => ({
              ...source,
              diagnosticUpload: {
                index: index + 1,
                sourcePath: source.imagePath,
                uploadPath: source.imagePath,
                mode: uploadLabel,
                originalBytes: source.sourceBuffer.length,
                uploadBytes: source.sourceBuffer.length,
                originalDimensions: readPngDimensions(source.sourceBuffer),
                uploadDimensions: readPngDimensions(source.sourceBuffer),
              },
            }))
            : makeDiagnosticUploadSources(taskSources, uploadRoot, uploadEdge, uploadLabel);
          tasks.push({
            suite,
            prompt,
            size,
            fieldMode,
            uploadEdge,
            uploadLabel,
            combinationMode,
            refCount,
            attempt,
            parallel,
            timeoutMs,
            sources: diagnosticSources,
          });
        }
      }
    }
  }
  return tasks;
}

async function runFhlMultirefDiagnostic(config, flags, prompts) {
  if (prompts.length === 0) {
    console.error("ERROR: --fhl-multiref-diagnostic requires --prompt <text>.");
    return 1;
  }
  const imagePaths = flags.images || [];
  if (imagePaths.length < 2) {
    console.error("ERROR: --fhl-multiref-diagnostic requires at least two --image <path> values.");
    return 1;
  }
  if (imagePaths.length > MAX_EDIT_SOURCES) {
    console.error(`ERROR: Diagnostic supports up to ${MAX_EDIT_SOURCES} source images.`);
    return 1;
  }
  const sourceGroup = loadSourceImages(imagePaths);
  if (!sourceGroup.ok) {
    console.error(`ERROR: ${sourceGroup.error}`);
    return 1;
  }
  const provider = PROVIDER_FHL;
  const workers = getConfiguredWorkers(config, { provider }).filter((worker) => worker.enabled !== false && worker.apiKey);
  if (workers.length === 0) {
    console.error("ERROR: No enabled FHL worker is configured.");
    return 1;
  }
  const requestedAspect = flags.aspect ?? flags.ratio ?? "9:16";
  const { size } = resolveGenerationParams({ ...flags, aspect: requestedAspect }, { quality: FIXED_REQUEST_QUALITY, ratio: requestedAspect }, { provider, operation: "edit" });
  const outputRoot = flags.outputDir || join(homedir(), "Pictures", "fhl-image-gen", `fhl_multiref_diagnostic_${timestamp()}`);
  const tasks = buildFhlDiagnosticTasks(flags, prompts, size, sourceGroup.sources, outputRoot);
  if (tasks.length === 0) {
    console.error("ERROR: Diagnostic task matrix is empty.");
    return 1;
  }

  console.log(`FHL multiref diagnostic`);
  console.log(`Output: ${outputRoot}`);
  console.log(`Size: ${size}`);
  console.log(`Sources: ${sourceGroup.sources.length}`);
  console.log(`Workers: ${workers.length}`);
  console.log(`Tasks: ${tasks.length}`);
  if (flags.dryRun) {
    for (const task of tasks) {
      console.log(`DRY ${task.suite} refs=${task.refCount} field=${task.fieldMode} upload=${task.uploadLabel} combo=${task.combinationMode} attempt=${task.attempt} parallel=${task.parallel}`);
    }
    return 0;
  }

  mkdirSync(join(outputRoot, "results"), { recursive: true });
  const started = Date.now();
  const runTask = async (task, index) => {
    const worker = workers[index % workers.length];
    const result = await runFhlDiagnosticEditTask(worker, task, outputRoot);
    const uploads = task.sources.map((source) => source.diagnosticUpload);
    const record = {
      suite: task.suite,
      refCount: task.refCount,
      fieldMode: task.fieldMode,
      uploadLabel: task.uploadLabel,
      combinationMode: task.combinationMode,
      attempt: task.attempt,
      parallel: task.parallel,
      requestedSize: task.size,
      timeoutMs: task.timeoutMs,
      workerId: result.workerId,
      workerName: result.workerName,
      ok: result.ok,
      status: result.status,
      elapsed: result.elapsed,
      seconds: Math.round((result.elapsed || 0) / 1000),
      path: result.path || null,
      fileSize: result.fileSize || null,
      bytes: result.path && existsSync(result.path) ? readFileSync(result.path).length : null,
      width: result.width || null,
      height: result.height || null,
      dimensions: result.dimensions || null,
      error: result.error || null,
      uploads,
    };
    console.log(`${record.ok ? "OK" : "FAIL"} refs=${record.refCount} field=${record.fieldMode} upload=${record.uploadLabel} worker=${record.workerName} status=${record.status} ${record.seconds}s${record.path ? ` ${record.path}` : ` ${record.error}`}`);
    return record;
  };

  const results = [];
  const parallel = tasks.some((task) => task.parallel);
  if (parallel) {
    results.push(...await Promise.all(tasks.map((task, index) => runTask(task, index))));
  } else {
    for (const [index, task] of tasks.entries()) {
      results.push(await runTask(task, index));
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    provider,
    route: "images_edits",
    model: IMAGE_MODEL,
    prompt: prompts[0],
    requestedSize: size,
    elapsedMs: Date.now() - started,
    sourceImages: imagePaths,
    results,
  };
  const reportPaths = writeFhlDiagnosticReports(outputRoot, manifest);
  const successCount = results.filter((item) => item.ok).length;
  console.log(`Summary: ${successCount}/${results.length} succeeded`);
  console.log(`Manifest: ${reportPaths.manifestPath}`);
  console.log(`Summary CSV: ${reportPaths.summaryPath}`);
  console.log(`Failures: ${reportPaths.failuresPath}`);
  return successCount === results.length ? 0 : 1;
}

async function editImageViaResponsesOnce(apiKey, sources, prompt, size, outputDir, options = {}) {
  const resize = options.resize === true;
  const start = Date.now();
  const sourceDataURLs = sources.map((item) => item.dataURL).filter(Boolean);
  const sourceName = summarizeSources(sources);
  const rawLogPath = options.rawLogPath || null;
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
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      if (rawLogPath) saveTextArtifact(rawLogPath, raw);
      return { ok: false, elapsed: Date.now() - start, error: parseErrorBody(res.status, raw), sourceName, routeLabel: fhlModeLabel(FHL_API_MODE_RESPONSES) };
    }

    const raw = await res.text();
    if (rawLogPath) saveTextArtifact(rawLogPath, raw);
    const [base64] = extractImagesFromResponses(raw);
    const saved = options.savePath
      ? saveBase64ImageToPath(base64, options.savePath, resize ? size : null)
      : saveBase64Image(base64, outputDir, "edit", options.saveIndex ?? null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "No image_generation_call result in Responses stream", sourceName, routeLabel: fhlModeLabel(FHL_API_MODE_RESPONSES) };
    return { ok: true, elapsed, ...saved, sourceName, routeLabel: fhlModeLabel(FHL_API_MODE_RESPONSES) };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
      sourceName,
      routeLabel: fhlModeLabel(FHL_API_MODE_RESPONSES),
    };
  }
}

async function editImageViaImagesOnce(apiKey, sources, prompt, size, outputDir, options = {}) {
  const resize = options.resize === true;
  const start = Date.now();
  const sourceName = summarizeSources(sources);
  try {
    const res = await requestWithTimeout(IMAGES_EDITS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: buildImagesEditForm(prompt, size, sources),
    }, REQUEST_TIMEOUT_MS);
    if (!res.ok) return { ok: false, elapsed: Date.now() - start, error: await parseErrorResponse(res), sourceName, routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };

    const raw = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, elapsed: Date.now() - start, error: "Images API returned invalid JSON", sourceName, routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };
    }
    const extracted = extractImagesFromImagesApiResponse(parsed);
    if (!extracted.ok) return { ok: false, elapsed: Date.now() - start, error: extracted.error, sourceName, routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };

    const saved = options.savePath
      ? saveBase64ImageToPath(extracted.images[0], options.savePath, resize ? size : null)
      : saveBase64Image(extracted.images[0], outputDir, "edit", options.saveIndex ?? null, resize ? size : null);
    const elapsed = Date.now() - start;
    if (!saved) return { ok: false, elapsed, error: "No b64_json image in Images API response", sourceName, routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };
    return { ok: true, elapsed, ...saved, sourceName, routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES) };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
      sourceName,
      routeLabel: fhlModeLabel(FHL_API_MODE_IMAGES),
    };
  }
}

async function saveApimartResult(payload, outputDir, prefix, index, targetSize) {
  const downloaded = await downloadApimartImagePayload(payload);
  if (!downloaded.ok) return downloaded;
  const saved = downloaded.base64
    ? saveBase64Image(downloaded.base64, outputDir, prefix, index, targetSize)
    : saveImageBuffer(downloaded.buffer, outputDir, prefix, index, targetSize);
  if (!saved) return { ok: false, error: "APIMart image result could not be saved" };
  return { ok: true, ...saved };
}

async function generateImageViaApimart(apiKey, prompt, size, outputDir, options = {}) {
  const resize = options.resize === true;
  const resolution = normalizeApimartResolution(options.apimartResolution) || APIMART_RESOLUTION;
  const start = Date.now();
  try {
    const submitted = await submitApimartImageTask(apiKey, buildApimartImageBody(prompt, size, [], { resolution }));
    if (!submitted.ok) return { ok: false, elapsed: Date.now() - start, error: submitted.error, routeLabel: "APIMart" };
    const completed = await waitForApimartImage(apiKey, submitted.taskId, start);
    if (!completed.ok) return { ok: false, elapsed: Date.now() - start, error: completed.error, taskId: submitted.taskId, routeLabel: "APIMart" };
    const saved = await saveApimartResult(completed.payload, outputDir, "img", null, resize ? apimartSaveTargetSize(size) : null);
    if (!saved.ok) return { ok: false, elapsed: Date.now() - start, error: saved.error, taskId: submitted.taskId, routeLabel: "APIMart" };
    return { ok: true, elapsed: Date.now() - start, taskId: submitted.taskId, routeLabel: "APIMart", ...saved };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${APIMART_TASK_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
      routeLabel: "APIMart",
    };
  }
}

async function editImageViaApimart(apiKey, sources, prompt, size, outputDir, options = {}) {
  const resize = options.resize === true;
  const resolution = normalizeApimartResolution(options.apimartResolution) || APIMART_RESOLUTION;
  const start = Date.now();
  const sourceDataURLs = sources.map((item) => item.dataURL).filter(Boolean);
  const sourceName = summarizeSources(sources);
  try {
    const submitted = await submitApimartImageTask(apiKey, buildApimartImageBody(prompt, size, sourceDataURLs, { resolution }));
    if (!submitted.ok) return { ok: false, elapsed: Date.now() - start, error: submitted.error, sourceName, routeLabel: "APIMart" };
    const completed = await waitForApimartImage(apiKey, submitted.taskId, start);
    if (!completed.ok) return { ok: false, elapsed: Date.now() - start, error: completed.error, taskId: submitted.taskId, sourceName, routeLabel: "APIMart" };
    let saved = null;
    if (options.savePath) {
      const downloaded = await downloadApimartImagePayload(completed.payload);
      if (!downloaded.ok) return { ok: false, elapsed: Date.now() - start, error: downloaded.error, taskId: submitted.taskId, sourceName, routeLabel: "APIMart" };
      saved = downloaded.base64
        ? saveBase64ImageToPath(downloaded.base64, options.savePath, resize ? apimartSaveTargetSize(size) : null)
        : savePngBuffer(options.savePath, downloaded.buffer, resize ? apimartSaveTargetSize(size) : null);
    } else {
      const result = await saveApimartResult(completed.payload, outputDir, "edit", options.saveIndex ?? null, resize ? apimartSaveTargetSize(size) : null);
      if (!result.ok) return { ok: false, elapsed: Date.now() - start, error: result.error, taskId: submitted.taskId, sourceName, routeLabel: "APIMart" };
      saved = result;
    }
    if (!saved) return { ok: false, elapsed: Date.now() - start, error: "APIMart image result could not be saved", taskId: submitted.taskId, sourceName, routeLabel: "APIMart" };
    return { ok: true, elapsed: Date.now() - start, taskId: submitted.taskId, routeLabel: "APIMart", ...saved, sourceName };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: error?.name === "AbortError" ? `Timeout (${APIMART_TASK_TIMEOUT_MS / 1000}s)` : error?.message || String(error),
      sourceName,
      routeLabel: "APIMart",
    };
  }
}

async function generateImageForWorker(worker, prompt, size, outputDir, options = {}) {
  if (workerProvider(worker) === PROVIDER_APIMART) {
    return generateImageViaApimart(worker.apiKey, prompt, size, outputDir, options);
  }
  if (normalizeFhlApiMode(options.fhlApiMode) === FHL_API_MODE_IMAGES) {
    return generateImageViaImages(worker.apiKey, prompt, size, outputDir, options);
  }
  return generateImage(worker.apiKey, prompt, size, outputDir, options);
}

async function editImageForWorker(worker, sources, prompt, size, outputDir, options = {}) {
  if (workerProvider(worker) === PROVIDER_APIMART) {
    return editImageViaApimart(worker.apiKey, sources, prompt, size, outputDir, options);
  }
  if (normalizeFhlApiMode(options.fhlApiMode) === FHL_API_MODE_IMAGES) {
    return editImageViaImagesOnce(worker.apiKey, sources, prompt, size, outputDir, options);
  }
  return editImageViaResponsesOnce(worker.apiKey, sources, prompt, size, outputDir, options);
}

function finalizeRoutedTaskResult(result, meta) {
  return {
    ...result,
    routeUsed: meta.routeUsed,
    primaryRoute: meta.primaryRoute,
    fallbackRoute: meta.fallbackRoute || null,
    fallbackTriggered: !!meta.fallbackTriggered,
    responsesError: meta.responsesError || null,
    imagesError: meta.imagesError || null,
  };
}

function composeDualRouteError(primaryRoute, primaryError, fallbackRoute, fallbackError) {
  return `${primaryRoute} failed: ${primaryError}; ${fallbackRoute} failed: ${fallbackError}`;
}

async function runSingleTaskWithApiMode(apiMode, routes) {
  const mode = normalizeApiMode(apiMode) || "auto";
  const executeRoute = async (routeName) => routes[routeName]();

  if (mode === "responses") {
    const result = await executeRoute("responses");
    return finalizeRoutedTaskResult(result, {
      routeUsed: "responses",
      primaryRoute: "responses",
      responsesError: result.ok ? null : result.error,
    });
  }

  if (mode === "images") {
    const result = await executeRoute("images");
    return finalizeRoutedTaskResult(result, {
      routeUsed: "images",
      primaryRoute: "images",
      imagesError: result.ok ? null : result.error,
    });
  }

  const primary = await executeRoute("responses");
  if (primary.ok) {
    return finalizeRoutedTaskResult(primary, {
      routeUsed: "responses",
      primaryRoute: "responses",
    });
  }

  if (!isRouteFallbackEligible(primary.error)) {
    return finalizeRoutedTaskResult(primary, {
      routeUsed: "responses",
      primaryRoute: "responses",
      responsesError: primary.error,
    });
  }

  const fallback = await executeRoute("images");
  if (fallback.ok) {
    return finalizeRoutedTaskResult(fallback, {
      routeUsed: "images",
      primaryRoute: "responses",
      fallbackRoute: "images",
      fallbackTriggered: true,
      responsesError: primary.error,
    });
  }

  return finalizeRoutedTaskResult({
    ...fallback,
    error: composeDualRouteError("responses", primary.error, "images", fallback.error),
  }, {
    routeUsed: "images",
    primaryRoute: "responses",
    fallbackRoute: "images",
    fallbackTriggered: true,
    responsesError: primary.error,
    imagesError: fallback.error,
  });
}

function createWorkerSession(worker) {
  return {
    ...worker,
    busy: false,
    fatal: false,
    disabledUntil: 0,
    lastError: null,
    used: false,
    stats: {
      assigned: 0,
      success: 0,
      failed: 0,
      retries: 0,
      cooldowns: 0,
      fatalErrors: 0,
    },
  };
}

function workerSlotCount(worker) {
  return workerProvider(worker) === PROVIDER_APIMART ? APIMART_WORKER_CONCURRENCY : 1;
}

function createWorkerSessions(workers) {
  const sessions = [];
  for (const worker of workers) {
    const slots = workerSlotCount(worker);
    if (slots <= 1) {
      sessions.push(createWorkerSession(worker));
      continue;
    }
    for (let index = 0; index < slots; index += 1) {
      sessions.push(createWorkerSession({
        ...worker,
        id: `${worker.id}#${index + 1}`,
        name: `${worker.name || worker.id}#${index + 1}`,
        baseWorkerId: worker.id,
        slotIndex: index + 1,
        slotCount: slots,
      }));
    }
  }
  return sessions;
}

function activeWorkerCount(sessions) {
  return sessions.filter((worker) => worker.enabled !== false && !worker.fatal).length;
}

function hasPotentialWorkerSessions(sessions) {
  return activeWorkerCount(sessions) > 0;
}

function schedulerCooldownMs(sessions, retryDelayMs, cooldownMs) {
  return activeWorkerCount(sessions) > 1 ? cooldownMs : retryDelayMs;
}

function findAvailableWorker(sessions) {
  const now = Date.now();
  const candidates = sessions.filter((worker) => worker.enabled !== false && !worker.fatal && !worker.busy && worker.disabledUntil <= now);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    if (left.stats.assigned !== right.stats.assigned) return left.stats.assigned - right.stats.assigned;
    if (left.disabledUntil !== right.disabledUntil) return left.disabledUntil - right.disabledUntil;
    return left.id.localeCompare(right.id);
  });
  return candidates[0];
}

function nextAvailableWorkerDelayMs(sessions) {
  const now = Date.now();
  const delays = sessions
    .filter((worker) => worker.enabled !== false && !worker.fatal && !worker.busy && worker.disabledUntil > now)
    .map((worker) => worker.disabledUntil - now);
  if (delays.length === 0) return null;
  return Math.max(1, Math.min(...delays));
}

function createTaskStates(tasks) {
  return tasks.map((task, index) => ({
    index,
    payload: task,
    pending: true,
    running: false,
    done: false,
    notBefore: 0,
    attempts: 0,
    retries: 0,
    finalResult: null,
  }));
}

function takeNextReadyTask(taskStates) {
  const now = Date.now();
  const task = taskStates.find((item) => item.pending && !item.running && !item.done && item.notBefore <= now);
  if (!task) return null;
  task.pending = false;
  task.running = true;
  return task;
}

function taskGroupKey(taskState) {
  const raw = taskState?.payload?.groupKey;
  if (raw == null) return "";
  const key = String(raw).trim();
  return key || "";
}

function hasRemainingGroupTasks(taskStates, groupKey) {
  if (!groupKey) return false;
  return taskStates.some((task) => {
    if (task.done) return false;
    return taskGroupKey(task) === groupKey;
  });
}

function availableWorkerSessions(sessions) {
  const now = Date.now();
  return sessions
    .filter((worker) => worker.enabled !== false && !worker.fatal && !worker.busy && worker.disabledUntil <= now)
    .sort((left, right) => {
      if (left.stats.assigned !== right.stats.assigned) return left.stats.assigned - right.stats.assigned;
      if (left.disabledUntil !== right.disabledUntil) return left.disabledUntil - right.disabledUntil;
      return left.id.localeCompare(right.id);
    });
}

function takeNextStickyTaskAssignment(taskStates, sessions, groupAssignments, runningGroups) {
  const now = Date.now();
  const ready = taskStates.filter((item) => item.pending && !item.running && !item.done && item.notBefore <= now);
  if (ready.length === 0) return null;
  const available = availableWorkerSessions(sessions);
  if (available.length === 0) return null;

  for (const task of ready) {
    const groupKey = taskGroupKey(task);
    if (!groupKey || runningGroups.has(groupKey)) continue;
    const assignedWorkerId = groupAssignments.get(groupKey);
    if (!assignedWorkerId) continue;
    const worker = available.find((candidate) => candidate.id === assignedWorkerId);
    if (!worker) continue;
    task.pending = false;
    task.running = true;
    runningGroups.add(groupKey);
    return { taskState: task, worker };
  }

  for (const task of ready) {
    const groupKey = taskGroupKey(task);
    if (!groupKey || runningGroups.has(groupKey) || groupAssignments.has(groupKey)) continue;
    const worker = available[0];
    task.pending = false;
    task.running = true;
    groupAssignments.set(groupKey, worker.id);
    runningGroups.add(groupKey);
    return { taskState: task, worker };
  }

  const plain = ready.find((task) => !taskGroupKey(task));
  if (!plain) return null;
  plain.pending = false;
  plain.running = true;
  return { taskState: plain, worker: available[0] };
}

function nextTaskDelayMs(taskStates) {
  const now = Date.now();
  const delays = taskStates
    .filter((task) => task.pending && !task.running && !task.done && task.notBefore > now)
    .map((task) => task.notBefore - now);
  if (delays.length === 0) return null;
  return Math.max(1, Math.min(...delays));
}

function completeTask(taskState, result) {
  taskState.pending = false;
  taskState.running = false;
  taskState.done = true;
  taskState.notBefore = 0;
  taskState.finalResult = {
    ...result,
    attempts: taskState.attempts,
    retries: taskState.retries,
  };
}

function requeueTask(taskState, delayMs = 0) {
  taskState.pending = true;
  taskState.running = false;
  taskState.notBefore = delayMs > 0 ? Date.now() + delayMs : 0;
}

function printWorkerStats(report) {
  console.log(`Workers: total=${report.workerCount}, enabled=${report.enabledWorkerCount}, used=${report.activeWorkerCount}, peak concurrency=${report.peakConcurrency}`);
  for (const worker of report.workerStats) {
    console.log(`- ${worker.name} [${worker.id}] assigned=${worker.assigned} success=${worker.success} failed=${worker.failed} retries=${worker.retries} cooldowns=${worker.cooldowns} fatalErrors=${worker.fatalErrors}${worker.lastError ? ` lastError="${worker.lastError}"` : ""}`);
  }
}

async function runWorkerTaskQueue(workers, tasks, options = {}) {
  const {
    concurrency = DEFAULTS.concurrency,
    adaptive = true,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BACKOFF_MS,
    cooldownMs = DEFAULT_WORKER_COOLDOWN_MS,
    runTask,
    onTaskStart = () => {},
    onTaskComplete = () => {},
    outputDir = null,
    returnReport = false,
    stickyTaskGroups = false,
  } = options;

  const configuredWorkers = Array.isArray(workers) ? workers.filter((worker) => worker?.apiKey) : [];
  const enabledWorkers = configuredWorkers.filter((worker) => worker.enabled !== false);
  const total = tasks.length;
  if (enabledWorkers.length === 0) {
    const report = {
      total,
      success: 0,
      failed: total,
      retryCount: 0,
      workerCount: configuredWorkers.length,
      enabledWorkerCount: 0,
      activeWorkerCount: 0,
      initialConcurrency: 0,
      peakConcurrency: 0,
      elapsed: 0,
      outputDir,
      paths: [],
      exhaustedReason: "No enabled worker configured.",
      results: tasks.map((task) => ({
        ok: false,
        prompt: task?.prompt || null,
        sourceName: task?.sourceName || null,
        error: "No enabled worker configured.",
        skipped: true,
      })),
      workerStats: [],
      exitCode: 1,
    };
    return returnReport ? report : report.exitCode;
  }

  const sessions = createWorkerSessions(enabledWorkers);
  const taskStates = createTaskStates(tasks);
  const groupAssignments = new Map();
  const runningGroups = new Set();
  const started = Date.now();
  const initialConcurrency = Math.max(1, Math.min(Number(concurrency) || DEFAULTS.concurrency, total || 1, enabledWorkers.length, MAX_CONCURRENCY));
  let activeRuns = 0;
  let peakConcurrency = 0;
  let retryCount = 0;
  let exhaustedReason = null;

  function allTasksDone() {
    return taskStates.every((task) => task.done);
  }

  async function dispatcher() {
    while (true) {
      if (allTasksDone()) return;
      if (!hasPotentialWorkerSessions(sessions)) {
        exhaustedReason = exhaustedReason || "No enabled worker remained available for this run.";
        return;
      }

      let worker = null;
      let taskState = null;
      if (stickyTaskGroups) {
        const assignment = takeNextStickyTaskAssignment(taskStates, sessions, groupAssignments, runningGroups);
        if (assignment) {
          ({ taskState, worker } = assignment);
        }
      } else {
        worker = findAvailableWorker(sessions);
        if (worker) taskState = takeNextReadyTask(taskStates);
      }

      if (!worker || !taskState) {
        const taskDelay = nextTaskDelayMs(taskStates);
        const workerDelay = nextAvailableWorkerDelayMs(sessions);
        if (taskDelay == null && taskStates.some((task) => task.running)) {
          await sleep(SCHEDULER_IDLE_MS);
          continue;
        }
        const waitValues = [taskDelay, workerDelay, SCHEDULER_IDLE_MS].filter((value) => Number.isFinite(value) && value >= 0);
        await sleep(waitValues.length > 0 ? Math.max(1, Math.min(...waitValues)) : SCHEDULER_IDLE_MS);
        continue;
      }

      worker.busy = true;
      worker.used = true;
      worker.stats.assigned += 1;
      activeRuns += 1;
      peakConcurrency = Math.max(peakConcurrency, activeRuns);
      taskState.attempts += 1;
      onTaskStart(taskState.payload, { index: taskState.index, total, worker, attempt: taskState.attempts });

      let result;
      try {
        result = await runTask(worker, taskState.payload, { index: taskState.index, total, attempt: taskState.attempts });
      } catch (error) {
        result = {
          ok: false,
          elapsed: 0,
          error: error?.message || String(error),
        };
      }

      activeRuns -= 1;
      worker.busy = false;
      const groupKey = taskGroupKey(taskState);
      if (groupKey) runningGroups.delete(groupKey);

      const baseResult = {
        ...result,
        workerId: worker.id,
        workerName: worker.name,
        workerLabel: workerLabel(worker),
      };

      if (result.ok) {
        worker.stats.success += 1;
        worker.lastError = null;
        completeTask(taskState, baseResult);
        if (groupKey && !hasRemainingGroupTasks(taskStates, groupKey)) groupAssignments.delete(groupKey);
        onTaskComplete(taskState.payload, taskState.finalResult, { index: taskState.index, total, worker });
        console.log(`[${taskState.index + 1}/${total}] OK via ${workerLabel(worker)} ${(result.elapsed / 1000).toFixed(1)}s attempts=${taskState.attempts}`);
        continue;
      }

      worker.stats.failed += 1;
      worker.lastError = result.error || "Unknown error";
      const retryable = isRetryableError(result.error);
      const workerFatal = isWorkerFatalError(result.error);
      const taskFatal = isTaskFatalError(result.error);
      const fatal = isFatalError(result.error) || workerFatal || taskFatal;

      if (workerFatal) {
        worker.fatal = true;
        worker.stats.fatalErrors += 1;
        console.log(`[worker:${workerLabel(worker)}] Disabled for this run: ${result.error}`);
      } else if (retryable && adaptive) {
        worker.disabledUntil = Date.now() + schedulerCooldownMs(sessions, retryDelayMs, cooldownMs);
        worker.stats.cooldowns += 1;
      }

      const canRetry = !taskFatal && (retryable || workerFatal) && taskState.retries < maxRetries && hasPotentialWorkerSessions(sessions);
      if (canRetry) {
        taskState.retries += 1;
        retryCount += 1;
        worker.stats.retries += 1;
        if (groupKey && workerFatal) groupAssignments.delete(groupKey);
        const requeueDelay = !adaptive && retryable ? retryDelayMs : 0;
        requeueTask(taskState, requeueDelay);
        console.log(`[${taskState.index + 1}/${total}] RETRY ${taskState.retries}/${maxRetries} via ${workerLabel(worker)}: ${result.error}`);
        continue;
      }

      completeTask(taskState, {
        ...baseResult,
        retryable,
        fatal,
        workerFatal,
        taskFatal,
      });
      if (groupKey && !hasRemainingGroupTasks(taskStates, groupKey)) groupAssignments.delete(groupKey);
      onTaskComplete(taskState.payload, taskState.finalResult, { index: taskState.index, total, worker });
      console.log(`[${taskState.index + 1}/${total}] FAILED via ${workerLabel(worker)} attempts=${taskState.attempts} ${result.error}`);
    }
  }

  await Promise.all(Array.from({ length: initialConcurrency }, () => dispatcher()));

  for (const taskState of taskStates) {
    if (taskState.done) continue;
    completeTask(taskState, {
      ok: false,
      prompt: taskState.payload?.prompt || null,
      sourceName: taskState.payload?.sourceName || null,
      error: exhaustedReason || "Not started",
      skipped: true,
    });
  }

  const results = taskStates.map((task) => task.finalResult);
  const ok = results.filter((item) => item?.ok);
  const failed = results.filter((item) => item && !item.ok);
  const elapsed = Date.now() - started;

  const report = {
    total,
    success: ok.length,
    failed: failed.length,
    retryCount,
    workerCount: configuredWorkers.length,
    enabledWorkerCount: enabledWorkers.length,
    activeWorkerCount: sessions.filter((worker) => worker.used).length,
    initialConcurrency,
    peakConcurrency,
    elapsed,
    outputDir,
    paths: ok.map((item) => item.path).filter(Boolean),
    exhaustedReason,
    results,
    workerStats: sessions.map((worker) => ({
      id: worker.id,
      name: worker.name,
      assigned: worker.stats.assigned,
      success: worker.stats.success,
      failed: worker.stats.failed,
      retries: worker.stats.retries,
      cooldowns: worker.stats.cooldowns,
      fatalErrors: worker.stats.fatalErrors,
      lastError: worker.lastError,
    })),
    exitCode: failed.length > 0 ? 1 : 0,
  };
  return returnReport ? report : report.exitCode;
}

async function runSingleGenerate(workers, prompt, size, outputDir, options = {}) {
  const apiMode = normalizeApiMode(options.apiMode) || "images";
  const fhlApiMode = normalizeFhlApiMode(options.fhlApiMode);
  const resize = options.resize === true;
  const report = await runWorkerTaskQueue(workers, [{
    prompt,
    fhlApiMode,
    startText: `Generating: "${truncateText(prompt)}"`,
  }], {
    concurrency: 1,
    adaptive: options.adaptive !== false,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
    outputDir,
    returnReport: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)} [${routeLabelForWorker(context.worker, task.fhlApiMode)}]`);
    },
    runTask: async (worker, task) => {
      if (workerProvider(worker) === PROVIDER_APIMART) {
        return generateImageForWorker(worker, task.prompt, size, outputDir, { resize, apimartResolution: options.apimartResolution });
      }
      if (task.fhlApiMode) {
        return generateImageForWorker(worker, task.prompt, size, outputDir, { resize, fhlApiMode: task.fhlApiMode });
      }
      return runSingleTaskWithApiMode(apiMode, {
        responses: () => generateImage(worker.apiKey, task.prompt, size, outputDir, { resize }),
        images: () => generateImageViaImages(worker.apiKey, task.prompt, size, outputDir, { resize }),
      });
    },
  });

  const result = report.results[0];
  if (result?.ok) return { ok: true, ...result, report };
  return {
    ok: false,
    report,
    error: result?.error || "Generation failed",
    workerLabel: result?.workerLabel || null,
    workerName: result?.workerName || null,
    workerId: result?.workerId || null,
    routeUsed: result?.routeUsed || null,
    primaryRoute: result?.primaryRoute || apiMode,
    fallbackTriggered: !!result?.fallbackTriggered,
    responsesError: result?.responsesError || null,
    imagesError: result?.imagesError || null,
  };
}

async function runSingleEdit(workers, imagePath, prompt, size, outputDir, options = {}) {
  const apiMode = normalizeApiMode(options.apiMode) || "images";
  const fhlApiMode = normalizeFhlApiMode(options.fhlApiMode);
  const resize = options.resize === true;
  const sourceGroup = loadSourceImages([imagePath]);
  if (!sourceGroup.ok) return sourceGroup;
  const { sources, sourceName } = sourceGroup;
  console.log(`Loaded ${sources[0].sourceName} (${(sources[0].sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);

  const report = await runWorkerTaskQueue(workers, [{
    prompt,
    sourceName,
    fhlApiMode,
    sources,
    startText: `Editing ${sourceName}`,
  }], {
    concurrency: 1,
    adaptive: options.adaptive !== false,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
    outputDir,
    returnReport: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)} [${routeLabelForWorker(context.worker, task.fhlApiMode)}]`);
    },
    runTask: async (worker, task) => {
      if (workerProvider(worker) === PROVIDER_APIMART) {
        return editImageForWorker(worker, task.sources, prompt, size, outputDir, { resize, apimartResolution: options.apimartResolution });
      }
      if (task.fhlApiMode) {
        return editImageForWorker(worker, task.sources, prompt, size, outputDir, { resize, fhlApiMode: task.fhlApiMode });
      }
      return runSingleTaskWithApiMode(apiMode, {
        responses: () => editImageViaResponsesOnce(worker.apiKey, task.sources, prompt, size, outputDir, { resize }),
        images: () => editImageViaImagesOnce(worker.apiKey, task.sources, prompt, size, outputDir, { resize }),
      });
    },
  });

  const result = report.results[0];
  if (result?.ok) return { ok: true, ...result, report, sourceName };
  return {
    ok: false,
    report,
    sourceName,
    error: result?.error || "Edit failed",
    workerLabel: result?.workerLabel || null,
    workerName: result?.workerName || null,
    workerId: result?.workerId || null,
    routeUsed: result?.routeUsed || null,
    primaryRoute: result?.primaryRoute || apiMode,
    fallbackTriggered: !!result?.fallbackTriggered,
    responsesError: result?.responsesError || null,
    imagesError: result?.imagesError || null,
  };
}

async function editImage(workers, imagePaths, prompt, size, outputDir, count = 1, silent = false, options = {}) {
  const resize = options.resize === true;
  const fhlApiMode = normalizeFhlApiMode(options.fhlApiMode) || FHL_API_MODE_RESPONSES;
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

  const tasks = Array.from({ length: count }, (_, index) => ({
    prompt,
    fhlApiMode,
    sourceName,
    sources,
    saveIndex: count > 1 ? index + 1 : null,
    startText: count > 1
      ? `Editing variation ${index + 1}/${count} from ${sourceName}`
      : `Editing ${sourceName}`,
  }));

  const requestedConcurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULTS.concurrency, count, MAX_CONCURRENCY));
  const report = await runWorkerTaskQueue(workers, tasks, {
    concurrency: requestedConcurrency,
    adaptive: options.adaptive !== false,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
    outputDir,
    returnReport: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)} [${routeLabelForWorker(context.worker, task.fhlApiMode)}]`);
    },
    runTask: async (worker, task) => editImageForWorker(worker, task.sources, prompt, size, outputDir, {
      resize,
      fhlApiMode: task.fhlApiMode,
      saveIndex: task.saveIndex,
      apimartResolution: options.apimartResolution,
    }),
  });

  const results = report.results.filter((item) => item?.ok);
  const failures = report.results.filter((item) => item && !item.ok);
  if (failures.length > 0) {
    return {
      ok: false,
      elapsed: report.elapsed,
      sourceName,
      results,
      failures,
      retries: report.retryCount,
      report,
      error: failures[0]?.error || "Edit failed",
    };
  }
  if (count > 1) return { ok: true, elapsed: report.elapsed, results, sourceName, retries: report.retryCount, report };
  return { ok: true, elapsed: report.elapsed, ...results[0], sourceName, retries: report.retryCount, report };
}

async function runBatch(workers, prompts, size, concurrency, outputDir, options = {}) {
  if (typeof options === "boolean") options = { isVariation: options };
  const {
    isVariation = false,
    adaptive = true,
    maxRetries = MAX_RETRIES,
    retryDelayMs = RETRY_BACKOFF_MS,
    resize = false,
    returnReport = false,
    fhlApiMode = FHL_API_MODE_RESPONSES,
  } = options;

  const tasks = prompts.map((prompt, index) => ({
    prompt,
    fhlApiMode,
    startText: isVariation
      ? `Generating variation ${index + 1}/${prompts.length}`
      : `Generating: "${truncateText(prompt)}"`,
  }));

  const report = await runWorkerTaskQueue(workers, tasks, {
    concurrency,
    adaptive,
    maxRetries,
    retryDelayMs,
    outputDir,
    returnReport: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)} [${routeLabelForWorker(context.worker, task.fhlApiMode)}]`);
    },
    runTask: async (worker, task) => generateImageForWorker(worker, task.prompt, size, outputDir, {
      resize,
      fhlApiMode: task.fhlApiMode,
      apimartResolution: options.apimartResolution,
    }),
  });

  console.log("");
  if (isVariation) {
    console.log(`Prompt: "${prompts[0]}" x ${prompts.length}`);
    const successes = report.results.filter((item) => item?.ok);
    const failures = report.results.filter((item) => item && !item.ok);
    for (const [index, result] of successes.entries()) {
      console.log(`${index + 1}. ${basename(result.path)} ${formatImageResult(result)} via ${result.workerLabel}${result.routeLabel ? ` [${result.routeLabel}]` : ""}`);
    }
    for (const result of failures) console.log(`FAILED via ${result.workerLabel || "n/a"}${result.routeLabel ? ` [${result.routeLabel}]` : ""}: ${result.error}`);
  } else {
    for (const result of report.results) {
      console.log(`Prompt: "${result.prompt}"`);
      if (result.ok) {
        console.log(`Path: ${result.path}`);
        console.log(`Worker: ${result.workerLabel}`);
        if (result.routeLabel) console.log(`Route label: ${result.routeLabel}`);
        console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s, ${formatImageResult(result)}`);
      } else {
        console.log(`Worker: ${result.workerLabel || "n/a"}`);
        if (result.routeLabel) console.log(`Route label: ${result.routeLabel}`);
        console.log(`FAILED: ${result.error}`);
      }
      console.log("");
    }
  }
  console.log(`Total: ${report.total}`);
  console.log(`Success: ${report.success}`);
  console.log(`Failed: ${report.failed}`);
  console.log(`Retries: ${report.retryCount}`);
  console.log(`Done: ${report.success}/${report.total} in ${(report.elapsed / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputDir}`);
  if (report.paths.length > 0) {
    console.log("Successful paths:");
    for (const path of report.paths) console.log(path);
  }
  printWorkerStats(report);
  if (report.exhaustedReason) console.log(`Worker pool stop: ${report.exhaustedReason}`);
  return returnReport ? report : report.exitCode;
}

async function runBatchEdit(workers, imagePaths, prompt, size, concurrency, outputDir, options = {}) {
  const resize = options.resize === true;
  const fhlApiMode = normalizeFhlApiMode(options.fhlApiMode) || FHL_API_MODE_RESPONSES;
  const tasks = [];
  for (const imagePath of imagePaths) {
    const sourceGroup = loadSourceImages([imagePath]);
    if (!sourceGroup.ok) {
      console.error(`FAILED ${basename(imagePath)}: ${sourceGroup.error}`);
      return 1;
    }
    tasks.push({
      prompt,
      fhlApiMode,
      sourceName: sourceGroup.sourceName,
      sources: sourceGroup.sources,
      startText: `Editing ${basename(imagePath)}`,
    });
  }

  const report = await runWorkerTaskQueue(workers, tasks, {
    concurrency,
    adaptive: options.adaptive !== false,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    retryDelayMs: options.retryDelayMs ?? RETRY_BACKOFF_MS,
    outputDir,
    returnReport: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)} [${routeLabelForWorker(context.worker, task.fhlApiMode)}]`);
    },
    runTask: async (worker, task) => editImageForWorker(worker, task.sources, prompt, size, outputDir, {
      resize,
      fhlApiMode: task.fhlApiMode,
      apimartResolution: options.apimartResolution,
    }),
  });

  console.log("");
  console.log(`Edit prompt: "${prompt}"`);
  for (const result of report.results.filter((item) => item?.ok)) {
    console.log(`${basename(result.path)} <- ${result.sourceName} ${formatImageResult(result)} via ${result.workerLabel}${result.routeLabel ? ` [${result.routeLabel}]` : ""}`);
  }
  for (const result of report.results.filter((item) => item && !item.ok)) {
    console.log(`FAILED ${result.sourceName}: ${result.error} via ${result.workerLabel || "n/a"}${result.routeLabel ? ` [${result.routeLabel}]` : ""}`);
  }
  console.log(`Done: ${report.success}/${report.total} in ${(report.elapsed / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputDir}`);
  printWorkerStats(report);
  if (report.exhaustedReason) console.log(`Worker pool stop: ${report.exhaustedReason}`);
  return report.exitCode;
}

function buildNailProductDirName(productIndex, productName) {
  return `${String(productIndex).padStart(3, "0")}_${sanitizePathSegment(fileStem(productName))}`;
}

function selectNailStressProducts(productDir, limit) {
  const files = listNaturalSortedImageFiles(productDir);
  if (files.length < limit) {
    throw new Error(`Product directory only has ${files.length} image files, fewer than requested limit ${limit}.`);
  }
  return {
    availableCount: files.length,
    products: files.slice(0, limit).map((file, index) => ({
      ...file,
      productIndex: index + 1,
      dirName: buildNailProductDirName(index + 1, file.name),
    })),
  };
}

function buildNailStressTasks(personaPath, products, outputRoot) {
  const tasks = [];
  for (const product of products) {
    const productOutputDir = join(outputRoot, product.dirName);
    for (const scene of NAIL_STRESS_SCENES) {
      tasks.push({
        personaPath,
        productIndex: product.productIndex,
        productFileName: product.name,
        productPath: product.path,
        productDirName: product.dirName,
        groupKey: product.dirName,
        sceneIndex: scene.sceneIndex,
        sceneKey: scene.sceneKey,
        sceneLabel: scene.label,
        prompt: buildNailScenePrompt(scene),
        outputDir: productOutputDir,
        outputPath: join(productOutputDir, scene.filename),
        rawLogBasePath: join(productOutputDir, `${String(scene.sceneIndex).padStart(2, "0")}_${scene.sceneKey}`),
        startText: `${String(product.productIndex).padStart(3, "0")} ${product.name} -> ${scene.label}`,
      });
    }
  }
  return tasks;
}

function buildNailStressRecords(tasks, resultsOrReport) {
  const resultList = Array.isArray(resultsOrReport)
    ? resultsOrReport
    : (resultsOrReport?.results || []);
  return tasks.map((task, index) => {
    const result = resultList[index] || null;
    const status = !result
      ? "pending"
      : result.ok
        ? "success"
        : "failed";
    return {
      productIndex: task.productIndex,
      productFileName: task.productFileName,
      productPath: task.productPath,
      productDirName: task.productDirName,
      sceneIndex: task.sceneIndex,
      sceneKey: task.sceneKey,
      sceneLabel: task.sceneLabel,
      prompt: task.prompt,
      status,
      workerId: result?.workerId || null,
      workerName: result?.workerName || null,
      workerLabel: result?.workerLabel || null,
      attempts: result?.attempts ?? 0,
      retries: result?.retries ?? 0,
      elapsedMs: result?.elapsed ?? 0,
      outputPath: result?.path || task.outputPath,
      fileSize: result?.fileSize || null,
      width: result?.width || null,
      height: result?.height || null,
      dimensions: result?.dimensions || null,
      resized: !!result?.resized,
      originalDimensions: result?.originalDimensions || null,
      error: status === "failed" ? (result?.error || "Unknown error") : null,
      skipped: !!result?.skipped,
    };
  });
}

function buildNailStressSummary(records, report = null) {
  const success = records.filter((item) => item.status === "success").length;
  const failed = records.filter((item) => item.status === "failed").length;
  const pending = records.filter((item) => item.status === "pending").length;
  return {
    total: records.length,
    success,
    failed,
    pending,
    retries: report?.retryCount ?? records.reduce((sum, item) => sum + (item.retries || 0), 0),
    workerCount: report?.workerCount ?? null,
    enabledWorkerCount: report?.enabledWorkerCount ?? null,
    activeWorkerCount: report?.activeWorkerCount ?? null,
    initialConcurrency: report?.initialConcurrency ?? null,
    peakConcurrency: report?.peakConcurrency ?? null,
    elapsedMs: report?.elapsed ?? null,
    exhaustedReason: report?.exhaustedReason || null,
  };
}

function writeNailStressArtifacts(outputRoot, records, report, metadata, options = {}) {
  const manifestPath = join(outputRoot, "manifest.json");
  const summaryCsvPath = join(outputRoot, "summary.csv");
  const failuresPath = join(outputRoot, "failures.json");
  const failures = records.filter((item) => item.status !== "success");
  const partial = options.partial === true;
  const summary = buildNailStressSummary(records, report);

  writeTextFileAtomic(manifestPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    outputRoot,
    metadata,
    partial,
    summary,
    workerStats: report?.workerStats || [],
    items: records,
  }, null, 2), "utf8");

  writeCsvFile(summaryCsvPath, [
    ["productIndex", "productFileName", "sceneIndex", "sceneKey", "sceneLabel", "status", "worker", "attempts", "retries", "elapsedMs", "dimensions", "outputPath", "error"],
    ...records.map((item) => [
      item.productIndex,
      item.productFileName,
      item.sceneIndex,
      item.sceneKey,
      item.sceneLabel,
      item.status,
      item.workerLabel || "",
      item.attempts,
      item.retries,
      item.elapsedMs,
      item.dimensions || "",
      item.outputPath,
      item.error || "",
    ]),
  ]);

  writeTextFileAtomic(failuresPath, JSON.stringify(failures, null, 2), "utf8");
  return { manifestPath, summaryCsvPath, failuresPath };
}

function printNailStressDryRun(personaPath, productDir, limit, size, outputRoot, selection, tasks, concurrency) {
  console.log("Nail stress test dry run");
  console.log(`Persona: ${personaPath}`);
  console.log(`Product dir: ${productDir}`);
  console.log(`Available product images: ${selection.availableCount}`);
  console.log(`Selected products: ${selection.products.length}`);
  console.log(`Aspect: 9:16 (${size})`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Output root: ${outputRoot}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log("First products:");
  for (const product of selection.products.slice(0, Math.min(5, limit))) {
    console.log(`- ${String(product.productIndex).padStart(3, "0")} ${product.name}`);
  }
  if (selection.products.length > 5) {
    const tail = selection.products.slice(-Math.min(5, selection.products.length));
    console.log("Last products:");
    for (const product of tail) {
      console.log(`- ${String(product.productIndex).padStart(3, "0")} ${product.name}`);
    }
  }
}

function buildWorkflowItemDirName(itemIndex, itemName) {
  return `${String(itemIndex).padStart(3, "0")}_${sanitizePathSegment(fileStem(itemName))}`;
}

function sanitizeTemplateKey(value, fallback) {
  const key = sanitizePathSegment(String(value || "").toLowerCase().replace(/\s+/g, "_"));
  return key === "item" ? fallback : key;
}

function workflowTemplateFilename(template) {
  if (template.filename) {
    const filename = sanitizePathSegment(template.filename.replace(/\.png$/i, ""));
    return `${filename}.png`;
  }
  return `${String(template.templateIndex).padStart(2, "0")}_${sanitizeTemplateKey(template.templateKey, `template_${template.templateIndex}`)}.png`;
}

function normalizeWorkflowTemplateEntry(entry, index) {
  const templateIndex = index + 1;
  const fallbackKey = `template_${templateIndex}`;
  if (typeof entry === "string") {
    return {
      templateIndex,
      templateKey: fallbackKey,
      label: fallbackKey,
      prompt: entry,
      filename: null,
    };
  }
  if (!entry || typeof entry !== "object") {
    throw new Error(`Workflow template #${templateIndex} must be a string or object.`);
  }
  const prompt = String(entry.prompt ?? entry.instruction ?? entry.text ?? "").trim();
  if (!prompt) throw new Error(`Workflow template #${templateIndex} is missing prompt/instruction/text.`);
  const rawKey = entry.key ?? entry.name ?? entry.label ?? fallbackKey;
  const templateKey = sanitizeTemplateKey(rawKey, fallbackKey);
  return {
    templateIndex,
    templateKey,
    label: String(entry.label ?? entry.name ?? templateKey).trim() || templateKey,
    prompt,
    filename: entry.filename ? String(entry.filename).trim() : null,
  };
}

function workflowPresetTemplates(preset) {
  const normalized = String(preset || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized !== WORKFLOW_NAIL_PRESET) {
    throw new Error(`Unknown workflow preset "${preset}". Supported preset: ${WORKFLOW_NAIL_PRESET}.`);
  }
  return NAIL_STRESS_SCENES.map((scene, index) => normalizeWorkflowTemplateEntry({
    key: scene.sceneKey,
    label: scene.label,
    filename: scene.filename,
    prompt: buildNailScenePrompt(scene),
  }, index));
}

function parseWorkflowTemplates(flags) {
  const inlineTemplates = Array.isArray(flags.templateInline) ? flags.templateInline : [];
  let rawTemplates = [];
  if (flags.templatesFile) {
    const parsed = JSON.parse(readFileSync(flags.templatesFile, "utf8").replace(/^\uFEFF/, ""));
    rawTemplates = Array.isArray(parsed) ? parsed : parsed?.templates;
    if (!Array.isArray(rawTemplates)) {
      throw new Error("--templates must be a JSON array or an object with a templates array.");
    }
  }
  if (inlineTemplates.length > 0) rawTemplates.push(...inlineTemplates);
  if (rawTemplates.length === 0 && flags.preset) return workflowPresetTemplates(flags.preset);
  if (rawTemplates.length === 0) {
    throw new Error(`--workflow-batch-edit requires --templates <json>, one or more --template-inline, or --preset ${WORKFLOW_NAIL_PRESET}.`);
  }
  return rawTemplates.map(normalizeWorkflowTemplateEntry);
}

function selectWorkflowItems(itemDir, limit, limitExplicit) {
  const files = listNaturalSortedImageFiles(itemDir);
  if (files.length === 0) throw new Error(`Item directory has no image files: ${itemDir}`);
  if (limitExplicit && files.length < limit) {
    throw new Error(`Item directory only has ${files.length} image files, fewer than requested limit ${limit}.`);
  }
  const selectedCount = Math.min(files.length, limit);
  return {
    availableCount: files.length,
    items: files.slice(0, selectedCount).map((file, index) => ({
      itemIndex: index + 1,
      name: file.name,
      path: file.path,
      dirName: buildWorkflowItemDirName(index + 1, file.name),
    })),
  };
}

function buildWorkflowPrompt(template, options = {}) {
  const fixedCount = options.fixedRefCount || 0;
  const variableRefIndex = fixedCount + 1;
  return [
    `Reference order: ${fixedCount > 0 ? `references 1-${fixedCount} are fixed context images; ` : ""}reference ${variableRefIndex} is the current variable item image.`,
    "Follow the user's template exactly. Do not assume a product category unless the template says it. Combine or apply the references according to the template.",
    template.prompt,
  ].join("\n\n");
}

function buildWorkflowTasks(items, templates, outputRoot, options = {}) {
  const tasks = [];
  for (const item of items) {
    const itemOutputDir = join(outputRoot, item.dirName);
    for (const template of templates) {
      const filename = workflowTemplateFilename(template);
      const task = {
        itemIndex: item.itemIndex,
        itemFileName: item.name,
        itemPath: item.path,
        itemDirName: item.dirName,
        groupKey: item.dirName,
        templateIndex: template.templateIndex,
        templateKey: template.templateKey,
        templateLabel: template.label,
        prompt: buildWorkflowPrompt(template, options),
        rawTemplatePrompt: template.prompt,
        outputDir: itemOutputDir,
        outputPath: join(itemOutputDir, filename),
        rawLogBasePath: join(itemOutputDir, `${String(template.templateIndex).padStart(2, "0")}_${template.templateKey}`),
        startText: `${String(item.itemIndex).padStart(3, "0")} ${item.name} -> ${template.label}`,
      };
      tasks.push(task);
    }
  }
  return tasks;
}

function classifyWorkflowError(error) {
  const text = String(error || "").toLowerCase();
  if (!text) return "";
  if (text.includes("http 524") || text.includes("timeout occurred") || text.includes("cloudflare timeout")) return "timeout_524";
  if (text.includes("no image_generation_call result")) return "no_image_result";
  if (text.includes("fetch failed") || text.includes("terminated") || text.includes("socket hang up") || text.includes("econnreset")) return "network";
  if (text.includes("content policy") || text.includes("safety policy") || text.includes("moderation")) return "content_policy";
  if (text.includes("http 401") || text.includes("http 403") || text.includes("invalid api key") || text.includes("unauthorized") || text.includes("forbidden")) return "auth";
  if (isRetryableError(text)) return "retryable";
  if (isFatalError(text)) return "fatal";
  return "other";
}

function buildWorkflowRecords(tasks, resultsOrReport) {
  const results = Array.isArray(resultsOrReport) ? resultsOrReport : resultsOrReport?.results || [];
  return tasks.map((task, index) => {
    const result = results[index] || {};
    const status = result.ok ? "success" : result.error ? "failed" : "pending";
    return {
      itemIndex: task.itemIndex,
      itemFileName: task.itemFileName,
      itemPath: task.itemPath,
      itemDirName: task.itemDirName,
      templateIndex: task.templateIndex,
      templateKey: task.templateKey,
      templateLabel: task.templateLabel,
      prompt: task.prompt,
      status,
      workerId: result.workerId || null,
      workerName: result.workerName || null,
      workerLabel: result.workerLabel || null,
      attempts: result.attempts || 0,
      retries: result.retries || 0,
      elapsedMs: result.elapsed || 0,
      outputPath: task.outputPath,
      fileSize: result.fileSize || null,
      width: result.width || null,
      height: result.height || null,
      dimensions: result.dimensions || null,
      resized: !!result.resized,
      originalDimensions: result.originalDimensions || null,
      error: result.error || null,
      errorClass: classifyWorkflowError(result.error),
      reusedExisting: !!result.reusedExisting,
    };
  });
}

function buildWorkflowSummary(records, report = null) {
  const success = records.filter((item) => item.status === "success").length;
  const failed = records.filter((item) => item.status === "failed").length;
  const pending = records.length - success - failed;
  const retries = records.reduce((sum, item) => sum + (Number(item.retries) || 0), 0);
  return {
    total: records.length,
    success,
    failed,
    pending,
    retries: report?.retryCount ?? retries,
    workerCount: report?.workerCount ?? null,
    enabledWorkerCount: report?.enabledWorkerCount ?? null,
    activeWorkerCount: report?.activeWorkerCount ?? null,
    initialConcurrency: report?.initialConcurrency ?? null,
    peakConcurrency: report?.peakConcurrency ?? null,
    elapsedMs: report?.elapsed ?? null,
    exhaustedReason: report?.exhaustedReason ?? null,
  };
}

function writeWorkflowArtifacts(outputRoot, records, report, metadata, sessions = [], options = {}) {
  const partial = options.partial === true;
  const summary = buildWorkflowSummary(records, report);
  const manifestPath = join(outputRoot, "manifest.json");
  const summaryCsvPath = join(outputRoot, "summary.csv");
  const failuresPath = join(outputRoot, "failures.json");
  const sessionsPath = join(outputRoot, "sessions.json");
  writeTextFileAtomic(manifestPath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    outputRoot,
    metadata,
    partial,
    summary,
    workerStats: report?.workerStats || [],
    sessions,
    items: records,
  }, null, 2)}\n`, "utf8");
  writeCsvFile(summaryCsvPath, [
    ["itemIndex", "itemFileName", "templateIndex", "templateKey", "templateLabel", "status", "errorClass", "worker", "attempts", "retries", "elapsedMs", "dimensions", "outputPath", "error"],
    ...records.map((item) => [
      item.itemIndex,
      item.itemFileName,
      item.templateIndex,
      item.templateKey,
      item.templateLabel,
      item.status,
      item.errorClass,
      item.workerLabel || item.workerName || item.workerId || "",
      item.attempts,
      item.retries,
      item.elapsedMs,
      item.dimensions,
      item.outputPath,
      item.error,
    ]),
  ]);
  writeTextFileAtomic(failuresPath, `${JSON.stringify(records.filter((item) => item.status !== "success"), null, 2)}\n`, "utf8");
  writeTextFileAtomic(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  return { manifestPath, summaryCsvPath, failuresPath, sessionsPath };
}

function buildWorkflowSession(label, report, queuedCount, startedAt, endedAt) {
  return {
    label,
    startedAt,
    endedAt,
    queuedCount,
    total: report.total,
    success: report.success,
    failed: report.failed,
    retries: report.retryCount,
    workerCount: report.workerCount,
    enabledWorkerCount: report.enabledWorkerCount,
    activeWorkerCount: report.activeWorkerCount,
    initialConcurrency: report.initialConcurrency,
    peakConcurrency: report.peakConcurrency,
    elapsedMs: report.elapsed,
    exhaustedReason: report.exhaustedReason,
    workerStats: report.workerStats,
  };
}

function mergeWorkerStats(reports) {
  const merged = new Map();
  for (const report of reports) {
    for (const worker of report.workerStats || []) {
      const current = merged.get(worker.id) || {
        id: worker.id,
        name: worker.name,
        assigned: 0,
        success: 0,
        failed: 0,
        retries: 0,
        cooldowns: 0,
        fatalErrors: 0,
        lastError: null,
      };
      current.assigned += worker.assigned || 0;
      current.success += worker.success || 0;
      current.failed += worker.failed || 0;
      current.retries += worker.retries || 0;
      current.cooldowns += worker.cooldowns || 0;
      current.fatalErrors += worker.fatalErrors || 0;
      current.lastError = worker.lastError || current.lastError;
      merged.set(worker.id, current);
    }
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function noOpQueueReport(workers, outputRoot) {
  const configuredWorkers = Array.isArray(workers) ? workers.filter((worker) => worker?.apiKey) : [];
  const enabledWorkers = configuredWorkers.filter((worker) => worker.enabled !== false);
  return {
    total: 0,
    success: 0,
    failed: 0,
    retryCount: 0,
    workerCount: configuredWorkers.length,
    enabledWorkerCount: enabledWorkers.length,
    activeWorkerCount: 0,
    initialConcurrency: 0,
    peakConcurrency: 0,
    elapsed: 0,
    outputDir: outputRoot,
    paths: [],
    exhaustedReason: null,
    results: [],
    workerStats: [],
    exitCode: 0,
  };
}

async function runWorkflowQueuePass(workers, queuedTasks, passOptions) {
  const {
    label,
    outputRoot,
    concurrency,
    adaptive,
    resize,
    fixedSources,
    size,
    fhlApiMode = FHL_API_MODE_RESPONSES,
    liveResults,
    allTasks,
    metadata,
    sessions,
    repair = false,
  } = passOptions;
  if (queuedTasks.length === 0) return noOpQueueReport(workers, outputRoot);
  const startedAt = new Date().toISOString();
  const report = await runWorkerTaskQueue(workers, queuedTasks, {
    concurrency,
    adaptive,
    maxRetries: MAX_RETRIES,
    retryDelayMs: RETRY_BACKOFF_MS,
    outputDir: outputRoot,
    returnReport: true,
    stickyTaskGroups: true,
    onTaskStart: (task, context) => {
      console.log(`[${label} ${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)} [${routeLabelForWorker(context.worker, task.fhlApiMode || fhlApiMode)}]`);
    },
    onTaskComplete: (task, result) => {
      liveResults[task.fullIndex] = result;
      const liveRecords = buildWorkflowRecords(allTasks, liveResults);
      writeWorkflowArtifacts(outputRoot, liveRecords, null, metadata, sessions, { partial: true });
    },
    runTask: async (worker, task, context) => {
      const item = loadSourceImage(task.itemPath);
      if (!item.ok) {
        return {
          ok: false,
          elapsed: 0,
          error: item.error,
          sourceName: basename(task.itemPath),
        };
      }
      return editImageForWorker(worker, [...fixedSources, item], task.prompt, size, task.outputDir, {
        resize,
        fhlApiMode: task.fhlApiMode || fhlApiMode,
        apimartResolution: options.apimartResolution,
        savePath: task.outputPath,
        rawLogPath: `${task.rawLogBasePath}.${repair ? "repair" : "main"}.attempt${context.attempt}.sse.txt`,
      });
    },
  });
  const endedAt = new Date().toISOString();
  sessions.push(buildWorkflowSession(label, report, queuedTasks.length, startedAt, endedAt));
  return report;
}

function workflowMissingQueue(tasks, liveResults) {
  const queued = [];
  for (const [index, task] of tasks.entries()) {
    const existing = inspectExistingImage(task.outputPath);
    if (existing) {
      liveResults[index] = {
        ...existing,
        workerId: liveResults[index]?.workerId || "existing",
        workerName: liveResults[index]?.workerName || "existing",
        workerLabel: liveResults[index]?.workerLabel || "existing",
      };
      continue;
    }
    queued.push({ ...task, fullIndex: index });
  }
  return queued;
}

function printWorkflowDryRun(fixedRefPaths, itemDir, limit, size, outputRoot, selection, templates, tasks, concurrency) {
  console.log("Workflow batch edit dry run");
  console.log(`Fixed refs: ${fixedRefPaths.length}`);
  for (const refPath of fixedRefPaths) console.log(`- ${refPath}`);
  console.log(`Item dir: ${itemDir}`);
  console.log(`Available item images: ${selection.availableCount}`);
  console.log(`Selected items: ${selection.items.length}`);
  console.log(`Templates: ${templates.length}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log(`Aspect/size: ${size}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Output root: ${outputRoot}`);
  console.log("First items:");
  for (const item of selection.items.slice(0, Math.min(5, limit))) {
    console.log(`- ${String(item.itemIndex).padStart(3, "0")} ${item.name}`);
  }
  console.log("Templates:");
  for (const template of templates) {
    console.log(`- ${String(template.templateIndex).padStart(2, "0")} ${template.templateKey}: ${template.label}`);
  }
}

async function runWorkflowBatchEdit(workers, options) {
  const {
    fixedRefPaths = [],
    itemDir,
    limit = WORKFLOW_DEFAULT_LIMIT,
    limitExplicit = false,
    templates,
    preset = null,
    size,
    aspect,
    fhlApiMode = FHL_API_MODE_RESPONSES,
    concurrency = MAX_CONCURRENCY,
    adaptive = true,
    resize = false,
    outputDir,
    dryRun = false,
    repairPasses = WORKFLOW_DEFAULT_REPAIR_PASSES,
  } = options;

  const fixedGroup = loadSourceImages(fixedRefPaths);
  if (!fixedGroup.ok) throw new Error(fixedGroup.error);
  const fixedSources = fixedGroup.sources || [];
  const outputRoot = buildWorkflowOutputRoot(outputDir);
  const selection = selectWorkflowItems(itemDir, limit, limitExplicit);
  for (const item of selection.items) mkdirSync(join(outputRoot, item.dirName), { recursive: true });
  const workflowTemplates = templates;
  const tasks = buildWorkflowTasks(selection.items, workflowTemplates, outputRoot, { fixedRefCount: fixedSources.length });
  const metadata = {
    workflow: "batch-edit",
    preset,
    fixedRefPaths,
    itemDir,
    limit,
    selectedItemCount: selection.items.length,
    availableItemCount: selection.availableCount,
    size,
    aspect,
    templateCount: workflowTemplates.length,
    repairPasses,
    fhlApiMode,
  };

  if (dryRun) {
    printWorkflowDryRun(fixedRefPaths, itemDir, limit, size, outputRoot, selection, workflowTemplates, tasks, concurrency);
    return { ok: true, dryRun: true, outputRoot, selection, templates: workflowTemplates, tasks };
  }

  console.log("Workflow batch edit started");
  console.log(`Fixed refs: ${fixedSources.length}`);
  for (const source of fixedSources) console.log(`- ${source.sourceName} (${(source.sourceBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
  console.log(`Item dir: ${itemDir}`);
  console.log(`Items: ${selection.items.length}/${selection.availableCount}`);
  console.log(`Templates per item: ${workflowTemplates.length}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log(`Aspect/size: ${aspect} (${size})`);
  console.log(`Output root: ${outputRoot}`);

  const liveResults = Array.from({ length: tasks.length }, () => null);
  const sessions = [];
  const mainQueue = workflowMissingQueue(tasks, liveResults);
  console.log(`Existing images reused: ${liveResults.filter(Boolean).length}`);
  console.log(`Queued tasks: ${mainQueue.length}`);
  writeWorkflowArtifacts(outputRoot, buildWorkflowRecords(tasks, liveResults), null, metadata, sessions, { partial: true });

  const reports = [];
  const mainReport = await runWorkflowQueuePass(workers, mainQueue, {
    label: "main",
    outputRoot,
    concurrency,
    adaptive,
    resize,
    fixedSources,
    size,
    fhlApiMode,
    liveResults,
    allTasks: tasks,
    metadata,
    sessions,
  });
  reports.push(mainReport);

  for (let pass = 1; pass <= repairPasses; pass += 1) {
    const repairQueue = workflowMissingQueue(tasks, liveResults);
    if (repairQueue.length === 0) break;
    console.log(`Repair pass ${pass}: ${repairQueue.length} missing task(s).`);
    const repairReport = await runWorkflowQueuePass(workers, repairQueue, {
      label: `repair-${pass}`,
      outputRoot,
      concurrency: WORKFLOW_REPAIR_CONCURRENCY,
      adaptive,
      resize,
      fixedSources,
      size,
      fhlApiMode,
      liveResults,
      allTasks: tasks,
      metadata,
      sessions,
      repair: true,
    });
    reports.push(repairReport);
  }

  workflowMissingQueue(tasks, liveResults);
  const records = buildWorkflowRecords(tasks, liveResults);
  const finalSummary = buildWorkflowSummary(records, null);
  const combinedReport = {
    ...reports[reports.length - 1],
    total: records.length,
    success: finalSummary.success,
    failed: records.length - finalSummary.success,
    retryCount: reports.reduce((sum, report) => sum + (report.retryCount || 0), 0),
    workerCount: workers.length,
    enabledWorkerCount: workers.filter((worker) => worker.enabled !== false).length,
    activeWorkerCount: new Set(reports.flatMap((report) => (report.workerStats || []).filter((worker) => worker.assigned > 0).map((worker) => worker.id))).size,
    initialConcurrency: reports[0]?.initialConcurrency || 0,
    peakConcurrency: Math.max(0, ...reports.map((report) => report.peakConcurrency || 0)),
    elapsed: reports.reduce((sum, report) => sum + (report.elapsed || 0), 0),
    workerStats: mergeWorkerStats(reports),
    exitCode: finalSummary.success === records.length ? 0 : 1,
    exhaustedReason: reports.map((report) => report.exhaustedReason).filter(Boolean).join("; ") || null,
  };
  const artifacts = writeWorkflowArtifacts(outputRoot, records, combinedReport, metadata, sessions, { partial: false });
  const missing = records.filter((record) => record.status !== "success");

  console.log("");
  console.log(`Done: ${finalSummary.success}/${finalSummary.total} in ${(combinedReport.elapsed / 1000).toFixed(1)}s`);
  console.log(`Retries: ${combinedReport.retryCount}`);
  console.log(`Output: ${outputRoot}`);
  console.log(`Manifest: ${artifacts.manifestPath}`);
  console.log(`Summary CSV: ${artifacts.summaryCsvPath}`);
  console.log(`Failures JSON: ${artifacts.failuresPath}`);
  console.log(`Sessions JSON: ${artifacts.sessionsPath}`);
  const samplePaths = records.filter((item) => item.status === "success").map((item) => item.outputPath).slice(0, 8);
  if (samplePaths.length > 0) {
    console.log("Sample successful paths:");
    for (const path of samplePaths) console.log(path);
  }
  if (missing.length > 0) {
    console.log("Missing or failed items:");
    for (const item of missing.slice(0, 20)) {
      console.log(`- ${String(item.itemIndex).padStart(3, "0")} ${item.itemFileName} ${item.templateLabel}: ${item.error || "missing output"}`);
    }
  }
  printWorkerStats(combinedReport);

  return {
    ok: missing.length === 0,
    dryRun: false,
    outputRoot,
    selection,
    templates: workflowTemplates,
    tasks,
    records,
    report: combinedReport,
    artifacts,
  };
}

async function runWorkflowSelfTest() {
  const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
  const outputRoot = join(tmpdir(), `fhl-workflow-self-test_${timestamp()}`);
  const item = {
    itemIndex: 1,
    name: "item.png",
    path: join(outputRoot, "item.png"),
    dirName: "001_item",
  };
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(item.path, onePixelPng);
  const templates = [
    normalizeWorkflowTemplateEntry({ key: "scene_a", prompt: "Place the variable item into a clean scene." }, 0),
    normalizeWorkflowTemplateEntry({ key: "scene_b", prompt: "Create a second independent scene." }, 1),
  ];
  const tasks = buildWorkflowTasks([item], templates, outputRoot, { fixedRefCount: 0 });
  const liveResults = Array.from({ length: tasks.length }, () => null);
  const firstQueue = workflowMissingQueue(tasks, liveResults);
  savePngBuffer(tasks[0].outputPath, onePixelPng, null);
  const repairQueue = workflowMissingQueue(tasks, liveResults);
  liveResults[tasks[1].templateIndex - 1] = {
    ok: false,
    error: "HTTP 524: Error 524: A timeout occurred",
    attempts: 1,
    retries: 1,
    elapsed: 1000,
  };
  const records = buildWorkflowRecords(tasks, liveResults);
  const artifacts = writeWorkflowArtifacts(outputRoot, records, noOpQueueReport([], outputRoot), {
    workflow: "self-test",
    size: "1152x2048",
    aspect: "9:16",
  }, [{
    label: "mock-main",
    queuedCount: firstQueue.length,
    retries: 1,
  }], { partial: false });

  const ok = firstQueue.length === 2
    && repairQueue.length === 1
    && records[0].status === "success"
    && records[1].errorClass === "timeout_524"
    && existsSync(artifacts.manifestPath)
    && existsSync(artifacts.sessionsPath);
  if (!ok) {
    console.error("Workflow self-test FAILED.");
    console.error(JSON.stringify({ firstQueue: firstQueue.length, repairQueue: repairQueue.length, records, artifacts }, null, 2));
    return 1;
  }
  console.log("Workflow self-test OK.");
  console.log(`Output: ${outputRoot}`);
  return 0;
}

async function runNailStressTest(workers, options) {
  const {
    personaPath,
    productDir,
    limit = NAIL_STRESS_DEFAULT_LIMIT,
    size,
    fhlApiMode = FHL_API_MODE_RESPONSES,
    concurrency = MAX_CONCURRENCY,
    adaptive = true,
    resize = false,
    outputDir,
    dryRun = false,
    resumeExisting = true,
  } = options;

  const persona = loadSourceImage(personaPath);
  if (!persona.ok) throw new Error(persona.error);

  const outputRoot = buildNailStressOutputRoot(outputDir);
  const selection = selectNailStressProducts(productDir, limit);
  for (const product of selection.products) {
    mkdirSync(join(outputRoot, product.dirName), { recursive: true });
  }
  const tasks = buildNailStressTasks(personaPath, selection.products, outputRoot);
  const metadata = {
    personaPath,
    productDir,
    limit,
    size,
    aspect: "9:16",
    sceneCount: NAIL_STRESS_SCENES.length,
  };

  if (dryRun) {
    printNailStressDryRun(personaPath, productDir, limit, size, outputRoot, selection, tasks, concurrency);
    return {
      ok: true,
      dryRun: true,
      outputRoot,
      selection,
      tasks,
    };
  }

  console.log("Nail stress test started");
  console.log(`Persona: ${persona.sourceName}`);
  console.log(`Product dir: ${productDir}`);
  console.log(`Products: ${selection.products.length}/${selection.availableCount}`);
  console.log(`Scenes per product: ${NAIL_STRESS_SCENES.length}`);
  console.log(`Total tasks: ${tasks.length}`);
  console.log(`Aspect: 9:16 (${size})`);
  console.log(`Output root: ${outputRoot}`);

  const liveResults = Array.from({ length: tasks.length }, () => null);
  const queuedTasks = [];
  for (const [index, task] of tasks.entries()) {
    const existing = resumeExisting ? inspectExistingImage(task.outputPath) : null;
    if (existing) {
      liveResults[index] = {
        ...existing,
        workerId: "existing",
        workerName: "existing",
        workerLabel: "existing",
      };
      continue;
    }
    queuedTasks.push({ ...task, fullIndex: index });
  }
  console.log(`Existing images reused: ${liveResults.filter(Boolean).length}`);
  console.log(`Queued tasks: ${queuedTasks.length}`);

  const writePartialArtifacts = () => {
    const liveRecords = buildNailStressRecords(tasks, liveResults);
    return writeNailStressArtifacts(outputRoot, liveRecords, null, metadata, { partial: true });
  };
  writePartialArtifacts();

  const report = queuedTasks.length === 0
    ? {
      total: 0,
      success: 0,
      failed: 0,
      retryCount: 0,
      workerCount: workers.length,
      enabledWorkerCount: workers.filter((worker) => worker.enabled !== false).length,
      activeWorkerCount: 0,
      initialConcurrency: 0,
      peakConcurrency: 0,
      elapsed: 0,
      outputDir: outputRoot,
      paths: [],
      exhaustedReason: null,
      results: [],
      workerStats: [],
      exitCode: 0,
    }
    : await runWorkerTaskQueue(workers, queuedTasks, {
    concurrency,
    adaptive,
    maxRetries: MAX_RETRIES,
    retryDelayMs: RETRY_BACKOFF_MS,
    outputDir: outputRoot,
    returnReport: true,
    stickyTaskGroups: true,
    onTaskStart: (task, context) => {
      console.log(`[${context.index + 1}/${context.total}] ${task.startText} via ${workerLabel(context.worker)} [${routeLabelForWorker(context.worker, fhlApiMode)}]`);
    },
    onTaskComplete: (task, result, context) => {
      liveResults[task.fullIndex] = result;
      writePartialArtifacts();
    },
    runTask: async (worker, task, context) => {
      const product = loadSourceImage(task.productPath);
      if (!product.ok) {
        return {
          ok: false,
          elapsed: 0,
          error: product.error,
          sourceName: basename(task.productPath),
        };
      }
      return editImageForWorker(worker, [persona, product], task.prompt, size, task.outputDir, {
        resize,
        fhlApiMode,
        apimartResolution: options.apimartResolution,
        savePath: task.outputPath,
        rawLogPath: `${task.rawLogBasePath}.attempt${context.attempt}.sse.txt`,
      });
    },
  });

  const records = buildNailStressRecords(tasks, liveResults);
  const artifacts = writeNailStressArtifacts(outputRoot, records, report, metadata, { partial: false });
  const summary = buildNailStressSummary(records, report);

  console.log("");
  console.log(`Done: ${summary.success}/${summary.total} in ${(report.elapsed / 1000).toFixed(1)}s`);
  console.log(`Retries: ${summary.retries}`);
  console.log(`Output: ${outputRoot}`);
  console.log(`Manifest: ${artifacts.manifestPath}`);
  console.log(`Summary CSV: ${artifacts.summaryCsvPath}`);
  console.log(`Failures JSON: ${artifacts.failuresPath}`);
  const samplePaths = records.filter((item) => item.status === "success").map((item) => item.outputPath).slice(0, 8);
  if (samplePaths.length > 0) {
    console.log("Sample successful paths:");
    for (const path of samplePaths) console.log(path);
  }
  if (summary.failed > 0) {
    console.log("Failed items:");
    for (const item of records.filter((record) => record.status !== "success").slice(0, 20)) {
      console.log(`- ${String(item.productIndex).padStart(3, "0")} ${item.productFileName} ${item.sceneLabel}: ${item.error}`);
    }
  }
  printWorkerStats(report);
  if (report.exhaustedReason) console.log(`Worker pool stop: ${report.exhaustedReason}`);

  return {
    ok: summary.failed === 0,
    dryRun: false,
    outputRoot,
    selection,
    tasks,
    report,
    records,
    artifacts,
  };
}

async function runAdaptiveSelfTest() {
  const mockWorkers = Array.from({ length: 4 }, (_, index) => ({
    id: `${WORKER_ID_PREFIX}${index + 1}`,
    name: `mock-${index + 1}`,
    apiKey: `mock-key-${index + 1}`,
    enabled: true,
    createdAt: "2026-07-08T00:00:00.000Z",
  }));

  console.log("Worker pool self-test: a single task should use only one worker.");
  const singleReport = await runWorkerTaskQueue(mockWorkers, [
    { prompt: "single-task" },
  ], {
    concurrency: 4,
    retryDelayMs: 0,
    returnReport: true,
    runTask: async (worker, task) => {
      await sleep(5);
      return { ok: true, elapsed: 5, path: `mock://${worker.id}-${task.prompt}.png`, fileSize: "1.00KB" };
    },
  });

  const singleOk = singleReport.exitCode === 0
    && singleReport.success === 1
    && singleReport.activeWorkerCount === 1
    && singleReport.peakConcurrency === 1;

  console.log("");
  console.log("Worker pool self-test: retryable worker failure should cool the worker and move the task.");
  const retryCalls = new Map();
  const retryableReport = await runWorkerTaskQueue(mockWorkers, Array.from({ length: 5 }, (_, index) => ({
    prompt: `retryable-${index + 1}`,
  })), {
    concurrency: 4,
    retryDelayMs: 0,
    cooldownMs: 0,
    returnReport: true,
    runTask: async (worker, task, context) => {
      const key = `${worker.id}:${context.index}`;
      const count = (retryCalls.get(key) || 0) + 1;
      retryCalls.set(key, count);
      await sleep(5);
      if (worker.id === "worker-2" && context.index === 1 && count === 1) {
        return { ok: false, elapsed: 5, error: "HTTP 502: Cloudflare Bad Gateway" };
      }
      return { ok: true, elapsed: 5, path: `mock://${worker.id}-${task.prompt}.png`, fileSize: "1.00KB" };
    },
  });

  const retryableOk = retryableReport.exitCode === 0
    && retryableReport.success === 5
    && retryableReport.retryCount === 1
    && retryableReport.workerStats.some((worker) => worker.id === "worker-2" && worker.cooldowns === 1);

  console.log("");
  console.log("Worker pool self-test: one auth-fatal worker should be disabled while others continue.");
  const authFatalReport = await runWorkerTaskQueue(mockWorkers.slice(0, 3), Array.from({ length: 4 }, (_, index) => ({
    prompt: `auth-fatal-${index + 1}`,
  })), {
    concurrency: 3,
    retryDelayMs: 0,
    cooldownMs: 0,
    returnReport: true,
    runTask: async (worker, task) => {
      await sleep(5);
      if (worker.id === "worker-2") {
        return { ok: false, elapsed: 5, error: "HTTP 401: Invalid API key" };
      }
      return { ok: true, elapsed: 5, path: `mock://${worker.id}-${task.prompt}.png`, fileSize: "1.00KB" };
    },
  });

  const authFatalOk = authFatalReport.exitCode === 0
    && authFatalReport.success === 4
    && authFatalReport.workerStats.some((worker) => worker.id === "worker-2" && worker.fatalErrors === 1);

  console.log("");
  console.log("Worker pool self-test: all workers fatal should stop the remaining queue.");
  const allFatalReport = await runWorkerTaskQueue(mockWorkers.slice(0, 2), Array.from({ length: 3 }, (_, index) => ({
    prompt: `all-fatal-${index + 1}`,
  })), {
    concurrency: 2,
    retryDelayMs: 0,
    cooldownMs: 0,
    returnReport: true,
    runTask: async () => {
      await sleep(5);
      return { ok: false, elapsed: 5, error: "HTTP 401: Invalid API key" };
    },
  });

  const allFatalOk = allFatalReport.exitCode === 1
    && allFatalReport.failed === 3
    && !!allFatalReport.exhaustedReason;

  if (!singleOk || !retryableOk || !authFatalOk || !allFatalOk) {
    console.error("Worker pool self-test FAILED.");
    console.error(JSON.stringify({ singleReport, retryableReport, authFatalReport, allFatalReport }, null, 2));
    return 1;
  }

  console.log("");
  console.log("Worker pool self-test OK.");
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

async function runImagesGenerateSelfTest() {
  console.log("Images generate self-test: payload shape and b64_json extraction.");
  const payload = buildImagesGenerationBody("mock generate prompt", "2048x1152");
  const payloadOk = payload.model === IMAGE_MODEL
    && typeof payload.prompt === "string"
    && payload.prompt.includes("mock generate prompt")
    && payload.n === 1
    && payload.size === "2048x1152"
    && payload.quality === "auto"
    && payload.output_format === "png"
    && payload.response_format === "b64_json"
    && !Object.prototype.hasOwnProperty.call(payload, "stream")
    && !Object.prototype.hasOwnProperty.call(payload, "partial_images");

  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const extracted = extractImagesFromImagesApiResponse({
    created: 0,
    data: [{ b64_json: pngB64 }],
  });
  const outputDir = resolveOutputDir(join(tmpdir(), "fhl-image-gen-self-test"));
  const saved = extracted.ok ? saveBase64Image(extracted.images[0], outputDir, "self_test_images_generate") : null;
  const savedOk = extracted.ok && !!saved?.path && existsSync(saved.path) && saved.width === 1 && saved.height === 1;

  if (!payloadOk || !savedOk) {
    console.error("Images generate self-test FAILED.");
    console.error(JSON.stringify({
      payloadOk,
      extracted,
      savedOk,
      saved,
    }, null, 2));
    return 1;
  }

  console.log("Images generate self-test OK.");
  console.log(`Saved: ${saved.path}`);
  return 0;
}

async function runImagesEditSelfTest() {
  console.log("Images edit self-test: multipart shape and b64_json extraction.");
  const sources = [
    {
      sourceName: "mock-a.png",
      sourceBuffer: Buffer.from("mock-source-a"),
      mimeType: "image/png",
      ext: "png",
    },
    {
      sourceName: "mock-b.jpg",
      sourceBuffer: Buffer.from("mock-source-b"),
      mimeType: "image/jpeg",
      ext: "jpg",
    },
  ];
  const form = buildImagesEditForm("mock edit prompt", "1152x2048", sources);
  const formKeys = Array.from(form.keys());
  const imagePrimary = form.get("image");
  const imageSecondary = form.getAll("image[]");
  const payloadOk = formKeys.includes("image")
    && formKeys.includes("image[]")
    && form.get("prompt")?.toString().includes("mock edit prompt")
    && form.get("model") === IMAGE_MODEL
    && form.get("n") === "1"
    && form.get("size") === "1152x2048"
    && form.get("quality") === "auto"
    && form.get("output_format") === "png"
    && form.get("response_format") === "b64_json"
    && imagePrimary
    && imageSecondary.length === 1;

  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const extracted = extractImagesFromImagesApiResponse({
    created: 0,
    data: [{ b64_json: pngB64 }],
  });
  const outputDir = resolveOutputDir(join(tmpdir(), "fhl-image-gen-self-test"));
  const saved = extracted.ok ? saveBase64Image(extracted.images[0], outputDir, "self_test_images_edit") : null;
  const savedOk = extracted.ok && !!saved?.path && existsSync(saved.path) && saved.width === 1 && saved.height === 1;

  if (!payloadOk || !savedOk) {
    console.error("Images edit self-test FAILED.");
    console.error(JSON.stringify({
      payloadOk,
      formKeys,
      imageSecondaryCount: imageSecondary.length,
      extracted,
      savedOk,
      saved,
    }, null, 2));
    return 1;
  }

  console.log("Images edit self-test OK.");
  console.log(`Saved: ${saved.path}`);
  return 0;
}

async function runRouteFallbackSelfTest() {
  console.log("Route fallback self-test: auto should switch Responses -> Images when eligible.");

  let imagesCalled = 0;
  const autoFallback = await runSingleTaskWithApiMode("auto", {
    responses: async () => ({ ok: false, error: "HTTP 502: Cloudflare Bad Gateway", elapsed: 10 }),
    images: async () => {
      imagesCalled += 1;
      return { ok: true, elapsed: 20, path: "mock.png", fileSize: "0.01MB", width: 1, height: 1, dimensions: "1x1" };
    },
  });

  let authFallbackCalled = false;
  const authNoFallback = await runSingleTaskWithApiMode("auto", {
    responses: async () => ({ ok: false, error: "HTTP 401: invalid api key", elapsed: 10 }),
    images: async () => {
      authFallbackCalled = true;
      return { ok: true, elapsed: 20 };
    },
  });

  let forcedImagesFallbackCalled = false;
  const forcedImages = await runSingleTaskWithApiMode("images", {
    responses: async () => {
      forcedImagesFallbackCalled = true;
      return { ok: true, elapsed: 10 };
    },
    images: async () => ({ ok: false, error: "HTTP 502: Cloudflare Bad Gateway", elapsed: 20 }),
  });

  const autoFallbackOk = autoFallback.ok
    && autoFallback.routeUsed === "images"
    && autoFallback.fallbackTriggered === true
    && autoFallback.responsesError === "HTTP 502: Cloudflare Bad Gateway"
    && imagesCalled === 1;
  const authNoFallbackOk = !authNoFallback.ok
    && authNoFallback.routeUsed === "responses"
    && authNoFallback.fallbackTriggered === false
    && authFallbackCalled === false;
  const forcedImagesOk = !forcedImages.ok
    && forcedImages.primaryRoute === "images"
    && forcedImages.routeUsed === "images"
    && forcedImagesFallbackCalled === false;

  if (!autoFallbackOk || !authNoFallbackOk || !forcedImagesOk) {
    console.error("Route fallback self-test FAILED.");
    console.error(JSON.stringify({
      autoFallback,
      imagesCalled,
      authNoFallback,
      authFallbackCalled,
      forcedImages,
      forcedImagesFallbackCalled,
    }, null, 2));
    return 1;
  }

  console.log("Route fallback self-test OK.");
  return 0;
}

function redactApimartRequestBody(body) {
  const imageUrls = Array.isArray(body?.image_urls) ? body.image_urls : [];
  const redacted = { ...body };
  if (imageUrls.length > 0) {
    redacted.image_urls = imageUrls.map((value, index) => {
      const text = String(value || "");
      const mime = text.match(/^data:([^;,]+)[;,]/i)?.[1] || null;
      return {
        index: index + 1,
        type: mime ? "data-url" : (/^https?:\/\//i.test(text) ? "url" : "unknown"),
        mimeType: mime,
        length: text.length,
        value: mime ? `data:${mime};base64,<redacted>` : "<redacted>",
      };
    });
  } else {
    delete redacted.image_urls;
  }
  return redacted;
}

async function runApimartRoundtripStep(apiKey, label, body, outputPath) {
  const start = Date.now();
  const log = {
    label,
    prompt: body.prompt,
    request: redactApimartRequestBody(body),
    outputPath,
    ok: false,
    taskId: null,
    status: null,
    elapsedMs: null,
    dimensions: null,
    fileSize: null,
    error: null,
  };

  const submitted = await submitApimartImageTask(apiKey, body);
  if (!submitted.ok) {
    log.elapsedMs = Date.now() - start;
    log.error = submitted.error;
    return { ok: false, log, error: submitted.error };
  }
  log.taskId = submitted.taskId;

  const completed = await waitForApimartImage(apiKey, submitted.taskId, start);
  log.status = completed.status || null;
  if (!completed.ok) {
    log.elapsedMs = Date.now() - start;
    log.error = completed.error;
    return { ok: false, log, error: completed.error };
  }

  const downloaded = await downloadApimartImagePayload(completed.payload);
  if (!downloaded.ok) {
    log.elapsedMs = Date.now() - start;
    log.error = downloaded.error;
    return { ok: false, log, error: downloaded.error };
  }

  const saved = downloaded.base64
    ? saveBase64ImageToPath(downloaded.base64, outputPath, null)
    : savePngBuffer(outputPath, downloaded.buffer, null);
  if (!saved) {
    log.elapsedMs = Date.now() - start;
    log.error = "APIMart image result could not be saved";
    return { ok: false, log, error: log.error };
  }

  log.ok = true;
  log.elapsedMs = Date.now() - start;
  log.dimensions = saved.dimensions || null;
  log.fileSize = saved.fileSize || null;
  log.width = saved.width || null;
  log.height = saved.height || null;
  return { ok: true, log, ...saved, taskId: submitted.taskId, status: completed.status || null };
}

async function runApimartRoundtripTest(config, flags = {}) {
  const workers = getConfiguredWorkers(config, { provider: PROVIDER_APIMART, requireEnabled: true });
  const worker = workers[0];
  if (!worker) {
    console.error("ERROR: No enabled APIMart worker is configured. Run --set-apimart-key <key> first.");
    return 1;
  }
  const resolution = normalizeApimartResolution(flags.apimartResolution || flags.apimartTestResolution) || APIMART_RESOLUTION;

  const outputDir = buildApimartRoundtripOutputRoot(flags.outputDir, resolution);
  const aspect = "1:1";
  const requestedSize = aspect;
  const textPrompt = "钓鱼的小羊";
  const editPrompt = "图中小羊钓起一条鱼大鱼";
  const textPath = join(outputDir, "01_text_to_image_raw.png");
  const editPath = join(outputDir, "02_image_to_image_raw.png");
  const logPath = join(outputDir, "request-log.json");
  const log = {
    workflow: "apimart-roundtrip-test",
    provider: PROVIDER_APIMART,
    model: APIMART_MODEL,
    resolution,
    officialFallback: false,
    endpoint: APIMART_GENERATIONS_URL,
    aspect,
    requestedSize,
    worker: {
      id: worker.id,
      name: worker.name,
      keyPreview: previewKey(worker.apiKey),
    },
    outputDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    steps: [],
  };

  console.log("APIMart roundtrip test");
  console.log(`Output: ${outputDir}`);
  console.log(`Resolution: ${resolution}`);
  console.log(`Step 1 prompt: ${textPrompt}`);

  const textBody = buildApimartImageBody(textPrompt, requestedSize, [], { resolution });
  const textResult = await runApimartRoundtripStep(worker.apiKey, "text-to-image", textBody, textPath);
  log.steps.push(textResult.log);
  if (!textResult.ok) {
    log.finishedAt = new Date().toISOString();
    saveTextArtifact(logPath, JSON.stringify(log, null, 2));
    console.error(`Text-to-image failed: ${textResult.error}`);
    console.error(`Log: ${logPath}`);
    return 1;
  }

  console.log(`Step 1 saved: ${textResult.path} (${formatImageResult(textResult)})`);
  console.log(`Step 2 prompt: ${editPrompt}`);

  const sourceBuffer = readFileSync(textResult.path);
  const sourceDataURL = imageDataURLFromBuffer(sourceBuffer, "image/png");
  const editBody = buildApimartImageBody(editPrompt, requestedSize, [sourceDataURL], { resolution });
  const editResult = await runApimartRoundtripStep(worker.apiKey, "image-to-image", editBody, editPath);
  log.steps.push(editResult.log);
  log.finishedAt = new Date().toISOString();
  saveTextArtifact(logPath, JSON.stringify(log, null, 2));

  if (!editResult.ok) {
    console.error(`Image-to-image failed: ${editResult.error}`);
    console.error(`Log: ${logPath}`);
    return 1;
  }

  console.log(`Step 2 saved: ${editResult.path} (${formatImageResult(editResult)})`);
  console.log(`Request log: ${logPath}`);
  return 0;
}

function parseArgs(argv) {
  const args = { prompts: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const value = argv[i];
    if (value === "--get-config") args.flags.getConfig = true;
    else if (value === "--list-workers") args.flags.listWorkers = true;
    else if (value === "--provider" && argv[i + 1]) args.flags.provider = argv[++i];
    else if (value === "--fhl-api-mode" && argv[i + 1]) args.flags.fhlApiMode = argv[++i];
    else if (value === "--set-fhl-api-mode" && argv[i + 1]) args.flags.setFhlApiMode = argv[++i];
    else if (value === "--set-default-provider" && argv[i + 1]) args.flags.setDefaultProvider = argv[++i];
    else if (value === "--clear-default-provider") args.flags.clearDefaultProvider = true;
    else if (value === "--set-key" && argv[i + 1]) args.flags.setKey = argv[++i];
    else if (value === "--set-apimart-key" && argv[i + 1]) args.flags.setApimartKey = argv[++i];
    else if (value === "--add-worker-key" && argv[i + 1]) args.flags.addWorkerKey = argv[++i];
    else if (value === "--add-apimart-key" && argv[i + 1]) args.flags.addApimartKey = argv[++i];
    else if (value === "--worker-name" && argv[i + 1]) args.flags.workerName = argv[++i];
    else if (value === "--set-worker-key" && argv[i + 2]) {
      args.flags.setWorkerKey = { worker: argv[++i], key: argv[++i] };
    } else if (value === "--remove-worker" && argv[i + 1]) args.flags.removeWorker = argv[++i];
    else if (value === "--enable-worker" && argv[i + 1]) args.flags.enableWorker = argv[++i];
    else if (value === "--disable-worker" && argv[i + 1]) args.flags.disableWorker = argv[++i];
    else if (value === "--set-quick-mode") args.flags.setQuickMode = true;
    else if (value === "--set-batch-mode") args.flags.setBatchMode = true;
    else if (value === "--prompt" && argv[i + 1]) args.prompts.push(argv[++i]);
    else if (value === "--quality" && argv[i + 1]) args.flags.quality = argv[++i];
    else if (value === "--ratio" && argv[i + 1]) args.flags.ratio = argv[++i];
    else if (value === "--aspect" && argv[i + 1]) args.flags.aspect = argv[++i];
    else if (value === "--size" && argv[i + 1]) args.flags.size = argv[++i];
    else if (value === "--count" && argv[i + 1]) args.flags.count = Number.parseInt(argv[++i], 10);
    else if (value === "--repeat" && argv[i + 1]) args.flags.repeat = Number.parseInt(argv[++i], 10);
    else if (value === "--limit" && argv[i + 1]) args.flags.limit = Number.parseInt(argv[++i], 10);
    else if (value === "--output-dir" && argv[i + 1]) args.flags.outputDir = argv[++i];
    else if (value === "--api-mode" && argv[i + 1]) args.flags.apiMode = argv[++i];
    else if (value === "--concurrency" && argv[i + 1]) args.flags.concurrency = Number.parseInt(argv[++i], 10);
    else if (value === "--adaptive") args.flags.adaptive = true;
    else if (value === "--no-adaptive") args.flags.adaptive = false;
    else if (value === "--dry-run") args.flags.dryRun = true;
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
    } else if (value === "--workflow-batch-edit") args.flags.workflowBatchEdit = true;
    else if (value === "--fixed-ref" && argv[i + 1]) {
      if (!args.flags.fixedRefs) args.flags.fixedRefs = [];
      args.flags.fixedRefs.push(argv[++i]);
    } else if (value === "--item-dir" && argv[i + 1]) args.flags.itemDir = argv[++i];
    else if (value === "--templates" && argv[i + 1]) args.flags.templatesFile = argv[++i];
    else if (value === "--template-inline" && argv[i + 1]) {
      if (!args.flags.templateInline) args.flags.templateInline = [];
      args.flags.templateInline.push(argv[++i]);
    } else if (value === "--preset" && argv[i + 1]) args.flags.preset = argv[++i];
    else if (value === "--repair-passes" && argv[i + 1]) args.flags.repairPasses = Number.parseInt(argv[++i], 10);
    else if (value === "--no-repair") args.flags.repairPasses = 0;
    else if (value === "--nail-stress-test") args.flags.nailStressTest = true;
    else if (value === "--persona" && argv[i + 1]) args.flags.personaPath = argv[++i];
    else if (value === "--product-dir" && argv[i + 1]) args.flags.productDir = argv[++i];
    else if (value === "--resolve-size") args.flags.resolveSize = true;
    else if (value === "--self-test-adaptive") args.flags.selfTestAdaptive = true;
    else if (value === "--self-test-workers") args.flags.selfTestAdaptive = true;
    else if (value === "--self-test-edit-responses") args.flags.selfTestEditResponses = true;
    else if (value === "--self-test-images-generate") args.flags.selfTestImagesGenerate = true;
    else if (value === "--self-test-images-edit") args.flags.selfTestImagesEdit = true;
    else if (value === "--self-test-route-fallback") args.flags.selfTestRouteFallback = true;
    else if (value === "--self-test-workflow") args.flags.selfTestWorkflow = true;
    else if (value === "--apimart-roundtrip-test") args.flags.apimartRoundtripTest = true;
    else if (value === "--fhl-multiref-diagnostic") args.flags.fhlMultirefDiagnostic = true;
    else if (value === "--diagnostic-suite" && argv[i + 1]) args.flags.diagnosticSuite = argv[++i];
    else if (value === "--field-mode" && argv[i + 1]) args.flags.fieldMode = argv[++i];
    else if (value === "--field-modes" && argv[i + 1]) args.flags.fieldModes = argv[++i];
    else if (value === "--ref-counts" && argv[i + 1]) args.flags.refCounts = argv[++i];
    else if (value === "--upload-max-edge" && argv[i + 1]) args.flags.uploadMaxEdge = argv[++i];
    else if (value === "--upload-max-edges" && argv[i + 1]) args.flags.uploadMaxEdges = argv[++i];
    else if (value === "--diagnostic-attempts" && argv[i + 1]) args.flags.diagnosticAttempts = Number.parseInt(argv[++i], 10);
    else if (value === "--diagnostic-timeout-ms" && argv[i + 1]) args.flags.diagnosticTimeoutMs = Number.parseInt(argv[++i], 10);
    else if (value === "--diagnostic-combination-mode" && argv[i + 1]) args.flags.diagnosticCombinationMode = argv[++i];
    else if (value === "--diagnostic-parallel") args.flags.diagnosticParallel = true;
    else if (value === "--diagnostic-sequential") args.flags.diagnosticParallel = false;
    else if (value === "--apimart-resolution" && argv[i + 1]) args.flags.apimartResolution = argv[++i];
    else if (value === "--apimart-test-resolution" && argv[i + 1]) args.flags.apimartTestResolution = argv[++i];
    else if (value === "--internal") args.flags.internal = true;
    else if (value === "--help-internal") {
      args.flags.help = true;
      args.flags.internal = true;
    }
    else if (value === "--help" || value === "-h") args.flags.help = true;
    i++;
  }
  return args;
}

function printUsage(options = {}) {
  if (options.internal === true) {
    printInternalUsage();
    return;
  }
  console.log(`FHL Image Gen

CONFIG
  --get-config
  --list-workers
  --set-key <key>                         save/update the default FHL worker
  --add-worker-key <key> [--worker-name <name>]
  --set-worker-key <worker> <key>
  --remove-worker <worker>
  --enable-worker <worker>
  --disable-worker <worker>
  --set-fhl-api-mode responses|images     persist the default FHL route
  --set-quick-mode --ratio R --count 1..${MAX_GENERATION_COUNT}
  --set-batch-mode --ratio R --concurrency 1..${MAX_CONCURRENCY}

GENERATE
  --prompt "..." [--ratio R|--aspect R] [--api-mode auto|responses|images] [--fhl-api-mode responses|images] [--count 1..${MAX_GENERATION_COUNT}] [--resize]
  --prompt "..." --repeat 1..${MAX_REPEAT} [--concurrency 1..${MAX_CONCURRENCY}] [--adaptive|--no-adaptive]
  --batch prompts.json [--ratio R|--aspect R] [--concurrency N] [--resize]
  --batch-inline "prompt 1" "prompt 2" ... [--ratio R|--aspect R] [--concurrency N] [--resize]

EDIT
  --edit --image path.png --prompt "..." [--ratio R|--aspect R] [--api-mode auto|responses|images] [--fhl-api-mode responses|images] [--count 1..${MAX_EDIT_COUNT}] [--concurrency N]
  --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R] [--count 1..${MAX_EDIT_COUNT}] [--concurrency N]
  --batch-edit --edit --image one.png --image two.png --prompt "..." [--ratio R|--aspect R] [--concurrency N]
  FHL defaults to Images API because the upstream Responses route may be unstable
  If Images fails, try --api-mode responses for single tasks or --fhl-api-mode responses for provider-level routing
  Edit concurrency recommendation: 10-worker edit concurrency is validated for single-reference edits only; keep multi-reference edits low-concurrency
  --legacy-edit and --edit-api images stay disabled as legacy entry points

WORKFLOW BATCH EDIT
  --workflow-batch-edit --fixed-ref ref.png --item-dir dir --templates templates.json [--limit ${WORKFLOW_DEFAULT_LIMIT}] [--aspect R] [--concurrency 1..${MAX_CONCURRENCY}] [--repair-passes 0..5|--no-repair] [--dry-run]
  --workflow-batch-edit --fixed-ref ref.png --item-dir dir --template-inline "scene prompt" [--template-inline "..."] [--limit N]
  --workflow-batch-edit --fixed-ref persona.png --item-dir dir --preset ${WORKFLOW_NAIL_PRESET} [--limit N] [--aspect 9:16]
  templates JSON: array of strings/objects or { "templates": [{ "key": "scene", "prompt": "..." }] }

NAIL STRESS TEST
  --nail-stress-test --persona path.png --product-dir dir [--limit ${NAIL_STRESS_DEFAULT_LIMIT}] [--aspect 9:16] [--concurrency 1..${MAX_CONCURRENCY}] [--dry-run]

TOOLS
  --resolve-size --quality 2K --aspect 16:9
  --self-test-adaptive
  --self-test-workers
  --self-test-edit-responses
  --self-test-images-generate
  --self-test-images-edit
  --self-test-route-fallback
  --self-test-workflow

DEFAULTS
  API root: ${API_ROOT}
  responses text model: ${TEXT_MODEL}
  image model: ${IMAGE_MODEL}
  default provider: fhl
  FHL single-task routing: default images; use --api-mode responses or --api-mode auto only when needed
  request quality: public FHL preset stays fixed ${FIXED_REQUEST_QUALITY}
  saved image policy: always keep the raw upstream PNG; --resize only creates a separate __resized_WxH copy and never overwrites the raw file
  output: ~/Pictures/fhl-image-gen
  worker pool: enabled, max configured workers ${MAX_WORKERS}
  adaptive: on, concurrency ${DEFAULTS.concurrency}, retries ${MAX_RETRIES}, worker cooldown ${DEFAULT_WORKER_COOLDOWN_MS / 1000}s
  notice: ${FHL_SIZE_LIMIT_NOTICE}
  workflow batch edit: generic fixed refs + variable item refs + user templates, auto resume and repair passes
  nail stress test: compatibility preset for ${WORKFLOW_NAIL_PRESET}; do not assume product type in generic workflow

RATIOS
  FHL 2K generate stable: ${supportedRatioText({ provider: PROVIDER_FHL, operation: "generate", quality: "2K" })}
  FHL 2K edit stable: ${supportedRatioText({ provider: PROVIDER_FHL, operation: "edit", quality: "2K" })}
  aliases: square=1:1, landscape=4:3, portrait=3:4

SIZE MATRIX
  2K matrix: 1:1 2048x2048, 3:2 2048x1360, 2:3 1360x2048, 4:3 2048x1536, 3:4 1536x2048, 5:4 2048x1632, 4:5 1632x2048, 16:9 2048x1152, 9:16 1152x2048, 2:1 2048x1024, 1:2 1024x2048, 3:1 2048x688, 1:3 688x2048, 7:4 2208x1264, 4:7 1264x2208
  --size WxH is disabled. Use only --ratio/--aspect from the fixed supported list above.`);
}

function printInternalUsage() {
  console.log(`FHL Image Gen Internal Help

PUBLIC DEFAULT
  User-facing configuration and generation stay FHL-only. Do not mention the backup provider in normal user setup.

INTERNAL BACKUP PROVIDER
  --provider apimart
  --set-apimart-key <key>
  --add-apimart-key <key> [--worker-name <name>]
  --set-default-provider apimart
  --clear-default-provider
  --apimart-resolution 1k|2k|4k
  --get-config --internal
  --list-workers --internal

INTERNAL BACKUP GENERATE
  --provider apimart --prompt "..." [--ratio R|--aspect R] [--apimart-resolution 1k|2k|4k]
  --provider apimart --edit --image path.png --prompt "..." [--ratio R|--aspect R] [--apimart-resolution 1k|2k|4k]

INTERNAL DIAGNOSTICS
  --apimart-roundtrip-test [--apimart-resolution 1k|2k|4k]
  --apimart-test-resolution 1k|2k|4k remains as a compatibility alias for diagnostics only
  --fhl-multiref-diagnostic --prompt "..." --image a.png --image b.png [...]
    [--diagnostic-suite fields|upload|concurrency]
    [--field-mode mixed|repeat-image|array]
    [--field-modes mixed,repeat-image,array]
    [--ref-counts 2,3,5,10]
    [--upload-max-edge native|1536|1024|768]
    [--upload-max-edges native,1536,1024,768]
    [--diagnostic-combination-mode first|sliding]
    [--diagnostic-timeout-ms 180000]
    [--diagnostic-parallel|--diagnostic-sequential]

BACKUP PROVIDER CONTRACT
  Endpoint: ${APIMART_GENERATIONS_URL}
  Model: ${APIMART_MODEL}
  Default resolution: ${APIMART_RESOLUTION}
  Text-to-image: do not send image_urls
  Image-to-image: send image_urls with data:image/...;base64 references
  Do not use gpt-image-2-official, and do not use /v1/images/edits
  1:1 actual tested sizes: 1k=1254x1254, 2k=2048x2048, 4k=2880x2880
  Treat image-to-image as reference generation/fusion, not guaranteed precise local editing.`);
}

function resolveGenerationParams(flags, modeConfig, options = {}) {
  const requestedQuality = flags.quality || modeConfig?.quality || DEFAULTS.quality;
  const quality = normalizeQuality(requestedQuality);
  const provider = normalizeProvider(options.provider) || PROVIDER_FHL;
  const operation = normalizeOperation(options.operation);
  const apimartResolution = normalizeApimartResolution(options.apimartResolution || flags.apimartResolution) || APIMART_RESOLUTION;
  const sizeMatrixQuality = provider === PROVIDER_APIMART ? apimartResolution.toUpperCase() : quality;
  if (shouldWarnFixedQuality(requestedQuality)) {
    if (provider === PROVIDER_APIMART) {
      console.warn(`NOTICE: Internal backup provider uses resolution="${apimartResolution}"; ignoring requested quality="${requestedQuality}". ${APIMART_COST_NOTICE}`);
    } else {
      console.warn(`NOTICE: FHL Codex image generation is fixed to ${FIXED_REQUEST_QUALITY}; ignoring requested quality="${requestedQuality}". ${FHL_SIZE_LIMIT_NOTICE}`);
    }
  }

  if (flags.size) {
    console.error(`ERROR: --size is disabled in this plugin. Use only --aspect/--ratio. Supported ${operation} ratios: ${supportedRatioText({ provider, operation, quality: sizeMatrixQuality })}.`);
    process.exit(1);
  }

  const requestedRatio = flags.aspect ?? flags.ratio ?? modeConfig?.ratio ?? DEFAULTS.ratio;
  let ratio = normalizeRatio(requestedRatio);
  if (!isRatioSupportedForRequest(ratio, { provider, operation, quality: sizeMatrixQuality })) {
    const supported = supportedRatioText({ provider, operation, quality: sizeMatrixQuality });
    if (provider === PROVIDER_FHL) {
      console.error(`ERROR: Ratio="${requestedRatio}" is not in the tested FHL ${sizeMatrixQuality} ${operation} matrix. Supported ratios: ${supported}.`);
    } else {
      console.error(`ERROR: Ratio="${requestedRatio}" is not supported for ${operation}. Supported ratios: ${supported}.`);
    }
    process.exit(1);
  }
  const size = resolveSizeFromMatrix(sizeMatrixQuality, ratio);
  if (!size) {
    console.error(`ERROR: Invalid ratio="${requestedRatio}". Supported ratios: ${supportedRatioText({ provider, operation, quality: sizeMatrixQuality })}. Aliases: square, landscape, portrait.`);
    process.exit(1);
  }
  return { quality, ratio, size, sizeMatrixQuality, explicitSize: false, requestedSize: flags.size || null };
}

function didUserExplicitlySetApiMode(flags) {
  return flags.apiMode != null;
}

function explicitNonResponsesApiMode(flags, apiMode) {
  return didUserExplicitlySetApiMode(flags) && apiMode !== "responses";
}

function printRouteSummary(result) {
  if (result?.routeLabel) console.log(`Route label: ${result.routeLabel}`);
  if (!result?.primaryRoute) return;
  console.log(`Route: ${result.routeUsed || result.primaryRoute}`);
  console.log(`Primary route: ${result.primaryRoute}`);
  console.log(`Fallback triggered: ${result.fallbackTriggered ? "yes" : "no"}`);
  if (result.responsesError) console.log(`Responses error: ${result.responsesError}`);
  if (result.imagesError) console.log(`Images error: ${result.imagesError}`);
}

async function main() {
  const { prompts, flags } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const apiMode = flags.apiMode == null ? null : normalizeApiMode(flags.apiMode);
  const requestedProvider = flags.provider != null ? normalizeProvider(flags.provider) : null;
  const requestedFhlApiMode = flags.fhlApiMode != null ? normalizeFhlApiMode(flags.fhlApiMode) : null;
  const requestedSetFhlApiMode = flags.setFhlApiMode != null ? normalizeFhlApiMode(flags.setFhlApiMode) : null;
  const requestedApimartResolution = normalizeApimartResolution(flags.apimartResolution) || null;

  if (flags.apiMode != null && !apiMode) {
    console.error(`ERROR: Invalid --api-mode "${flags.apiMode}". Use responses, images, or auto.`);
    process.exit(1);
  }
  if (flags.provider != null && !requestedProvider) {
    console.error(`ERROR: Invalid provider "${flags.provider}". Use fhl.`);
    process.exit(1);
  }
  if (flags.fhlApiMode != null && !requestedFhlApiMode) {
    console.error(`ERROR: Invalid FHL API mode "${flags.fhlApiMode}". Use responses or images.`);
    process.exit(1);
  }
  if (flags.setFhlApiMode != null && !requestedSetFhlApiMode) {
    console.error(`ERROR: Invalid FHL API mode "${flags.setFhlApiMode}". Use responses or images.`);
    process.exit(1);
  }
  if (flags.apimartResolution != null && !normalizeApimartResolution(flags.apimartResolution)) {
    console.error(`ERROR: Invalid internal backup resolution "${flags.apimartResolution}". Use 1k, 2k, or 4k.`);
    process.exit(1);
  }
  if (flags.apimartTestResolution != null && !normalizeApimartResolution(flags.apimartTestResolution)) {
    console.error(`ERROR: Invalid APIMart test resolution "${flags.apimartTestResolution}". Use 1k, 2k, or 4k.`);
    process.exit(1);
  }

  if (flags.getConfig) {
    console.log(JSON.stringify(buildConfigSummary(config, { internal: flags.internal === true }), null, 2));
    return;
  }

  if (flags.listWorkers) {
    printWorkerList(config, { internal: flags.internal === true });
    return;
  }

  if (flags.setFhlApiMode) {
    config.fhlApiMode = requestedSetFhlApiMode;
    saveConfig(config);
    console.log(`FHL API mode saved: ${requestedSetFhlApiMode}`);
    return;
  }

  if (flags.setDefaultProvider) {
    const provider = normalizeProvider(flags.setDefaultProvider);
    if (!provider) {
      console.error(`ERROR: Invalid provider "${flags.setDefaultProvider}". Use fhl.`);
      process.exit(1);
    }
    config.defaultProvider = provider;
    saveConfig(config);
    console.log(`Default provider saved: ${provider}`);
    return;
  }

  if (flags.clearDefaultProvider) {
    if ("defaultProvider" in config) delete config.defaultProvider;
    saveConfig(config);
    console.log("Default provider cleared.");
    return;
  }

  if (flags.setKey) {
    const workers = getConfiguredWorkers(config);
    const fhlWorkers = workers.filter((worker) => workerProvider(worker) === PROVIDER_FHL);
    if (fhlWorkers.length > 1) {
      console.error("ERROR: --set-key only works when zero or one FHL worker is configured. Use --add-worker-key or --set-worker-key <worker> <key> for multi-worker FHL setups.");
      process.exit(1);
    }
    if (fhlWorkers.length === 0) {
      config.workers = [...workers, createWorkerRecord(flags.setKey, DEFAULT_WORKER_NAME, workers, PROVIDER_FHL)];
    } else {
      config.workers = config.workers.map((worker) => (worker.id === fhlWorkers[0].id
        ? { ...worker, apiKey: String(flags.setKey).trim() }
        : worker));
    }
    saveConfig(config);
    const savedWorker = getConfiguredWorkers(config).find((worker) => workerProvider(worker) === PROVIDER_FHL);
    console.log(`FHL API worker saved: ${previewKey(flags.setKey)} (${savedWorker?.name || DEFAULT_WORKER_NAME})`);
    return;
  }

  if (flags.setApimartKey) {
    const workers = getConfiguredWorkers(config);
    const apimartWorkers = workers.filter((worker) => workerProvider(worker) === PROVIDER_APIMART);
    if (apimartWorkers.length > 1) {
      console.error("ERROR: --set-apimart-key only works when zero or one APIMart worker is configured. Use --add-apimart-key or --set-worker-key <worker> <key> for multi-worker APIMart setups.");
      process.exit(1);
    }
    if (apimartWorkers.length === 0) {
      config.workers = [...workers, createWorkerRecord(flags.setApimartKey, flags.workerName || "apimart", workers, PROVIDER_APIMART)];
    } else {
      config.workers = config.workers.map((worker) => (worker.id === apimartWorkers[0].id
        ? { ...worker, apiKey: String(flags.setApimartKey).trim() }
        : worker));
    }
    saveConfig(config);
    const savedWorker = getConfiguredWorkers(config).find((worker) => workerProvider(worker) === PROVIDER_APIMART);
    console.log(`APIMart API worker saved: ${previewKey(flags.setApimartKey)} (${savedWorker?.name || "apimart"})`);
    return;
  }

  if (flags.addWorkerKey) {
    const workers = getConfiguredWorkers(config);
    if (workers.length >= MAX_WORKERS) {
      console.error(`ERROR: Worker pool supports up to ${MAX_WORKERS} API workers. Remove or disable an existing worker before adding another one.`);
      process.exit(1);
    }
    const duplicate = findDuplicateWorkerKey(workers, flags.addWorkerKey);
    if (duplicate) {
      console.error(`ERROR: This API key is already configured on ${duplicate.name} [${duplicate.id}].`);
      process.exit(1);
    }
    const worker = createWorkerRecord(flags.addWorkerKey, flags.workerName, workers, PROVIDER_FHL);
    config.workers = [...workers, worker];
    saveConfig(config);
    console.log(`Worker added: ${worker.name} [${worker.id}] provider=${worker.provider} key=${previewKey(worker.apiKey)}`);
    return;
  }

  if (flags.addApimartKey) {
    const workers = getConfiguredWorkers(config);
    if (workers.length >= MAX_WORKERS) {
      console.error(`ERROR: Worker pool supports up to ${MAX_WORKERS} API workers. Remove or disable an existing worker before adding another one.`);
      process.exit(1);
    }
    const duplicate = findDuplicateWorkerKey(workers, flags.addApimartKey);
    if (duplicate) {
      console.error(`ERROR: This API key is already configured on ${duplicate.name} [${duplicate.id}].`);
      process.exit(1);
    }
    const apimartCount = workers.filter((worker) => workerProvider(worker) === PROVIDER_APIMART).length;
    const worker = createWorkerRecord(flags.addApimartKey, flags.workerName || `apimart-${apimartCount + 1}`, workers, PROVIDER_APIMART);
    config.workers = [...workers, worker];
    saveConfig(config);
    console.log(`APIMart worker added: ${worker.name} [${worker.id}] key=${previewKey(worker.apiKey)}`);
    return;
  }

  if (flags.setWorkerKey) {
    const resolved = resolveWorkerReference(config, flags.setWorkerKey.worker);
    if (!resolved) {
      console.error(`ERROR: Worker "${flags.setWorkerKey.worker}" was not found.`);
      process.exit(1);
    }
    const duplicate = findDuplicateWorkerKey(getConfiguredWorkers(config), flags.setWorkerKey.key, resolved.worker.id);
    if (duplicate) {
      console.error(`ERROR: This API key is already configured on ${duplicate.name} [${duplicate.id}].`);
      process.exit(1);
    }
    config.workers[resolved.index] = {
      ...config.workers[resolved.index],
      apiKey: String(flags.setWorkerKey.key).trim(),
    };
    saveConfig(config);
    console.log(`Worker key updated: ${resolved.worker.name} [${resolved.worker.id}] -> ${previewKey(flags.setWorkerKey.key)}`);
    return;
  }

  if (flags.removeWorker) {
    const resolved = resolveWorkerReference(config, flags.removeWorker);
    if (!resolved) {
      console.error(`ERROR: Worker "${flags.removeWorker}" was not found.`);
      process.exit(1);
    }
    const removed = config.workers.splice(resolved.index, 1)[0];
    saveConfig(config);
    console.log(`Worker removed: ${removed.name} [${removed.id}]`);
    return;
  }

  if (flags.enableWorker) {
    const resolved = resolveWorkerReference(config, flags.enableWorker);
    if (!resolved) {
      console.error(`ERROR: Worker "${flags.enableWorker}" was not found.`);
      process.exit(1);
    }
    config.workers[resolved.index] = { ...config.workers[resolved.index], enabled: true };
    saveConfig(config);
    console.log(`Worker enabled: ${resolved.worker.name} [${resolved.worker.id}]`);
    return;
  }

  if (flags.disableWorker) {
    const resolved = resolveWorkerReference(config, flags.disableWorker);
    if (!resolved) {
      console.error(`ERROR: Worker "${flags.disableWorker}" was not found.`);
      process.exit(1);
    }
    config.workers[resolved.index] = { ...config.workers[resolved.index], enabled: false };
    saveConfig(config);
    console.log(`Worker disabled: ${resolved.worker.name} [${resolved.worker.id}]`);
    return;
  }

  if (flags.setQuickMode) {
    const previous = config.quickMode || {};
    const requestedQuality = flags.quality || previous.quality || DEFAULTS.quality;
    const quality = normalizeQuality(requestedQuality);
    if (shouldWarnFixedQuality(requestedQuality)) {
      console.warn(`NOTICE: Quick mode is fixed to ${FIXED_REQUEST_QUALITY}; ignoring requested quality="${requestedQuality}". ${FHL_SIZE_LIMIT_NOTICE}`);
    }
    const ratio = normalizeRatio(flags.aspect ?? flags.ratio ?? previous.ratio ?? DEFAULTS.ratio);
    const count = clampInteger(flags.count ?? previous.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
    if (!isRatioSupportedForRequest(ratio, { provider: PROVIDER_FHL, operation: "generate", quality })) {
      console.error(`ERROR: Invalid ratio="${ratio}". Supported generation ratios: ${supportedRatioText({ provider: PROVIDER_FHL, operation: "generate", quality })}.`);
      process.exit(1);
    }
    const size = resolveSize(quality, ratio);
    if (!size) {
      console.error(`ERROR: Invalid ratio="${ratio}". Supported generation ratios: ${supportedRatioText({ provider: PROVIDER_FHL, operation: "generate", quality })}.`);
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
    if (!isRatioSupportedForRequest(ratio, { provider: PROVIDER_FHL, operation: "generate", quality })) {
      console.error(`ERROR: Invalid ratio="${ratio}". Supported generation ratios: ${supportedRatioText({ provider: PROVIDER_FHL, operation: "generate", quality })}.`);
      process.exit(1);
    }
    const size = resolveSize(quality, ratio);
    if (!size) {
      console.error(`ERROR: Invalid ratio="${ratio}". Supported generation ratios: ${supportedRatioText({ provider: PROVIDER_FHL, operation: "generate", quality })}.`);
      process.exit(1);
    }
    config.batchMode = { quality, ratio, concurrency };
    saveConfig(config);
    console.log(`Batch mode saved: ${quality}, ${ratioLabel(ratio)} (${size}), concurrency ${concurrency}`);
    return;
  }

  if (flags.resolveSize) {
    const provider = requestedProvider || normalizeProvider(config.defaultProvider) || PROVIDER_FHL;
    const { quality, ratio, size, explicitSize, sizeMatrixQuality } = resolveGenerationParams(flags, config.quickMode, { provider, operation: "generate", apimartResolution: requestedApimartResolution });
    console.log(JSON.stringify({ provider, quality, ratio, size, sizeMatrixQuality, explicitSize }, null, 2));
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

  if (flags.selfTestImagesGenerate) {
    process.exitCode = await runImagesGenerateSelfTest();
    return;
  }

  if (flags.selfTestImagesEdit) {
    process.exitCode = await runImagesEditSelfTest();
    return;
  }

  if (flags.selfTestRouteFallback) {
    process.exitCode = await runRouteFallbackSelfTest();
    return;
  }

  if (flags.selfTestWorkflow) {
    process.exitCode = await runWorkflowSelfTest();
    return;
  }

  if (flags.apimartRoundtripTest) {
    process.exitCode = await runApimartRoundtripTest(config, flags);
    return;
  }

  if (flags.fhlMultirefDiagnostic) {
    process.exitCode = await runFhlMultirefDiagnostic(config, flags, prompts);
    return;
  }

  if (flags.help || (prompts.length === 0 && !flags.batchFile && !flags.edit && !flags.nailStressTest && !flags.workflowBatchEdit)) {
    printUsage({ internal: flags.internal === true });
    return;
  }

  const providerForRun = requestedProvider || normalizeProvider(config.defaultProvider) || PROVIDER_FHL;
  const effectiveFhlApiMode = resolveFhlApiMode(config, flags);

  if (isWorkerLimitExceeded(config, { provider: providerForRun })) {
    console.error(workerLimitErrorMessage(getConfiguredWorkers(config, { provider: providerForRun }).length));
    process.exit(1);
  }

  if (providerForRun === PROVIDER_APIMART && flags.fhlApiMode != null) {
    console.error("ERROR: --fhl-api-mode only applies when --provider fhl is used.");
    process.exit(1);
  }
  if (providerForRun === PROVIDER_APIMART && flags.apiMode != null) {
    console.error("ERROR: --api-mode is only supported for FHL single-task compatibility. APIMart does not use --api-mode.");
    process.exit(1);
  }

  const configuredWorkers = getConfiguredWorkers(config, { provider: providerForRun });
  if (configuredWorkers.filter((worker) => worker.enabled !== false).length === 0) {
    const providerText = providerForRun === PROVIDER_APIMART ? "APIMart" : "FHL";
    const setupHint = providerForRun === PROVIDER_APIMART
      ? "Run --set-apimart-key <key> or --add-apimart-key <key> first."
      : "Run --set-key <key> or --add-worker-key <key> first.";
    console.error(`ERROR: No enabled ${providerText} API worker is configured. ${setupHint}`);
    process.exit(1);
  }

  if (flags.workflowBatchEdit) {
    if (explicitNonResponsesApiMode(flags, apiMode)) {
      console.error("ERROR: --api-mode only applies to single FHL tasks. For workflow use --fhl-api-mode responses|images.");
      process.exit(1);
    }
    if (!flags.itemDir) {
      console.error("ERROR: --workflow-batch-edit requires --item-dir <dir>.");
      process.exit(1);
    }
    let templates;
    try {
      templates = parseWorkflowTemplates(flags);
    } catch (error) {
      console.error(`ERROR: ${error?.message || String(error)}`);
      process.exit(1);
    }
    const workflowAspect = flags.aspect ?? flags.ratio ?? "9:16";
    const { ratio, size } = resolveGenerationParams({ ...flags, aspect: workflowAspect }, { quality: FIXED_REQUEST_QUALITY, ratio: workflowAspect }, { provider: providerForRun, operation: "edit", apimartResolution: requestedApimartResolution });
    const limitExplicit = flags.limit != null;
    const limit = clampInteger(flags.limit, 1, 1000, WORKFLOW_DEFAULT_LIMIT);
    const concurrency = clampInteger(flags.concurrency ?? MAX_CONCURRENCY, 1, MAX_CONCURRENCY, Math.min(MAX_CONCURRENCY, DEFAULTS.concurrency));
    const repairPasses = clampInteger(flags.repairPasses, 0, 5, WORKFLOW_DEFAULT_REPAIR_PASSES);
    const result = await runWorkflowBatchEdit(configuredWorkers, {
      fixedRefPaths: flags.fixedRefs || [],
      itemDir: flags.itemDir,
      limit,
      limitExplicit,
      templates,
      preset: flags.preset || null,
      size,
      aspect: ratio,
      fhlApiMode: effectiveFhlApiMode,
      apimartResolution: requestedApimartResolution,
      concurrency,
      adaptive: flags.adaptive !== false,
      resize: flags.resize === true,
      outputDir: flags.outputDir,
      dryRun: !!flags.dryRun,
      repairPasses,
    });
    process.exitCode = result.report?.exitCode || 0;
    return;
  }

  if (flags.nailStressTest) {
    if (explicitNonResponsesApiMode(flags, apiMode)) {
      console.error("ERROR: --api-mode only applies to single FHL tasks. For nail stress test use --fhl-api-mode responses|images.");
      process.exit(1);
    }
    if (!flags.personaPath) {
      console.error("ERROR: --nail-stress-test requires --persona <path>.");
      process.exit(1);
    }
    if (!flags.productDir) {
      console.error("ERROR: --nail-stress-test requires --product-dir <dir>.");
      process.exit(1);
    }
    const requestedAspect = flags.aspect ?? flags.ratio ?? "9:16";
    const normalizedAspect = normalizeRatio(requestedAspect);
    if (normalizedAspect !== "9:16") {
      console.error(`ERROR: --nail-stress-test is fixed to 9:16. Received "${requestedAspect}".`);
      process.exit(1);
    }
    const limit = clampInteger(flags.limit, 1, 1000, NAIL_STRESS_DEFAULT_LIMIT);
    const concurrency = clampInteger(flags.concurrency ?? MAX_CONCURRENCY, 1, MAX_CONCURRENCY, Math.min(MAX_CONCURRENCY, DEFAULTS.concurrency));
    const { size } = resolveGenerationParams({ ...flags, aspect: "9:16" }, { quality: FIXED_REQUEST_QUALITY, ratio: "9:16" }, { provider: providerForRun, operation: "edit", apimartResolution: requestedApimartResolution });
    const result = await runNailStressTest(configuredWorkers, {
      personaPath: flags.personaPath,
      productDir: flags.productDir,
      limit,
      size,
      fhlApiMode: effectiveFhlApiMode,
      apimartResolution: requestedApimartResolution,
      concurrency,
      adaptive: flags.adaptive !== false,
      resize: flags.resize === true,
      outputDir: flags.outputDir,
      dryRun: !!flags.dryRun,
    });
    process.exitCode = result.report?.exitCode || 0;
    return;
  }

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
      console.error("ERROR: --legacy-edit and --edit-api images are legacy-disabled in this plugin. Use --api-mode images for single FHL edit tests or --fhl-api-mode images for provider-level FHL routing.");
      process.exit(1);
    }
    const { size } = resolveGenerationParams(flags, config.quickMode, { provider: providerForRun, operation: "edit", apimartResolution: requestedApimartResolution });
    if (images.length > 1 && flags.batchEdit) {
      if (explicitNonResponsesApiMode(flags, apiMode)) {
        console.error("ERROR: --api-mode only applies to single FHL tasks. For batch edit use --fhl-api-mode responses|images.");
        process.exit(1);
      }
      const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
      process.exitCode = await runBatchEdit(configuredWorkers, images, prompts[0], size, concurrency, outputDir, {
        adaptive: flags.adaptive !== false,
        fhlApiMode: effectiveFhlApiMode,
        apimartResolution: requestedApimartResolution,
        resize: flags.resize === true,
      });
      return;
    }
    const count = clampInteger(flags.count, 1, MAX_EDIT_COUNT, 1);
    const isSingleImagesApiEligible = providerForRun === PROVIDER_FHL && images.length === 1 && count === 1 && !flags.batchEdit && !requestedFhlApiMode;
    if (!isSingleImagesApiEligible && explicitNonResponsesApiMode(flags, apiMode)) {
      console.error("ERROR: --api-mode currently supports only single-image single-task FHL edit in v0.2.0. Use --fhl-api-mode for provider-level FHL routing.");
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency ?? count, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    const result = isSingleImagesApiEligible
      ? await runSingleEdit(configuredWorkers, images[0], prompts[0], size, outputDir, {
        adaptive: flags.adaptive !== false,
        resize: flags.resize === true,
        fhlApiMode: requestedFhlApiMode || null,
        apimartResolution: requestedApimartResolution,
        apiMode: apiMode || "images",
      })
      : await editImage(configuredWorkers, images, prompts[0], size, outputDir, count, false, {
        adaptive: flags.adaptive !== false,
        concurrency,
        fhlApiMode: effectiveFhlApiMode,
        apimartResolution: requestedApimartResolution,
        resize: flags.resize === true,
      });
    if (!result.ok) {
      if (result.results?.length > 0) {
        console.error("Partial edit successes:");
        for (const [index, item] of result.results.entries()) {
          console.error(`${index + 1}. ${item.path} ${formatImageResult(item)} via ${item.workerLabel}`);
        }
      }
      console.error(`Edit failed: ${result.error}`);
      if (count === 1) printRouteSummary(result);
      if (result.report) printWorkerStats(result.report);
      process.exitCode = 1;
      return;
    }
    console.log(`Edit prompt: "${prompts[0]}"`);
    if (count > 1) {
      for (const [index, item] of result.results.entries()) {
        console.log(`${index + 1}. ${item.path} ${formatImageResult(item)} via ${item.workerLabel}`);
      }
    } else {
      console.log(`Path: ${result.path}`);
      console.log(`Size: ${formatImageResult(result)}`);
      console.log(`Worker: ${result.workerLabel}`);
      printRouteSummary(result);
    }
    console.log(`Source: ${result.sourceName}`);
    console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s`);
    if (result.report) printWorkerStats(result.report);
    return;
  }

  const isBatch = !!flags.batchFile || !!flags.batchInline;
  const modeConfig = isBatch ? config.batchMode : config.quickMode;
  const { size } = resolveGenerationParams(flags, modeConfig, { provider: providerForRun, operation: "generate", apimartResolution: requestedApimartResolution });

  if (flags.batchFile) {
    if (explicitNonResponsesApiMode(flags, apiMode)) {
      console.error("ERROR: --api-mode only applies to single FHL tasks. For batch use --fhl-api-mode responses|images.");
      process.exit(1);
    }
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
    process.exit(await runBatch(configuredWorkers, batchPrompts.map(String), size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      fhlApiMode: effectiveFhlApiMode,
      apimartResolution: requestedApimartResolution,
      resize: flags.resize === true,
    }));
  }

  if (flags.batchInline) {
    if (explicitNonResponsesApiMode(flags, apiMode)) {
      console.error("ERROR: --api-mode only applies to single FHL tasks. For batch-inline use --fhl-api-mode responses|images.");
      process.exit(1);
    }
    if (prompts.length > MAX_BATCH_PROMPTS) {
      console.error(`ERROR: Batch generation supports up to ${MAX_BATCH_PROMPTS} prompts.`);
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(configuredWorkers, prompts, size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      fhlApiMode: effectiveFhlApiMode,
      apimartResolution: requestedApimartResolution,
      resize: flags.resize === true,
    }));
  }

  const prompt = prompts[0];
  const total = flags.repeat != null
    ? clampInteger(flags.repeat, 1, MAX_REPEAT, DEFAULTS.count)
    : clampInteger(flags.count ?? config.quickMode?.count, 1, MAX_GENERATION_COUNT, DEFAULTS.count);
  if (total > 1) {
    if (explicitNonResponsesApiMode(flags, apiMode)) {
      console.error("ERROR: --api-mode currently covers only one single FHL generation task. Use --fhl-api-mode for provider-level FHL routing.");
      process.exit(1);
    }
    const concurrency = clampInteger(flags.concurrency ?? config.batchMode?.concurrency, 1, MAX_CONCURRENCY, DEFAULTS.concurrency);
    process.exit(await runBatch(configuredWorkers, Array(total).fill(prompt), size, concurrency, outputDir, {
      adaptive: flags.adaptive !== false,
      fhlApiMode: effectiveFhlApiMode,
      apimartResolution: requestedApimartResolution,
      isVariation: true,
      resize: flags.resize === true,
    }));
  }

  const result = await runSingleGenerate(configuredWorkers, prompt, size, outputDir, {
    adaptive: flags.adaptive !== false,
    resize: flags.resize === true,
    fhlApiMode: requestedFhlApiMode || null,
    apimartResolution: requestedApimartResolution,
    apiMode: apiMode || "images",
  });
  if (!result.ok) {
    console.error(`Generation failed: ${result.error}`);
    printRouteSummary(result);
    if (result.report) printWorkerStats(result.report);
    process.exitCode = 1;
    return;
  }
  console.log(`Prompt: "${prompt}"`);
  console.log(`Path: ${result.path}`);
  console.log(`Size: ${formatImageResult(result)}`);
  console.log(`Worker: ${result.workerLabel}`);
  printRouteSummary(result);
  console.log(`Time: ${(result.elapsed / 1000).toFixed(1)}s`);
  if (result.report) printWorkerStats(result.report);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
