#!/usr/bin/env python3
"""Compile OpenCV evidence and renderer assets for one adjacent Shot pair."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
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


def fingerprint() -> dict[str, Any]:
    return {
        "opencvVersion": cv2.__version__,
        "numpyVersion": np.__version__,
        "algorithms": ["orb", "ransac-homography", "farneback-bidirectional", "forward-backward-occlusion", "hu-contour-correspondence"],
    }


def rounded(value: float, digits: int = 8) -> float:
    return round(float(value), digits)


def read_pair(request: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    outgoing = cv2.imread(request["outgoing"]["imagePath"], cv2.IMREAD_COLOR)
    incoming = cv2.imread(request["incoming"]["imagePath"], cv2.IMREAD_COLOR)
    if outgoing is None or incoming is None:
        raise WorkerError("TRANSITION_SOURCE_UNREADABLE", "An adjacent Vision Asset preview could not be decoded.")
    source_height, source_width = outgoing.shape[:2]
    scale = min(1.0, 640.0 / max(source_width, source_height))
    width = max(32, int(round(source_width * scale)))
    height = max(32, int(round(source_height * scale)))
    outgoing = cv2.resize(outgoing, (width, height), interpolation=cv2.INTER_AREA)
    incoming = cv2.resize(incoming, (width, height), interpolation=cv2.INTER_AREA)
    return outgoing, incoming


def homography_evidence(outgoing: np.ndarray, incoming: np.ndarray, limits: dict[str, Any]) -> tuple[dict[str, Any], list[float] | None]:
    gray_out = cv2.cvtColor(outgoing, cv2.COLOR_BGR2GRAY)
    gray_in = cv2.cvtColor(incoming, cv2.COLOR_BGR2GRAY)
    cv2.setRNGSeed(0)
    orb = cv2.ORB_create(nfeatures=2200, scaleFactor=1.2, nlevels=8, edgeThreshold=12, fastThreshold=8)
    key_out, descriptors_out = orb.detectAndCompute(gray_out, None)
    key_in, descriptors_in = orb.detectAndCompute(gray_in, None)
    matches: list[Any] = []
    if descriptors_out is not None and descriptors_in is not None and len(descriptors_out) >= 2 and len(descriptors_in) >= 2:
        for candidates in cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(descriptors_out, descriptors_in, k=2):
            if len(candidates) == 2 and candidates[0].distance < 0.75 * candidates[1].distance:
                matches.append(candidates[0])
    matrix: np.ndarray | None = None
    inliers = 0
    inlier_ratio = 0.0
    reprojection: float | None = None
    corners_valid = False
    area_ratio: float | None = None
    overlap = 0.0
    if len(matches) >= 4:
        source_points = np.float32([key_out[match.queryIdx].pt for match in matches]).reshape(-1, 1, 2)
        destination_points = np.float32([key_in[match.trainIdx].pt for match in matches]).reshape(-1, 1, 2)
        matrix, mask = cv2.findHomography(source_points, destination_points, cv2.RANSAC, 3.0, maxIters=3000, confidence=0.995)
        if matrix is not None and mask is not None and np.all(np.isfinite(matrix)):
            accepted = mask.ravel().astype(bool)
            inliers = int(np.count_nonzero(accepted))
            inlier_ratio = float(inliers) / max(1, len(matches))
            if inliers:
                projected = cv2.perspectiveTransform(source_points[accepted], matrix)
                errors = np.linalg.norm(projected[:, 0, :] - destination_points[accepted, 0, :], axis=1)
                reprojection = float(np.median(errors))
            height, width = gray_out.shape
            corners = np.float32([[[0, 0]], [[width - 1, 0]], [[width - 1, height - 1]], [[0, height - 1]]])
            projected_corners = cv2.perspectiveTransform(corners, matrix).reshape(-1, 2)
            projected_polygon = projected_corners.astype(np.float32)
            projected_area = abs(float(cv2.contourArea(projected_polygon)))
            frame_area = float(width * height)
            area_ratio = projected_area / frame_area
            corners_valid = bool(cv2.isContourConvex(projected_polygon) and projected_area > 1 and np.all(np.isfinite(projected_polygon)))
            if corners_valid:
                frame = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
                try:
                    intersection, _ = cv2.intersectConvexConvex(projected_polygon, frame)
                    overlap = max(0.0, min(1.0, float(intersection) / frame_area))
                except cv2.error:
                    overlap = 0.0
    reasons: list[str] = []
    if len(matches) < int(limits["minimumMatches"]):
        reasons.append("filtered-match-count-below-threshold")
    if inliers < int(limits["minimumInliers"]):
        reasons.append("ransac-inlier-count-below-threshold")
    if inlier_ratio < float(limits["minimumInlierRatio"]):
        reasons.append("ransac-inlier-ratio-below-threshold")
    if reprojection is None or reprojection > float(limits["maximumReprojectionError"]):
        reasons.append("reprojection-error-above-threshold")
    if not corners_valid:
        reasons.append("projected-corners-invalid")
    if overlap < float(limits["minimumOverlapCoverage"]):
        reasons.append("projected-overlap-below-threshold")
    if area_ratio is None or area_ratio > float(limits["maximumProjectedAreaRatio"]):
        reasons.append("projected-area-outside-threshold")
    metrics = {
        "passed": not reasons,
        "detectedOutgoing": len(key_out),
        "detectedIncoming": len(key_in),
        "filteredMatches": len(matches),
        "inliers": inliers,
        "inlierRatio": rounded(inlier_ratio),
        "medianReprojectionError": rounded(reprojection) if reprojection is not None else None,
        "projectedCornersValid": corners_valid,
        "projectedAreaRatio": rounded(area_ratio) if area_ratio is not None else None,
        "overlapCoverage": rounded(overlap),
        "reasons": reasons,
    }
    return metrics, [rounded(value, 12) for value in matrix.reshape(-1)] if matrix is not None else None


def encode_flow(flow: np.ndarray, scale: float) -> np.ndarray:
    encoded = np.zeros((*flow.shape[:2], 4), dtype=np.uint8)
    encoded[:, :, 2] = np.clip((flow[:, :, 0] / scale * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    encoded[:, :, 1] = np.clip((flow[:, :, 1] / scale * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    encoded[:, :, 3] = 255
    return encoded


def optical_flow_evidence(outgoing: np.ndarray, incoming: np.ndarray, limits: dict[str, Any]) -> tuple[dict[str, Any], np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, float]:
    gray_out = cv2.cvtColor(outgoing, cv2.COLOR_BGR2GRAY)
    gray_in = cv2.cvtColor(incoming, cv2.COLOR_BGR2GRAY)
    parameters = dict(pyr_scale=0.5, levels=4, winsize=21, iterations=5, poly_n=7, poly_sigma=1.5, flags=cv2.OPTFLOW_FARNEBACK_GAUSSIAN)
    forward = cv2.calcOpticalFlowFarneback(gray_out, gray_in, None, **parameters)
    backward = cv2.calcOpticalFlowFarneback(gray_in, gray_out, None, **parameters)
    height, width = gray_out.shape
    grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))

    def directional_evidence(origin: np.ndarray, destination: np.ndarray, primary: np.ndarray, inverse: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict[str, float | None]]:
        mapped_x = grid_x + primary[:, :, 0]
        mapped_y = grid_y + primary[:, :, 1]
        valid = (mapped_x >= 0) & (mapped_x <= width - 1) & (mapped_y >= 0) & (mapped_y <= height - 1)
        inverse_at_destination = cv2.remap(inverse, mapped_x, mapped_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        consistency_error = np.linalg.norm(primary + inverse_at_destination, axis=2)
        warped_destination = cv2.remap(destination, mapped_x, mapped_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT101)
        photometric_error = cv2.absdiff(origin, warped_destination).astype(np.float32)
        confidence = np.exp(-consistency_error / 1.5) * np.exp(-photometric_error / 28.0) * valid.astype(np.float32)
        occlusion = (~valid) | (confidence < 0.35)
        gradient = cv2.magnitude(cv2.Sobel(origin, cv2.CV_32F, 1, 0), cv2.Sobel(origin, cv2.CV_32F, 0, 1))
        active = gradient >= np.percentile(gradient, 55)
        evaluation = active & valid
        if not np.count_nonzero(evaluation):
            evaluation = valid
        measured = {
            "confidence": float(np.mean(confidence[evaluation])) if np.count_nonzero(evaluation) else 0.0,
            "occlusion": float(np.mean(occlusion[evaluation])) if np.count_nonzero(evaluation) else 1.0,
            "error": float(np.median(consistency_error[evaluation])) if np.count_nonzero(evaluation) else None,
            "displacement": float(np.percentile(np.linalg.norm(primary, axis=2)[evaluation], 95)) if np.count_nonzero(evaluation) else 0.0,
        }
        return confidence, occlusion, measured

    confidence_forward, occlusion_forward, forward_values = directional_evidence(gray_out, gray_in, forward, backward)
    confidence_backward, occlusion_backward, backward_values = directional_evidence(gray_in, gray_out, backward, forward)
    confidence_value = min(float(forward_values["confidence"]), float(backward_values["confidence"]))
    occlusion_ratio = max(float(forward_values["occlusion"]), float(backward_values["occlusion"]))
    directional_errors = [value for value in [forward_values["error"], backward_values["error"]] if value is not None]
    median_error = max(directional_errors) if directional_errors else None
    displacement_p95 = max(float(forward_values["displacement"]), float(backward_values["displacement"]))
    displacement_ratio = displacement_p95 / max(1.0, float(min(width, height)))
    reasons: list[str] = []
    if confidence_value < float(limits["minimumConfidence"]):
        reasons.append("flow-confidence-below-threshold")
    if occlusion_ratio > float(limits["maximumOcclusionRatio"]):
        reasons.append("flow-occlusion-above-threshold")
    if median_error is None or median_error > float(limits["maximumForwardBackwardError"]):
        reasons.append("forward-backward-error-above-threshold")
    if displacement_ratio > float(limits["maximumDisplacementRatio"]):
        reasons.append("flow-displacement-above-threshold")
    metrics = {
        "passed": not reasons,
        "confidence": rounded(confidence_value),
        "occlusionRatio": rounded(occlusion_ratio),
        "medianForwardBackwardError": rounded(median_error) if median_error is not None else None,
        "displacementP95": rounded(displacement_p95),
        "displacementRatioP95": rounded(displacement_ratio),
        "reasons": reasons,
    }
    flow_scale = max(1.0, float(min(width, height)) * float(limits["maximumDisplacementRatio"]))
    return (
        metrics,
        encode_flow(forward, flow_scale),
        encode_flow(backward, flow_scale),
        np.clip(confidence_forward * 255.0, 0, 255).astype(np.uint8),
        np.clip(confidence_backward * 255.0, 0, 255).astype(np.uint8),
        occlusion_forward.astype(np.uint8) * 255,
        occlusion_backward.astype(np.uint8) * 255,
        flow_scale,
    )


def contour_array(contour: dict[str, Any]) -> np.ndarray:
    return np.float32([[point["x"], point["y"]] for point in contour["points"]])


def resample_closed_array(points: np.ndarray, count: int = 64) -> np.ndarray:
    if len(points) < 3:
        points = np.float32([[0, 0], [1, 0], [1, 1]])
    closed = np.vstack([points, points[0]])
    segments = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    cumulative = np.concatenate([[0.0], np.cumsum(segments)])
    total = float(cumulative[-1])
    targets = np.linspace(0, total, count, endpoint=False)
    output: list[np.ndarray] = []
    for target in targets:
        index = min(len(segments) - 1, int(np.searchsorted(cumulative, target, side="right") - 1))
        amount = 0.0 if segments[index] <= 1e-9 else (target - cumulative[index]) / segments[index]
        point = closed[index] + (closed[index + 1] - closed[index]) * amount
        output.append(np.clip(point, 0, 1))
    return np.float32(output)


def signed_area(points: np.ndarray) -> float:
    return float(0.5 * np.sum(points[:, 0] * np.roll(points[:, 1], -1) - np.roll(points[:, 0], -1) * points[:, 1]))


def aligned_contours(left: np.ndarray, right: np.ndarray) -> tuple[list[dict[str, float]], list[dict[str, float]]]:
    outgoing = resample_closed_array(left)
    incoming = resample_closed_array(right)
    if signed_area(outgoing) * signed_area(incoming) < 0:
        incoming = incoming[::-1].copy()
    costs = [float(np.sum(np.square(outgoing - np.roll(incoming, -shift, axis=0)))) for shift in range(len(incoming))]
    incoming = np.roll(incoming, -int(np.argmin(costs)), axis=0)
    points = lambda values: [{"x": rounded(point[0]), "y": rounded(point[1])} for point in values]
    return points(outgoing), points(incoming)


def contour_evidence(outgoing: list[dict[str, Any]], incoming: list[dict[str, Any]], limits: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    source = outgoing
    target = incoming
    candidates: list[tuple[float, str, str, dict[str, Any], dict[str, Any]]] = []
    for left in source:
        left_points = contour_array(left)
        left_center = np.mean(left_points, axis=0)
        left_cv = left_points.reshape(-1, 1, 2)
        for right in target:
            if bool(left["hole"]) != bool(right["hole"]):
                continue
            right_points = contour_array(right)
            right_center = np.mean(right_points, axis=0)
            area_cost = abs(float(left["areaRatio"]) - float(right["areaRatio"])) / max(1e-6, max(float(left["areaRatio"]), float(right["areaRatio"])))
            center_cost = float(np.linalg.norm(left_center - right_center))
            shape_cost = float(cv2.matchShapes(left_cv, right_points.reshape(-1, 1, 2), cv2.CONTOURS_MATCH_I1, 0.0))
            hierarchy_cost = 0.0 if bool(left.get("parentId")) == bool(right.get("parentId")) else 1.0
            cost = area_cost * 0.30 + center_cost * 0.30 + min(2.0, shape_cost) * 0.30 + hierarchy_cost * 0.10
            candidates.append((cost, left["id"], right["id"], left, right))
    used_left: set[str] = set()
    used_right: set[str] = set()
    pairs: list[dict[str, Any]] = []
    for cost, left_id, right_id, left, right in sorted(candidates, key=lambda entry: (entry[0], entry[1], entry[2])):
        if left_id in used_left or right_id in used_right:
            continue
        confidence = math.exp(-2.2 * cost)
        if confidence < 0.25:
            continue
        used_left.add(left_id)
        used_right.add(right_id)
        coverage = min(float(left["areaRatio"]), float(right["areaRatio"]))
        outgoing_points, incoming_points = aligned_contours(contour_array(left), contour_array(right))
        pairs.append({
            "id": f"contour-pair-{len(pairs):04d}",
            "confidence": rounded(confidence),
            "coverage": rounded(coverage),
            "outgoingContourId": left_id,
            "incomingContourId": right_id,
            "outgoing": outgoing_points,
            "incoming": incoming_points,
        })
    total_source = sum(float(contour["areaRatio"]) for contour in source)
    coverage = min(1.0, sum(pair["coverage"] for pair in pairs) / max(1e-9, total_source))
    confidence = float(np.mean([pair["confidence"] for pair in pairs])) if pairs else 0.0
    reasons: list[str] = []
    if len(pairs) < int(limits["minimumPairs"]):
        reasons.append("contour-pair-count-below-threshold")
    if coverage < float(limits["minimumCoverage"]):
        reasons.append("contour-coverage-below-threshold")
    if confidence < float(limits["minimumConfidence"]):
        reasons.append("contour-confidence-below-threshold")
    return {"passed": not reasons, "pairCount": len(pairs), "coverage": rounded(coverage), "confidence": rounded(confidence), "reasons": reasons}, pairs


def choose_plan(request: dict[str, Any], metrics: dict[str, Any]) -> dict[str, Any]:
    intent = request["transitionIntent"]
    quality = {
        "homography-dissolve": metrics["homography"]["passed"],
        "optical-flow-dissolve": metrics["opticalFlow"]["passed"],
        "contour-morph": metrics["contours"]["passed"],
        "distance-field-wipe": request["outgoing"]["maskMethod"] != "full-frame-fallback" and 0.03 <= float(request["outgoing"]["maskAnalysis"]["coverage"]) <= 0.90,
        "cross-dissolve": True,
        "fade-to-black": True,
        "cut": True,
    }
    fallback_chains = {
        "continuity": ["optical-flow-dissolve", "homography-dissolve", "cross-dissolve"],
        "reveal": ["contour-morph", "distance-field-wipe", "cross-dissolve"],
        "atmospheric": ["distance-field-wipe", "cross-dissolve"],
        "dislocation": ["cut"],
        "terminal": ["cut"],
    }
    chain = fallback_chains[intent["intent"]]
    locked = intent.get("lockedMethod")
    if locked:
        chain = [locked]
        if not quality.get(locked, False):
            raise WorkerError("LOCKED_TRANSITION_QUALITY_GATE_FAILED", f"Locked transition method {locked} did not pass its recorded quality gate.")
        return {"selectedMethod": locked, "fallbackChain": chain, "rejectedMethods": [], "locked": True, "selectionReason": "Locked method passed its recorded quality gate."}
    rejected: list[str] = []
    for method in chain:
        if quality.get(method, False):
            fallback = bool(rejected)
            reason = f"Selected {method} after quality-gated fallback from {', '.join(rejected)}." if fallback else f"Selected {method} as the first quality-compatible method for {intent['intent']} intent."
            return {"selectedMethod": method, "fallbackChain": chain, "rejectedMethods": rejected, "locked": False, "selectionReason": reason}
        rejected.append(method)
    raise WorkerError("NO_TRANSITION_METHOD_AVAILABLE", "No transition method or deterministic fallback is available.")


def write_png(output: Path, name: str, image: np.ndarray) -> str:
    if not cv2.imwrite(str(output / name), image, [cv2.IMWRITE_PNG_COMPRESSION, 9]):
        raise WorkerError("TRANSITION_ASSET_WRITE_FAILED", "A required transition raster could not be written.")
    return name


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compile_transition(request: dict[str, Any], output: Path) -> None:
    if request.get("fingerprint") != fingerprint():
        raise WorkerError("TRANSITION_RUNTIME_CHANGED", "The OpenCV transition runtime changed after inspection; retry compilation.")
    output.mkdir(parents=True, exist_ok=True)
    outgoing, incoming = read_pair(request)
    homography_metrics, homography = homography_evidence(outgoing, incoming, request["thresholds"]["homography"])
    flow_metrics, flow_forward, flow_backward, confidence_forward, confidence_backward, occlusion_forward, occlusion_backward, flow_scale = optical_flow_evidence(outgoing, incoming, request["thresholds"]["opticalFlow"])
    contour_metrics, correspondences = contour_evidence(request["outgoing"]["contours"], request["incoming"]["contours"], request["thresholds"]["contours"])
    metrics = {"homography": homography_metrics, "opticalFlow": flow_metrics, "contours": contour_metrics}
    plan = choose_plan(request, metrics)
    files = {
        "flowForwardPath": write_png(output, "flow-forward.png", flow_forward),
        "flowBackwardPath": write_png(output, "flow-backward.png", flow_backward),
        "confidenceForwardPath": write_png(output, "flow-confidence-forward.png", confidence_forward),
        "confidenceBackwardPath": write_png(output, "flow-confidence-backward.png", confidence_backward),
        "occlusionForwardPath": write_png(output, "flow-occlusion-forward.png", occlusion_forward),
        "occlusionBackwardPath": write_png(output, "flow-occlusion-backward.png", occlusion_backward),
    }
    final_directory = Path(request["artifactDirectory"])
    warnings = [f"{family}: {reason}" for family, evidence in metrics.items() for reason in evidence["reasons"]]
    manifest = {
        "schemaVersion": request["schemaVersion"],
        "artifactHash": request["artifactHash"],
        "generator": {"name": "highpass-transition-compiler", "version": request["generatorVersion"], **fingerprint()},
        "provenance": request["hashes"],
        "sources": {
            "outgoing": {key: request["outgoing"][key] for key in ["visionArtifactHash", "manifestPath", "imagePath", "maskPath", "distanceFieldPath"]},
            "incoming": {key: request["incoming"][key] for key in ["visionArtifactHash", "manifestPath", "imagePath", "maskPath", "distanceFieldPath"]},
        },
        "transitionIntent": request["transitionIntent"],
        "thresholds": request["thresholds"],
        "analysis": {"width": outgoing.shape[1], "height": outgoing.shape[0], "flowScale": rounded(flow_scale)},
        "metrics": metrics,
        "plan": plan,
        "artifacts": {
            "homography": homography,
            **{key: str(final_directory / value) for key, value in files.items()},
            **{key.replace("Path", "Hash"): file_hash(output / value) for key, value in files.items()},
        },
        "contourCorrespondences": correspondences,
        "warnings": warnings,
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
            print(json.dumps(fingerprint(), sort_keys=True, separators=(",", ":")))
            return 0
        if not args.request or not args.output:
            raise WorkerError("INVALID_TRANSITION_REQUEST", "Transition request and output paths are required.")
        with Path(args.request).open("r", encoding="utf-8") as handle:
            request = json.load(handle)
        compile_transition(request, Path(args.output))
        return 0
    except WorkerError as error:
        print(json.dumps({"code": error.code, "message": error.message}), file=sys.stderr)
        return 2
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        print(json.dumps({"code": "INVALID_TRANSITION_REQUEST", "message": "The Transition Compiler request is invalid."}), file=sys.stderr)
        return 2
    except Exception:
        print(json.dumps({"code": "TRANSITION_COMPILATION_FAILED", "message": "OpenCV could not analyze this adjacent Shot pair."}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
