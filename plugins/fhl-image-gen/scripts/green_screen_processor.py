#!/usr/bin/env python3
"""Green-screen removal and grid splitting for FHL Image Gen.

The module intentionally keeps the image operation local: FHL only supplies the
RGB/RGBA source image; this script creates the actual alpha channel.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

PROCESSOR_VERSION = "0.2.2"
DEFAULT_GREEN_THRESHOLD = 100.0
DEFAULT_SPILL_THRESHOLD = 0.08
DEFAULT_EDGE_FEATHER = 2
DEFAULT_BACKGROUND = (48, 48, 48)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_name(value: str, fallback: str) -> str:
    text = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", str(value or "")).strip("._")
    return text or fallback


def load_rgba(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGBA")


def green_candidate(rgb: np.ndarray, threshold: float) -> np.ndarray:
    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    return (g > threshold) & (g > r * 1.18) & (g > b * 1.12)


def edge_connected(mask: np.ndarray) -> np.ndarray:
    height, width = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        if mask[0, x]: queue.append((0, x))
        if height > 1 and mask[height - 1, x]: queue.append((height - 1, x))
    for y in range(1, max(1, height - 1)):
        if mask[y, 0]: queue.append((y, 0))
        if width > 1 and mask[y, width - 1]: queue.append((y, width - 1))
    while queue:
        y, x = queue.popleft()
        if seen[y, x]:
            continue
        seen[y, x] = True
        if y and mask[y - 1, x] and not seen[y - 1, x]: queue.append((y - 1, x))
        if y + 1 < height and mask[y + 1, x] and not seen[y + 1, x]: queue.append((y + 1, x))
        if x and mask[y, x - 1] and not seen[y, x - 1]: queue.append((y, x - 1))
        if x + 1 < width and mask[y, x + 1] and not seen[y, x + 1]: queue.append((y, x + 1))
    return seen


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    result = mask.copy()
    for _ in range(max(0, radius)):
        expanded = mask.copy()
        expanded[1:, :] |= mask[:-1, :]
        expanded[:-1, :] |= mask[1:, :]
        expanded[:, 1:] |= mask[:, :-1]
        expanded[:, :-1] |= mask[:, 1:]
        result = expanded
        mask = result.copy()
    return result


def remove_green(image: Image.Image, green_threshold: float, spill_threshold: float, edge_feather: int) -> tuple[Image.Image, dict]:
    rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
    rgb = rgba[:, :, :3]
    original_alpha = rgba[:, :, 3].copy()
    connected = edge_connected(green_candidate(rgb, green_threshold))
    rgba[connected, 3] = 0
    transparent = rgba[:, :, 3] == 0
    if edge_feather:
        edge_band = dilate(transparent, edge_feather) & ~transparent
        for distance in range(1, edge_feather + 1):
            band = dilate(transparent, distance) & ~dilate(transparent, distance - 1)
            rgba[band, 3] = np.minimum(rgba[band, 3], max(32, 255 - distance * 72))
        edge_band &= rgba[:, :, 3] > 0
        if edge_band.any():
            spill = rgb[edge_band].astype(np.float32)
            strength = np.clip((spill[:, 1] - np.maximum(spill[:, 0], spill[:, 2])) / 255.0, 0, 1)
            rgb[edge_band, 1] = np.minimum(spill[:, 1], np.maximum(spill[:, 0], spill[:, 2]) + 255 * (1 - strength * (1 - spill_threshold))).astype(np.uint8)
            rgba[:, :, :3] = rgb
    alpha = rgba[:, :, 3]
    bbox = Image.fromarray(alpha, "L").getbbox()
    edge_region = dilate(alpha > 0, 2) & (alpha > 0)
    edge_green = green_candidate(rgb, green_threshold) & edge_region
    opaque = int(np.count_nonzero(alpha >= 250))
    transparent_count = int(np.count_nonzero(alpha == 0))
    edge_green_count = int(np.count_nonzero(edge_green))
    spill_score = edge_green_count / max(1, int(np.count_nonzero(alpha > 0)))
    warnings = []
    if bbox is None:
        warnings.append("no_foreground_bbox")
    if spill_score > spill_threshold:
        warnings.append("edge_green_remains")
    if int(np.count_nonzero(original_alpha > 0)) and transparent_count > int(np.count_nonzero(original_alpha > 0) * 0.995):
        warnings.append("nearly_all_pixels_removed")
    status = "failed" if bbox is None else ("uncertain" if warnings else "passed")
    metrics = {
        "width": image.width,
        "height": image.height,
        "has_alpha": True,
        "transparent_pixel_count": transparent_count,
        "opaque_pixel_count": opaque,
        "edge_green_pixel_count": edge_green_count,
        "green_spill_score": round(spill_score, 6),
        "bbox": list(bbox) if bbox else None,
        "status": status,
        "warnings": warnings,
        "processor_version": PROCESSOR_VERSION,
        "timestamp": now_iso(),
    }
    return Image.fromarray(rgba, "RGBA"), metrics


def preview(image: Image.Image, path: Path, background=DEFAULT_BACKGROUND) -> None:
    rgba = image.convert("RGBA")
    tile = 24
    canvas = Image.new("RGB", rgba.size, background)
    draw = ImageDraw.Draw(canvas)
    light = (210, 210, 210)
    dark = (165, 165, 165)
    for y in range(0, canvas.height, tile):
        for x in range(0, canvas.width, tile):
            draw.rectangle((x, y, x + tile, y + tile), fill=light if ((x // tile) + (y // tile)) % 2 else dark)
    canvas.paste(rgba, mask=rgba.getchannel("A"))
    canvas.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, "JPEG", quality=90, optimize=True)


def save_rgba(image: Image.Image, path: Path) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGBA").save(path, "PNG", optimize=True)
    return {"output_path": str(path.resolve()), "file_size": path.stat().st_size, "sha256": sha256(path)}


def record_metrics(metrics: dict, saved: dict, source: Path) -> dict:
    result = dict(metrics)
    result.update({"source_path": str(source.resolve()), **saved})
    return result


def process_one(source: Path, output_root: Path, name: str, args: argparse.Namespace) -> dict:
    raw_path = output_root / "raw_green" / "source.png"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    if not raw_path.exists() or source.resolve() != raw_path.resolve():
        raw_path.write_bytes(source.read_bytes())
    try:
        image = load_rgba(source)
        result, metrics = remove_green(image, args.green_threshold, args.spill_threshold, args.edge_feather)
        out_path = output_root / "transparent" / f"{safe_name(name, 'result')}.png"
        saved = save_rgba(result, out_path)
        metrics = record_metrics(metrics, saved, source)
        preview(result, output_root / "review" / "preview.jpg")
        return metrics
    except Exception as exc:  # pragma: no cover - defensive boundary
        return {"source_path": str(source.resolve()), "output_path": None, "status": "failed", "warnings": [str(exc)], "processor_version": PROCESSOR_VERSION, "timestamp": now_iso()}


def write_reports(root: Path, records: list[dict], prompt: str | None = None, retry: list[dict] | None = None) -> None:
    reports = root / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    quality = {"processor_version": PROCESSOR_VERSION, "created_at": now_iso(), "items": records}
    manifest = {"processor_version": PROCESSOR_VERSION, "created_at": now_iso(), "items": records}
    retry_report = {"processor_version": PROCESSOR_VERSION, "created_at": now_iso(), "items": retry or [r for r in records if r.get("status") == "failed"]}
    (reports / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (reports / "quality_report.json").write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8")
    (reports / "retry_report.json").write_text(json.dumps(retry_report, ensure_ascii=False, indent=2), encoding="utf-8")
    if prompt is not None:
        (reports / "prompt.txt").write_text(prompt, encoding="utf-8")


def split_boundaries(values: np.ndarray, parts: int) -> list[int]:
    length = len(values)
    expected = [round(i * length / parts) for i in range(parts + 1)]
    window = max(2, length // parts // 5)
    result = [0]
    for index in range(1, parts):
        center = expected[index]
        lo, hi = max(result[-1] + 1, center - window), min(length - 1, center + window)
        result.append(lo + int(np.argmin(values[lo:hi + 1])))
    result.append(length)
    return result


def fit_square(image: Image.Image, size: int = 1024, margin: float = 0.05) -> Image.Image:
    rgba = image.convert("RGBA")
    bbox = rgba.getchannel("A").getbbox()
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if not bbox:
        return canvas
    crop = rgba.crop(bbox)
    limit = int(size * (1 - margin * 2))
    scale = min(limit / crop.width, limit / crop.height)
    resized = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def save_upload(image: Image.Image, path: Path) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    for colors in (256, 128, 64):
        candidate = image.convert("RGBA").quantize(colors=colors, method=Image.Quantize.FASTOCTREE).convert("RGBA")
        candidate.save(path, "PNG", optimize=True)
        if path.stat().st_size <= 500 * 1024:
            break
    return {"output_path": str(path.resolve()), "file_size": path.stat().st_size, "sha256": sha256(path), "has_alpha": True, "status": "passed" if path.stat().st_size <= 500 * 1024 else "failed", "warnings": [] if path.stat().st_size <= 500 * 1024 else ["upload_over_500KB"]}


def contact_sheet(images: list[tuple[str, Image.Image]], path: Path) -> None:
    tile = 220
    cols = 4
    rows = max(1, (len(images) + cols - 1) // cols)
    sheet = Image.new("RGB", (cols * tile, rows * (tile + 24)), (42, 42, 42))
    draw = ImageDraw.Draw(sheet)
    for index, (label, image) in enumerate(images):
        x, y = (index % cols) * tile, (index // cols) * (tile + 24)
        rgba = fit_square(image, tile - 12, 0.03)
        sheet.paste(rgba, (x + 6, y + 6), rgba)
        draw.text((x + 8, y + tile), label[:32], fill="white")
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, "JPEG", quality=88, optimize=True)


def split_grid(source: Path, root: Path, columns: int, rows: int, captions: list[str], args: argparse.Namespace) -> list[dict]:
    image = load_rgba(source)
    raw_path = root / "raw_green" / "source.png"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_bytes(source.read_bytes())
    rgb = np.array(image)[:, :, :3]
    green = green_candidate(rgb, args.green_threshold)
    x_values = np.count_nonzero(~green, axis=0)
    y_values = np.count_nonzero(~green, axis=1)
    xs, ys = split_boundaries(x_values, columns), split_boundaries(y_values, rows)
    records, previews = [], []
    for index in range(columns * rows):
        row, col = divmod(index, columns)
        tile = image.crop((xs[col], ys[row], xs[col + 1], ys[row + 1]))
        processed, metrics = remove_green(tile, args.green_threshold, args.spill_threshold, args.edge_feather)
        caption = captions[index] if index < len(captions) and captions[index] else None
        stem = f"{index + 1:02d}_{safe_name(caption, 'item') if caption else 'item'}"
        master = fit_square(processed, 1024)
        master_path = root / "master_1x1" / f"{stem}.png"
        upload_path = root / "upload_512" / f"{stem}.png"
        master_saved = save_rgba(master, master_path)
        upload_saved = save_upload(fit_square(processed, 512), upload_path)
        record = record_metrics(metrics, master_saved, source)
        record.update({"caption": caption, "grid_index": index + 1, "master_path": str(master_path.resolve()), "upload_path": str(upload_path.resolve()), "upload_file_size": upload_saved["file_size"], "upload_status": upload_saved["status"]})
        if upload_saved["status"] == "failed": record["status"] = "failed"
        records.append(record)
        previews.append((f"{index + 1:02d} {caption or ''}".strip(), master))
    contact_sheet(previews, root / "contact_sheet.jpg")
    zip_path = root / f"{safe_name(root.name, 'pack')}_512上传包.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((root / "upload_512").glob("*.png")):
            archive.write(path, path.relative_to(root).as_posix())
    write_reports(root, records)
    return records


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="FHL green-screen remover")
    sub = p.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--green-threshold", type=float, default=DEFAULT_GREEN_THRESHOLD)
    common.add_argument("--spill-threshold", type=float, default=DEFAULT_SPILL_THRESHOLD)
    common.add_argument("--edge-feather", type=int, default=DEFAULT_EDGE_FEATHER)
    common.add_argument("--background-color", default="48,48,48")
    one = sub.add_parser("remove-green", parents=[common])
    one.add_argument("--input", required=True)
    one.add_argument("--output-dir", required=True)
    one.add_argument("--name", default="result")
    grid = sub.add_parser("split-grid", parents=[common])
    grid.add_argument("--input", required=True)
    grid.add_argument("--output-dir", required=True)
    grid.add_argument("--columns", type=int, required=True)
    grid.add_argument("--rows", type=int, required=True)
    grid.add_argument("--captions", default="")
    sub.add_parser("doctor")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "doctor":
        print(json.dumps({"ok": True, "python": sys.executable, "processor_version": PROCESSOR_VERSION, "pillow": __import__("PIL").__version__, "numpy": np.__version__}, ensure_ascii=False))
        return 0
    source = Path(args.input).expanduser().resolve()
    root = Path(args.output_dir).expanduser().resolve()
    if not source.exists():
        print(json.dumps({"ok": False, "status": "failed", "error": f"input not found: {source}"}, ensure_ascii=False))
        return 1
    if args.command == "remove-green":
        record = process_one(source, root, args.name, args)
        write_reports(root, [record])
        print(json.dumps({"ok": record.get("status") != "failed", "items": [record]}, ensure_ascii=False))
        return 0 if record.get("status") != "failed" else 1
    if args.columns < 1 or args.rows < 1 or args.columns * args.rows > 256:
        print(json.dumps({"ok": False, "status": "failed", "error": "columns and rows must produce 1..256 cells"}, ensure_ascii=False))
        return 1
    captions = [item.strip() for item in args.captions.split(",")] if args.captions else []
    records = split_grid(source, root, args.columns, args.rows, captions, args)
    print(json.dumps({"ok": all(item.get("status") != "failed" for item in records), "items": records, "count": len(records)}, ensure_ascii=False))
    return 0 if all(item.get("status") != "failed" for item in records) else 1


if __name__ == "__main__":
    raise SystemExit(main())
