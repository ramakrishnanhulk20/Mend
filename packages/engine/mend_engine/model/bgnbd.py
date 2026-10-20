"""The BG/NBD customer model of Fader, Hardie and Lee (2005), in numpy and scipy only.

Each customer buys at a steady personal rate while active and, after any purchase,
may drop out for good. Rates follow a gamma(r, alpha) spread across customers and
dropout chances a beta(a, b) spread. Equation numbers refer to the paper,
http://www.brucehardie.com/papers/bgnbd_2004-04-20.pdf

Rank lapse risk with expected_purchases over a future window. The model's
probability-alive figure is deliberately not offered: it rates every one-time buyer
as certainly alive, so it cannot tell a lapsed one-timer from a new one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, fields

import numpy as np
from scipy.optimize import minimize
from scipy.special import digamma, gammaln, hyp2f1

# The search runs on log parameters inside these limits. A best fit that ends within
# a factor of _EDGE_FACTOR of a limit means the data do not pin that parameter down
# (on one UCI cutoff an unbounded search sent b to 5e15), so it is reported as not
# converged rather than returned as an answer.
LOWER_LIMIT = 1e-4
UPPER_LIMIT = 1e5
_EDGE_FACTOR = 2.0
MAX_STARTS = 50
_MAX_ITERATIONS = 2000
_SAME_OPTIMUM = 1e-3

# Equation 10 divides by a - 1. Closer than this to 1, the value is taken as the mean
# of the two sides, because the cancellation would otherwise lose most digits.
_NEAR_ONE = 1e-6
# Tiny negatives from rounding are cleared to zero. Anything below this is a real
# numerical failure and raises.
_ROUNDING_FLOOR = -1e-9


@dataclass(frozen=True)
class Params:
    """The four BG/NBD parameters. Every one must be a finite number above zero."""

    r: float
    alpha: float
    a: float
    b: float

    def __post_init__(self) -> None:
        for field in fields(self):
            value = getattr(self, field.name)
            if isinstance(value, bool) or not isinstance(value, (int, float, np.floating, np.integer)):
                raise ValueError(f"{field.name} must be a number")
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f"{field.name} must be a finite number above zero")
            object.__setattr__(self, field.name, float(value))


@dataclass(frozen=True)
class FitResult:
    """The best fit found. Use params only when converged is True; message says why not."""

    params: Params
    log_likelihood: float
    converged: bool
    message: str


def log_likelihood(params: Params, x, t_x, T) -> float:
    """Total log-likelihood of the customers' histories under params (equations 6 and 7).

    x, t_x and T are equal-length 1-D arrays, one entry per customer, as built by
    rfm.summarise. Raises ValueError on invalid histories (see _checked).
    """
    x, t_x, T = _checked(x, t_x, T)
    log_params = np.log([params.r, params.alpha, params.a, params.b])
    total, _ = _log_likelihood_and_gradient(log_params, x, t_x, T)
    return float(total)


def fit(x, t_x, T, *, starts: int = 5, seed: int = 0) -> FitResult:
    """Fit the four parameters by maximum likelihood.

    Runs L-BFGS-B on the log parameters from `starts` points (the first fixed, the
    rest drawn from a generator seeded with `seed`) and keeps the best likelihood.
    converged is False if the best search did not finish cleanly or any parameter
    ended near LOWER_LIMIT or UPPER_LIMIT; the parameters are then not usable.

    Raises ValueError on empty or invalid histories, if starts is not between 1 and
    MAX_STARTS, or if seed is not an int from 0 up.
    """
    if isinstance(starts, bool) or not isinstance(starts, int) or not 1 <= starts <= MAX_STARTS:
        raise ValueError(f"starts must be an int from 1 to {MAX_STARTS}")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise ValueError("seed must be an int from 0 up")
    x, t_x, T = _checked(x, t_x, T)
    if x.size == 0:
        raise ValueError("cannot fit a model to zero customers")

    count = x.size

    def objective(log_params: np.ndarray) -> tuple[float, np.ndarray]:
        # The mean, not the total, so the gradient tolerance means the same thing
        # for a shop of 50 customers and one of 50,000.
        total, gradient = _log_likelihood_and_gradient(log_params, x, t_x, T)
        return -total / count, -gradient / count

    bounds = [(math.log(LOWER_LIMIT), math.log(UPPER_LIMIT))] * 4
    results = []
    for start in _start_points(T, starts, seed):
        result = minimize(
            objective,
            start,
            jac=True,
            method="L-BFGS-B",
            bounds=bounds,
            options={"maxiter": _MAX_ITERATIONS, "ftol": 1e-13, "gtol": 1e-9},
        )
        if np.isfinite(result.fun) and np.all(np.isfinite(result.x)):
            results.append(result)
    if not results:
        raise RuntimeError("no starting point produced a finite likelihood")

    best = min(results, key=lambda result: result.fun)
    best_total = -best.fun * count
    agreeing = sum(1 for result in results if abs(result.fun - best.fun) * count <= _SAME_OPTIMUM)
    values = np.exp(best.x)
    params = Params(*(float(v) for v in values))

    problems = []
    if not best.success:
        problems.append(f"the search stopped early ({best.message})")
    for name, value in zip(("r", "alpha", "a", "b"), values):
        if value <= LOWER_LIMIT * _EDGE_FACTOR or value >= UPPER_LIMIT / _EDGE_FACTOR:
            problems.append(f"{name} ran to its limit ({value:.3g}), so the data do not pin it down")
    summary = f"best of {starts} starts, {agreeing} reached the same likelihood"
    if problems:
        return FitResult(params, float(best_total), False, f"not converged: {'; '.join(problems)}; {summary}")
    return FitResult(params, float(best_total), True, f"converged: {summary}")


def expected_purchases(params: Params, t: float, x, t_x, T) -> np.ndarray:
    """Expected purchases in the next t time units for each customer (equation 10).

    Same units as T. This is the number to rank lapse risk by: low means the model
    expects little from that customer. Returns one non-negative value per customer.
    Raises ValueError if t is negative or not finite, or the histories are invalid.
    """
    t = _checked_window(t)
    x, t_x, T = _checked(x, t_x, T)
    if abs(params.a - 1.0) < _NEAR_ONE:
        below = _conditional(params.r, params.alpha, 1.0 - _NEAR_ONE, params.b, t, x, t_x, T)
        above = _conditional(params.r, params.alpha, 1.0 + _NEAR_ONE, params.b, t, x, t_x, T)
        values = (below + above) / 2.0
    else:
        values = _conditional(params.r, params.alpha, params.a, params.b, t, x, t_x, T)
    return _cleared(values)


def expected_purchases_unconditional(params: Params, t: float) -> float:
    """Expected purchases in the first t time units after a customer's first purchase (equation 9).

    Used to forecast a whole cohort: sum it over customers with each one's own time
    since first purchase. Raises ValueError if t is negative or not finite.
    """
    # Equation 9 is equation 10 for a customer seen for no time at all.
    zero = np.zeros(1)
    return float(expected_purchases(params, t, zero, zero, zero)[0])


def _checked(x, t_x, T) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Turn the three histories into float arrays, refusing anything the model cannot read.

    x must be whole numbers from 0 up, T at least 0, t_x between 0 and T, and t_x
    exactly 0 where x is 0. All three must be 1-D, the same length and finite.
    """
    arrays = []
    for name, values in (("x", x), ("t_x", t_x), ("T", T)):
        try:
            array = np.asarray(values, dtype=float)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must be numbers") from exc
        if array.ndim != 1:
            raise ValueError(f"{name} must be a 1-D array")
        if not np.all(np.isfinite(array)):
            raise ValueError(f"{name} must be finite")
        arrays.append(array)
    x, t_x, T = arrays
    if not x.size == t_x.size == T.size:
        raise ValueError("x, t_x and T must have the same length")
    if np.any(x < 0) or np.any(x != np.floor(x)):
        raise ValueError("x must be whole numbers from 0 up")
    if np.any(T < 0):
        raise ValueError("T must be at least 0")
    if np.any(t_x < 0) or np.any(t_x > T):
        raise ValueError("t_x must be between 0 and T")
    if np.any((x == 0) & (t_x != 0)):
        raise ValueError("t_x must be 0 for a customer with no repeat purchase")
    return x, t_x, T


def _checked_window(t: float) -> float:
    if isinstance(t, bool) or not isinstance(t, (int, float, np.floating, np.integer)):
        raise ValueError("t must be a number")
    if not math.isfinite(t) or t < 0:
        raise ValueError("t must be a finite number from 0 up")
    return float(t)


def _start_points(T: np.ndarray, starts: int, seed: int) -> list[np.ndarray]:
    """Log-parameter starting points: one fixed, the rest random around sensible scales.

    alpha is a time scale, so it is centred on the mean customer age, which keeps the
    starts sensible whether T is in days or weeks.
    """
    scale = float(T.mean()) if T.size and T.mean() > 0 else 1.0
    points = [np.log([1.0, scale, 1.0, 1.0])]
    rng = np.random.default_rng(seed)
    for _ in range(starts - 1):
        points.append(np.array([
            rng.uniform(math.log(0.05), math.log(5.0)),
            math.log(scale) + rng.uniform(-3.0, 3.0),
            rng.uniform(math.log(0.1), math.log(10.0)),
            rng.uniform(math.log(0.1), math.log(10.0)),
        ]))
    inner = (math.log(LOWER_LIMIT * _EDGE_FACTOR), math.log(UPPER_LIMIT / _EDGE_FACTOR))
    return [np.clip(point, *inner) for point in points]


def _log_likelihood_and_gradient(
    log_params: np.ndarray, x: np.ndarray, t_x: np.ndarray, T: np.ndarray
) -> tuple[float, np.ndarray]:
    """Equation 6 summed over customers, plus its gradient with respect to the log parameters.

    Uses the paper's split L = A1 * A2 * (A3 + [x > 0] A4), all in logs, and adds A3
    and A4 with logaddexp so neither overflows for heavy buyers.
    """
    r, alpha, a, b = np.exp(log_params)
    repeat = x > 0
    b_shift = np.where(repeat, b + x - 1.0, 1.0)

    log_a1 = gammaln(r + x) - gammaln(r) + r * np.log(alpha)
    log_a2 = gammaln(a + b) + gammaln(b + x) - gammaln(b) - gammaln(a + b + x)
    log_a3 = -(r + x) * np.log(alpha + T)
    log_a4 = np.where(repeat, np.log(a) - np.log(b_shift) - (r + x) * np.log(alpha + t_x), -np.inf)
    log_mix = np.logaddexp(log_a3, log_a4)
    total = float(np.sum(log_a1 + log_a2 + log_mix))

    # Share of A4 in A3 + A4; 0 for customers with no repeat purchase.
    share = np.exp(log_a4 - log_mix)
    d_r = (
        digamma(r + x) - digamma(r) + np.log(alpha)
        - (1.0 - share) * np.log(alpha + T) - share * np.log(alpha + t_x)
    )
    d_alpha = r / alpha - (1.0 - share) * (r + x) / (alpha + T) - share * (r + x) / (alpha + t_x)
    d_a = digamma(a + b) - digamma(a + b + x) + share / a
    d_b = digamma(a + b) + digamma(b + x) - digamma(b) - digamma(a + b + x) - share / b_shift
    gradient = np.array([r * d_r.sum(), alpha * d_alpha.sum(), a * d_a.sum(), b * d_b.sum()])
    return total, gradient


def _conditional(
    r: float, alpha: float, a: float, b: float, t: float,
    x: np.ndarray, t_x: np.ndarray, T: np.ndarray,
) -> np.ndarray:
    """Equation 10, rewritten with Euler's transformation of the hypergeometric function.

    As printed, the formula multiplies ((alpha+T)/(alpha+T+t))^(r+x) by
    2F1(r+x, b+x; a+b+x-1; z), which underflow and overflow for heavy buyers (the
    second is about 1e279 at x = 1000). Euler's identity
    2F1(p, q; c; z) = (1-z)^(c-p-q) 2F1(c-p, c-q; c; z) folds the power into
    (1-z)^(a-1) and leaves a 2F1 whose top parameters do not grow with x.
    """
    window = alpha + T + t
    keep = (alpha + T) / window
    z = t / window
    c = a + b + x - 1.0
    tail = 1.0 - keep ** (a - 1.0) * hyp2f1(a + b - 1.0 - r, a - 1.0, c, z)
    if_active = c / (a - 1.0) * tail

    repeat = x > 0
    b_shift = np.where(repeat, b + x - 1.0, 1.0)
    log_odds_gone = np.log(a) - np.log(b_shift) + (r + x) * (np.log(alpha + T) - np.log(alpha + t_x))
    # 1 / (1 + odds) without overflow; customers with no repeat purchase get weight 1.
    weight = np.where(repeat, np.exp(-np.logaddexp(0.0, log_odds_gone)), 1.0)
    return if_active * weight


def _cleared(values: np.ndarray) -> np.ndarray:
    if not np.all(np.isfinite(values)):
        raise ValueError("expected purchases are undefined for these parameters (a + b + x - 1 is 0)")
    if np.any(values < _ROUNDING_FLOOR):
        raise ValueError("expected purchases came out negative, which the model does not allow")
    return np.maximum(values, 0.0)
