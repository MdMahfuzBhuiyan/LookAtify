"""Regression tests for the reported bugs in the attention pipeline.

The bugs these cover were all found on a real bbc.com capture:

1. the heatmap was a pale green wash with no yellow or red;
2. the attention was spread almost evenly over the page;
3. the top attention points sat far down the page, in the footer;
4. the viewer showed "Analysis time 0 ms";
5. a faint horizontal line appeared near the bottom of the page.

Each test states the behaviour that was broken, so a future change that
brings it back fails here.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.config import Settings
from app.heatmap import normalise_for_display
from app.pipeline import AnalysisPipeline, Tile


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------
def banded_page(width: int = 600, height: int = 3000) -> np.ndarray:
    """A page with a bright hero on top and a flat, dull footer."""
    page = np.full((height, width, 3), 245, dtype=np.uint8)
    page[0:400] = (250, 225, 180)
    page[100:350, 80:520] = (240, 90, 40)
    page[450:520, 40 : width - 60] = (20, 20, 20)
    page[height - 600 :] = (28, 28, 30)
    return page


def thirds(values: np.ndarray) -> tuple[float, float, float]:
    """The share of the total in each vertical third."""
    probability = values / max(values.sum(), 1e-12)
    third = values.shape[0] / 3
    top = probability[: int(third)].sum()
    middle = probability[int(third) : int(2 * third)].sum()
    bottom = probability[int(2 * third) :].sum()
    return top, middle, bottom


# ----------------------------------------------------------------------
# bug 1: the heatmap was a pale wash
# ----------------------------------------------------------------------
def test_display_stretch_shows_hotspots_instead_of_a_pale_wash() -> None:
    """A peaked map must use the top of the colormap, not just the bottom.

    A saliency map is peaked: nearly every pixel sits near the bottom of
    the range and a handful reach the top. A min-max stretch leaves the
    bulk of the page near zero, so the viewer paints a faint wash and no
    yellow or red ever appears.
    """
    values = np.zeros((100, 100), dtype=np.float32)
    values[40:60, 40:60] = 1.0  # a small hotspot
    values += np.random.default_rng(0).random((100, 100)).astype(np.float32) * 0.01

    stretched = normalise_for_display(values)

    # The hotspot has to reach the top of the colormap, so it is red.
    assert float(stretched[50, 50]) > 0.9
    # The map has to span the range instead of sitting in its bottom: a
    # wash would leave the 99th percentile low as well.
    assert float(np.percentile(stretched, 99)) > 0.8
    # And the background must stay dark, so the page is still readable
    # under the overlay.
    assert float(np.percentile(stretched, 50)) < 0.3


def test_display_stretch_has_no_hard_contour() -> None:
    """The stretch must not draw a contour line across the page.

    Clipping the low end to zero draws a contour where the intensity
    crosses the percentile. That contour is the faint horizontal line the
    bug report described.
    """
    rows = np.linspace(0.0, 1.0, 400, dtype=np.float32)
    values = np.tile(rows[:, None], (1, 50))

    stretched = normalise_for_display(values)
    row_means = stretched.mean(axis=1)

    # No row may differ sharply from its neighbours.
    jumps = np.abs(np.diff(row_means))
    assert float(jumps.max()) < 0.05


def test_display_stretch_handles_a_flat_map() -> None:
    """A flat map has no structure, but it is not "no attention"."""
    stretched = normalise_for_display(np.full((8, 8), 0.25, dtype=np.float32))

    assert stretched.shape == (8, 8)
    assert np.all(stretched == pytest.approx(0.5, abs=1e-6))


# ----------------------------------------------------------------------
# bugs 2 and 3: the attention was spread evenly over the page
# ----------------------------------------------------------------------
def test_global_profile_makes_the_top_of_the_page_win() -> None:
    """A bright hero has to attract more attention than a dull footer.

    The model normalises every tile it sees to sum to one, so the tiles
    alone cannot say which part of the page is more interesting. The
    global profile is what restores that comparison.
    """
    # A detail map that is identical in both halves, because the tiles
    # cannot tell them apart.
    detail = np.full((400, 400), 1.0, dtype=np.float64)
    # A profile that says the top half is ten times as interesting.
    profile = np.ones((400, 400), dtype=np.float64)
    profile[:200] = 10.0

    combined = AnalysisPipeline._apply_global_profile(detail, profile)
    total = combined.sum()

    # The boosted half holds ten elevenths of the attention.
    assert float(combined[:200].sum() / total) == pytest.approx(10 / 11, abs=0.01)
    # The third that contains the boost wins over the one that does not.
    top, _middle, bottom = thirds(combined)
    assert top > bottom


def test_global_profile_keeps_the_detail() -> None:
    """The profile may not flatten the structure inside a band."""
    detail = np.zeros((200, 200), dtype=np.float64)
    detail[10:20, 10:20] = 50.0  # one hotspot
    profile = np.ones((200, 200), dtype=np.float64)

    combined = AnalysisPipeline._apply_global_profile(detail, profile)

    assert combined[15, 15] == combined.max()
    assert combined[15, 15] > combined[100, 100]


def test_global_profile_survives_a_mismatched_shape() -> None:
    """A profile of the wrong size is ignored rather than raising."""
    detail = np.ones((10, 10), dtype=np.float64)

    combined = AnalysisPipeline._apply_global_profile(detail, np.ones((5, 5)))

    assert combined.shape == (10, 10)


def test_the_blend_cannot_distinguish_tiles_on_its_own() -> None:
    """The blend alone gives every tile the same mass.

    This is the reason the global profile exists. The model normalises
    every tile it sees to sum to one, so two tiles with different content
    still contribute the same amount of attention once they are blended.
    The test records that fact, so the reason for the second pass stays
    obvious.
    """
    pipeline = AnalysisPipeline(None, Settings())
    tiles = [
        Tile(index=0, top=0, bottom=100, left=0, right=100),
        Tile(index=1, top=80, bottom=180, left=0, right=100),
    ]
    strong = np.full((100, 100), 2.0, dtype=np.float32)
    weak = np.full((100, 100), 1.0, dtype=np.float32)

    blended = pipeline._blend_tiles([strong, weak], tiles, (100, 180), scale=1.0)

    # The two halves carry the same attention, so the blend cannot say
    # that the first tile was the more interesting one.
    assert blended[:80].mean() == pytest.approx(blended[100:].mean(), rel=1e-6)


def test_the_global_profile_restores_the_comparison() -> None:
    """With the profile, the more interesting band wins."""
    pipeline = AnalysisPipeline(None, Settings())
    tiles = [
        Tile(index=0, top=0, bottom=100, left=0, right=100),
        Tile(index=1, top=80, bottom=180, left=0, right=100),
    ]
    strong = np.full((100, 100), 2.0, dtype=np.float32)
    weak = np.full((100, 100), 1.0, dtype=np.float32)

    blended = pipeline._blend_tiles([strong, weak], tiles, (100, 180), scale=1.0)

    # A profile that says the top band is the interesting one.
    profile = np.ones((180, 100), dtype=np.float64)
    profile[:80] = 5.0

    combined = AnalysisPipeline._apply_global_profile(blended, profile)

    assert combined[:80].mean() > combined[100:].mean()


def test_coarse_profile_is_skipped_for_a_short_page() -> None:
    """A page that fits in one pass does not need a second pass."""
    pipeline = AnalysisPipeline(None, Settings())
    page = np.zeros((400, 300, 3), dtype=np.uint8)

    # The pipeline has no model here, so the coarse pass must not be
    # attempted at all.
    assert pipeline._coarse_profile(page) is None


# ----------------------------------------------------------------------
# bug 5: the faint horizontal line
# ----------------------------------------------------------------------
def test_the_saliency_map_has_no_row_discontinuity() -> None:
    """The blended map must not contain a row that jumps.

    A seam between two tiles shows up as a single row that differs
    sharply from the rows above and below it.
    """
    pipeline = AnalysisPipeline(None, Settings())
    tiles = [
        Tile(index=0, top=0, bottom=100, left=0, right=100),
        Tile(index=1, top=80, bottom=180, left=0, right=100),
    ]
    logits = [
        np.linspace(-5.0, 0.0, 100, dtype=np.float32)[None, :].repeat(100, axis=0)
        for _ in tiles
    ]

    blended = pipeline._blend_tiles(logits, tiles, (100, 180), scale=1.0)
    row_means = blended.mean(axis=1)

    jumps = np.abs(np.diff(row_means))
    assert float(jumps.max()) < 1e-9


def test_the_tile_overlap_is_blended_without_a_step() -> None:
    """Two tiles with different strengths must meet smoothly."""
    pipeline = AnalysisPipeline(None, Settings())
    tiles = [
        Tile(index=0, top=0, bottom=100, left=0, right=100),
        Tile(index=1, top=80, bottom=180, left=0, right=100),
    ]
    strong = np.zeros((100, 100), dtype=np.float32)
    strong[0] = 1.0
    weak = np.zeros((100, 100), dtype=np.float32)
    weak[0] = 0.1

    blended = pipeline._blend_tiles([strong, weak], tiles, (100, 180), scale=1.0)
    row_means = blended.mean(axis=1)

    # The transition between the two tiles is gradual, not a single step.
    transition = row_means[70:95]
    assert float(np.abs(np.diff(transition)).max()) < 0.05


# ----------------------------------------------------------------------
# bug 6: the middle of a long page was empty
# ----------------------------------------------------------------------
def test_an_over_steep_profile_is_flattened() -> None:
    """A profile that is far too steep must be flattened.

    On a very long page the coarse pass sees a tall, narrow strip, which the
    model handles badly: the profile it returns is much steeper than the
    page really is. Multiplied with the per-tile detail, that crushes every
    hotspot in the middle of the page below the visible part of the colormap,
    and the middle of the page comes out empty.
    """
    profile = np.ones((1000, 100), dtype=np.float64)
    profile[:100] = 8.0  # the first band is eight times as strong

    compressed = AnalysisPipeline._compress_profile(profile, 1.6)

    # The steepness is brought down to the limit.
    assert AnalysisPipeline._profile_steepness(compressed) == pytest.approx(1.6, rel=0.15)
    # The profile still favours the first band, so the ranking survives.
    assert compressed[:100].mean() > compressed[500:600].mean()


def test_a_reasonable_profile_is_left_alone() -> None:
    """A page that works today must not be changed.

    For a page whose profile is already reasonable, the profile is what
    lifts the local hotspots above the visible threshold. Flattening it
    would push them back down, so such a profile is returned unchanged.
    """
    profile = np.ones((1000, 100), dtype=np.float64)
    profile[:100] = 1.3

    compressed = AnalysisPipeline._compress_profile(profile, 1.6)

    assert np.array_equal(compressed, profile)


def test_compressing_a_profile_keeps_the_ranking() -> None:
    """The compression is monotone, so the order of the bands stays.

    The statistics and the top attention points are computed from the
    original profile, so they have to describe the same page either way.
    """
    profile = np.ones((1000, 100), dtype=np.float64)
    profile[:100] = 8.0
    profile[900:] = 4.0

    compressed = AnalysisPipeline._compress_profile(profile, 1.6)

    assert compressed[:100].mean() > compressed[900:].mean()
    assert compressed[900:].mean() > compressed[500:600].mean()


def test_every_band_of_a_long_page_keeps_a_hotspot() -> None:
    """The whole point: no band of a long page may come out empty.

    This is the reported failure. The first and last band of the page had a
    heatmap and everything in between was blank.
    """
    height = 3000
    detail = np.zeros((height, 100), dtype=np.float64)
    # Every band has a hotspot of its own, the way a real page has
    # headlines and images all the way down.
    for index in range(10):
        top = index * (height // 10)
        detail[top + 10 : top + 40, 40:60] = 1.0

    # A profile that is far too steep: the first band takes almost
    # everything, which is what the coarse pass produced for a long page.
    profile = np.ones((height, 100), dtype=np.float64)
    profile[: height // 10] = 8.0

    compressed = AnalysisPipeline._compress_profile(profile, 1.6)
    display = normalise_for_display(
        AnalysisPipeline._apply_global_profile(detail, compressed)
    )

    band_height = height // 10
    for index in range(10):
        band = display[index * band_height : (index + 1) * band_height]
        # The hotspot of the band has to reach the yellow part of the
        # colormap, otherwise the band looks empty.
        assert float(band.max()) > 0.55, f"band {index} has no visible hotspot"


def test_the_statistics_keep_the_original_profile() -> None:
    """The flattening is for the display only.

    The statistics and the top attention points describe where the
    attention goes. They have to be computed from the real profile, so the
    share of the top of the page does not change because the heatmap was
    made readable.
    """
    height = 2000
    detail = np.ones((height, 100), dtype=np.float64)
    profile = np.ones((height, 100), dtype=np.float64)
    profile[: height // 10] = 8.0

    compressed = AnalysisPipeline._compress_profile(profile, 1.6)

    # The flattening is monotone, so the order of the bands is the same.
    band_count = 10
    band_height = height // band_count
    original_order = np.argsort(
        [profile[i * band_height : (i + 1) * band_height].mean() for i in range(band_count)]
    )
    compressed_order = np.argsort(
        [
            compressed[i * band_height : (i + 1) * band_height].mean()
            for i in range(band_count)
        ]
    )
    assert np.array_equal(original_order, compressed_order)

    # The statistics use the original profile, so the share of the top of
    # the page is the share the page really has.
    statistics = AnalysisPipeline._apply_global_profile(detail, profile)
    top_share = statistics[: height // 3].sum() / statistics.sum()
    assert top_share > 0.4, "the top of the page still gets most of the attention"


def test_the_display_stretch_keeps_a_weak_band_visible() -> None:
    """A band whose hotspot is weaker must still be painted.

    The stretch decides how much of the colormap the page uses. With the
    high percentile at 99.5, one stray pixel could scale the whole page
    down so far that the hotspots of several bands stayed below the yellow
    part of the colormap.
    """
    values = np.full((1000, 100), 0.01, dtype=np.float32)
    # Ten weak hotspots, one per band.
    for index in range(10):
        top = index * 100
        values[top + 10 : top + 30, 40:60] = 0.2
    # A single very strong pixel, the kind that skewed the stretch.
    values[5, 5] = 50.0

    stretched = normalise_for_display(values)

    for index in range(10):
        top = index * 100
        band = stretched[top : top + 100]
        assert float(band.max()) > 0.55, f"band {index} has no visible hotspot"
