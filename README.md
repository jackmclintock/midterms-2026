# Midterms 2026

A live forecast and results tracker for the 3 November 2026 US midterm elections. Senate, House and governors, with every poll we can find, every public model, prediction markets and historical context, plus our own model that keeps re-estimating the likely outcome through election night.

Live site: https://jackmclintock.github.io/midterms-2026/

## How it works

```
GitHub Actions (cron)  ->  scripts/polls.py     ->  data/polls.json          (every individual poll, from Wikipedia tables)
                       ->  scripts/refresh.py   ->  data/polls_combined.json (Wikipedia + VoteHub + CNN polls, our averages)
                                                 ->  data/live.json          (results + markets + model, what the page reads)
                                                 ->  data/timeseries.json    (headline numbers over time)
GitHub Pages           ->  index.html + assets/  (static, reads the JSON, refreshes itself every minute)
```

Everything is plain Python 3 standard library and vanilla JavaScript. No build step, no framework, no paid APIs.

### Cadence

* Normal: every 30 minutes.
* Election window (3 Nov 10:00 UTC to 7 Nov): every 5 minutes. A full refresh twice an hour and a fast refresh (results and markets only) in between.
* The page itself re-fetches `data/live.json` every 60 seconds and when the tab regains focus.

### Sources

| Kind | Source | How |
|---|---|---|
| Results | New York Times election feeds (AP counts and calls, NYT expected vote) | public JSON on static01.nyt.com |
| Results fallback | CNN politics API | public JSON |
| Polls | Wikipedia polling tables for all 35 Senate, 36 governor races and the generic ballot | MediaWiki API, parsed |
| Polls | VoteHub open polling API (Senate, governor, House, generic ballot) | public JSON, CC-BY |
| Polls | CNN poll of polls (generic ballot) | public JSON |
| Poll averages | RealClearPolling, PollCheck, Silver Bulletin, Strength In Numbers, FiftyPlusOne, DDHQ, 270toWin | curated snapshot in `data/seed/` |
| Models | Decision Desk HQ, Silver Bulletin, The Economist, Split Ticket, Poliwave, Dave Manuel, PollCheck, Vote-Scope, ElectIndex | curated snapshot in `data/seed/` |
| Ratings | Cook Political Report, Sabato's Crystal Ball, Inside Elections, NYT | seed plus live NYT |
| Markets | Polymarket (Gamma API), Kalshi (public API) | live, chamber control plus per-race |
| History | Midterms 1946 to 2022, 2018 and 2022 Senate polls vs results, polling error by cycle, poll closing times, counting speed | `data/seed/history.json` |
| News | Google News RSS; Tavily only as a capped fallback if RSS fails | live |

### Our model

Before the election, each race gets an expected margin from a weighted blend of: our own polling average (recency and sample weighted, pollster de-duplicated), published model probabilities, race ratings, prediction markets and fundamentals (2024 presidential margin shifted by the national environment implied by the generic ballot, with an incumbency bonus). Chamber control comes from 20,000 simulations with a shared national error term so races move together.

On election night, each race blends the live margin with its prior, trusting the count more as the share of expected vote reported rises. Called races are fixed. Across races that are mostly counted, the median gap between result and expectation becomes a swing that shifts the uncalled races. Details are in the Method section of the site and in `scripts/refresh.py`.

## Running locally

```bash
python3 scripts/polls.py      # optional, slow: collects polls from Wikipedia
python3 scripts/refresh.py    # builds data/live.json (about 2 minutes)
python3 -m http.server 8765   # then open http://localhost:8765/
```

Set `FAST_MODE=1` to skip the slow sources. Set `TAVILY_API_KEY` to enable the news fallback.

## Repository secrets

* `TAVILY_API_KEY` (optional). Used only if Google News RSS returns nothing, at most once per run, with a six-hour cool-down.

## Updating the curated data

The seed files in `data/seed/` hold the figures that cannot be fetched automatically (paywalled models, ratings pages that block bots). Edit them and push; the next run picks them up. The `as_of` field on each file is shown on the site.
