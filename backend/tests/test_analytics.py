"""Tests for the analytics helpers."""

from __future__ import annotations

import numpy as np
import pytest

from app.analytics import compute_stats, find_peaks, region_attention_share


def test_find_peaks_finds_the_strongest_blob() -> None:
    saliency = np.zeros((100, 100), dtype=np.float32)
    saliency[40:45, 60:65] = 1.0

    peaks = find_peaks(saliency, top_n=3, min_distance=10)

    assert peaks
    assert peaks[0].rank == 1
    assert peaks[0].score == pytest.approx(1.0)
    assert 40 <= peaks[0].y <= 44
    assert 60 <= peaks[0].x <= 64


def test_find_peaks_collapses_plateaus_into_one_peak() -> None:
    """A flat bright band must not produce a row of duplicate peaks."""
    saliency = np.zeros((100, 100), dtype=np.float32)
    saliency[50, 10:90] = 1.0

    peaks = find_peaks(saliency, top_n=5, min_distance=20)

    assert len(peaks) == 1
    assert peaks[0].y == 50


def test_find_peaks_respects_min_distance() -> None:
    saliency = np.zeros((120, 120), dtype=np.float32)
    saliency[30, 30] = 1.0
    saliency[34, 34] = 0.95

    peaks = find_peaks(saliency, top_n=5, min_distance=40)

    assert len(peaks) == 1


def test_find_peaks_returns_empty_for_blank_map() -> None:
    assert find_peaks(np.zeros((50, 50), dtype=np.float32), top_n=5) == []


def test_compute_stats_splits_thirds_and_halves() -> None:
    probability = np.zeros((300, 100), dtype=np.float64)
    probability[:100, :50] = 1.0  # top third, left half

    stats = compute_stats(probability, fold_height=800)

    assert stats.thirds_pct.top == pytest.approx(100.0)
    assert stats.thirds_pct.middle == pytest.approx(0.0)
    assert stats.thirds_pct.bottom == pytest.approx(0.0)
    assert stats.left_right_pct.left == pytest.approx(100.0)
    assert stats.left_right_pct.right == pytest.approx(0.0)


def test_compute_stats_reports_above_fold_share() -> None:
    probability = np.zeros((1000, 100), dtype=np.float64)
    probability[:400] = 1.0
    probability[400:] = 1.0 / 3.0

    stats = compute_stats(probability, fold_height=800)

    # Fold = 400 rows at weight 1 plus 400 rows at weight 1/3 = 53333.
    # Page = 40000 at weight 1 plus 600 rows at weight 1/3 = 60000.
    assert stats.above_fold_pct == pytest.approx(88.89, abs=0.01)


def test_compute_stats_handles_empty_map() -> None:
    stats = compute_stats(np.zeros((10, 10), dtype=np.float64))

    assert stats.above_fold_pct == 0.0
    assert stats.thirds_pct.top == 0.0


def test_region_attention_share_counts_the_rectangle() -> None:
    probability = np.zeros((100, 100), dtype=np.float64)
    probability[:50, :50] = 1.0
    probability[50:, 50:] = 1.0 / 3.0

    share = region_attention_share(probability, 0, 0, 50, 50)

    # Inside: 50x50 at weight 1. Outside: 50x50 at weight 1/3.
    assert share == pytest.approx(75.0, abs=0.01)


def test_region_attention_share_clamps_out_of_bounds() -> None:
    probability = np.ones((10, 10), dtype=np.float64)

    share = region_attention_share(probability, -20, -20, 100, 100)

    assert share == pytest.approx(100.0)
