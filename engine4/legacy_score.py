"""Compatibility implementation of archived HJ3.8 score Top4 policy.
Requires prematch lambdas and a separately identified 1X2 probability input.
Do not claim original frozen HJ P-final when using market-derived probabilities.
"""
import math

def legacy_score_top4(home_lambda, away_lambda, final_probs, max_goals=10):
    if not (0 < home_lambda <= 5 and 0 < away_lambda <= 5):
        raise ValueError("invalid prematch lambdas")
    if len(final_probs) != 3 or any(not math.isfinite(x) or x <= 0 for x in final_probs):
        raise ValueError("invalid final probabilities")
    total = sum(final_probs)
    final = dict(zip(("home", "draw", "away"), (x / total for x in final_probs)))
    rho = -0.08
    rows = []
    for h in range(max_goals + 1):
        for a in range(max_goals + 1):
            mass = math.exp(-home_lambda) * home_lambda**h / math.factorial(h)
            mass *= math.exp(-away_lambda) * away_lambda**a / math.factorial(a)
            weight = (1 - home_lambda * away_lambda * rho if (h, a) == (0, 0)
                      else 1 + home_lambda * rho if (h, a) == (0, 1)
                      else 1 + away_lambda * rho if (h, a) == (1, 0)
                      else 1 - rho if (h, a) == (1, 1) else 1)
            if weight < 0:
                raise ValueError("negative Dixon-Coles adjustment")
            rows.append((h, a, mass * weight))
    norm = sum(p for _, _, p in rows)
    rows = [(h, a, p / norm) for h, a, p in rows]
    direction = lambda h, a: "home" if h > a else "draw" if h == a else "away"
    ordered = sorted(rows, key=lambda x: (-x[2], x[0] + x[1], x[0], x[1]))
    mass = {k: sum(p for h, a, p in rows if direction(h, a) == k) for k in final}
    base = ordered[:3]
    challenger = sorted(ordered[3:],
        key=lambda x: (-x[2] * math.sqrt(final[direction(x[0], x[1])] /
                    max(mass[direction(x[0], x[1])], 1e-12)),
                    -x[2], x[0] + x[1], x[0], x[1]))[0]
    selected = base + [challenger]
    return {"top4": [f"{h}:{a}" for h, a, _ in selected],
            "top3": [f"{h}:{a}" for h, a, _ in base],
            "probabilities": {f"{h}:{a}": round(p, 6) for h, a, p in selected},
            "dc_rho": rho, "method": "HJ38_SCORE_TOP4_COMPAT_V1"}
