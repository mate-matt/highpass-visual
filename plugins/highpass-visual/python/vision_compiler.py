#!/usr/bin/env python3
"""Compile one Selected Image into a deterministic Highpass Visual Vision Asset."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np


class WorkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def normalized_point(x: int | float, y: int | float, width: int, height: int) -> dict[str, float]:
    return {
        "x": round(float(x) / max(1, width - 1), 8),
        "y": round(float(y) / max(1, height - 1), 8),
    }


def write_png(output: Path, name: str, image: np.ndarray) -> str:
    target = output / name
    if not cv2.imwrite(str(target), image, [cv2.IMWRITE_PNG_COMPRESSION, 9]):
        raise WorkerError("CHANNEL_WRITE_FAILED", "A required Vision Asset raster channel could not be written.")
    return name


def mask_measurements(mask: np.ndarray, confidence: float, fallback_reason: str | None) -> dict[str, Any]:
    height, width = mask.shape
    ys, xs = np.where(mask > 0)
    coverage = float(len(xs)) / float(width * height)
    if len(xs):
        x, y, box_width, box_height = cv2.boundingRect(np.column_stack((xs, ys)).astype(np.int32))
    else:
        x, y, box_width, box_height = 0, 0, 0, 0
    center = mask[int(height * 0.35):max(int(height * 0.65), 1), int(width * 0.35):max(int(width * 0.65), 1)]
    return {
        "coverage": round(coverage, 10),
        "confidence": round(max(0.0, min(1.0, confidence)), 8),
        "centralSupport": bool(np.count_nonzero(center)),
        "bounds": {
            "x": round(float(x) / max(1, width), 8),
            "y": round(float(y) / max(1, height), 8),
            "width": round(float(box_width) / max(1, width), 8),
            "height": round(float(box_height) / max(1, height), 8),
        },
        "fallbackReason": fallback_reason,
    }


def plausible_mask(mask: np.ndarray) -> bool:
    measured = mask_measurements(mask, 0.0, None)
    bounds = measured["bounds"]
    return bool(
        0.03 <= measured["coverage"] <= 0.90
        and measured["centralSupport"]
        and bounds["width"] > 0.02
        and bounds["height"] > 0.02
    )


def subject_mask(image: np.ndarray, gray: np.ndarray, explicit_path: str | None) -> tuple[np.ndarray, str, dict[str, Any]]:
    height, width = gray.shape
    if explicit_path:
        supplied = cv2.imread(explicit_path, cv2.IMREAD_GRAYSCALE)
        if supplied is None:
            raise WorkerError("MASK_UNREADABLE", "The explicit Selected Image mask could not be decoded.")
        if supplied.shape != gray.shape:
            raise WorkerError("MASK_SIZE_MISMATCH", "The explicit mask dimensions must match the Selected Image.")
        # Preserve an artist-authored soft matte byte-for-byte.  Binary image
        # analysis is derived separately by the compiler so compositing does
        # not destroy feathered hair, smoke, or translucent edges.
        return supplied.copy(), "explicit", mask_measurements(supplied, 1.0, None)

    _, candidate = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if float(np.count_nonzero(candidate)) / float(width * height) > 0.5:
        candidate = cv2.bitwise_not(candidate)
    kernel_size = max(3, int(round(min(width, height) * 0.025)) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, kernel)
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, kernel)
    if np.count_nonzero(candidate) >= max(16, int(width * height * 0.001)):
        grabcut_seed = np.full(gray.shape, cv2.GC_BGD, dtype=np.uint8)
        grabcut_seed[candidate > 0] = cv2.GC_PR_FGD
        eroded = cv2.erode(candidate, np.ones((3, 3), np.uint8), iterations=1)
        grabcut_seed[eroded > 0] = cv2.GC_FGD
        border = max(1, int(round(min(width, height) * 0.02)))
        grabcut_seed[:border, :] = cv2.GC_BGD
        grabcut_seed[-border:, :] = cv2.GC_BGD
        grabcut_seed[:, :border] = cv2.GC_BGD
        grabcut_seed[:, -border:] = cv2.GC_BGD
        try:
            cv2.setRNGSeed(0)
            background_model = np.zeros((1, 65), np.float64)
            foreground_model = np.zeros((1, 65), np.float64)
            cv2.grabCut(image, grabcut_seed, None, background_model, foreground_model, 5, cv2.GC_INIT_WITH_MASK)
            grabbed = np.where(
                (grabcut_seed == cv2.GC_FGD) | (grabcut_seed == cv2.GC_PR_FGD),
                255,
                0,
            ).astype(np.uint8)
            grabbed = cv2.morphologyEx(grabbed, cv2.MORPH_CLOSE, kernel)
            if plausible_mask(grabbed):
                sure_ratio = float(np.count_nonzero(grabcut_seed == cv2.GC_FGD)) / max(1.0, float(np.count_nonzero(grabbed)))
                confidence = 0.72 + min(0.23, sure_ratio * 0.23)
                return grabbed, "grabcut", mask_measurements(grabbed, confidence, None)
        except cv2.error:
            pass

    if plausible_mask(candidate):
        return candidate, "otsu-morphology", mask_measurements(candidate, 0.52, "grabcut-quality-gate-failed")
    candidate = np.full_like(gray, 255)
    return candidate, "full-frame-fallback", mask_measurements(candidate, 0.15, "grabcut-and-otsu-degenerate")


def ximgproc_features() -> dict[str, bool]:
    module = getattr(cv2, "ximgproc", None)
    return {
        "thinning": callable(getattr(module, "thinning", None)),
    }


def compiler_fingerprint() -> dict[str, Any]:
    return {
        "opencvVersion": cv2.__version__,
        "numpyVersion": np.__version__,
        "features": ximgproc_features(),
    }


def skeletonize(edges: np.ndarray, features: dict[str, bool]) -> np.ndarray:
    if features["thinning"]:
        return cv2.ximgproc.thinning(edges, thinningType=cv2.ximgproc.THINNING_GUOHALL)

    skeleton = np.zeros_like(edges)
    work = edges.copy()
    kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    while cv2.countNonZero(work):
        opened = cv2.morphologyEx(work, cv2.MORPH_OPEN, kernel)
        skeleton = cv2.bitwise_or(skeleton, cv2.subtract(work, opened))
        work = cv2.erode(work, kernel)
    return skeleton


def extract_region_contours(
    mask: np.ndarray,
    min_area_ratio: float,
    epsilon_ratio: float,
) -> tuple[list[dict[str, Any]], int, int]:
    height, width = mask.shape
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return [], 0, 0
    hierarchy_rows = hierarchy[0]
    diagonal = math.hypot(width, height)
    candidates: list[tuple[int, np.ndarray, float]] = []
    for index, contour in enumerate(contours):
        area_ratio = abs(float(cv2.contourArea(contour))) / float(width * height)
        if area_ratio < min_area_ratio:
            continue
        simplified = cv2.approxPolyDP(contour, max(0.25, epsilon_ratio * diagonal), True)
        if len(simplified) >= 3:
            candidates.append((index, simplified, area_ratio))

    raw_path_count = len(candidates)
    raw_vertex_count = sum(len(points) for _, points, _ in candidates)
    selected = sorted(candidates, key=lambda entry: entry[0])
    selected_indices = {index for index, _, _ in selected}
    identifiers = {index: f"region-{order:05d}" for order, (index, _, _) in enumerate(selected)}

    output: list[dict[str, Any]] = []
    for index, contour, area_ratio in selected:
        parent = int(hierarchy_rows[index][3])
        depth = 0
        cursor = parent
        while cursor >= 0:
            depth += 1
            cursor = int(hierarchy_rows[cursor][3])
        while parent >= 0 and parent not in selected_indices:
            parent = int(hierarchy_rows[parent][3])
        output.append({
            "id": identifiers[index],
            "parentId": identifiers[parent] if parent >= 0 else None,
            "hole": depth % 2 == 1,
            "areaRatio": round(area_ratio, 10),
            "points": [
                normalized_point(point[0][0], point[0][1], width, height)
                for point in contour
            ],
        })
    return output, raw_path_count, raw_vertex_count


NEIGHBOR_OFFSETS = (
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1), (0, 1),
    (1, -1), (1, 0), (1, 1),
)


def edge_key(left: tuple[int, int], right: tuple[int, int]) -> tuple[tuple[int, int], tuple[int, int]]:
    return (left, right) if left <= right else (right, left)


def trace_skeleton(skeleton: np.ndarray) -> list[list[tuple[int, int]]]:
    pixels = {(int(y), int(x)) for y, x in np.argwhere(skeleton > 0)}

    def neighbors(point: tuple[int, int]) -> list[tuple[int, int]]:
        y, x = point
        return sorted(
            (y + dy, x + dx)
            for dy, dx in NEIGHBOR_OFFSETS
            if (y + dy, x + dx) in pixels
        )

    adjacency = {point: neighbors(point) for point in pixels}
    visited: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    paths: list[list[tuple[int, int]]] = []

    def walk(start: tuple[int, int], following: tuple[int, int]) -> list[tuple[int, int]]:
        path = [start, following]
        previous, current = start, following
        visited.add(edge_key(previous, current))
        while len(adjacency[current]) == 2:
            choices = [
                candidate for candidate in adjacency[current]
                if candidate != previous and edge_key(current, candidate) not in visited
            ]
            if not choices:
                break
            following_point = choices[0]
            visited.add(edge_key(current, following_point))
            path.append(following_point)
            previous, current = current, following_point
        if len(path) > 2 and path[-1] == path[0]:
            path.pop()
        return path

    terminals = sorted(point for point, linked in adjacency.items() if len(linked) != 2)
    for start in terminals:
        for following in adjacency[start]:
            if edge_key(start, following) not in visited:
                path = walk(start, following)
                if len(path) >= 2:
                    paths.append(path)

    for start in sorted(pixels):
        for following in adjacency[start]:
            if edge_key(start, following) not in visited:
                path = walk(start, following)
                if len(path) >= 2:
                    paths.append(path)
    return paths


def extract_open_strokes(
    skeleton: np.ndarray,
    epsilon_ratio: float,
) -> tuple[list[dict[str, Any]], int, int]:
    height, width = skeleton.shape
    diagonal = math.hypot(width, height)
    traced = trace_skeleton(skeleton)
    simplified_paths: list[np.ndarray] = []
    for traced_path in traced:
        points = np.array([(x, y) for y, x in traced_path], dtype=np.int32).reshape((-1, 1, 2))
        simplified = cv2.approxPolyDP(points, max(0.25, epsilon_ratio * diagonal), False)
        if len(simplified) >= 2:
            simplified_paths.append(simplified)
    raw_path_count = len(simplified_paths)
    raw_vertex_count = sum(len(points) for points in simplified_paths)
    simplified_paths.sort(key=lambda points: (-cv2.arcLength(points, False), points[0][0][1], points[0][0][0]))

    output: list[dict[str, Any]] = []
    for points in simplified_paths:
        normalized = [normalized_point(point[0][0], point[0][1], width, height) for point in points]
        if normalized[0] == normalized[-1]:
            normalized.pop()
        if len(normalized) < 2:
            continue
        cumulative = [0.0]
        for index in range(1, len(normalized)):
            dx = normalized[index]["x"] - normalized[index - 1]["x"]
            dy = normalized[index]["y"] - normalized[index - 1]["y"]
            cumulative.append(round(cumulative[-1] + math.hypot(dx, dy), 10))
        output.append({
            "id": f"stroke-{len(output):05d}",
            "points": normalized,
            "cumulativeLength": cumulative,
            "length": cumulative[-1],
        })
    return output, raw_path_count, raw_vertex_count


def saliency_metadata(gray: np.ndarray) -> dict[str, Any]:
    height, width = gray.shape
    gradient_x = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(gradient_x, gradient_y)
    mass = float(np.sum(magnitude))
    if mass <= 1e-9:
        centroid_x = 0.5
        centroid_y = 0.5
        bounds = {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5}
        covariance = {"xx": 0.0, "xy": 0.0, "yy": 0.0}
    else:
        xs = np.arange(width, dtype=np.float32)[None, :]
        ys = np.arange(height, dtype=np.float32)[:, None]
        centroid_px = float(np.sum(magnitude * xs) / mass)
        centroid_py = float(np.sum(magnitude * ys) / mass)
        centroid_x = centroid_px / max(1, width - 1)
        centroid_y = centroid_py / max(1, height - 1)
        threshold = float(np.percentile(magnitude[magnitude > 0], 70)) if np.count_nonzero(magnitude) else 0.0
        active_y, active_x = np.where(magnitude >= threshold)
        if len(active_x):
            x, y, active_width, active_height = cv2.boundingRect(np.column_stack((active_x, active_y)).astype(np.int32))
            bounds = {
                "x": round(float(x) / max(1, width), 8),
                "y": round(float(y) / max(1, height), 8),
                "width": round(float(active_width) / max(1, width), 8),
                "height": round(float(active_height) / max(1, height), 8),
            }
        else:
            bounds = {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5}
        dx = (xs - centroid_px) / max(1, width - 1)
        dy = (ys - centroid_py) / max(1, height - 1)
        covariance = {
            "xx": round(float(np.sum(magnitude * dx * dx) / mass), 10),
            "xy": round(float(np.sum(magnitude * dx * dy) / mass), 10),
            "yy": round(float(np.sum(magnitude * dy * dy) / mass), 10),
        }
    return {
        "method": "gradient-magnitude",
        "centroid": {"x": round(centroid_x, 8), "y": round(centroid_y, 8)},
        "bounds": bounds,
        "covariance": covariance,
        "mass": round(mass / max(1.0, float(width * height) * 255.0), 10),
    }


def compile_asset(request: dict[str, Any], output: Path) -> None:
    source = request["selectedImage"]
    recipe = request["recipe"]
    image = cv2.imread(source["path"], cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise WorkerError("SOURCE_UNREADABLE", "The Selected Image could not be decoded by OpenCV.")
    height, width = image.shape[:2]
    preview_scale = min(1.0, (float(1280 * 720) / float(width * height)) ** 0.5)
    preview_width = max(1, int(width * preview_scale))
    preview_height = max(1, int(height * preview_scale))

    def preview_raster(raster: np.ndarray) -> np.ndarray:
        if preview_width == width and preview_height == height:
            return raster
        return cv2.resize(raster, (preview_width, preview_height), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    output.mkdir(parents=True, exist_ok=True)

    sigma = float(recipe["lowFrequencySigma"])
    low_frequency = cv2.GaussianBlur(image, (0, 0), sigmaX=sigma, sigmaY=sigma, borderType=cv2.BORDER_REFLECT101)
    signed_detail = cv2.addWeighted(image, 1.0, low_frequency, -1.0, 128.0)
    signed_response = image.astype(np.int16) - low_frequency.astype(np.int16)
    signed_detail_light = np.clip(signed_response * 2, 0, 255).astype(np.uint8)
    signed_detail_dark = np.clip(-signed_response * 2, 0, 255).astype(np.uint8)
    strong_edge = cv2.Canny(
        gray,
        float(recipe["strongEdges"]["low"]),
        float(recipe["strongEdges"]["high"]),
        L2gradient=True,
    )
    detail_edge = cv2.Canny(
        gray,
        float(recipe["detailEdges"]["low"]),
        float(recipe["detailEdges"]["high"]),
        L2gradient=True,
    )
    mask, mask_method, mask_analysis = subject_mask(image, gray, source.get("maskPath"))
    analysis_mask = np.where(mask >= 128, 255, 0).astype(np.uint8)
    inside = cv2.distanceTransform(analysis_mask, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    outside = cv2.distanceTransform(cv2.bitwise_not(analysis_mask), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    distance_scale = float(max(width, height))
    signed_distance = inside - outside
    distance_field = np.clip((signed_distance / distance_scale) * 32767.0 + 32768.0, 0, 65535).astype(np.uint16)
    foreground_plate = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
    foreground_plate[:, :, 3] = mask
    inpaint_radius = max(1, int(round(min(width, height) * 0.035)))
    background_plate = cv2.inpaint(image, analysis_mask, inpaint_radius, cv2.INPAINT_TELEA) \
        if mask_analysis["coverage"] < 0.9 else cv2.GaussianBlur(image, (0, 0), sigmaX=max(2.0, inpaint_radius))
    middle_color = cv2.addWeighted(background_plate, 0.58, low_frequency, 0.42, 0.0)
    middle_plate = cv2.cvtColor(middle_color, cv2.COLOR_BGR2BGRA)
    ring_radius = max(3, int(round(min(width, height) * 0.055)) | 1)
    ring_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ring_radius, ring_radius))
    context_ring = cv2.subtract(cv2.dilate(analysis_mask, ring_kernel), analysis_mask)
    middle_plate[:, :, 3] = context_ring
    max_inside = float(np.max(inside))
    normalized_inside = inside / max_inside if max_inside > 1e-9 else np.zeros_like(inside)
    depth_proxy = np.clip((mask.astype(np.float32) / 255.0) * (0.55 + normalized_inside * 0.45) * 255.0, 0, 255).astype(np.uint8)

    fingerprint = compiler_fingerprint()
    if request.get("compilerFingerprint") != fingerprint:
        raise WorkerError("RUNTIME_CHANGED", "The Vision Compiler runtime changed after capability inspection; retry compilation.")
    features = fingerprint["features"]
    skeleton = skeletonize(detail_edge, features)
    max_paths = int(recipe["maxPaths"])
    max_vertices = int(recipe["maxVertices"])
    contours, raw_contour_paths, raw_contour_vertices = extract_region_contours(
        analysis_mask,
        float(recipe["minContourAreaRatio"]),
        float(recipe["simplifyEpsilonRatio"]),
    )
    contour_vertices = sum(len(contour["points"]) for contour in contours)
    strokes, raw_stroke_paths, raw_stroke_vertices = extract_open_strokes(
        skeleton,
        float(recipe["simplifyEpsilonRatio"]),
    )

    channel_files = {
        "low-frequency": write_png(output, "low-frequency.png", low_frequency),
        "signed-detail": write_png(output, "signed-detail.png", signed_detail),
        "signed-detail-light": write_png(output, "signed-detail-light.png", signed_detail_light),
        "signed-detail-dark": write_png(output, "signed-detail-dark.png", signed_detail_dark),
        "strong-edge": write_png(output, "strong-edge.png", strong_edge),
        "detail-edge": write_png(output, "detail-edge.png", detail_edge),
        "subject-mask": write_png(output, "subject-mask.png", mask),
        "distance-field": write_png(output, "distance-field.png", distance_field),
        "foreground-plate": write_png(output, "foreground-plate.png", foreground_plate),
        "middle-plate": write_png(output, "middle-plate.png", middle_plate),
        "background-plate": write_png(output, "background-plate.png", background_plate),
        "depth-proxy": write_png(output, "depth-proxy.png", depth_proxy),
    }
    channel_rasters = {
        "low-frequency": low_frequency,
        "signed-detail": signed_detail,
        "signed-detail-light": signed_detail_light,
        "signed-detail-dark": signed_detail_dark,
        "strong-edge": strong_edge,
        "detail-edge": detail_edge,
        "subject-mask": mask,
        "distance-field": distance_field,
        "foreground-plate": foreground_plate,
        "middle-plate": middle_plate,
        "background-plate": background_plate,
        "depth-proxy": depth_proxy,
    }
    preview_channel_files = {
        identifier: write_png(output, f"preview-{identifier}.png", preview_raster(raster))
        for identifier, raster in channel_rasters.items()
    }
    source_preview_file = write_png(output, "selected-image.png", image)
    source_bounded_preview_file = write_png(output, "preview-selected-image.png", preview_raster(image))
    final_directory = Path(request["artifactDirectory"])

    def channel(identifier: str, family: str, encoding: str, **extra: float) -> dict[str, Any]:
        return {
            "id": identifier,
            "family": family,
            "path": str(final_directory / channel_files[identifier]),
            "previewPath": str(final_directory / preview_channel_files[identifier]),
            "format": "png",
            "width": width,
            "height": height,
            "previewWidth": preview_width,
            "previewHeight": preview_height,
            "encoding": encoding,
            **extra,
        }

    path_count = len(contours) + len(strokes)
    vertex_count = contour_vertices + sum(len(stroke["points"]) for stroke in strokes)
    warnings: list[str] = []
    if path_count > max_paths:
        warnings.append(f"Path budget exceeded by {path_count - max_paths}; geometry was preserved for semantic fidelity.")
    if vertex_count > max_vertices:
        warnings.append(f"Vertex budget exceeded by {vertex_count - max_vertices}; geometry was preserved for semantic fidelity.")

    manifest = {
        "schemaVersion": request["schemaVersion"],
        "artifactHash": request["artifactHash"],
        "generator": {
            "name": "highpass-vision-compiler",
            "version": request["generatorVersion"],
            "opencvVersion": fingerprint["opencvVersion"],
            "numpyVersion": fingerprint["numpyVersion"],
            "features": features,
        },
        "provenance": request["hashes"],
        "source": {
            "selectedImageId": source["id"],
            "path": source["path"],
            "maskPath": source.get("maskPath"),
            "imageHash": source["imageHash"],
            "maskHash": source.get("maskHash"),
            "compiledPath": str(final_directory / source_preview_file),
            "previewPath": str(final_directory / source_bounded_preview_file),
            "width": width,
            "height": height,
            "previewWidth": preview_width,
            "previewHeight": preview_height,
        },
        "recipe": recipe,
        "channels": [
            channel("low-frequency", "frequency-layer", "srgb8"),
            channel("signed-detail", "frequency-layer", "signed-offset-128", zeroValue=128),
            channel("signed-detail-light", "frequency-layer", "positive-detail-rgb8"),
            channel("signed-detail-dark", "frequency-layer", "negative-detail-rgb8"),
            channel("strong-edge", "edge-layer", "mask8"),
            channel("detail-edge", "edge-layer", "mask8"),
            channel("subject-mask", "mask", "mask8"),
            channel("distance-field", "distance-field", "signed-normalized-uint16", zeroValue=32768, scale=distance_scale),
            channel("foreground-plate", "rgba-plate", "bgra8-straight-alpha"),
            channel("middle-plate", "rgba-plate", "bgra8-context-ring-alpha"),
            channel("background-plate", "frequency-layer", "srgb8-inpaint-telea"),
            channel("depth-proxy", "depth-proxy", "foreground-distance-uint8"),
        ],
        "regionContours": contours,
        "openStrokes": strokes,
        "complexity": {
            "pathCount": path_count,
            "vertexCount": vertex_count,
            "edgeDensity": round(float(np.count_nonzero(detail_edge)) / float(width * height), 10),
            "saliency": saliency_metadata(gray),
            "budgets": {"maxPaths": max_paths, "maxVertices": max_vertices},
            "warnings": warnings,
        },
        "maskMethod": mask_method,
        "maskAnalysis": mask_analysis,
    }
    with (output / "manifest.json").open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fingerprint", action="store_true")
    parser.add_argument("--request")
    parser.add_argument("--output")
    args = parser.parse_args()
    try:
        if args.fingerprint:
            print(json.dumps(compiler_fingerprint(), sort_keys=True, separators=(",", ":")))
            return 0
        if not args.request or not args.output:
            raise WorkerError("INVALID_REQUEST", "The Vision Compiler request and output directory are required.")
        with Path(args.request).open("r", encoding="utf-8") as handle:
            request = json.load(handle)
        compile_asset(request, Path(args.output))
        return 0
    except WorkerError as error:
        print(json.dumps({"code": error.code, "message": error.message}), file=sys.stderr)
        return 2
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        print(json.dumps({"code": "INVALID_REQUEST", "message": "The Vision Compiler request is invalid."}), file=sys.stderr)
        return 2
    except Exception:
        print(json.dumps({"code": "COMPILATION_FAILED", "message": "OpenCV could not compile the Selected Image with this recipe."}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
