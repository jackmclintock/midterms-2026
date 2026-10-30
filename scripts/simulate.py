#!/usr/bin/env python3
"""
Election-night rehearsal. Takes the current data/live.json, invents a partial
count (some races called, some counting, some waiting) consistent with a chosen
national swing, re-runs the projection engine and writes the result to a
scratch folder you can serve to see what the page looks like on the night.

    python3 scripts/simulate.py --hours 3 --swing -2 --out /tmp/rehearsal
    cd /tmp/rehearsal && python3 -m http.server 8766

--hours  hours since the first polls closed (controls how much is counted)
--swing  true national swing vs expectations in points (positive = Democrats over-perform)
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import random
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import refresh as R  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def fake_count(race: dict, hours: float, swing: float, rng: random.Random, closing: dict) -> None:
    live = race.get("live")
    if not live:
        return
    st = race.get("postal") or race.get("state")
    close = closing.get(st)
    opened = hours - (close or 1.0)
    if opened <= 0:
        live.update({"eevp": 0, "votes": 0, "margin": None, "call": "too_early", "winner": None, "winner_party": None})
        return
    speed = {"FL": 1.6, "GA": 1.4, "NC": 1.4, "TX": 1.3, "OH": 1.3, "IA": 1.2, "NE": 1.2, "CA": 0.25, "AZ": 0.35, "NV": 0.4,
             "WA": 0.3, "OR": 0.3, "AK": 0.5, "PA": 0.7, "WI": 0.8, "MI": 0.9, "ME": 0.6, "NY": 0.6, "UT": 0.5}.get(st, 1.0)
    eevp = min(99, int(100 * (1 - 2.718 ** (-opened * speed * 0.9))))
    prior = race["prior"]
    true_margin = prior["margin"] + swing + rng.gauss(0, 3.5)
    # early vote-type skew: first returns lean the other way in some states
    skew = {"PA": -6, "WI": -4, "MI": -3, "AZ": 5, "NC": 4, "GA": 4, "FL": 3, "TX": 3, "OH": 2}.get(st, 0) * (1 - eevp / 100)
    cur = true_margin + skew + rng.gauss(0, 6 * (1 - eevp / 100))
    exp = live.get("expected") or 1_000_000
    votes = int(exp * eevp / 100)
    live["eevp"] = eevp
    live["votes"] = votes
    cands = live.get("cands") or []
    d = next((c for c in cands if c["party"] == "D"), None)
    r = next((c for c in cands if c["party"] == "R"), None)
    i = next((c for c in cands if c["party"] == "I"), None)
    lead = d or i
    if lead and r and votes:
        other = 0.04
        lead_pct = (1 - other) / 2 + cur / 200
        lead["pct"] = round(100 * lead_pct, 1); r["pct"] = round(100 * (1 - other - lead_pct), 1)
        lead["votes"] = int(votes * lead_pct); r["votes"] = int(votes * (1 - other - lead_pct))
        for c in cands:
            if c is not lead and c is not r:
                c["pct"] = round(100 * other / max(1, len(cands) - 2), 1); c["votes"] = int(votes * other / max(1, len(cands) - 2))
        cands.sort(key=lambda c: -c["votes"])
        for c in cands:
            c["leader"] = c is cands[0]
    live["margin"] = round(cur, 1)
    live["updated"] = datetime.now(timezone.utc).isoformat()
    # call rule: enough in and a clear lead
    if (eevp >= 70 and abs(cur) > 6) or (eevp >= 90 and abs(cur) > 2) or (eevp >= 50 and abs(cur) > 14):
        win = lead if cur > 0 else r
        if win:
            live["call"] = "called"; live["winner"] = win["name"]; live["winner_party"] = win["party"]; live["called_by"] = ["ap"]
    else:
        live["call"] = "too_early"; live["winner"] = None; live["winner_party"] = None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=3.0)
    ap.add_argument("--swing", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=str(ROOT / "rehearsal"))
    a = ap.parse_args()
    rng = random.Random(a.seed)
    live = json.loads((ROOT / "data" / "live.json").read_text())
    # poll closing offsets in hours after 18:00 ET
    closing = {}
    for c in live.get("poll_closing", []):
        t = datetime.fromisoformat(c["close_utc"].replace("Z", "+00:00"))
        closing[c["state"]] = (t - datetime(2026, 11, 3, 23, 0, tzinfo=timezone.utc)).total_seconds() / 3600
    sim = copy.deepcopy(live)
    sim["phase"] = "live"
    now = datetime(2026, 11, 3, 23, 0, tzinfo=timezone.utc) + timedelta(hours=a.hours)
    sim["generated_at"] = now.isoformat(timespec="seconds")
    R.NOW = now
    for section in ("senate", "governors"):
        races = sim[section]["races"]
        for r in races:
            fake_count(r, a.hours, a.swing, rng, closing)
        sw = R.observed_swing(races)
        for r in races:
            r["proj"] = R.live_update(r["prior"], r.get("live"), sw["swing"])
        sim[section]["swing"] = sw
    for d in sim["house"]["districts"]:
        d.setdefault("postal", d["state"])
        if d.get("live") and "cands" in d["live"]:
            fake_count(d, a.hours, a.swing, rng, closing)
        elif d.get("live"):
            # slim record: give it a plausible count without candidates
            tmp = {"prior": d["prior"], "live": {**d["live"], "cands": [], "expected": 300000}, "postal": d["state"]}
            fake_count(tmp, a.hours, a.swing, rng, closing)
            d["live"] = tmp["live"]
    hs = R.observed_swing(sim["house"]["districts"])
    for d in sim["house"]["districts"]:
        d["proj"] = R.live_update(d["prior"], d.get("live"), hs["swing"])
    sim["house"]["swing"] = hs
    s = sim["senate"]["summary"]
    sim["senate"]["summary"] = {**s, **R.summarize_chamber(sim["senate"]["races"], s["not_up"]["D"], s["not_up"]["R"], s["to_win"]["D"], s["to_win"]["R"], 100)}
    g = sim["governors"]["summary"]
    sim["governors"]["summary"] = {**g, **R.summarize_chamber(sim["governors"]["races"], g["not_up"]["D"], g["not_up"]["R"], 26, 26, 50)}
    hsum = sim["house"]["summary"]
    sim["house"]["summary"] = {**hsum, **R.summarize_chamber(sim["house"]["districts"], 0, 0, 218, 218, 435)}
    out = Path(a.out)
    (out / "data" / "seed").mkdir(parents=True, exist_ok=True)
    (out / "data" / "live.json").write_text(json.dumps(sim, separators=(",", ":")))
    for f in ("polls_combined.json", "timeseries.json"):
        if (ROOT / "data" / f).exists():
            shutil.copy(ROOT / "data" / f, out / "data" / f)
    shutil.copy(ROOT / "data" / "seed" / "history.json", out / "data" / "seed" / "history.json")
    shutil.copy(ROOT / "index.html", out / "index.html")
    if (out / "assets").exists():
        shutil.rmtree(out / "assets")
    shutil.copytree(ROOT / "assets", out / "assets")
    ss = sim["senate"]["summary"]; hh = sim["house"]["summary"]
    print(f"wrote {out}: hours={a.hours} swing={a.swing} | Senate P(D)={ss['p_dem_control']} called D{ss['called']['D']} R{ss['called']['R']} "
          f"exp {ss['expected']} obs swing {sim['senate']['swing']} | House P(D)={hh['p_dem_control']} called D{hh['called']['D']} R{hh['called']['R']} exp {hh['expected']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
