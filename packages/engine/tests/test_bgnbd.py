# Not covered here: the real CDNOW numbers (test_benchmark.py), whether the model
# suits a given shop, uncertainty in the fitted parameters, and the a = 1 averaging
# beyond the value staying finite.
import numpy as np
import pytest
from scipy.special import hyp2f1

from mend_engine.model.bgnbd import (
    Params,
    _log_likelihood_and_gradient,
    expected_purchases,
    expected_purchases_unconditional,
    fit,
    log_likelihood,
)

PUBLISHED = Params(r=0.243, alpha=4.414, a=0.793, b=2.426)
X = np.array([0, 0, 1, 2, 5, 7, 12])
T_X = np.array([0.0, 0.0, 3.0, 20.0, 30.0, 10.0, 38.0])
T = np.array([38.857, 27.0, 35.0, 30.0, 38.0, 38.857, 38.857])


def _printed_equation_10(p: Params, t: float, x, t_x, T) -> np.ndarray:
    x = np.asarray(x, float)
    hyp = hyp2f1(p.r + x, p.b + x, p.a + p.b + x - 1, t / (p.alpha + T + t))
    top = (p.a + p.b + x - 1) / (p.a - 1) * (1 - ((p.alpha + T) / (p.alpha + T + t)) ** (p.r + x) * hyp)
    odds = (x > 0) * p.a / np.where(x > 0, p.b + x - 1, 1.0) * ((p.alpha + T) / (p.alpha + t_x)) ** (p.r + x)
    return top / (1 + odds)


@pytest.mark.parametrize("params", [PUBLISHED, Params(0.5, 2.0, 1.7, 3.0), Params(0.8, 6.0, 0.3, 0.4)])
def test_expected_purchases_is_non_negative_and_grows_with_t(params: Params) -> None:
    windows = [0.0, 0.5, 1.0, 4.0, 13.0, 39.0, 104.0, 1000.0]
    values = np.array([expected_purchases(params, t, X, T_X, T) for t in windows])

    assert np.all(values >= 0)
    assert np.all(values[0] == 0)
    assert np.all(np.diff(values, axis=0) > 0)


def test_matches_the_paper_formulas_as_printed() -> None:
    # The code uses an Euler-transformed form of equation 10 so heavy buyers do not
    # overflow; for ordinary customers it must give the printed formulas' values.
    assert np.allclose(expected_purchases(PUBLISHED, 39.0, X, T_X, T), _printed_equation_10(PUBLISHED, 39.0, X, T_X, T))

    p, t = PUBLISHED, 39.0
    equation_9 = (p.a + p.b - 1) / (p.a - 1) * (
        1 - (p.alpha / (p.alpha + t)) ** p.r * hyp2f1(p.r, p.b, p.a + p.b - 1, t / (p.alpha + t))
    )
    assert expected_purchases_unconditional(p, t) == pytest.approx(equation_9, rel=1e-12)


def test_heavy_buyers_stay_finite() -> None:
    values = expected_purchases(PUBLISHED, 39.0, [1000, 5000], [38.0, 38.8], [38.857, 38.857])
    assert np.all(np.isfinite(values)) and np.all(values >= 0)


def test_a_equal_to_one_stays_finite() -> None:
    value = expected_purchases_unconditional(Params(0.243, 4.414, 1.0, 2.426), 39.0)
    assert np.isfinite(value) and value > 0


def test_fit_refuses_empty_input() -> None:
    with pytest.raises(ValueError):
        fit([], [], [])


def test_degenerate_input_is_not_converged_and_does_not_run_away() -> None:
    # Nobody ever comes back: the likelihood keeps rising as the rate goes to zero,
    # which an unbounded search would chase forever.
    T_all = np.linspace(1.0, 39.0, 200)
    zeros = np.zeros_like(T_all)

    result = fit(zeros, zeros, T_all)

    assert result.converged is False
    assert "ran to its limit" in result.message
    assert max(result.params.r, result.params.alpha, result.params.a, result.params.b) <= 1e6


def test_gradient_matches_central_differences() -> None:
    log_params = np.log([0.3, 5.0, 0.7, 2.0])
    x = X.astype(float)
    _, gradient = _log_likelihood_and_gradient(log_params, x, T_X, T)
    step = 1e-6
    numeric = [
        (_log_likelihood_and_gradient(log_params + step * e, x, T_X, T)[0]
         - _log_likelihood_and_gradient(log_params - step * e, x, T_X, T)[0]) / (2 * step)
        for e in np.eye(4)
    ]
    assert np.allclose(gradient, numeric, rtol=1e-6, atol=1e-6)


@pytest.mark.parametrize(
    ("x", "t_x", "T"),
    [
        ([1], [5.0], [4.0]),
        ([-1], [0.0], [4.0]),
        ([1.5], [1.0], [4.0]),
        ([0], [1.0], [4.0]),
        ([1, 2], [1.0], [4.0, 4.0]),
        ([1], [float("nan")], [4.0]),
        ([[1]], [[1.0]], [[4.0]]),
        (["a"], [1.0], [4.0]),
    ],
)
def test_refuses_invalid_histories(x, t_x, T) -> None:
    with pytest.raises(ValueError):
        log_likelihood(PUBLISHED, x, t_x, T)
    with pytest.raises(ValueError):
        expected_purchases(PUBLISHED, 13.0, x, t_x, T)


@pytest.mark.parametrize("t", [-1.0, float("nan"), float("inf"), True])
def test_refuses_a_bad_window(t: float) -> None:
    with pytest.raises(ValueError):
        expected_purchases(PUBLISHED, t, X, T_X, T)


@pytest.mark.parametrize("bad", [0.0, -1.0, float("nan"), float("inf"), True])
def test_params_refuse_values_that_are_not_positive_and_finite(bad: float) -> None:
    with pytest.raises(ValueError):
        Params(r=bad, alpha=1.0, a=1.0, b=1.0)


@pytest.mark.parametrize("starts", [0, -1, 51, True])
def test_fit_refuses_a_bad_start_count(starts: int) -> None:
    with pytest.raises(ValueError):
        fit(X, T_X, T, starts=starts)
