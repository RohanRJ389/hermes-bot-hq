#!/usr/bin/env python3
"""Fetch GitHub traffic APIs and upsert JSON into a traffic-branch checkout."""

from __future__ import annotations

import html
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_VERSION = "2022-11-28"
USER_AGENT = "hermes-bot-hq-traffic-archive"
README_INTRO = """Daily snapshots of this repository's GitHub Insights traffic APIs (views, clones, popular paths and referrers). GitHub only retains 14 days in the UI and REST API; this branch keeps a longer series.

Do not merge this branch into the default branch. It is unrelated history, not plugin source.
"""
README_SOURCES = (
    "_Sources: API from 7 Sep 2026 onward. 20 Aug–3 Sep from Insights screenshots "
    "(estimated). 5–6 Sep clone uniques from a screenshot (count stored as uniques). "
    "4 Sep and 5–6 Sep views are a gap, not zero._\n"
)
SUMMARY_START = "<!-- traffic-summary -->"
SUMMARY_END = "<!-- /traffic-summary -->"
DASHBOARD_FILE = "dashboard.html"
DASHBOARD_TEMPLATE = Path(__file__).with_name("traffic_dashboard.html")
DATA_PLACEHOLDER = "__TRAFFIC_DATA__"
TITLE_PLACEHOLDER = "__TRAFFIC_TITLE__"


def api_get(repo: str, path: str, token: str):
    url = f"https://api.github.com/repos/{repo}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"GET {url} failed: {exc.code} {exc.reason}\n{body}") from exc


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise SystemExit(f"{path} must be a JSON object of date keys")
    return data


def dump_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


def utc_day(timestamp: str) -> str:
    return timestamp[:10]


def upsert_series(existing: dict, payload: dict, series_key: str) -> dict:
    merged = dict(existing)
    for row in payload.get(series_key, []):
        day = utc_day(row["timestamp"])
        merged[day] = {"count": row["count"], "uniques": row["uniques"]}
    return dict(sorted(merged.items()))


def sum_daily(series: dict, field: str) -> int:
    total = 0
    for row in series.values():
        if isinstance(row, dict):
            total += int(row.get(field) or 0)
    return total


def pages_url(repo: str) -> str:
    owner, _, name = repo.partition("/")
    return f"https://{owner.lower()}.github.io/{name}/{DASHBOARD_FILE}"


def summary_block(views: dict, clones: dict, dashboard_url: str) -> str:
    stats = [
        (sum_daily(views, "count"), "Views"),
        (sum_daily(views, "uniques"), "Unique viewers"),
        (sum_daily(clones, "count"), "Clones"),
        (sum_daily(clones, "uniques"), "Unique cloners"),
    ]
    cells = "".join(
        f'<td align="center"><font size="6"><strong>{value:,}</strong></font><br>{label}</td>\n'
        for value, label in stats
    )
    return (
        f"{SUMMARY_START}\n"
        f'<div align="center">\n'
        f"<table>\n<tr>\n{cells}</tr>\n</table>\n"
        f"<sub>All-time totals. Unique counts are sums of daily uniques, not deduplicated across days.</sub><br><br>\n"
        f'<a href="{html.escape(dashboard_url)}"><strong>Open the interactive dashboard</strong></a><br>\n'
        f"<sub>Charts by date range, plus top referrers and paths with filters. "
        f"Served by GitHub Pages from this branch; opening <code>{DASHBOARD_FILE}</code> "
        f"in the file list shows source only.</sub>\n"
        f"</div>\n"
        f"{SUMMARY_END}\n"
    )


def upsert_readme(path: Path, views: dict, clones: dict, dashboard_url: str) -> None:
    parts = [
        "# GitHub traffic archive\n",
        summary_block(views, clones, dashboard_url),
        "<br>\n",
        README_INTRO,
        README_SOURCES,
    ]
    text = "\n".join(parts)
    if not text.endswith("\n"):
        text += "\n"
    path.write_text(text, encoding="utf-8")


def load_snapshots(snapshot_dir: Path) -> dict:
    snapshots: dict[str, dict] = {}
    if not snapshot_dir.is_dir():
        return snapshots
    for kind in ("referrers", "paths"):
        for file in sorted(snapshot_dir.glob(f"*-{kind}.json")):
            day = file.name[:10]
            with file.open(encoding="utf-8") as fh:
                rows = json.load(fh)
            if isinstance(rows, list):
                snapshots.setdefault(day, {"referrers": [], "paths": []})[kind] = rows
    return dict(sorted(snapshots.items()))


def write_dashboard(out: Path, repo: str, views: dict, clones: dict) -> None:
    data = {
        "repo": repo,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "views": views,
        "clones": clones,
        "snapshots": load_snapshots(out / "snapshots"),
    }
    # "<" is escaped so path or referrer strings cannot close the <script> tag.
    payload = json.dumps(data, separators=(",", ":")).replace("<", "\\u003c")
    template = DASHBOARD_TEMPLATE.read_text(encoding="utf-8")
    page = template.replace(TITLE_PLACEHOLDER, html.escape(repo)).replace(
        DATA_PLACEHOLDER, payload
    )
    (out / DASHBOARD_FILE).write_text(page, encoding="utf-8")


def main() -> None:
    token = os.environ.get("TRAFFIC_TOKEN", "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not token:
        raise SystemExit("TRAFFIC_TOKEN is not set")
    if not repo:
        raise SystemExit("GITHUB_REPOSITORY is not set")

    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    today = datetime.now(timezone.utc).date().isoformat()

    views = api_get(repo, "/traffic/views?per=day", token)
    clones = api_get(repo, "/traffic/clones?per=day", token)
    referrers = api_get(repo, "/traffic/popular/referrers", token)
    paths = api_get(repo, "/traffic/popular/paths", token)

    views_series = upsert_series(load_json(out / "views.json"), views, "views")
    dump_json(out / "views.json", views_series)
    clones_series = upsert_series(load_json(out / "clones.json"), clones, "clones")
    dump_json(out / "clones.json", clones_series)
    dump_json(out / "snapshots" / f"{today}-referrers.json", referrers)
    dump_json(out / "snapshots" / f"{today}-paths.json", paths)

    upsert_readme(out / "README.md", views_series, clones_series, pages_url(repo))
    write_dashboard(out, repo, views_series, clones_series)


if __name__ == "__main__":
    main()
