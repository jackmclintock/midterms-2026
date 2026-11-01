#!/usr/bin/env python3
"""Collect individual polls for the 2026 US Senate, governor and generic-ballot
races from Wikipedia's polling tables and compute this project's own averages.

Standard library only (Python 3.13).  Designed to run unattended inside GitHub
Actions every 30 minutes:

* polite: identifying User-Agent, a small sleep between requests, retries with
  exponential backoff that honour ``Retry-After``;
* robust: every race is wrapped in try/except and failures are recorded in the
  ``status`` block instead of raising; when a race fails and a previous
  ``data/polls.json`` exists, the old entry is kept and flagged ``stale``.

Pages are fetched through the MediaWiki ``action=parse`` API (rendered HTML).
If that endpoint throttles us (HTTP 429) the REST ``page/html`` endpoint is used
as a fallback; both return the same tables.

Usage::

    python3 scripts/polls.py            # writes data/polls.json
    from polls import collect_all       # returns the dict instead
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

UA = "midterms-2026-dashboard/1.0 (github.com/jackmclintock/midterms-2026)"
API_URL = "https://en.wikipedia.org/w/api.php"
REST_URL = "https://en.wikipedia.org/api/rest_v1/page/html/"
WIKI_URL = "https://en.wikipedia.org/wiki/"

SLEEP_BETWEEN_REQUESTS = float(os.environ.get("POLLS_SLEEP", "0.5"))
MAX_ATTEMPTS = int(os.environ.get("POLLS_MAX_ATTEMPTS", "6"))
MAX_RETRY_WAIT = float(os.environ.get("POLLS_MAX_RETRY_WAIT", "60"))
TIME_BUDGET_SECONDS = float(os.environ.get("POLLS_TIME_BUDGET", "1500"))
HTTP_TIMEOUT = 60

WINDOW_DAYS = 21
MIN_POLLS_IN_WINDOW = 3
FALLBACK_LAST_N = 8
RECENCY_TAU = 10.0
SAMPLE_CAP = 1500
SAMPLE_REF = 600
DUPLICATE_POLLSTER_WEIGHT = 0.3
TREND_WEEKS = 12
GENERIC_TREND_START = date(2026, 1, 1)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUTPUT_PATH = os.environ.get("POLLS_OUTPUT") or os.path.join(os.environ.get("DATA_DIR") or os.path.join(REPO_ROOT, "data"), "polls.json")

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
    "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee",
    "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}

# Class 2 seats (33) plus the Ohio and Florida special elections.
SENATE_STATES = [
    "AL", "AK", "AR", "CO", "DE", "GA", "ID", "IL", "IA", "KS", "KY", "LA", "ME", "MA", "MI",
    "MN", "MS", "MT", "NE", "NH", "NJ", "NM", "NC", "OK", "OR", "RI", "SC", "SD", "TN", "TX",
    "VA", "WV", "WY", "OH", "FL",
]
SENATE_SPECIALS = {"OH", "FL"}

GOVERNOR_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "FL", "GA", "HI", "ID", "IL", "IA", "KS", "ME",
    "MD", "MA", "MI", "MN", "NE", "NV", "NH", "NM", "NY", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "VT", "WI", "WY",
]

# Candidate titles for the national generic ballot table, tried in order.
GENERIC_BALLOT_TITLES = [
    "2026 United States elections",
    "Opinion polling for the 2026 United States House of Representatives elections",
    "Nationwide opinion polling for the 2026 United States House of Representatives elections",
    "2026 United States House of Representatives elections",
]

MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3, "april": 4,
    "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7, "august": 8, "aug": 8,
    "september": 9, "sep": 9, "sept": 9, "october": 10, "oct": 10, "november": 11,
    "nov": 11, "december": 12, "dec": 12,
}

PARTY_WORDS = [
    (re.compile(r"^democrat(ic)?s?$", re.I), "D"),
    (re.compile(r"^republicans?$", re.I), "R"),
    (re.compile(r"^independents?$", re.I), "I"),
    (re.compile(r"^libertarians?$", re.I), "L"),
    (re.compile(r"^greens?$", re.I), "G"),
]
PARTY_ABBR = {
    "d": "D", "dem": "D", "democratic": "D", "democrat": "D", "dfl": "D",
    "r": "R", "rep": "R", "gop": "R", "republican": "R",
    "i": "I", "ind": "I", "independent": "I", "np": "I", "npa": "I",
    "l": "L", "lib": "L", "libertarian": "L",
    "g": "G", "green": "G", "gp": "G",
    "wf": "WF", "wfp": "WF", "c": "C", "con": "C", "cp": "C", "fwd": "F", "f": "F",
    "a": "A", "nl": "NL", "pf": "PF", "ap": "AP", "u": "U", "w": "W",
}

VOID_TAGS = {"br", "img", "hr", "input", "wbr", "link", "meta", "area", "base", "col",
             "embed", "param", "source", "track"}

NON_CANDIDATE_HEADERS = ("lead", "margin", "net", "notes", "note", "spread", "difference")

SPONSOR_RE = re.compile(
    r"(?:polls?\s+)?(?:sponsored|commissioned|conducted|paid for|funded|released)\s+"
    r"(?:by|for|on behalf of)\s+(?:the\s+)?(.+?)(?:[,.;]|\s+which\b|\s+who\b|\s+a\s+\w+(?:-aligned|\s+PAC)|$)",
    re.I,
)

_START_TIME = time.monotonic()
_LAST_REQUEST = 0.0


def log(msg: str) -> None:
    print(f"[polls] {msg}", file=sys.stderr, flush=True)


def today_utc() -> date:
    override = os.environ.get("POLLS_TODAY")
    if override:
        try:
            return date.fromisoformat(override)
        except ValueError:
            pass
    return datetime.now(timezone.utc).date()


def budget_exhausted() -> bool:
    return (time.monotonic() - _START_TIME) > TIME_BUDGET_SECONDS


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class FetchError(Exception):
    pass


class PageMissing(FetchError):
    pass


def _polite_pause() -> None:
    global _LAST_REQUEST
    gap = time.monotonic() - _LAST_REQUEST
    if gap < SLEEP_BETWEEN_REQUESTS:
        time.sleep(SLEEP_BETWEEN_REQUESTS - gap)
    _LAST_REQUEST = time.monotonic()


def _http_get(url: str):
    """Return (status, body_text, final_url). Raises urllib errors for non-HTTP failures."""
    _polite_pause()
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
        "Accept-Encoding": "identity",
    })
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, body, resp.geturl(), {}
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        return e.code, body, url, dict(e.headers or {})


def _retry_wait(headers: dict, attempt: int) -> float:
    ra = None
    for k, v in headers.items():
        if k.lower() == "retry-after":
            ra = v
    wait = min(2.0 * (2 ** attempt), MAX_RETRY_WAIT)
    if ra:
        try:
            wait = max(wait, float(ra))
        except ValueError:
            pass
    return min(wait, MAX_RETRY_WAIT)


def fetch_page_html(title: str) -> tuple[str, str, str]:
    """Fetch rendered HTML for a Wikipedia page.

    Returns (html, resolved_title, source_endpoint).  Tries the MediaWiki API
    first and falls back to the REST endpoint when throttled.  Raises
    PageMissing if the page does not exist and FetchError on repeated failure.
    """
    api_url = API_URL + "?" + urllib.parse.urlencode({
        "action": "parse", "page": title, "prop": "text", "format": "json",
        "redirects": 1, "formatversion": 2,
    })
    rest_url = REST_URL + urllib.parse.quote(title.replace(" ", "_"), safe="")
    last_err = "unknown"
    for attempt in range(MAX_ATTEMPTS):
        if attempt and budget_exhausted():
            raise FetchError(f"time budget exhausted while fetching {title!r} ({last_err})")
        endpoints = [("api", api_url), ("rest", rest_url)]
        throttled_headers = None
        for kind, url in endpoints:
            try:
                status, body, final_url, headers = _http_get(url)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_err = f"{kind}: {e!r}"
                continue
            if status == 200:
                if kind == "api":
                    try:
                        data = json.loads(body)
                    except json.JSONDecodeError as e:
                        last_err = f"api: bad json ({e})"
                        continue
                    if "error" in data:
                        code = data["error"].get("code", "")
                        if code in ("missingtitle", "invalidtitle", "nosuchpageid"):
                            raise PageMissing(f"{title}: {code}")
                        last_err = f"api: {code}"
                        continue
                    parse = data.get("parse") or {}
                    text = parse.get("text")
                    if isinstance(text, dict):
                        text = text.get("*")
                    if not text:
                        last_err = "api: empty parse text"
                        continue
                    return text, parse.get("title") or title, "api"
                resolved = urllib.parse.unquote(final_url.rsplit("/", 1)[-1]).replace("_", " ")
                return body, resolved or title, "rest"
            if status == 404:
                if kind == "rest":
                    raise PageMissing(f"{title}: 404")
                last_err = "api: 404"
                continue
            if status == 429 or status >= 500:
                last_err = f"{kind}: HTTP {status}"
                throttled_headers = headers
                continue
            last_err = f"{kind}: HTTP {status}"
        wait = _retry_wait(throttled_headers or {}, attempt)
        log(f"retry {attempt + 1}/{MAX_ATTEMPTS} for {title!r} after {last_err}; sleeping {wait:.0f}s")
        time.sleep(wait)
    raise FetchError(f"failed to fetch {title!r}: {last_err}")


# --------------------------------------------------------------------------- #
# HTML parsing
# --------------------------------------------------------------------------- #

class WikiTableParser(HTMLParser):
    """Walk rendered MediaWiki HTML, collecting ``wikitable`` tables with their
    section headings, plus the footnote list (for sponsors and source URLs)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[dict] = []
        self.notes: dict[str, dict] = {}
        self._headings: dict[int, str] = {}
        self._heading_level: int | None = None
        self._heading_buf: list[str] = []
        self._table_stack: list[dict | None] = []
        self._row: list[dict] | None = None
        self._cell: dict | None = None
        self._skip: list[str] = []          # stack of tag names whose content is skipped
        self._skip_sup_refs = False
        self._note: dict | None = None
        self._note_depth = 0
        self._order = 0

    # -- helpers -----------------------------------------------------------
    @property
    def _table(self) -> dict | None:
        return self._table_stack[-1] if self._table_stack else None

    def _close_cell(self) -> None:
        if self._cell is not None and self._row is not None:
            self._row.append(self._cell)
        self._cell = None

    def _close_row(self) -> None:
        self._close_cell()
        if self._row is not None and self._table is not None:
            if self._row:
                self._table["rows"].append(self._row)
        self._row = None

    # -- tag handlers ------------------------------------------------------
    def handle_startendtag(self, tag, attrs):  # <br/> etc: treat as start only
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class") or ""
        if self._skip:
            if tag == "a" and self._cell is not None and self._skip_sup_refs:
                href = a.get("href") or ""
                if "#cite_note-" in href or "#cite_note" in href:
                    self._cell["refs"].append(href.split("#", 1)[1])
            if tag not in VOID_TAGS:
                self._skip.append(tag)
            return
        if tag in ("style", "script"):
            self._skip.append(tag)
            return
        if tag == "sup" and ("reference" in cls or "mw-ref" in cls):
            self._skip.append(tag)
            self._skip_sup_refs = True
            return
        if tag == "span" and "display:none" in (a.get("style") or "").replace(" ", ""):
            self._skip.append(tag)
            return
        if tag in ("h2", "h3", "h4"):
            self._heading_level = int(tag[1])
            self._heading_buf = []
            return
        if tag == "table":
            if "wikitable" in cls.split():
                self._close_row()
                self._table_stack.append({
                    "rows": [], "order": self._order, "class": cls,
                    "section": [self._headings.get(2, ""), self._headings.get(3, ""), self._headings.get(4, "")],
                })
                self._order += 1
            else:
                self._table_stack.append(None)
            return
        if self._table is not None:
            if tag == "tr":
                self._close_row()
                self._row = []
                return
            if tag in ("td", "th"):
                self._close_cell()
                if self._row is None:
                    self._row = []
                self._cell = {
                    "text": [], "header": tag == "th", "refs": [],
                    "rowspan": _int_attr(a.get("rowspan")), "colspan": _int_attr(a.get("colspan")),
                }
                return
            if tag == "br" and self._cell is not None:
                self._cell["text"].append("\n")
                return
            if tag == "a" and self._cell is not None:
                href = a.get("href") or ""
                if "#cite_note" in href:
                    self._cell["refs"].append(href.split("#", 1)[1])
            return
        if tag == "li":
            nid = a.get("id") or ""
            if nid.startswith("cite_note") and self._note is None:
                self._note = {"id": nid, "text": [], "url": None}
                self._note_depth = 1
                return
            if self._note is not None:
                self._note_depth += 1
            return
        if self._note is not None and tag == "a":
            href = a.get("href") or ""
            if href.startswith("http") and self._note["url"] is None:
                self._note["url"] = href
        if self._note is not None and tag == "br":
            self._note["text"].append(" ")

    def handle_endtag(self, tag):
        if self._skip:
            if tag == self._skip[-1]:
                self._skip.pop()
                if not self._skip:
                    self._skip_sup_refs = False
            elif tag in self._skip:
                while self._skip and self._skip[-1] != tag:
                    self._skip.pop()
                if self._skip:
                    self._skip.pop()
                if not self._skip:
                    self._skip_sup_refs = False
            return
        if tag in ("h2", "h3", "h4") and self._heading_level is not None:
            level = self._heading_level
            text = _clean_ws("".join(self._heading_buf))
            self._headings[level] = text
            for deeper in range(level + 1, 7):
                self._headings.pop(deeper, None)
            self._heading_level = None
            return
        if tag == "table":
            if self._table_stack:
                self._close_row()
                t = self._table_stack.pop()
                if t is not None and t["rows"]:
                    self.tables.append(t)
            return
        if self._table is not None:
            if tag in ("td", "th"):
                self._close_cell()
            elif tag == "tr":
                self._close_row()
            return
        if tag == "li" and self._note is not None:
            self._note_depth -= 1
            if self._note_depth <= 0:
                txt = _clean_ws("".join(self._note["text"]))
                self.notes[self._note["id"]] = {"text": txt, "url": self._note["url"]}
                self._note = None

    def handle_data(self, data):
        if self._skip:
            return
        if self._heading_level is not None:
            self._heading_buf.append(data)
        elif self._cell is not None:
            self._cell["text"].append(data)
        elif self._note is not None:
            self._note["text"].append(data)


def _int_attr(v) -> int:
    try:
        n = int(str(v).strip())
        return n if n > 0 else 1
    except (TypeError, ValueError):
        return 1


def _clean_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def cell_text(cell: dict | None) -> str:
    """Multi-line cell text (lines separated by '\\n'), whitespace-normalised."""
    if cell is None:
        return ""
    raw = "".join(cell["text"]).replace("\xa0", " ")
    lines = [re.sub(r"[ \t\r\f\v]+", " ", ln).strip() for ln in raw.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def expand_grid(rows: list[list[dict]]) -> list[list[dict]]:
    """Resolve rowspan/colspan into a rectangular grid of
    {"cell": cell, "inherited": bool} entries (None where empty)."""
    grid: list[list] = []
    pending: dict[int, list] = {}  # col -> [cell, remaining_rows]
    for row in rows:
        out: list = []
        col = 0
        cells = iter(row)
        cell = next(cells, None)
        while cell is not None or any(c >= col for c in pending):
            if col in pending:
                pc, remaining = pending[col]
                out.append({"cell": pc, "inherited": True})
                remaining -= 1
                if remaining <= 0:
                    del pending[col]
                else:
                    pending[col][1] = remaining
                col += 1
                continue
            if cell is None:
                if any(c > col for c in pending):
                    out.append(None)
                    col += 1
                    continue
                break
            for k in range(cell["colspan"]):
                c = col + k
                out.append({"cell": cell, "inherited": k > 0})
                if cell["rowspan"] > 1:
                    pending[c] = [cell, cell["rowspan"] - 1]
            col += cell["colspan"]
            cell = next(cells, None)
        grid.append(out)
    return grid


# --------------------------------------------------------------------------- #
# Field parsers
# --------------------------------------------------------------------------- #

DASHES = "–—‒―−-"
_DASH_RE = re.compile("[" + re.escape(DASHES) + "]")
_DATE_PART_RE = re.compile(r"([A-Za-z]+)?\.?\s*(\d{1,2})?(?:st|nd|rd|th)?,?\s*(\d{4})?")


def _parse_date_part(s: str):
    s = s.strip().strip(",").strip()
    month = day = year = None
    for tok in re.findall(r"[A-Za-z]+|\d+", s):
        if tok.isdigit():
            n = int(tok)
            if len(tok) == 4 and n > 1900:
                year = n
            elif day is None and 1 <= n <= 31:
                day = n
        else:
            m = MONTHS.get(tok.lower().rstrip("."))
            if m and month is None:
                month = m
    return month, day, year


def parse_date_range(text: str):
    """'October 20–22, 2026' -> ('2026-10-20', '2026-10-22').  Returns (None, None)
    when no usable date is present."""
    if not text:
        return None, None
    t = _DASH_RE.sub("-", text.replace("\n", " ").replace("\xa0", " "))
    t = re.sub(r"\s*-\s*", "-", t)
    t = re.sub(r"\s+", " ", t).strip()
    if not re.search(r"\d{4}", t):
        return None, None
    parts = t.split("-", 1) if "-" in t else [t, t]
    m1, d1, y1 = _parse_date_part(parts[0])
    m2, d2, y2 = _parse_date_part(parts[1])
    if m2 is None:
        m2 = m1
    if m1 is None:
        m1 = m2
    if y2 is None:
        y2 = y1
    if y1 is None:
        y1 = y2
    if d2 is None:
        d2 = d1
    if d1 is None:
        d1 = d2
    if y1 is None and y2 is None:
        return None, None
    if m1 and d1 and y1 and m2 is None:
        m2, d2, y2 = m1, d1, y1
    try:
        start = date(y1, m1, d1) if (y1 and m1 and d1) else None
        end = date(y2, m2, d2) if (y2 and m2 and d2) else None
    except ValueError:
        return None, None
    if start and end and end < start:
        if y1 == y2 and m2 < m1:
            # "December 30 – January 2, 2026": start belongs to the previous year
            try:
                start = date(y1 - 1, m1, d1)
            except ValueError:
                return None, None
        else:
            start, end = end, start
    return (start.isoformat() if start else None), (end.isoformat() if end else None)


def parse_sample(text: str):
    """'1,000 (LV)' -> (1000, 'LV'); '— (RV)' -> (None, 'RV'); '(LV)' -> (None, 'LV')."""
    t = text.replace("\n", " ")
    n = None
    m = re.search(r"(\d[\d,]*)", t)
    if m:
        try:
            n = int(m.group(1).replace(",", ""))
        except ValueError:
            n = None
    pop = None
    m = re.search(r"\(([A-Za-z]{1,3})\)", t)
    if m:
        pop = m.group(1).upper()
    return n, pop


def parse_moe(text: str):
    m = re.search(r"(\d+(?:\.\d+)?)\s*%?", text.replace("\n", " "))
    return float(m.group(1)) if m else None


def parse_pct(text: str):
    """'47%' -> 47.0, '<1%' -> 0.5, '—' -> None, '3% U' -> 3.0."""
    if not text:
        return None
    t = text.replace("\n", " ").strip()
    if re.fullmatch(r"[\s" + re.escape(DASHES) + r"?–—-]*", t):
        return None
    m = re.search(r"(<|≤|>)?\s*(\d+(?:\.\d+)?)\s*%?", t)
    if not m:
        return None
    v = float(m.group(2))
    if m.group(1) in ("<", "≤") and v <= 1:
        return 0.5
    return v


def parse_candidate_header(text: str):
    """'Jon\\nOssoff (D)' -> ('Jon Ossoff', 'D'); 'Democratic' -> ('Democratic', 'D');
    'Generic\\nRepublican' -> ('Generic Republican', 'R'); 'Dan\\nOsborn' -> ('Dan Osborn', None)."""
    name = _clean_ws(text.replace("\n", " "))
    name = re.sub(r"\[[^\]]*\]", "", name).strip()
    party = None
    m = re.match(r"^(.*?)\s*\(([^()]{1,24})\)\s*$", name)
    if m:
        name, p = m.group(1).strip(), m.group(2).strip()
        key = p.lower().replace(".", "").strip()
        party = PARTY_ABBR.get(key)
        if party is None:
            for rx, code in PARTY_WORDS:
                if rx.match(key):
                    party = code
            if party is None:
                party = p.upper()[:4]
    else:
        for rx, code in PARTY_WORDS:
            if rx.match(name):
                party = code
        if party is None:
            m2 = re.match(r"^generic\s+(\w+)$", name, re.I)
            if m2:
                for rx, code in PARTY_WORDS:
                    if rx.match(m2.group(1)):
                        party = code
    return name, party


def pollster_key(name: str) -> str:
    k = re.sub(r"\([^)]*\)", "", name or "")
    k = re.sub(r"[^a-z0-9]+", "", k.lower())
    return k


def pollster_lean(name: str):
    m = re.search(r"\((D|R)\)", name or "")
    return m.group(1) if m else None


NOTE_PREFIX_RE = re.compile(r"^(?:[\^\u2191]\s*)?(?:jump up to:?\s*)?(?:(?:[a-z]{1,2}|\d{1,3})\s+)*(?=[A-Z\"])")
SPONSOR_NOTE_RE = re.compile(
    r"^(?:this\s+)?poll(?:s|ing)?\s+(?:was\s+|were\s+)?(?:sponsored|commissioned|conducted|paid for|funded|released)\b"
    r"|^(?:sponsored|commissioned|conducted)\s+(?:by|for)\b", re.I)


def extract_sponsor(refs: list[str], notes: dict) -> str | None:
    """Sponsor from an explanatory footnote such as 'Poll sponsored by X, which
    supports Y'.  Ordinary citations are ignored."""
    for r in refs:
        note = notes.get(r)
        if not note:
            continue
        text = NOTE_PREFIX_RE.sub("", note["text"]).strip()
        if not SPONSOR_NOTE_RE.match(text):
            continue
        m = SPONSOR_RE.search(text)
        if m:
            s = m.group(1).strip().rstrip(".,;")
            s = re.sub(r"^(?:Poll|the)\s+", "", s)
            if 2 <= len(s) <= 120:
                return s
    return None


def extract_source_url(refs: list[str], notes: dict) -> str | None:
    for r in refs:
        note = notes.get(r)
        if note and note.get("url"):
            return note["url"]
    return None


# --------------------------------------------------------------------------- #
# Poll table interpretation
# --------------------------------------------------------------------------- #

def classify_table(table: dict, notes: dict) -> dict | None:
    """Return a description of a poll table (columns, candidates, rows) or None
    if it is not an individual-polls table."""
    grid = expand_grid(table["rows"])
    if not grid:
        return None
    header_rows = []
    for row in grid:
        cells = [c for c in row if c]
        if cells and all(c["cell"]["header"] for c in cells):
            header_rows.append(row)
        else:
            break
    if not header_rows:
        return None
    ncols = max(len(r) for r in header_rows)
    headers = []
    for ci in range(ncols):
        parts = []
        for hr in header_rows:
            if ci < len(hr) and hr[ci] and not hr[ci]["inherited"]:
                parts.append(cell_text(hr[ci]["cell"]))
            elif ci < len(hr) and hr[ci] and hr[ci]["inherited"] and hr[ci]["cell"]["rowspan"] == 1:
                # colspan-inherited header (grouping label); keep it once only
                pass
        headers.append("\n".join(p for p in parts if p))
    low = [h.lower().replace("\n", " ") for h in headers]
    joined = " | ".join(low)
    if not (("poll source" in joined or "pollster" in joined or "poll" in low[0:1]) and "sample" in joined
            and "margin" in joined and "error" in joined):
        return None

    cols = {"pollster": None, "dates": None, "sample": None, "moe": None, "round": None,
            "sponsor": None, "other": None, "und": None}
    candidates = []  # (col_index, name, party)
    for i, h in enumerate(low):
        if not h:
            continue
        if cols["pollster"] is None and ("poll source" in h or "pollster" in h or h.startswith("poll")):
            cols["pollster"] = i
        elif cols["dates"] is None and "date" in h:
            cols["dates"] = i
        elif cols["sample"] is None and "sample" in h:
            cols["sample"] = i
        elif cols["moe"] is None and "margin" in h and "error" in h:
            cols["moe"] = i
        elif cols["round"] is None and re.fullmatch(r"(rcv\s*)?rounds?(\s*#)?|round\s*\d*|rcv", h):
            cols["round"] = i
        elif cols["sponsor"] is None and "sponsor" in h:
            cols["sponsor"] = i
        elif "undecided" in h or "not ranked" in h or "don't know" in h or "unsure" in h or "no opinion" in h:
            if cols["und"] is None:
                cols["und"] = i
        elif h == "other" or h.startswith("other") or h == "others" or "someone else" in h or "other candidate" in h:
            if "other" in h and cols["other"] is None and "undecided" not in h:
                cols["other"] = i
            elif cols["und"] is None:
                cols["und"] = i
        elif any(h == w or h.startswith(w + " ") for w in NON_CANDIDATE_HEADERS):
            continue
        else:
            name, party = parse_candidate_header(headers[i])
            if name:
                candidates.append((i, name, party))
    if cols["pollster"] is None or cols["dates"] is None or not candidates:
        return None

    polls = []
    prev = None
    for row in grid[len(header_rows):]:
        p = _parse_row(row, cols, candidates, notes, prev)
        if p is None:
            continue
        polls.append(p)
        prev = (row, p)

    return {
        "order": table["order"],
        "section": table["section"],
        "candidates": [{"name": n, "party": pty} for _, n, pty in candidates],
        "is_rcv": cols["round"] is not None,
        "polls": polls,
    }


def _cell_at(row, i):
    if i is None or i >= len(row) or row[i] is None:
        return None
    return row[i]


def _parse_row(row, cols, candidates, notes, prev):
    pc = _cell_at(row, cols["pollster"])
    dc = _cell_at(row, cols["dates"])
    if pc is None or dc is None:
        return None
    if pc["cell"]["header"] and all((c is None or c["cell"]["header"]) for c in row):
        return None
    pollster_text = cell_text(pc["cell"])
    if not pollster_text:
        return None
    low = pollster_text.lower()
    if "average" in low or "aggregate" in low or low.startswith("source of poll"):
        return None
    # join multi-line pollster cells: "Beacon Research (D)/" + "Shaw & Co. Research (R)"
    lines = pollster_text.split("\n")
    pollster = ""
    for ln in lines:
        if pollster and not pollster.endswith("/") and not ln.startswith("/"):
            pollster += " "
        pollster += ln
    pollster = _clean_ws(pollster).replace(" /", "/").replace("/ ", "/")

    dates_text = cell_text(dc["cell"])
    start, end = parse_date_range(dates_text)
    if end is None:
        return None

    values = {}
    any_val = False
    for i, name, _party in candidates:
        c = _cell_at(row, i)
        v = parse_pct(cell_text(c["cell"])) if c else None
        if v is not None:
            any_val = True
        values[name] = v
    if not any_val:
        return None

    sc = _cell_at(row, cols["sample"])
    n, pop = parse_sample(cell_text(sc["cell"])) if sc else (None, None)
    mc = _cell_at(row, cols["moe"])
    moe = parse_moe(cell_text(mc["cell"])) if mc else None
    oc = _cell_at(row, cols["other"])
    other = parse_pct(cell_text(oc["cell"])) if oc else None
    uc = _cell_at(row, cols["und"])
    und = parse_pct(cell_text(uc["cell"])) if uc else None
    rnd = None
    if cols["round"] is not None:
        rc = _cell_at(row, cols["round"])
        rnd = _clean_ws(cell_text(rc["cell"]).replace("\n", " ")) if rc else ""
        rnd = re.sub(r"\[.*?\]", "", rnd).strip()
        if rnd not in ("", "1", "BA", "ba", "First", "first", "First round", "Round 1"):
            return None  # later RCV rounds are not comparable first-choice shares
    refs = list(pc["cell"]["refs"])
    sponsor = None
    if cols["sponsor"] is not None:
        spc = _cell_at(row, cols["sponsor"])
        sponsor = _clean_ws(cell_text(spc["cell"]).replace("\n", " ")) if spc else None
        if sponsor in ("", "—", "–", "-"):
            sponsor = None
    if sponsor is None:
        sponsor = extract_sponsor(refs, notes)
    url = extract_source_url(refs, notes)

    # Variant rows: same poll, alternative question wording / with leaners.
    variant = False
    if prev is not None:
        prow, pp = prev
        if pc["inherited"] and dc["inherited"] and pp["pollster"] == pollster and pp["end"] == end:
            same_sample = (sc is None) or sc["inherited"] or (pp["n"] == n and pp["pop"] == pop)
            if same_sample or (rnd is not None and pp.get("round") not in (None, rnd)):
                variant = True

    rec = {
        "pollster": pollster,
        "lean": pollster_lean(pollster),
        "sponsor": sponsor,
        "start": start,
        "end": end,
        "n": n,
        "pop": pop,
        "moe": moe,
        "values": values,
        "other": other,
        "und": und,
        "url": url,
        "variant": variant,
    }
    if rnd is not None:
        rec["round"] = rnd or None
    return rec


def is_primary_section(section: list[str]) -> bool:
    s = " ".join(section).lower()
    return any(w in s for w in ("primary", "primaries", "convention", "caucus", "runoff", "nominating"))


def is_hypothetical_section(section: list[str]) -> bool:
    return "hypothetical" in " ".join(section).lower()


def choose_main_tables(tables: list[dict]) -> list[dict]:
    """Pick the general-election matchup table(s) among parsed poll tables."""
    if not tables:
        return []
    general = [t for t in tables if "general election" in (t["section"][0] or "").lower()]
    if not general:
        general = [t for t in tables if not is_primary_section(t["section"])]
    if not general:
        return []  # only primary/convention polling on the page
    with_polls = [t for t in general if t["polls"]] or general

    def latest(t):
        ends = [p["end"] for p in t["polls"] if not p.get("variant")]
        return max(ends) if ends else ""

    def score(t):
        names = [c["name"].lower() for c in t["candidates"]]
        generic = all("generic" in n or n in ("democratic", "republican", "someone else") for n in names)
        return (
            0 if is_hypothetical_section(t["section"]) else 1,
            0 if generic else 1,
            latest(t),
            0 if t["is_rcv"] else 1,
            len(t["polls"]),
            -t["order"],
        )

    main = max(with_polls, key=score)
    key = frozenset(c["name"] for c in main["candidates"])
    chosen = [t for t in with_polls if frozenset(c["name"] for c in t["candidates"]) == key
              and t["is_rcv"] == main["is_rcv"]]
    return chosen or [main]


# --------------------------------------------------------------------------- #
# Averaging
# --------------------------------------------------------------------------- #

def pick_main_candidates(candidates: list[dict], polls: list[dict]):
    """Return (a, b): a = Democrat (or main non-R challenger), b = Republican (or
    main remaining opponent).  Each is a candidate dict or None."""
    recent = sorted([p for p in polls if not p.get("variant")], key=lambda p: p["end"], reverse=True)[:8]

    def strength(c):
        vals = [p["values"].get(c["name"]) for p in recent]
        vals = [v for v in vals if v is not None]
        return (sum(vals) / len(vals)) if vals else -1.0

    real = [c for c in candidates if "generic" not in c["name"].lower()
            and c["name"].lower() != "someone else"] or list(candidates)
    non_r = [c for c in real if c["party"] != "R"]
    # The Democrat is normally the strongest non-Republican; where an independent
    # is the real challenger (NE, MT, ID, SD) the independent wins this contest.
    a = max(non_r, key=strength) if non_r else None
    # The opponent is the strongest remaining candidate: normally the Republican,
    # but e.g. an independent when the Republican is a distant third (RI governor).
    rest = [c for c in real if c is not a]
    b = max(rest, key=strength) if rest else None
    return a, b


def _weights(polls_used: list[dict], today: date) -> list[float]:
    # most recent poll per pollster gets full weight, older ones 0.3
    seen = set()
    order = sorted(range(len(polls_used)), key=lambda i: (polls_used[i]["end"], polls_used[i].get("pop") == "LV",
                                                           polls_used[i].get("pop") == "RV"), reverse=True)
    dedupe = [1.0] * len(polls_used)
    for i in order:
        k = pollster_key(polls_used[i]["pollster"])
        if k in seen:
            dedupe[i] = DUPLICATE_POLLSTER_WEIGHT
        seen.add(k)
    out = []
    for i, p in enumerate(polls_used):
        days = (today - date.fromisoformat(p["end"])).days
        recency = math.exp(-max(days, 0) / RECENCY_TAU)
        n = p.get("n")
        sample = math.sqrt(min(n, SAMPLE_CAP) / SAMPLE_REF) if n else 1.0
        out.append(recency * sample * dedupe[i])
    return out


def compute_average(polls: list[dict], a: dict | None, b: dict | None, today: date,
                    candidates: list[dict] | None = None) -> dict | None:
    if a is None or b is None:
        return None
    usable = [p for p in polls if not p.get("variant") and p["values"].get(a["name"]) is not None
              and p["values"].get(b["name"]) is not None]
    if not usable:
        return None
    usable.sort(key=lambda p: p["end"], reverse=True)
    cutoff = (today - timedelta(days=WINDOW_DAYS)).isoformat()
    window = [p for p in usable if p["end"] >= cutoff]
    method = f"last {WINDOW_DAYS} days"
    if len(window) < MIN_POLLS_IN_WINDOW:
        window = usable[:FALLBACK_LAST_N]
        method = f"fewer than {MIN_POLLS_IN_WINDOW} polls in {WINDOW_DAYS} days; last {len(window)} polls"
    weights = _weights(window, today)
    wsum = sum(weights) or 1.0
    va = sum(w * p["values"][a["name"]] for w, p in zip(weights, window)) / wsum
    vb = sum(w * p["values"][b["name"]] for w, p in zip(weights, window)) / wsum
    oldest = min(p["end"] for p in window)
    window_days = WINDOW_DAYS if method.startswith("last") else max(WINDOW_DAYS, (today - date.fromisoformat(oldest)).days)
    # weighted share for every candidate column (over the polls that include them)
    shares = {}
    for name in window[0]["values"]:
        num = den = 0.0
        for w, p in zip(weights, window):
            v = p["values"].get(name)
            if v is not None:
                num += w * v
                den += w
        if den > 0:
            shares[name] = round(num / den, 1)
    avg = {
        "margin": round(va - vb, 1),
        "n_polls": len(window),
        "window_days": window_days,
        "method": method,
        "latest_poll": window[0]["end"],
        "weights": {
            "recency": f"exp(-days_since_end/{RECENCY_TAU:g})",
            "sample": f"sqrt(min(n,{SAMPLE_CAP})/{SAMPLE_REF})",
            "pollster_dedupe": DUPLICATE_POLLSTER_WEIGHT,
        },
        "polls_used": [
            {"pollster": p["pollster"], "end": p["end"], "n": p.get("n"), "weight": round(w / wsum, 3),
             a["name"]: p["values"][a["name"]], b["name"]: p["values"][b["name"]]}
            for w, p in zip(weights, window)
        ],
    }
    if a["party"] == "D":
        avg["dem"] = round(va, 1)
    else:
        avg["ind"] = round(va, 1)
        avg["main_challenger"] = a["party"] or "I"
        avg["ind_name"] = a["name"]
        if candidates:
            dem = next((c for c in candidates if c["party"] == "D" and c["name"] in shares), None)
            if dem is not None:
                avg["dem"] = shares[dem["name"]]  # informational: the Democrat is not the main challenger
                avg["dem_name"] = dem["name"]
    if b["party"] == "R":
        avg["rep"] = round(vb, 1)
    else:
        avg["opp"] = round(vb, 1)
        avg["opp_party"] = b["party"] or "I"
        avg["opp_name"] = b["name"]
        if candidates:
            rep = next((c for c in candidates if c["party"] == "R" and c["name"] in shares), None)
            if rep is not None:
                avg["rep"] = shares[rep["name"]]  # informational: the Republican is not the main opponent
                avg["rep_name"] = rep["name"]
    avg["candidates"] = shares
    return avg


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def compute_trend(polls: list[dict], a: dict | None, b: dict | None, today: date,
                  weeks: int | None = TREND_WEEKS, since: date | None = None) -> list[dict]:
    if a is None or b is None:
        return []
    buckets: dict[str, list[float]] = {}
    floor = None
    if weeks is not None:
        floor = week_start(today) - timedelta(weeks=weeks - 1)
    if since is not None:
        floor = week_start(since) if floor is None else min(floor, week_start(since))
    for p in polls:
        if p.get("variant"):
            continue
        va, vb = p["values"].get(a["name"]), p["values"].get(b["name"])
        if va is None or vb is None:
            continue
        d = date.fromisoformat(p["end"])
        if floor is not None and d < floor:
            continue
        wk = week_start(d).isoformat()
        buckets.setdefault(wk, []).append(va - vb)
    return [{"week": wk, "margin": round(sum(v) / len(v), 1), "n": len(v)}
            for wk, v in sorted(buckets.items())]


# --------------------------------------------------------------------------- #
# Race assembly
# --------------------------------------------------------------------------- #

def flatten_poll(p: dict, a: dict | None, b: dict | None) -> dict:
    out = {
        "pollster": p["pollster"], "lean": p.get("lean"), "sponsor": p.get("sponsor"),
        "start": p["start"], "end": p["end"], "n": p.get("n"), "pop": p.get("pop"), "moe": p.get("moe"),
    }
    if a is not None:
        out["dem" if a["party"] == "D" else "ind"] = p["values"].get(a["name"])
    if b is not None:
        out["rep" if b["party"] == "R" else "opp"] = p["values"].get(b["name"])
    out["other"] = p.get("other")
    out["und"] = p.get("und")
    out["results"] = p["values"]
    out["url"] = p.get("url")
    if p.get("variant"):
        out["variant"] = True
    if p.get("round"):
        out["round"] = p["round"]
    return out


def parse_page_tables(html_text: str) -> tuple[list[dict], dict]:
    parser = WikiTableParser()
    parser.feed(html_text)
    parser.close()
    tables = []
    for t in parser.tables:
        try:
            info = classify_table(t, parser.notes)
        except Exception as e:  # defensive: one broken table must not sink the page
            log(f"table {t['order']} skipped: {e!r}")
            continue
        if info is not None:
            tables.append(info)
    return tables, parser.notes


def collect_race(title_candidates: list[str], today: date) -> dict:
    last_exc: Exception | None = None
    html_text = resolved = source = None
    for title in title_candidates:
        try:
            html_text, resolved, source = fetch_page_html(title)
            break
        except PageMissing as e:
            last_exc = e
            continue
    if html_text is None:
        raise last_exc or FetchError("no page found")

    tables, _notes = parse_page_tables(html_text)
    main_tables = choose_main_tables(tables)
    polls: list[dict] = []
    candidates: list[dict] = []
    seen = set()
    for t in main_tables:
        for c in t["candidates"]:
            if c["name"] not in seen:
                seen.add(c["name"])
                candidates.append(c)
        polls.extend(t["polls"])
    # de-duplicate identical rows that appear in several tables
    uniq = {}
    for p in polls:
        k = (p["pollster"], p["start"], p["end"], p.get("n"), p.get("pop"), json.dumps(p["values"], sort_keys=True))
        uniq.setdefault(k, p)
    polls = sorted(uniq.values(), key=lambda p: (p["end"], p["start"] or ""), reverse=True)

    a, b = pick_main_candidates(candidates, polls)
    avg = compute_average(polls, a, b, today, candidates)
    trend = compute_trend(polls, a, b, today)
    return {
        "page": resolved,
        "url": WIKI_URL + urllib.parse.quote((resolved or title_candidates[0]).replace(" ", "_")),
        "fetched_via": source,
        "candidates": candidates,
        "main": {"a": a["name"] if a else None, "b": b["name"] if b else None},
        "avg": avg,
        "trend": trend,
        "n_polls": len([p for p in polls if not p.get("variant")]),
        "n_tables_on_page": len(tables),
        "polls": [flatten_poll(p, a, b) for p in polls],
    }


def collect_generic_ballot(today: date) -> dict:
    last_exc: Exception | None = None
    for title in GENERIC_BALLOT_TITLES:
        try:
            html_text, resolved, source = fetch_page_html(title)
        except PageMissing as e:
            last_exc = e
            continue
        tables, _ = parse_page_tables(html_text)
        gb = []
        for t in tables:
            parties = {c["party"] for c in t["candidates"]}
            names = [c["name"].lower() for c in t["candidates"]]
            if "D" in parties and "R" in parties and all(
                    n in ("democratic", "democrat", "democrats", "republican", "republicans")
                    or "generic" in n for n in names) and not is_primary_section(t["section"]):
                gb.append(t)
        if not gb:
            last_exc = FetchError(f"no generic ballot table on {resolved!r}")
            continue
        a = b = None
        polls = []
        for t in gb:
            for c in t["candidates"]:
                if c["party"] == "D" and a is None:
                    a = c
                if c["party"] == "R" and b is None:
                    b = c
            for p in t["polls"]:
                # normalise candidate keys across tables ("Democratic" vs "Democrats")
                vals = {}
                for c in t["candidates"]:
                    v = p["values"].get(c["name"])
                    if c["party"] == "D":
                        vals[a["name"]] = v
                    elif c["party"] == "R":
                        vals[b["name"]] = v
                    else:
                        vals[c["name"]] = v
                p = dict(p, values=vals)
                polls.append(p)
        uniq = {}
        for p in polls:
            k = (p["pollster"], p["start"], p["end"], p.get("n"), p.get("pop"), json.dumps(p["values"], sort_keys=True))
            uniq.setdefault(k, p)
        polls = sorted(uniq.values(), key=lambda p: (p["end"], p["start"] or ""), reverse=True)
        polls_2026 = [p for p in polls if p["end"] >= "2026-01-01"]
        avg = compute_average(polls, a, b, today)
        trend = compute_trend(polls, a, b, today, weeks=None, since=GENERIC_TREND_START)
        return {
            "page": resolved,
            "url": WIKI_URL + urllib.parse.quote(resolved.replace(" ", "_")),
            "fetched_via": source,
            "avg": avg,
            "trend": trend,
            "n_polls": len([p for p in polls_2026 if not p.get("variant")]),
            "n_polls_all": len(polls),
            "polls": [flatten_poll(p, a, b) for p in polls_2026],
        }
    raise last_exc or FetchError("generic ballot page not found")


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #

def senate_titles(postal: str) -> list[str]:
    state = STATE_NAMES[postal]
    regular = f"2026 United States Senate election in {state}"
    special = f"2026 United States Senate special election in {state}"
    return [special, regular] if postal in SENATE_SPECIALS else [regular, special]


def governor_titles(postal: str) -> list[str]:
    return [f"2026 {STATE_NAMES[postal]} gubernatorial election"]


def load_previous(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            prev = json.load(fh)
        return prev if isinstance(prev, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _run_one(label: str, fn, status: dict, previous_entry):
    """Run one collector; record status; fall back to the previous entry on failure."""
    if budget_exhausted():
        err = f"skipped: time budget of {TIME_BUDGET_SECONDS:.0f}s exhausted"
        status[label] = {"ok": False, "error": err, "stale": previous_entry is not None}
        log(f"{label}: {err}")
        return _stale(previous_entry, err)
    t0 = time.monotonic()
    try:
        result = fn()
        n = result.get("n_polls", 0)
        status[label] = {"ok": True, "n_polls": n, "page": result.get("page"),
                         "seconds": round(time.monotonic() - t0, 1)}
        if n == 0:
            status[label]["warning"] = "no general-election polls parsed"
        log(f"{label}: ok, {n} polls ({result.get('page')})")
        return result
    except Exception as e:  # noqa: BLE001 - never crash the caller
        err = f"{type(e).__name__}: {e}"
        status[label] = {"ok": False, "error": err[:500], "stale": previous_entry is not None,
                         "seconds": round(time.monotonic() - t0, 1)}
        log(f"{label}: FAILED {err}")
        return _stale(previous_entry, err)


def _stale(previous_entry, err):
    if previous_entry is None:
        return None
    entry = dict(previous_entry)
    entry["stale"] = True
    entry["stale_error"] = err[:500]
    return entry


def collect_all(previous: dict | None = None, today: date | None = None) -> dict:
    today = today or today_utc()
    previous = previous if previous is not None else load_previous(OUTPUT_PATH)
    prev_senate = previous.get("senate") or {}
    prev_gov = previous.get("governors") or {}
    status: dict = {}
    out = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "as_of_date": today.isoformat(),
        "source": "Wikipedia polling tables (aggregated by this project)",
        "method": {
            "window_days": WINDOW_DAYS,
            "min_polls_in_window": MIN_POLLS_IN_WINDOW,
            "fallback_last_n": FALLBACK_LAST_N,
            "weight": "exp(-days_since_end/10) * sqrt(min(n,1500)/600) * (1.0 for a pollster's most recent poll, 0.3 for its older ones)",
            "trend": "simple mean of poll margins per ISO week (Monday start)",
        },
        "generic_ballot": None,
        "senate": {},
        "governors": {},
        "status": status,
    }

    out["generic_ballot"] = _run_one("generic-ballot", lambda: collect_generic_ballot(today), status,
                                     previous.get("generic_ballot"))

    # Rotate the order each hour so a run that hits its time budget leaves different races stale each time,
    # and alternate which chamber goes first.
    sen_order, gov_order = list(SENATE_STATES), list(GOVERNOR_STATES)
    hour = datetime.now(timezone.utc).hour
    if os.environ.get("POLLS_ROTATE"):
        sen_order = sen_order[hour % len(sen_order):] + sen_order[:hour % len(sen_order)]
        gov_order = gov_order[hour % len(gov_order):] + gov_order[:hour % len(gov_order)]

    def run_senate():
        for postal in sen_order:
            res = _run_one(f"{postal}-senate", lambda p=postal: collect_race(senate_titles(p), today), status, prev_senate.get(postal))
            if res is not None:
                res["special"] = postal in SENATE_SPECIALS or "special" in (res.get("page") or "").lower()
                out["senate"][postal] = res

    def run_governors():
        for postal in gov_order:
            res = _run_one(f"{postal}-governor", lambda p=postal: collect_race(governor_titles(p), today), status, prev_gov.get(postal))
            if res is not None:
                out["governors"][postal] = res

    if os.environ.get("POLLS_ROTATE") and hour % 2:
        run_governors(); run_senate()
    else:
        run_senate(); run_governors()

    ok = sum(1 for s in status.values() if s.get("ok"))
    out["summary"] = {
        "races_ok": ok,
        "races_failed": len(status) - ok,
        "runtime_seconds": round(time.monotonic() - _START_TIME, 1),
    }
    return out


def write_output(data: dict, path: str = OUTPUT_PATH) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1, sort_keys=False)
        fh.write("\n")
    os.replace(tmp, path)


def main() -> int:
    try:
        data = collect_all()
    except Exception as e:  # noqa: BLE001 - absolutely never crash the caller
        log(f"collect_all crashed: {e!r}")
        data = load_previous(OUTPUT_PATH) or {}
        data["generated_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        data.setdefault("status", {})["_fatal"] = {"ok": False, "error": repr(e)[:500]}
    try:
        write_output(data)
        log(f"wrote {OUTPUT_PATH}")
    except Exception as e:  # noqa: BLE001
        log(f"could not write output: {e!r}")
        return 0
    s = data.get("summary") or {}
    log(f"done: {s.get('races_ok', '?')} ok, {s.get('races_failed', '?')} failed, {s.get('runtime_seconds', '?')}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
