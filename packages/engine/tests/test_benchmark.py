# Not covered here: downloading the sample (tests never touch the network), the
# Pareto/NBD numbers in the paper, the chi-square fit table, and any shop other
# than CDNOW. Tests that need the data skip when the cached copy is absent.
import zipfile
from pathlib import Path

import numpy as np
import pytest

from mend_engine.model.benchmark import (
    CALIBRATION_END,
    CDNOW_SAMPLE_SIZE,
    PUBLISHED,
    load_cdnow_sample,
    reproduce,
)
from mend_engine.model.bgnbd import Params, log_likelihood
from mend_engine.model.rfm import summarise

CACHED = Path(__file__).resolve().parents[3] / "reference" / "meendum-data" / "raw" / "cdnow" / "CDNOW_sample.zip"
needs_sample = pytest.mark.skipif(
    not CACHED.is_file(), reason=f"CDNOW sample not cached at {CACHED}; tests never download it"
)


@needs_sample
def test_loader_reads_every_row_and_customer() -> None:
    purchases = load_cdnow_sample(CACHED)

    assert sum(len(days) for days in purchases.values()) == 6919
    assert sum(len(set(days)) for days in purchases.values()) == 6696
    assert len(purchases) == 2357


@needs_sample
def test_log_likelihood_at_the_published_parameters_matches_the_paper() -> None:
    days = {customer: sorted(set(d)) for customer, d in load_cdnow_sample(CACHED).items()}
    summaries = summarise(days, CALIBRATION_END)
    x = np.array([s.x for s in summaries])
    t_x = np.array([s.t_x for s in summaries])
    T = np.array([s.T for s in summaries])

    published = Params(PUBLISHED["r"], PUBLISHED["alpha"], PUBLISHED["a"], PUBLISHED["b"])

    assert log_likelihood(published, x, t_x, T) == pytest.approx(-9582.4, abs=0.1)


@needs_sample
def test_reproduce_matches_the_published_targets() -> None:
    result = reproduce(CACHED)

    assert result.converged
    assert result.within_tolerance
    assert result.zero_group_size == 1411
    assert result.zero_group_holdout_purchases == 334
    assert result.cumulative_week78_actual == 4339


def test_loader_refuses_a_file_of_the_wrong_size(tmp_path: Path) -> None:
    fake = tmp_path / "CDNOW_sample.zip"
    with zipfile.ZipFile(fake, "w") as archive:
        archive.writestr("CDNOW_sample.txt", " 00004 0001 19970101  2   29.33\r\n")
    assert fake.stat().st_size != CDNOW_SAMPLE_SIZE

    with pytest.raises(ValueError):
        load_cdnow_sample(fake)
