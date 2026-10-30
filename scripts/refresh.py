#!/usr/bin/env python3
"""
Midterms 2026 data pipeline.

Runs on a schedule in GitHub Actions. Pulls live sources, merges them with the
curated seed data in data/seed/, runs our own model and writes a compact
data/live.json (plus data/polls_combined.json and data/timeseries.json) that the
static site reads.

Design rules:
  * Every fetcher is isolated. A failure is recorded in status and never stops
    the run. The site always gets a fresh live.json.
  * No credentials except an optional TAVILY_API_KEY, used only as a last-resort
    news fallback with a hard cap per run and a cool-down between runs.
  * Standard library only, so the Actions job has nothing to install.

Sources (all public, no auth):
  Results   NYT elections-assets JSON (AP counts + calls); CNN politics.api.cnn.io as fallback
  Polls     Wikipedia tables (scripts/polls.py), VoteHub API, CNN poll of polls, seed aggregator values
  Models    seed snapshot of DDHQ, Silver Bulletin, Economist, Split Ticket, Poliwave, Dave Manuel, etc.
  Ratings   Cook, Sabato, Inside Elections (seed), NYT (live)
  Markets   Polymarket Gamma API, Kalshi public API
  News      Google News RSS; Tavily only as fallback
"""
from __future__ import annotations

import json
import math
import os
import random
import re
import statistics
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SEED = DATA / "seed"
SOURCES = json.loads((ROOT / "scripts" / "sources.json").read_text())

ELECTION_DAY = datetime(2026, 11, 3, tzinfo=timezone.utc)
# First polls close 18:00 ET on 3 Nov = 23:00 UTC. Treat the day as live from 10:00 UTC.
LIVE_FROM = datetime(2026, 11, 3, 10, 0, tzinfo=timezone.utc)
LIVE_UNTIL = datetime(2026, 11, 24, 0, 0, tzinfo=timezone.utc)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 midterms-2026-dashboard")

STATUS: dict[str, dict[str, Any]] = {}
NOW = datetime.now(timezone.utc)
FAST = os.environ.get("FAST_MODE") == "1"   # election-night mode: skip slow, rarely-changing sources

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia",
}
NAME_TO_POSTAL = {v.lower(): k for k, v in STATE_NAMES.items()}


# --------------------------------------------------------------------------- utils
def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


def record(source: str, ok: bool, note: str = "", items: int = 0) -> None:
    STATUS[source] = {"ok": ok, "note": note[:300], "items": items,
                      "at": NOW.isoformat(timespec="seconds")}


def http_get(url: str, timeout: int = 30, headers: Optional[dict] = None,
             retries: int = 2) -> bytes:
    hdrs = {"User-Agent": UA, "Accept": "application/json, text/html;q=0.9, */*;q=0.8"}
    if headers:
        hdrs.update(headers)
    last: Exception = RuntimeError("no attempt")
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:  # noqa: PERF203
            last = e
            if isinstance(e, urllib.error.HTTPError) and e.code in (403, 404, 410):
                break
            time.sleep(1.5 * (attempt + 1) + (3 if isinstance(e, urllib.error.HTTPError) and e.code == 429 else 0))
    raise last


def get_json(url: str, **kw) -> Any:
    return json.loads(http_get(url, **kw).decode("utf-8", "replace"))


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json(path: Path, obj: Any, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
    else:
        path.write_text(json.dumps(obj, indent=1, ensure_ascii=False))


def phase_now() -> str:
    if NOW < LIVE_FROM:
        return "pre"
    if NOW < LIVE_UNTIL:
        return "live"
    return "post"


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def last_name(s: str) -> str:
    parts = slug(s).replace(" jr", "").replace(" iii", "").replace(" ii", "").split()
    return parts[-1] if parts else ""


def name_match(candidate: Optional[str], text: str) -> bool:
    """Loose match of a candidate's surname inside a poll answer (tolerates 'Healy' for 'Healey')."""
    import difflib
    ln = last_name(candidate or "")
    if not ln or len(ln) < 3:
        return False
    words = slug(text).split()
    if ln in words:
        return True
    return any(len(w) >= 4 and difflib.SequenceMatcher(None, ln, w).ratio() >= 0.8 for w in words)


def norm_other(lst: Any) -> list[dict]:
    """Seed 'other' entries may be dicts or plain strings; normalise to dicts."""
    out = []
    for o in lst or []:
        if isinstance(o, dict) and o.get("name"):
            out.append({"name": o["name"], "party": o.get("party") or "I"})
        elif isinstance(o, str) and o.strip():
            m = re.match(r"^(.*?)\s*\(([^)]+)\)\s*$", o.strip())
            out.append({"name": m.group(1) if m else o.strip(), "party": (m.group(2)[:1].upper() if m else "I")})
    return out


def first_other(r: dict) -> Optional[str]:
    oth = norm_other(r.get("other"))
    return r.get("ind") or (oth[0]["name"] if oth else None)


def rating_to_prob(rating: Optional[str]) -> Optional[float]:
    """Map a race rating string to a Democratic win probability."""
    if not rating or not isinstance(rating, str):
        return None
    r = rating.lower().replace("_", "-").replace(" ", "-")
    table = {
        "solid-dem": 0.99, "safe-dem": 0.99, "solid-d": 0.99, "safe-d": 0.99,
        "likely-dem": 0.90, "likely-d": 0.90,
        "lean-dem": 0.76, "lean-d": 0.76,
        "tilt-dem": 0.62, "tilt-d": 0.62,
        "toss-up": 0.50, "tossup": 0.50, "toss-up-dem": 0.55, "toss-up-rep": 0.45,
        "tilt-rep": 0.38, "tilt-r": 0.38,
        "lean-rep": 0.24, "lean-r": 0.24,
        "likely-rep": 0.10, "likely-r": 0.10,
        "solid-rep": 0.01, "safe-rep": 0.01, "solid-r": 0.01, "safe-r": 0.01,
        # independents: treat as the non-Republican side
        "lean-i": 0.76, "tilt-i": 0.62, "likely-i": 0.90, "solid-i": 0.99, "safe-i": 0.99,
    }
    if r in table:
        return table[r]
    if "toss" in r:
        return 0.5
    return None


# --------------------------------------------------------------------- NYT results
NYT_BASE = "https://static01.nyt.com/elections-assets/pages/data/2026-11-03/"


def party_code(nyt_party: Optional[str]) -> str:
    return {"DEM": "D", "GOP": "R", "REP": "R"}.get(nyt_party or "", "I" if (nyt_party or "") in ("IND", "IDP", "LIB", "GRE", "OTH") else "O")


def compact_candidate(meta: dict, votes: dict, total: int) -> dict:
    party = (meta.get("party") or {}).get("nyt_id") or "OTH"
    name = " ".join(x for x in [meta.get("first_name"), meta.get("last_name")] if x)
    v = int(votes.get("total") or 0)
    return {
        "id": meta.get("nyt_id"),
        "name": name or meta.get("last_name") or meta.get("nyt_id"),
        "party": party_code(party),
        "party_raw": party,
        "inc": bool(meta.get("incumbent")),
        "votes": v,
        "pct": round(100.0 * v / total, 1) if total else None,
    }


def compact_race(r: dict) -> dict:
    tru = r.get("top_reporting_unit") or {}
    cands_meta = r.get("candidate_metadata") or {}
    total = int(tru.get("total_votes") or 0)
    cands = []
    for c in tru.get("candidates") or []:
        meta = cands_meta.get(c.get("nyt_id"), {"nyt_id": c.get("nyt_id")})
        if meta.get("nyt_id") == "total_writeins" and not int((c.get("votes") or {}).get("total") or 0):
            continue
        cc = compact_candidate(meta, c.get("votes") or {}, total)
        cc["leader"] = bool(c.get("leader"))
        cands.append(cc)
    if not cands:  # no reporting unit yet: still list candidates from metadata
        for cid, meta in cands_meta.items():
            if cid == "total_writeins":
                continue
            cands.append(compact_candidate(meta, {}, 0) | {"leader": False})
    cands.sort(key=lambda c: (-c["votes"], c["name"]))
    won_ids = (r.get("outcome") or {}).get("won") or []
    winner = next((c for c in cands if c["id"] in won_ids), None)
    if winner is None and won_ids:
        meta = cands_meta.get(won_ids[0], {})
        if meta:
            winner = compact_candidate(meta, {}, 0)
    hist = {}
    for k, v in (tru.get("historical_comparison_race_data") or {}).items():
        if "-P-2024" in k:
            hist["pres_2024_margin_dem"] = v.get("margin")
    nyt_id = r.get("nyt_id", "")
    state = nyt_id.split("-")[0]
    dist = None
    if r.get("office_id") == "H":
        dist = r.get("seat_number") or r.get("seat")
    margin = None
    if len(cands) >= 2 and total:
        d = next((c for c in cands if c["party"] == "D"), None)
        rp = next((c for c in cands if c["party"] == "R"), None)
        if d and rp:
            margin = round(d["pct"] - rp["pct"], 1)
        elif rp:  # independent vs Republican: margin is the leading non-R minus R
            margin = round(cands[0]["pct"] - cands[1]["pct"], 1) * (1 if cands[0]["party"] != "R" else -1)
        else:
            margin = round(cands[0]["pct"] - cands[1]["pct"], 1) * (1 if cands[0]["party"] == "D" else -1)
    call = r.get("race_call_status")
    if won_ids and call != "called":
        call = "called"
    return {
        "id": nyt_id,
        "state": state,
        "district": dist,
        "special": "S_W" in nyt_id or r.get("race_type_id") == "S_W",
        "nyt_rating": r.get("rating") or r.get("general_rating"),
        "call": call,                                # too_early | called | runoff | ...
        "winner_party": winner["party"] if winner else None,
        "winner": winner["name"] if winner else None,
        "called_by": (r.get("outcome") or {}).get("called_by") or [],
        "eevp": tru.get("eevp") or 0,                # expected vote percent reported
        "votes": total,
        "expected": tru.get("total_expected_vote"),
        "precincts": [tru.get("precincts_reporting") or 0, tru.get("precincts_total") or 0],
        "margin": margin,                            # D (or leading non-R) minus R in current count
        "cands": cands[:5],
        "hist": hist,
        "uncontested": bool(r.get("uncontested")),
        "rcv": (r.get("tabulation_method") or "single-round") != "single-round",
        "updated": tru.get("provider_updated_at") or r.get("updated_at"),
        "url": r.get("url"),
    }


def fetch_nyt(office: str) -> Optional[dict]:
    url = NYT_BASE + f"results-{office}.json"
    try:
        raw = get_json(url, timeout=120)
    except Exception as e:
        record(f"nyt_{office}", False, f"{type(e).__name__}: {e}")
        return None
    races = [compact_race(r) for r in raw.get("races", [])
             if r.get("nyt_id") and not r["nyt_id"].startswith("US-")]
    pc = None
    try:
        offices = raw["partyControlData"]["results"][0]["offices"]
        key = {"senate": "S", "house": "H", "governor": "G"}[office]
        o = offices.get(key)
        if o:
            pb = o.get("party_balance") or {}
            pc = {
                "total": o.get("total"),
                "up": o.get("open_seats"),
                "not_up": o.get("no_election_seats"),
                "to_win": o.get("to_win"),
                "called": o.get("num_races_called"),
                "seats": {p: (pb.get(p) or {}).get("seats") for p in ("DEM", "GOP", "OTH")},
                "not_up_by_party": {p: (pb.get(p) or {}).get("no_election") for p in ("DEM", "GOP", "OTH")},
                "flips": {p: (pb.get(p) or {}).get("flip_count") for p in ("DEM", "GOP", "OTH")},
                "winner": next((p for p in ("DEM", "GOP") if (pb.get(p) or {}).get("winner")), None),
            }
    except Exception as e:  # party control is optional
        log(f"nyt {office} party control parse failed: {e}")
    meta = raw.get("resultsMeta") or {}
    closing = []
    for p in raw.get("pollClosingTimes") or []:
        try:
            closing.append({"state": p["reporting_unit"]["state_postal"],
                            "close_utc": p["poll_closing_time"],
                            "close_et": p["poll_closing_time_display_et"]})
        except Exception:
            pass
    record(f"nyt_{office}", True, f"updated {meta.get('resultsUpdatedAt')}", len(races))
    return {"races": races, "control": pc, "updated": meta.get("resultsUpdatedAt"),
            "closing": closing, "fetched": NOW.isoformat(timespec="seconds"), "provider": "nyt"}


# ----------------------------------------------------------------- CNN fallback
CNN_BASE = "https://politics.api.cnn.io/results/"


def fetch_cnn_bop(code: str) -> Optional[dict]:
    """Balance of power from CNN: code SG (Senate) or HG (House)."""
    try:
        d = get_json(CNN_BASE + f"bop/2026-{code}-US.json", timeout=30)
        vals = {c["id"]: c.get("value") for c in d.get("children", []) if isinstance(c, dict)}
        out = {"dem_not_up": vals.get("demNotUpForElection"), "dem_held": vals.get("demHeld"),
               "dem_flipped": vals.get("demFlippedSeats"), "rep_not_up": vals.get("repNotUpForElection"),
               "rep_held": vals.get("repHeld"), "rep_flipped": vals.get("repFlippedSeats")}
        out["dem_total"] = sum(v for v in (out["dem_not_up"], out["dem_held"], out["dem_flipped"]) if v)
        out["rep_total"] = sum(v for v in (out["rep_not_up"], out["rep_held"], out["rep_flipped"]) if v)
        record(f"cnn_bop_{code}", True, f"D {out['dem_total']} R {out['rep_total']}", 1)
        return out
    except Exception as e:
        record(f"cnn_bop_{code}", False, f"{type(e).__name__}: {e}")
        return None


def fetch_cnn_races(code: str) -> Optional[dict]:
    """CNN national race list as a fallback when NYT fails. code SG | GG | HG."""
    try:
        d = get_json(CNN_BASE + f"national-races/2026-{code}.json", timeout=60)
    except Exception as e:
        record(f"cnn_races_{code}", False, f"{type(e).__name__}: {e}")
        return None
    races = []
    for r in d if isinstance(d, list) else d.get("races", []):
        if r.get("electionTitle") and "General" not in r.get("electionTitle"):
            continue
        total = int(r.get("totalVote") or 0)
        cands = []
        for c in r.get("candidates", []):
            v = int(c.get("voteNum") or 0)
            cands.append({"id": c.get("lastNameSlug"), "name": c.get("fullName"), "party": {"D": "D", "R": "R"}.get(c.get("candidatePartyCode"), "I"),
                          "inc": bool(c.get("isIncumbent")), "votes": v, "pct": round(100 * v / total, 1) if total else None,
                          "leader": False, "winner": bool(c.get("winner"))})
        cands.sort(key=lambda c: -c["votes"])
        if cands:
            cands[0]["leader"] = total > 0
        winner = next((c for c in cands if c.get("winner")), None)
        d_ = next((c for c in cands if c["party"] == "D"), None)
        rp = next((c for c in cands if c["party"] == "R"), None)
        margin = round(d_["pct"] - rp["pct"], 1) if (d_ and rp and total) else None
        st = r.get("stateAbbreviation")
        dist = None
        if code == "HG":
            m = re.search(r"-(\d+)$", r.get("ecKey") or r.get("cid") or "")
            dist = m.group(1) if m else None
        races.append({"id": f"{st}-CNN-{code}-{dist or ''}", "state": st, "district": dist, "special": "Special" in (r.get("raceTitle") or ""),
                      "nyt_rating": None, "call": "called" if r.get("editorialStatus") == "called" or winner else "too_early",
                      "winner_party": winner["party"] if winner else None, "winner": winner["name"] if winner else None,
                      "called_by": ["cnn"] if winner else [], "eevp": r.get("percentReporting") or 0, "votes": total, "expected": None,
                      "precincts": [0, 0], "margin": margin, "cands": cands[:5], "hist": {}, "uncontested": False, "rcv": False,
                      "updated": r.get("voteTimestamp"), "url": None})
    record(f"cnn_races_{code}", True, "", len(races))
    return {"races": races, "control": None, "updated": NOW.isoformat(timespec="seconds"), "closing": [], "provider": "cnn"}


# ------------------------------------------------------------------ prediction mkts
def poly_event(slug_: str) -> Optional[dict]:
    ev = get_json(f"https://gamma-api.polymarket.com/events?slug={urllib.parse.quote(slug_)}")
    if isinstance(ev, list):
        ev = ev[0] if ev else None
    if not ev:
        return None
    markets = []
    for m in ev.get("markets", []):
        try:
            outcomes = json.loads(m.get("outcomes") or "[]")
            prices = [float(x) for x in json.loads(m.get("outcomePrices") or "[]")]
        except Exception:
            outcomes, prices = [], []
        if not prices:
            continue
        markets.append({
            "q": m.get("question") or m.get("groupItemTitle"),
            "item": m.get("groupItemTitle"),
            "slug": m.get("slug"),
            "outcomes": dict(zip(outcomes, prices)),
            "volume": float(m.get("volumeNum") or m.get("volume") or 0),
            "closed": bool(m.get("closed")),
        })
    return {"title": ev.get("title"), "slug": slug_, "markets": markets,
            "volume": float(ev.get("volume") or 0), "url": f"https://polymarket.com/event/{slug_}"}


def fetch_polymarket() -> dict:
    out: dict[str, Any] = {}
    cfg = SOURCES.get("polymarket", {})
    events = dict(cfg.get("events", {}))
    if not FAST:
        events.update(cfg.get("race_events", {}))
    else:
        events.update({k: v for k, v in cfg.get("race_events", {}).items() if k.startswith(("sen_", "gov_"))})
    n_ok = 0
    for key, s in events.items():
        try:
            ev = poly_event(s)
            if ev:
                out[key] = ev
                n_ok += 1
            else:
                out[key] = {"error": "event not found", "slug": s}
        except Exception as e:
            out[key] = {"error": f"{type(e).__name__}: {e}", "slug": s}
        time.sleep(0.15)
    record("polymarket", n_ok > 0, f"{n_ok}/{len(events)} events", n_ok)
    return out


def fetch_kalshi() -> dict:
    out: dict[str, Any] = {}
    cfg = SOURCES.get("kalshi", {})
    events = dict(cfg.get("events", {}))
    base = "https://api.elections.kalshi.com/trade-api/v2/markets"
    n_ok = 0
    for key, ticker in events.items():
        try:
            data = get_json(f"{base}?event_ticker={urllib.parse.quote(ticker)}&limit=100", retries=1)
            markets = []
            for m in data.get("markets", []):
                def f(x):
                    try:
                        return float(x) if x is not None else None
                    except Exception:
                        return None
                bid, ask, last = f(m.get("yes_bid_dollars")), f(m.get("yes_ask_dollars")), f(m.get("last_price_dollars"))
                if bid is None and m.get("yes_bid") is not None:
                    bid = float(m["yes_bid"]) / 100
                if ask is None and m.get("yes_ask") is not None:
                    ask = float(m["yes_ask"]) / 100
                mid = (bid + ask) / 2 if (bid is not None and ask is not None and (bid or ask)) else None
                yes = mid if mid is not None else last
                if yes is None:
                    continue
                markets.append({"ticker": m.get("ticker"), "title": m.get("title"), "sub": m.get("yes_sub_title"),
                                "yes": round(yes, 4), "bid": bid, "ask": ask, "last": last,
                                "volume": f(m.get("volume_fp")), "oi": f(m.get("open_interest_fp")), "status": m.get("status")})
            out[key] = {"event": ticker, "markets": markets, "url": f"https://kalshi.com/markets/{ticker.split('-')[0].lower()}"}
            n_ok += 1
        except Exception as e:
            out[key] = {"error": f"{type(e).__name__}: {e}", "event": ticker}
        time.sleep(1.1)  # Kalshi rate-limits bursts
    record("kalshi", n_ok > 0, f"{n_ok}/{len(events)} events", n_ok)
    return out


def extract_market_summary(poly: dict, kalshi: dict, seed_names: dict) -> dict:
    """Uniform summary: chamber control probabilities and per-race non-Republican probabilities.
    seed_names maps 'sen_GA' -> {'dem': 'Jon Ossoff', 'rep': 'Mike Collins', 'ind': 'Dan Osborn'}."""
    summ: dict[str, Any] = {"senate": {}, "house": {}, "senate_races": {}, "gov_races": {}, "house_races": {},
                            "balance_of_power": {}}

    def poly_dem(ev: dict, names: dict) -> Optional[float]:
        if not ev or not ev.get("markets"):
            return None
        best = None
        no_dem = bool(names) and not names.get("dem") and bool(names.get("ind"))
        for m in ev["markets"]:
            q = (m.get("q") or "") + " " + (m.get("item") or "")
            yes = m.get("outcomes", {}).get("Yes")
            if yes is None:
                continue
            if no_dem and name_match(names.get("ind"), q):
                return round(yes, 3)
            if not no_dem and (re.search(r"democrat", q, re.I) or re.search(r"\(D\)", q) or name_match(names.get("dem"), q)):
                return round(yes, 3)
            if name_match(names.get("ind"), q):
                best = round(yes, 3)
        return best

    def kalshi_dem(ev: dict, names: dict) -> Optional[float]:
        if not ev or not ev.get("markets"):
            return None
        best = None
        no_dem = bool(names) and not names.get("dem") and bool(names.get("ind"))
        for m in ev["markets"]:
            t = (m.get("ticker") or "")
            sub = (m.get("sub") or "") + " " + (m.get("title") or "")
            if no_dem and name_match(names.get("ind"), sub):
                return m["yes"]
            if not no_dem and (t.endswith("-D") or re.search(r"democrat", sub, re.I) or name_match(names.get("dem"), sub)):
                return m["yes"]
            if name_match(names.get("ind"), sub):
                best = m["yes"]
        return best

    summ["senate"] = {"polymarket_dem": poly_dem(poly.get("senate_control"), {}), "kalshi_dem": kalshi_dem(kalshi.get("senate_control"), {})}
    summ["house"] = {"polymarket_dem": poly_dem(poly.get("house_control"), {}), "kalshi_dem": kalshi_dem(kalshi.get("house_control"), {})}
    bop = poly.get("balance_of_power") or {}
    for m in bop.get("markets", []):
        item = (m.get("item") or m.get("q") or "")
        key = {"Democrats Sweep": "DD", "D Senate, R House": "DR", "R Senate, D House": "RD", "Republicans Sweep": "RR"}.get(item)
        if key and m.get("outcomes", {}).get("Yes") is not None:
            summ["balance_of_power"][key] = round(m["outcomes"]["Yes"], 3)
    kb = kalshi.get("balance_of_power") or {}
    for m in kb.get("markets", []):
        t = (m.get("ticker") or "").split("-")[-1]
        if t in ("DD", "DR", "RD", "RR"):
            summ["balance_of_power"].setdefault("kalshi_" + t, m["yes"])

    for key, ev in poly.items():
        if key.startswith(("sen_", "gov_", "hou_")):
            names = seed_names.get(key, {})
            v = poly_dem(ev, names)
            if v is not None:
                group = {"sen": "senate_races", "gov": "gov_races", "hou": "house_races"}[key[:3]]
                summ[group].setdefault(key[4:], {})["polymarket_dem"] = v
    for key, ev in kalshi.items():
        if key.startswith(("sen_", "gov_", "hou_")):
            names = seed_names.get(key, {})
            v = kalshi_dem(ev, names)
            if v is not None:
                group = {"sen": "senate_races", "gov": "gov_races", "hou": "house_races"}[key[:3]]
                summ[group].setdefault(key[4:], {})["kalshi_dem"] = v
    return summ


# ----------------------------------------------------------------------- polls
def recency_weight(end: Optional[str], ref: date) -> float:
    try:
        d = date.fromisoformat(end[:10])
    except Exception:
        return 0.3
    days = max(0, (ref - d).days)
    return math.exp(-days / 10.0)


def our_average(polls: list[dict], ref: Optional[date] = None, window_days: int = 21, min_polls: int = 3,
                main_i: Optional[bool] = None) -> Optional[dict]:
    """Recency and sample weighted average with pollster de-duplication.
    polls: [{pollster, end, n, dem, rep, ind?}] margin = dem - rep (or ind - rep when main_challenger is I)."""
    ref = ref or NOW.date()
    usable = [p for p in polls if p.get("end") and p.get("rep") is not None and (p.get("dem") is not None or p.get("ind") is not None)]
    if not usable:
        return None
    usable.sort(key=lambda p: p["end"], reverse=True)
    cutoff = (ref - timedelta(days=window_days)).isoformat()
    window = [p for p in usable if p["end"] >= cutoff]
    if len(window) < min_polls:
        window = usable[:8]
    if not window:
        return None
    if main_i is None:
        main_i = sum(1 for p in window if p.get("dem") is None and p.get("ind") is not None) > len(window) / 2
    if not main_i:
        window = [p for p in window if p.get("dem") is not None]
        if not window:
            return None
    seen_pollsters: dict[str, int] = {}
    wsum = 0.0
    acc = {"dem": 0.0, "rep": 0.0, "ind": 0.0, "margin": 0.0}
    cnt_ind = 0
    for p in window:
        key = slug(p.get("pollster") or "")
        dup = seen_pollsters.get(key, 0)
        seen_pollsters[key] = dup + 1
        w = recency_weight(p["end"], ref) * math.sqrt(min(float(p.get("n") or 600), 1500) / 600.0) * (1.0 if dup == 0 else 0.3)
        if p.get("partisan") or p.get("internal") or p.get("lean"):
            w *= 0.5
        a = p.get("ind") if main_i else p.get("dem")
        if a is None:
            a = p.get("dem") if p.get("dem") is not None else p.get("ind")
        if a is None:
            continue
        acc["margin"] += w * (float(a) - float(p["rep"]))
        acc["rep"] += w * float(p["rep"])
        if p.get("dem") is not None:
            acc["dem"] += w * float(p["dem"])
        if p.get("ind") is not None:
            acc["ind"] += w * float(p["ind"]); cnt_ind += w
        wsum += w
    if not wsum:
        return None
    out = {"margin": round(acc["margin"] / wsum, 1), "rep": round(acc["rep"] / wsum, 1), "n_polls": len(window),
           "window_days": window_days if len([p for p in usable if p["end"] >= cutoff]) >= min_polls else None,
           "main_challenger": "I" if main_i else "D", "latest_end": window[0]["end"],
           "pollsters": len(seen_pollsters)}
    out["dem"] = round(acc["dem"] / wsum, 1) if any(p.get("dem") is not None for p in window) else None
    out["ind"] = round(acc["ind"] / cnt_ind, 1) if cnt_ind else None
    return out


def weekly_trend(polls: list[dict], weeks: int = 16, main_i: Optional[bool] = None) -> list[dict]:
    """Weekly recency-weighted margins for the last N weeks."""
    out = []
    end = NOW.date()
    for i in range(weeks - 1, -1, -1):
        ref = end - timedelta(days=7 * i)
        avg = our_average([p for p in polls if p.get("end") and p["end"] <= ref.isoformat()], ref=ref, window_days=21, min_polls=2, main_i=main_i)
        if avg:
            out.append({"week": ref.isoformat(), "margin": avg["margin"], "n": avg["n_polls"]})
    return out


def fetch_votehub() -> dict:
    """VoteHub open polling API (CC-BY). Returns raw polls grouped by type."""
    out: dict[str, list] = {}
    n = 0
    for t in ("generic-ballot", "us-senator", "governor", "us-representative"):
        try:
            d = get_json(f"https://api.votehub.com/polls?poll_type={t}", timeout=60)
            polls = d["polls"] if isinstance(d, dict) and "polls" in d else d
            polls = [p for p in polls if str(p.get("subject", "")).startswith("2026") or t == "generic-ballot"]
            out[t] = polls
            n += len(polls)
        except Exception as e:
            record(f"votehub_{t}", False, f"{type(e).__name__}: {e}")
            out[t] = []
        time.sleep(0.4)
    record("votehub", n > 0, f"{n} polls", n)
    return out


def fetch_cnn_pop() -> list[dict]:
    try:
        d = get_json("https://politics.api.cnn.io/polling/2026-generic-ballot/latest-poll-of-polls.json", timeout=30)
        out = []
        for e in d.get("entries", []):
            qs = {q.get("label", ""): q.get("value") for q in e.get("questions", [])}
            dem = next((v for k, v in qs.items() if k.lower().startswith("dem")), None)
            rep = next((v for k, v in qs.items() if k.lower().startswith("rep")), None)
            if dem is None or rep is None:
                continue
            ed = e.get("end_date"); sd = e.get("start_date")
            out.append({"pollster": e.get("pollster"), "start": datetime.fromtimestamp(sd, timezone.utc).date().isoformat() if sd else None,
                        "end": datetime.fromtimestamp(ed, timezone.utc).date().isoformat() if ed else None,
                        "n": e.get("sample_size"), "pop": (e.get("sample_type") or "").upper()[:2] or None, "moe": e.get("moe"),
                        "dem": dem, "rep": rep, "url": e.get("source_uri"), "src": "cnn"})
        record("cnn_pop", True, "", len(out))
        return out
    except Exception as e:
        record("cnn_pop", False, f"{type(e).__name__}: {e}")
        return []


def vh_to_poll(p: dict, names: dict) -> Optional[dict]:
    """Convert a VoteHub poll into our shape using candidate names to assign parties."""
    ans = p.get("answers") or []
    dem = rep = ind = None
    other = 0.0
    dn, rn, inn = last_name(names.get("dem") or ""), last_name(names.get("rep") or ""), last_name(names.get("ind") or "")
    for a in ans:
        ch = str(a.get("choice") or ""); pct = a.get("pct")
        if pct is None:
            continue
        c = slug(ch)
        if c in ("dem", "democrat", "democrats", "democratic") or name_match(names.get("dem"), ch):
            dem = pct if dem is None else dem
        elif c in ("rep", "republican", "republicans") or name_match(names.get("rep"), ch):
            rep = pct if rep is None else rep
        elif name_match(names.get("ind"), ch):
            ind = pct if ind is None else ind
        elif c in ("undecided", "other", "someone else", "dont know", "don t know", "wouldn t vote", "no opinion"):
            other += pct
        else:
            # unknown name: try party hints in the choice string
            if re.search(r"\(d\)|democrat", ch, re.I):
                dem = pct if dem is None else dem
            elif re.search(r"\(r\)|republican", ch, re.I):
                rep = pct if rep is None else rep
            elif re.search(r"\(i\)|independent", ch, re.I):
                ind = pct if ind is None else ind
    if rep is None or (dem is None and ind is None):
        return None
    return {"pollster": p.get("pollster"), "sponsor": ", ".join(p.get("sponsors") or []) or None,
            "start": p.get("start_date"), "end": p.get("end_date"), "n": p.get("sample_size"),
            "pop": (p.get("population") or "").upper() or None, "dem": dem, "rep": rep, "ind": ind,
            "partisan": p.get("partisan"), "internal": p.get("internal"), "url": p.get("url"), "src": "votehub"}


def merge_polls(*lists: list[dict]) -> list[dict]:
    """De-duplicate polls from several sources by pollster + end date (+ sample size when present)."""
    seen: dict[tuple, dict] = {}
    for lst in lists:
        for p in lst or []:
            if not p or not p.get("end"):
                continue
            key = (slug(p.get("pollster") or "")[:18], p["end"][:10])
            if key in seen:
                # prefer the record with more fields
                a = seen[key]
                if sum(v is not None for v in p.values()) > sum(v is not None for v in a.values()):
                    seen[key] = {**a, **{k: v for k, v in p.items() if v is not None}}
                continue
            seen[key] = dict(p)
    out = list(seen.values())
    out.sort(key=lambda p: p["end"], reverse=True)
    return out


def build_polls(seed_senate: dict, seed_gov: dict, seed_house: dict, wiki: dict, vh: dict, cnn_pop: list[dict]) -> dict:
    """Combine every poll source into one structure keyed by race, with our averages and trends."""
    names_sen = {key_state(r): {"dem": r.get("dem"), "rep": r.get("rep"), "ind": first_other(r)} for r in seed_senate.get("races", [])}
    names_gov = {key_state(r): {"dem": r.get("dem"), "rep": r.get("rep"), "ind": first_other(r)} for r in seed_gov.get("races", [])}
    names_hou = {d.get("district", "").upper(): {"dem": d.get("dem"), "rep": d.get("rep")} for d in seed_house.get("competitive_districts", [])}

    def wiki_polls(section: str, st: str) -> list[dict]:
        sec = (wiki or {}).get(section) or {}
        rec = sec.get(st) or {}
        out = []
        for q in rec.get("polls", []) or []:
            out.append({**q, "src": "wikipedia"})
        return out

    out: dict[str, Any] = {"generated_at": NOW.isoformat(timespec="seconds"), "senate": {}, "governors": {}, "house": {}, "generic_ballot": {}}
    # generic ballot
    gb_vh = [vh_to_poll(p, {}) for p in (vh.get("generic-ballot") or [])]
    gb_wiki = [{**q, "src": "wikipedia"} for q in ((wiki or {}).get("generic_ballot") or {}).get("polls", []) or []]
    gb_all = [p for p in merge_polls(gb_wiki, gb_vh, cnn_pop) if p.get("end", "") >= "2025-01-01"]
    out["generic_ballot"] = {"polls": gb_all, "avg": our_average(gb_all, window_days=14, min_polls=5),
                             "trend": weekly_trend(gb_all, weeks=44), "sources": sorted({p.get("src") for p in gb_all if p.get("src")})}
    # per race
    def subj_state(s: str) -> Optional[str]:
        m = re.match(r"2026\s+(.+?)(\s+(Democratic|Republican)(\s+primary)?)?$", s or "")
        if not m or m.group(2):
            return None
        return NAME_TO_POSTAL.get(m.group(1).strip().lower())

    vh_sen: dict[str, list] = {}
    for p in vh.get("us-senator") or []:
        st = subj_state(p.get("subject"))
        if st:
            vh_sen.setdefault(st, []).append(p)
    vh_gov: dict[str, list] = {}
    for p in vh.get("governor") or []:
        st = subj_state(p.get("subject"))
        if st:
            vh_gov.setdefault(st, []).append(p)
    vh_hou: dict[str, list] = {}
    for p in vh.get("us-representative") or []:
        m = re.match(r"2026\s+([A-Z]{2}-\d{2})", p.get("subject") or "")
        if m:
            vh_hou.setdefault(m.group(1), []).append(p)

    for section, names, vhd, wsec in (("senate", names_sen, vh_sen, "senate"), ("governors", names_gov, vh_gov, "governors")):
        states = set(names) | set(vhd) | set(((wiki or {}).get(wsec) or {}).keys())
        for st in sorted(states):
            nm = names.get(st, {})
            converted = [x for x in (vh_to_poll(p, nm) for p in vhd.get(st, [])) if x]
            allp = merge_polls(wiki_polls(wsec, st), converted)
            allp = [p for p in allp if p.get("end", "") >= "2025-06-01"]
            if not allp:
                continue
            wrec = ((wiki or {}).get(wsec) or {}).get(st) or {}
            main_i = bool(nm) and not nm.get("dem") and bool(nm.get("ind"))
            out[section][st] = {"candidates": wrec.get("candidates") or [{"name": nm.get("dem"), "party": "D"}, {"name": nm.get("rep"), "party": "R"}] + ([{"name": nm.get("ind"), "party": "I"}] if nm.get("ind") else []),
                                "special": bool(wrec.get("special")), "polls": allp, "avg": our_average(allp, main_i=main_i),
                                "trend": weekly_trend(allp, weeks=16, main_i=main_i), "sources": sorted({p.get("src") for p in allp if p.get("src")})}
    for did, plist in vh_hou.items():
        nm = names_hou.get(did, {})
        converted = [x for x in (vh_to_poll(p, nm) for p in plist) if x]
        allp = merge_polls(converted)
        if allp:
            out["house"][did] = {"polls": allp, "avg": our_average(allp, min_polls=2), "sources": ["votehub"]}
    out["counts"] = {"generic_ballot": len(gb_all), "senate": sum(len(v["polls"]) for v in out["senate"].values()),
                     "governors": sum(len(v["polls"]) for v in out["governors"].values()), "house": sum(len(v["polls"]) for v in out["house"].values())}
    return out


# ------------------------------------------------------------------------ news
def fetch_rss(url: str, limit: int = 12) -> list[dict]:
    raw = http_get(url, timeout=25)
    root = ET.fromstring(raw)
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        pub = (it.findtext("pubDate") or "").strip()
        src_el = it.find("source")
        source = (src_el.text or "").strip() if src_el is not None else ""
        if not title:
            continue
        ts = None
        for fmt in ("%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S %z"):
            try:
                ts = datetime.strptime(pub, fmt).astimezone(timezone.utc).isoformat(timespec="minutes")
                break
            except Exception:
                continue
        items.append({"title": title, "url": link, "source": source, "at": ts})
        if len(items) >= limit:
            break
    return items


def fetch_news(prev: dict) -> dict:
    """Free RSS first. Tavily only if RSS yields nothing, a key exists and the
    cool-down has passed. Hard cap: one Tavily call per run."""
    items: list[dict] = []
    for q in SOURCES.get("news_queries", []):
        try:
            url = "https://news.google.com/rss/search?q=" + urllib.parse.quote(q) + "&hl=en-US&gl=US&ceid=US:en"
            items.extend(fetch_rss(url, limit=10))
        except Exception as e:
            log(f"rss failed for {q!r}: {e}")
    for feed in SOURCES.get("news_feeds", []):
        try:
            items.extend(fetch_rss(feed["url"], limit=8))
        except Exception as e:
            log(f"feed failed {feed.get('name')}: {e}")
    seen = set()
    dedup = []
    for it in items:
        k = re.sub(r"\W+", " ", it["title"].lower())[:80]
        if k in seen:
            continue
        seen.add(k)
        dedup.append(it)
    dedup.sort(key=lambda x: x.get("at") or "", reverse=True)
    out = {"items": dedup[:40], "via": "rss", "fetched": NOW.isoformat(timespec="seconds"),
           "tavily_last": (prev or {}).get("tavily_last"), "tavily_calls_total": (prev or {}).get("tavily_calls_total", 0)}
    record("news_rss", bool(dedup), f"{len(dedup)} items", len(dedup))

    key = os.environ.get("TAVILY_API_KEY")
    cool_h = float(SOURCES.get("tavily", {}).get("cooldown_hours", 6))
    last = out.get("tavily_last")
    cooled = True
    if last:
        try:
            cooled = (NOW - datetime.fromisoformat(last)) > timedelta(hours=cool_h)
        except Exception:
            cooled = True
    if not dedup and key and cooled:
        try:
            body = json.dumps({"query": SOURCES.get("tavily", {}).get("query", "2026 midterm elections latest results forecast"),
                               "topic": "news", "days": 2, "max_results": 10, "search_depth": "basic"}).encode()
            req = urllib.request.Request("https://api.tavily.com/search", data=body,
                                         headers={"Content-Type": "application/json",
                                                  "Authorization": f"Bearer {key}", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            out["items"] = [{"title": r.get("title"), "url": r.get("url"), "source": urllib.parse.urlparse(r.get("url", "")).netloc,
                             "at": r.get("published_date"), "snippet": (r.get("content") or "")[:220]} for r in data.get("results", [])]
            out["via"] = "tavily"
            out["tavily_last"] = NOW.isoformat(timespec="seconds")
            out["tavily_calls_total"] = int(out.get("tavily_calls_total") or 0) + 1
            record("news_tavily", True, "fallback used", len(out["items"]))
        except Exception as e:
            record("news_tavily", False, f"{type(e).__name__}: {e}")
    return out


# -------------------------------------------------------------------- the model
SIGMA_POLL = 4.8          # typical final-poll-average error in a Senate/Gov race (pts)
SIGMA_RATING_ONLY = 7.0   # when we only have a rating, not polls
SIGMA_NATIONAL = 2.6      # shared national error component (pts)
PRES_2024_NATIONAL = -1.5  # Trump beat Harris by about 1.5 points nationally


def prob_from_margin(margin: float, sigma: float) -> float:
    return min(0.995, max(0.005, norm_cdf(margin / sigma)))


def margin_from_prob(p: float, sigma: float) -> float:
    p = min(0.995, max(0.005, p))
    lo, hi = -40.0, 40.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if norm_cdf(mid / sigma) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def prior_for_race(seed: dict, nyt: Optional[dict], mkts: Optional[dict], our_poll: Optional[dict],
                   national_shift: Optional[float], office: str) -> dict:
    """Our pre-election model for one race. Returns expected margin (non-R minus R), sigma, p_dem, and the
    components so the page can show the working."""
    parts: list[tuple[str, float, float]] = []  # (component, margin_estimate, weight)
    # 1. polls: our own average first, then the seed aggregator value
    pm = None
    if our_poll and our_poll.get("margin") is not None:
        pm = float(our_poll["margin"])
        w = 2.0 * min(1.0, 0.4 + 0.15 * our_poll.get("n_polls", 0))   # thin polling gets less weight
        parts.append(("polls", pm, w))
    else:
        poll = (seed or {}).get("poll_avg") or {}
        if poll.get("margin") is not None:
            pm = float(poll["margin"])
            parts.append(("polls", pm, 1.6))
    # 2. published models
    fc = (seed or {}).get("forecast") or {}
    model_ps = [v for k, v in fc.items() if isinstance(v, (int, float)) and not k.endswith("_note")]
    if model_ps:
        parts.append(("models", margin_from_prob(statistics.mean(model_ps), SIGMA_POLL), 2.5))
    # 3. ratings (seed + NYT)
    ratings = (seed or {}).get("ratings") or {}
    rating_ps = [rating_to_prob(v) for k, v in ratings.items()
                 if isinstance(v, str) and k in ("cook", "sabato", "inside", "silver_bulletin", "split_ticket", "economist", "ddhq", "nyt")]
    rating_ps = [x for x in rating_ps if x is not None]
    if nyt and nyt.get("nyt_rating"):
        rp = rating_to_prob(nyt["nyt_rating"])
        if rp is not None:
            rating_ps.append(rp)
    if rating_ps:
        parts.append(("ratings", margin_from_prob(statistics.mean(rating_ps), SIGMA_RATING_ONLY), 1.5))
    # 4. markets
    if mkts:
        mp = [v for v in (mkts.get("polymarket_dem"), mkts.get("kalshi_dem")) if isinstance(v, (int, float))]
        if mp:
            parts.append(("markets", margin_from_prob(statistics.mean(mp), SIGMA_POLL), 1.0))
    # 5. fundamentals: 2024 presidential margin + national environment shift, plus incumbency
    h = ((nyt or {}).get("hist") or {}).get("pres_2024_margin_dem")
    if h is not None and national_shift is not None:
        fund = float(h) + float(national_shift)
        inc = {"DFL": "D", "DEM": "D", "GOP": "R", "REP": "R"}.get(str((seed or {}).get("incumbent_party") or "").upper(), (seed or {}).get("incumbent_party"))
        running = (seed or {}).get("incumbent_running", True) and not (seed or {}).get("open")
        if inc in ("D", "R") and running:
            fund += 2.5 if inc == "D" else -2.5
        if office == "governor":
            fund *= 0.35  # governor races are far less tied to presidential partisanship
        fund = max(-25.0, min(25.0, fund))
        wf = (0.3 if office == "governor" else 0.45) if parts else 1.0
        parts.append(("fundamentals", fund, wf))
    if not parts:
        return {"margin": 0.0, "sigma": 12.0, "p_dem": 0.5, "basis": "none", "parts": {}}
    w = sum(x[2] for x in parts)
    m = sum(x[1] * x[2] for x in parts) / w
    has_signal = pm is not None or model_ps
    sigma = SIGMA_POLL if has_signal else SIGMA_RATING_ONLY
    if pm is not None and our_poll and our_poll.get("n_polls", 0) >= 6 and our_poll.get("pollsters", 0) >= 4:
        sigma = 4.4
    return {"margin": round(m, 2), "sigma": sigma, "p_dem": round(prob_from_margin(m, sigma), 3),
            "basis": "+".join(p[0] for p in parts), "parts": {p[0]: round(p[1], 1) for p in parts}}


def live_update(prior: dict, nyt: Optional[dict], swing: float) -> dict:
    """Blend the prior with the live count. eevp is the expected-vote share in."""
    if not nyt:
        return {**prior, "p_live": prior["p_dem"], "state": "pre"}
    call = nyt.get("call")
    wp = nyt.get("winner_party")
    if call == "called" and wp in ("D", "R", "I", "O"):
        return {**prior, "p_live": 1.0 if wp != "R" else 0.0, "state": "called"}
    if call == "runoff":
        return {**prior, "p_live": prior["p_dem"], "state": "runoff"}
    eevp = float(nyt.get("eevp") or 0) / 100.0
    cur = nyt.get("margin")
    if cur is None or eevp <= 0.02:
        m = prior["margin"] + 0.7 * swing
        return {**prior, "margin_live": round(m, 2), "p_live": round(prob_from_margin(m, prior["sigma"]), 3),
                "state": "waiting" if eevp == 0 else "early"}
    # Early returns are noisy (vote-type ordering), so trust the count on a concave curve.
    trust = eevp ** 1.6
    m = trust * float(cur) + (1 - trust) * (prior["margin"] + 0.7 * swing)
    sigma = math.sqrt(((1 - eevp) * prior["sigma"]) ** 2 + (1.5 * (1 - eevp)) ** 2 + 0.6 ** 2)
    return {**prior, "margin_live": round(m, 2), "sigma_live": round(sigma, 2),
            "p_live": round(prob_from_margin(m, sigma), 3), "state": "counting"}


def observed_swing(races: list[dict]) -> dict:
    """Median (actual minus expected) margin across races with enough vote in.
    Positive means Democrats are running ahead of expectations."""
    obs = []
    for r in races:
        live = r.get("live") or {}
        prior = r.get("prior") or {}
        if live.get("call") == "called" or (live.get("eevp") or 0) >= 60:
            if live.get("margin") is not None and prior.get("basis") not in (None, "none") and (live.get("eevp") or 0) >= 40:
                obs.append((float(live["margin"]) - float(prior["margin"]), float(live.get("eevp") or 0)))
    if not obs:
        return {"swing": 0.0, "n": 0}
    vals = sorted(x[0] for x in obs)
    med = statistics.median(vals)
    return {"swing": round(med, 2), "n": len(obs), "mean": round(statistics.mean(vals), 2),
            "spread": round(statistics.pstdev(vals), 2) if len(vals) > 1 else None}


def simulate_chamber(races: list[dict], base_dem: int, to_win: int, sims: int = 20000, seed: int = 7) -> dict:
    """Monte Carlo with a shared national error term plus race-level noise."""
    rng = random.Random(seed)
    entries = []
    for r in races:
        pj = r.get("proj") or {}
        p = pj.get("p_live")
        if p is None:
            continue
        st = pj.get("state")
        if st == "called":
            entries.append(("fixed", 1 if p >= 0.5 else 0, 0.0))
            continue
        m = pj.get("margin_live", pj.get("margin", 0.0))
        s = pj.get("sigma_live", pj.get("sigma", SIGMA_POLL))
        eevp = float((r.get("live") or {}).get("eevp") or 0) / 100.0
        nat = SIGMA_NATIONAL * (1 - eevp)
        entries.append(("rand", m, (s, nat)))
    counts = [0] * (len(entries) + 1)
    dem_control = 0
    seat_sum = 0
    for _ in range(sims):
        nat_err = rng.gauss(0, 1)
        d = 0
        for kind, a, b in entries:
            if kind == "fixed":
                d += a
            else:
                s, nat = b
                idio = math.sqrt(max(s * s - nat * nat, 0.25))
                if a + nat * nat_err + rng.gauss(0, idio) > 0:
                    d += 1
        counts[d] += 1
        seat_sum += d
        if base_dem + d >= to_win:
            dem_control += 1
    exp_d = base_dem + seat_sum / sims
    dist = {str(base_dem + i): round(c / sims, 4) for i, c in enumerate(counts) if c}
    cum = 0.0
    lo = hi = None
    for i, c in enumerate(counts):
        cum += c / sims
        if lo is None and cum >= 0.10:
            lo = base_dem + i
        if hi is None and cum >= 0.90:
            hi = base_dem + i
            break
    return {"p_dem_control": round(dem_control / sims, 3), "exp_dem_seats": round(exp_d, 1),
            "dem_80": [lo, hi], "dist": dist, "sims": sims}


# ---------------------------------------------------------------------- merging
def key_state(seed_race: dict) -> str:
    return (seed_race.get("postal") or seed_race.get("state") or "").upper()


def merge_statewide(seed: dict, nyt: Optional[dict], mkts_group: dict, polls_group: dict, national_shift: Optional[float],
                    office: str) -> dict:
    nyt_by: dict[tuple, dict] = {}
    for r in (nyt or {}).get("races", []):
        nyt_by[(r["state"], bool(r["special"]))] = r
    out = []
    seen = set()
    for s in (seed or {}).get("races", []):
        st = key_state(s)
        sp = bool(s.get("special"))
        n = nyt_by.get((st, sp)) or nyt_by.get((st, not sp))
        if n:
            seen.add(n["id"])
        m = mkts_group.get(st)
        pp = (polls_group.get(st) or {})
        our_poll = pp.get("avg")
        prior = prior_for_race(s, n, m, our_poll, national_shift, office)
        other = norm_other(s.get("other"))
        if s.get("ind") and not any(o.get("name") == s["ind"] for o in other):
            other = [{"name": s["ind"], "party": "I"}] + other
        inc_party = {"DFL": "D", "DEM": "D", "GOP": "R", "REP": "R"}.get(str(s.get("incumbent_party") or "").upper(), s.get("incumbent_party"))
        out.append({"state": s.get("state"), "postal": st, "special": sp,
                    "incumbent": s.get("incumbent"), "incumbent_party": inc_party,
                    "incumbent_running": s.get("incumbent_running"), "open": s.get("open"),
                    "dem": s.get("dem"), "rep": s.get("rep"), "other": other,
                    "main_challenger": (our_poll or {}).get("main_challenger") or ("I" if (not s.get("dem") and other) else "D"),
                    "ratings": {k: v for k, v in (s.get("ratings") or {}).items() if isinstance(v, str)},
                    "poll_avg": our_poll or s.get("poll_avg"), "poll_avg_seed": s.get("poll_avg"),
                    "n_polls": len(pp.get("polls") or []),
                    "forecast": {k: v for k, v in (s.get("forecast") or {}).items() if isinstance(v, (int, float))},
                    "market": m, "prev": s.get("prev_result"),
                    "notes": s.get("notes"), "prior": prior, "live": n})
    for (st, sp), n in nyt_by.items():
        if n["id"] in seen:
            continue
        prior = prior_for_race({}, n, None, None, national_shift, office)
        out.append({"state": STATE_NAMES.get(st, st), "postal": st, "special": sp, "ratings": {"nyt": n.get("nyt_rating")},
                    "prior": prior, "live": n, "dem": next((c["name"] for c in n["cands"] if c["party"] == "D"), None),
                    "rep": next((c["name"] for c in n["cands"] if c["party"] == "R"), None), "other": [], "forecast": {}, "main_challenger": "D"})
    sw = observed_swing(out)
    for r in out:
        r["proj"] = live_update(r["prior"], r.get("live"), sw["swing"])
    out.sort(key=lambda r: abs(r["prior"]["margin"]))
    return {"races": out, "swing": sw}


def merge_house(seed: dict, nyt: Optional[dict], mkts: dict, house_polls: dict, swing: float, national_shift: Optional[float]) -> dict:
    comp = {d.get("district", "").upper(): d for d in (seed or {}).get("competitive_districts", [])}
    at_large = {"AK", "DE", "ND", "SD", "VT", "WY"}
    out = []
    for n in (nyt or {}).get("races", []):
        st = n["state"]
        dist = n.get("district")
        try:
            did = f"{st}-{int(dist):02d}"
        except Exception:
            did = f"{st}-{dist}" if dist else st
        if st in at_large:
            did = f"{st}-AL"
        s = comp.get(did) or comp.get(f"{st}-{str(dist).lstrip('0')}") or (comp.get(f"{st}-01") if st in at_large else None) or {}
        other_r = s.get("other_ratings") or {}
        seedlike = {"ratings": {**{k: s.get(k) for k in ("cook", "sabato", "inside") if s.get(k)},
                                **{k: v for k, v in other_r.items() if isinstance(v, str)}},
                    "poll_avg": s.get("poll_avg"), "forecast": s.get("forecast") or {},
                    "incumbent_party": s.get("incumbent_party"), "incumbent_running": s.get("incumbent_running", True)}
        hp = (house_polls.get(did) or {}).get("avg")
        prior = prior_for_race(seedlike, n, (mkts.get("house_races") or {}).get(did), hp, national_shift, "house")
        parties = {c["party"] for c in n.get("cands", [])}
        if n.get("uncontested") or (parties and parties <= {"D"}):
            prior = {"margin": 60.0, "sigma": 5.0, "p_dem": 0.999, "basis": "uncontested", "parts": {}}
        elif parties and parties <= {"R"}:
            prior = {"margin": -60.0, "sigma": 5.0, "p_dem": 0.001, "basis": "uncontested", "parts": {}}
        proj = live_update(prior, n, swing)
        rec = {"id": did, "state": st, "district": dist, "competitive": bool(s),
               "incumbent": s.get("incumbent"), "incumbent_party": s.get("incumbent_party"),
               "dem": s.get("dem") or next((c["name"] for c in n["cands"] if c["party"] == "D"), None),
               "rep": s.get("rep") or next((c["name"] for c in n["cands"] if c["party"] == "R"), None),
               "ratings": {**seedlike["ratings"], "nyt": n.get("nyt_rating")},
               "pvi": s.get("pvi"), "prev_margin_2024": s.get("prev_margin_2024"), "poll_avg": hp,
               "notes": s.get("notes"), "prior": prior, "proj": proj,
               "live": {k: n.get(k) for k in ("call", "winner_party", "winner", "eevp", "votes", "expected", "margin", "cands", "precincts", "hist", "updated", "url", "uncontested")}}
        out.append(rec)
    # infer incumbent party for non-seed districts from the NYT candidate list
    for d in out:
        if not d.get("incumbent_party"):
            inc = next((c for c in (d["live"].get("cands") or []) if c.get("inc")), None)
            if inc:
                d["incumbent_party"] = inc["party"]
                d["incumbent"] = inc["name"]
    out.sort(key=lambda r: abs(r["prior"]["margin"]))
    return {"districts": out}


def summarize_chamber(races: list[dict], not_up_dem: int, not_up_rep: int, to_win_dem: int,
                      to_win_rep: int, total: int) -> dict:
    called_d = sum(1 for r in races if (r.get("proj") or {}).get("state") == "called" and r["proj"]["p_live"] >= 0.5)
    called_r = sum(1 for r in races if (r.get("proj") or {}).get("state") == "called" and r["proj"]["p_live"] < 0.5)
    lead_d = sum(1 for r in races if (r.get("proj") or {}).get("state") == "counting" and ((r.get("live") or {}).get("margin") or 0) > 0)
    lead_r = sum(1 for r in races if (r.get("proj") or {}).get("state") == "counting" and ((r.get("live") or {}).get("margin") or 0) < 0)
    sim = simulate_chamber(races, not_up_dem, to_win_dem)
    exp_d = sim["exp_dem_seats"]
    flips = []
    for r in races:
        inc = r.get("incumbent_party")
        pj = r.get("proj") or {}
        if inc in ("D", "R") and pj.get("p_live") is not None:
            if (inc == "D" and pj["p_live"] < 0.5) or (inc == "R" and pj["p_live"] >= 0.5):
                flips.append({"id": r.get("postal") or r.get("id"), "from": inc, "to": "R" if inc == "D" else "D",
                              "p": pj["p_live"], "state": pj.get("state")})
    return {
        "total": total, "to_win": {"D": to_win_dem, "R": to_win_rep},
        "not_up": {"D": not_up_dem, "R": not_up_rep},
        "called": {"D": called_d, "R": called_r},
        "leading": {"D": lead_d, "R": lead_r},
        "secured": {"D": not_up_dem + called_d, "R": not_up_rep + called_r},
        "expected": {"D": round(exp_d, 1), "R": round(total - exp_d, 1)},
        "dem_80": sim["dem_80"], "p_dem_control": sim["p_dem_control"], "dist": sim["dist"],
        "uncalled": sum(1 for r in races if (r.get("proj") or {}).get("state") != "called"),
        "likely_flips": sorted(flips, key=lambda f: -abs(f["p"] - 0.5))[:60],
    }


# ------------------------------------------------------------------- timeseries
def append_timeseries(ts: dict, point: dict) -> dict:
    ts = ts or {"points": []}
    pts = ts["points"]
    if pts and point["t"][:15] == pts[-1]["t"][:15]:
        pts[-1] = point
    else:
        pts.append(point)
    cutoff = (NOW - timedelta(days=60)).isoformat()
    ts["points"] = [p for p in pts if p["t"] >= cutoff][-6000:]
    return ts


# ------------------------------------------------------------------------- main
def main() -> int:
    phase = phase_now()
    log(f"phase={phase} fast={FAST} now={NOW.isoformat()}")
    seed_senate = load_json(SEED / "senate.json", {}) or {}
    seed_house = load_json(SEED / "house.json", {}) or {}
    seed_gov = load_json(SEED / "governors.json", {}) or {}
    prev = load_json(DATA / "live.json", {}) or {}
    wiki_polls = load_json(DATA / "polls.json", {}) or {}
    prev_polls = load_json(DATA / "polls_combined.json", {}) or {}

    # Live results (NYT primary, CNN fallback)
    nyt_s = fetch_nyt("senate") or fetch_cnn_races("SG")
    nyt_g = fetch_nyt("governor") or fetch_cnn_races("GG")
    nyt_h = fetch_nyt("house") or fetch_cnn_races("HG")
    cnn_bop = {"senate": fetch_cnn_bop("SG"), "house": fetch_cnn_bop("HG")} if phase != "pre" or not FAST else {}

    # Markets
    poly = fetch_polymarket()
    kalshi = fetch_kalshi()
    seed_names = {}
    for r in seed_senate.get("races", []):
        seed_names["sen_" + key_state(r)] = {"dem": r.get("dem"), "rep": r.get("rep"), "ind": first_other(r)}
    for r in seed_gov.get("races", []):
        seed_names["gov_" + key_state(r)] = {"dem": r.get("dem"), "rep": r.get("rep"), "ind": first_other(r)}
    for d in seed_house.get("competitive_districts", []):
        seed_names["hou_" + d.get("district", "").upper()] = {"dem": d.get("dem"), "rep": d.get("rep")}
    mkts = extract_market_summary(poly, kalshi, seed_names)

    # Polls: VoteHub + CNN poll of polls + Wikipedia (from polls.py) -> our averages
    if FAST and prev_polls.get("generated_at"):
        polls = prev_polls   # election night: polls do not change, save the time
        record("votehub", True, "reused previous run (fast mode)", 0)
    else:
        vh = fetch_votehub()
        cnn_pop = fetch_cnn_pop()
        polls = build_polls(seed_senate, seed_gov, seed_house, wiki_polls, vh, cnn_pop)
        save_json(DATA / "polls_combined.json", polls)
    gb_our = (polls.get("generic_ballot") or {}).get("avg")

    # Generic ballot sources: seed aggregators + our own average
    gb = {g["source"]: g for g in (seed_house.get("generic_ballot") or []) if g.get("margin") is not None}
    gb_list = sorted(gb.values(), key=lambda g: g.get("as_of") or "", reverse=True)
    agg_margins = [g["margin"] for g in gb_list]
    if gb_our and gb_our.get("margin") is not None:
        agg_margins.append(gb_our["margin"]); agg_margins.append(gb_our["margin"])  # our average counts double
    gb_margin = round(statistics.median(agg_margins), 1) if agg_margins else None
    # National environment shift relative to the 2024 presidential vote, damped (generic ballot overstates)
    national_shift = round(0.8 * (gb_margin - PRES_2024_NATIONAL), 2) if gb_margin is not None else None

    # Senate
    senate = merge_statewide(seed_senate, nyt_s, mkts.get("senate_races") or {}, polls.get("senate") or {}, national_shift, "senate")
    ctrl = (nyt_s or {}).get("control") or {}
    nub = ctrl.get("not_up_by_party") or {}
    not_up_d = int(nub.get("DEM") or (seed_senate.get("seats_not_up") or {}).get("D") or 34)
    not_up_r = int(nub.get("GOP") or (seed_senate.get("seats_not_up") or {}).get("R") or 31)
    tw = ctrl.get("to_win") or {}
    senate["summary"] = summarize_chamber(senate["races"], not_up_d, not_up_r, int(tw.get("DEM") or 51), int(tw.get("GOP") or 50), 100)
    senate["summary"]["nyt_control"] = ctrl
    senate["summary"]["cnn_bop"] = cnn_bop.get("senate")
    senate["forecasts"] = seed_senate.get("chamber_forecasts") or {}
    senate["markets"] = mkts.get("senate")
    senate["current"] = seed_senate.get("current_composition")
    senate["provider"] = (nyt_s or {}).get("provider")

    # Governors
    govs = merge_statewide(seed_gov, nyt_g, mkts.get("gov_races") or {}, polls.get("governors") or {}, national_shift, "governor")
    gcur = seed_gov.get("current") or {}
    up_d = sum(1 for r in govs["races"] if r.get("incumbent_party") == "D")
    up_r = sum(1 for r in govs["races"] if r.get("incumbent_party") == "R")
    gnd = max(int(gcur.get("D") or 23) - up_d, 0)
    gnr = max(int(gcur.get("R") or 27) - up_r, 0)
    not_up_total = 50 - len(govs["races"])
    if gnd + gnr != not_up_total:
        gnr = max(not_up_total - gnd, 0)
    govs["summary"] = summarize_chamber(govs["races"], gnd, gnr, 26, 26, 50)
    govs["current"] = gcur
    govs["provider"] = (nyt_g or {}).get("provider")

    # House
    pre_swing = statistics.median([senate["swing"]["swing"], govs["swing"]["swing"]]) if (senate["swing"]["n"] or govs["swing"]["n"]) else 0.0
    house = merge_house(seed_house, nyt_h, mkts, polls.get("house") or {}, pre_swing, national_shift)
    hs = observed_swing(house["districts"])
    if hs["n"] >= 10:
        blended = round((pre_swing + hs["swing"]) / 2, 2) if (senate["swing"]["n"] or govs["swing"]["n"]) else hs["swing"]
        house = merge_house(seed_house, nyt_h, mkts, polls.get("house") or {}, blended, national_shift)
        hs = observed_swing(house["districts"])
    house["swing"] = hs
    house["summary"] = summarize_chamber(house["districts"], 0, 0, 218, 218, 435)
    house["summary"]["nyt_control"] = (nyt_h or {}).get("control")
    house["summary"]["cnn_bop"] = cnn_bop.get("house")
    house["generic_ballot"] = gb_list
    house["generic_ballot_median"] = gb_margin
    house["generic_ballot_our"] = gb_our
    house["national_shift"] = national_shift
    house["generic_ballot_history"] = seed_house.get("generic_ballot_history") or []
    house["forecasts"] = seed_house.get("chamber_forecasts") or []
    house["markets"] = mkts.get("house")
    house["current"] = seed_house.get("current_composition")
    house["ratings_summary"] = seed_house.get("ratings_summary")
    house["redistricting_notes"] = seed_house.get("redistricting_notes")
    house["provider"] = (nyt_h or {}).get("provider")
    slim = []
    for d in house["districts"]:
        if d["competitive"] or 0.08 < d["prior"]["p_dem"] < 0.92 or ((d["live"] or {}).get("call") != "called" and phase != "pre" and (d["live"] or {}).get("eevp")):
            slim.append(d)
        else:
            slim.append({k: d[k] for k in ("id", "state", "district", "competitive", "prior", "proj", "incumbent_party", "dem", "rep", "ratings")}
                        | {"live": {k: (d["live"] or {}).get(k) for k in ("call", "winner_party", "winner", "eevp", "margin")}})
    house["districts"] = slim

    # Timeseries of headline numbers
    ts = load_json(DATA / "timeseries.json", {"points": []})
    point = {"t": NOW.isoformat(timespec="minutes"),
             "sen_poly": (mkts.get("senate") or {}).get("polymarket_dem"),
             "sen_kalshi": (mkts.get("senate") or {}).get("kalshi_dem"),
             "hou_poly": (mkts.get("house") or {}).get("polymarket_dem"),
             "hou_kalshi": (mkts.get("house") or {}).get("kalshi_dem"),
             "gb": gb_margin, "gb_our": (gb_our or {}).get("margin"),
             "sen_model": senate["summary"]["p_dem_control"],
             "hou_model": house["summary"]["p_dem_control"],
             "gov_model": govs["summary"]["p_dem_control"],
             "sen_exp": senate["summary"]["expected"]["D"],
             "hou_exp": house["summary"]["expected"]["D"],
             "sen_called": senate["summary"]["called"], "hou_called": house["summary"]["called"],
             "swing": senate["swing"].get("swing") if senate["swing"].get("n") else None}
    ts = append_timeseries(ts, point)
    save_json(DATA / "timeseries.json", ts)

    closing = (nyt_s or {}).get("closing") or prev.get("poll_closing") or []
    live = {
        "generated_at": NOW.isoformat(timespec="seconds"),
        "phase": phase,
        "election_day": "2026-11-03",
        "status": STATUS,
        "nyt_updated": {"senate": (nyt_s or {}).get("updated"), "house": (nyt_h or {}).get("updated"),
                        "governor": (nyt_g or {}).get("updated")},
        "poll_closing": closing,
        "senate": senate,
        "house": house,
        "governors": govs,
        "balance_of_power": mkts.get("balance_of_power"),
        "markets_raw": {"polymarket": {k: {kk: vv for kk, vv in v.items() if kk != "markets"} | {"markets": v.get("markets", [])[:12]} for k, v in poly.items() if not k.startswith("hou_")},
                        "kalshi": {k: {kk: vv for kk, vv in v.items() if kk != "markets"} | {"markets": v.get("markets", [])[:12]} for k, v in kalshi.items()}},
        "poll_counts": polls.get("counts"),
        "news": fetch_news(prev.get("news") or {}) if not FAST or NOW.minute % 3 == 0 else (prev.get("news") or {}),
        "seed_as_of": {"senate": seed_senate.get("as_of"), "house": seed_house.get("as_of"), "governors": seed_gov.get("as_of")},
        "method": {
            "sigma_poll": SIGMA_POLL, "sigma_rating_only": SIGMA_RATING_ONLY, "sigma_national": SIGMA_NATIONAL,
            "national_shift": national_shift,
            "note": ("Prior per race = weighted blend of our polling average, published model probabilities, race ratings, "
                     "prediction markets and fundamentals (2024 presidential margin plus the national shift implied by the generic "
                     "ballot, with an incumbency bonus). On election night the prior is blended with the live count, weighted by the "
                     "share of expected vote in, and shifted by the median gap between results and expectations in races that are "
                     "mostly counted. Chamber odds come from 20,000 simulations with a shared national error term. Indicative only.")
        },
    }
    save_json(DATA / "live.json", live)
    ok = sum(1 for s in STATUS.values() if s["ok"])
    log(f"wrote data/live.json ({(DATA / 'live.json').stat().st_size // 1024} KB); sources ok {ok}/{len(STATUS)}")
    for k, v in STATUS.items():
        log(f"  {'OK ' if v['ok'] else 'ERR'} {k}: {v['note']}")
    log(f"senate P(D)={senate['summary']['p_dem_control']} exp={senate['summary']['expected']} | house P(D)={house['summary']['p_dem_control']} exp={house['summary']['expected']} | gov exp={govs['summary']['expected']} | gb={gb_margin} our_gb={(gb_our or {}).get('margin')} shift={national_shift}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
