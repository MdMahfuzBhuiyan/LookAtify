"""Attention analytics: top-N peaks and page-level statistics.

The functions here work on the saliency map resized to the original page
dimensions, so every coordinate is in screenshot pixels.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import label, maximum_filter

from .schemas import (
    AttentionStats,
    LeftRightPercentages,
    ThirdsPercentages,
    TopPoint,
)


def find_peaks(
    saliency: np.ndarray,
    top_n: int = 5,
    min_distance: int = 40,
) -> list[TopPoint]:
    """Find the strongest attention peaks with non-maximum suppression.

    Candidates are the pixels that are at least as bright as every pixel in
    their neighbourhood. Neighbouring candidates on the same flat region are
    then collapsed to the single brightest one, so a large uniform area
    produces one peak rather than a row of duplicates.

    :param saliency: 0..1 saliency map.
    :param top_n: number of peaks to return.
    :param min_distance: minimum distance in pixels between two peaks.
    :returns: peaks ordered by descending score.
    """
    if saliency.size == 0 or top_n <= 0:
        return []

    values = np.asarray(saliency, dtype=np.float32)
    if not np.any(values > 0):
        return []

    _height, _width = values.shape
    neighbourhood = max(3, int(min_distance) | 1)  # odd size for a centred window

    maxima = maximum_filter(values, size=neighbourhood, mode="nearest")
    # Pixels that merely tie their neighbourhood but sit at the background
    # level are not peaks, so they are excluded explicitly.
    candidate_mask = (values >= maxima) & (values > 0)
    if not candidate_mask.any():
        return []

    # Collapse each connected plateau to its single brightest pixel.
    components, component_count = label(candidate_mask)
    candidates: list[tuple[int, int, float]] = []
    for component in range(1, component_count + 1):
        ys, xs = np.nonzero(components == component)
        component_values = values[ys, xs]
        best = int(np.argmax(component_values))
        candidates.append((int(xs[best]), int(ys[best]), float(component_values[best])))

    candidates.sort(key=lambda item: item[2], reverse=True)

    # Report each score relative to the strongest peak so the value reads as
    # "how much of the top hotspot" instead of an unhelpfully small probability.
    strongest = candidates[0][2]
    scale = strongest if strongest > 0 else 1.0

    points: list[TopPoint] = []
    min_distance_squared = int(min_distance) ** 2

    for x, y, raw_score in candidates:
        score = raw_score / scale

        # Skip duplicates that sit inside the suppression radius of a peak
        # that has already been accepted.
        duplicate = False
        for point in points:
            delta_y = point.y - int(y)
            delta_x = point.x - int(x)
            if delta_y * delta_y + delta_x * delta_x < min_distance_squared:
                duplicate = True
                break
        if duplicate:
            continue

        points.append(
            TopPoint(
                rank=len(points) + 1,
                x=int(x),
                y=int(y),
                score=round(score, 6),
            )
        )
        if len(points) >= top_n:
            break

    return points


def compute_stats(
    probability: np.ndarray,
    fold_height: int = 800,
) -> AttentionStats:
    """Compute the page-level attention summary.

    :param probability: fixation probability map (values sum to 1).
    :param fold_height: height in pixels treated as "above the fold".
    """
    probability = np.asarray(probability, dtype=np.float64)
    total = float(probability.sum())
    if total <= 0:
        zero = 0.0
        return AttentionStats(
            above_fold_pct=zero,
            thirds_pct=ThirdsPercentages(top=zero, middle=zero, bottom=zero),
            left_right_pct=LeftRightPercentages(left=zero, right=zero),
            peak_score=zero,
            mean_intensity=zero,
        )

    height, width = probability.shape

    fold = probability[: min(fold_height, height)].sum()
    above_fold_pct = float(fold / total * 100.0)

    third = height / 3.0
    top = probability[: round(third)].sum()
    middle = probability[round(third) : round(2 * third)].sum()
    bottom = probability[round(2 * third) :].sum()
    thirds = ThirdsPercentages(
        top=round(float(top / total * 100.0), 2),
        middle=round(float(middle / total * 100.0), 2),
        bottom=round(float(bottom / total * 100.0), 2),
    )

    mid_column = width // 2
    left = probability[:, :mid_column].sum()
    right = probability[:, mid_column:].sum()
    left_right = LeftRightPercentages(
        left=round(float(left / total * 100.0), 2),
        right=round(float(right / total * 100.0), 2),
    )

    return AttentionStats(
        above_fold_pct=round(above_fold_pct, 2),
        thirds_pct=thirds,
        left_right_pct=left_right,
        peak_score=round(float(probability.max()), 8),
        mean_intensity=round(float(probability.mean()), 8),
    )


def region_attention_share(
    probability: np.ndarray,
    x: int,
    y: int,
    width: int,
    height: int,
) -> float:
    """Share of total attention inside a rectangle, as a percentage."""
    probability = np.asarray(probability, dtype=np.float64)
    total = float(probability.sum())
    if total <= 0:
        return 0.0

    image_height, image_width = probability.shape
    x0 = max(0, min(image_width, int(x)))
    y0 = max(0, min(image_height, int(y)))
    x1 = max(x0, min(image_width, int(x) + int(width)))
    y1 = max(y0, min(image_height, int(y) + int(height)))

    inside = float(probability[y0:y1, x0:x1].sum())
    return round(inside / total * 100.0, 3)
