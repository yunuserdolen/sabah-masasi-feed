#!/usr/bin/env python3
"""Sabah Masası — Katman 1 toplayıcı.

RSS + Google News RSS + GDELT kaynaklarını çeker, tekrarları ayıklar,
kaynak başına günlük tavan uygular ve İstanbul tarihine göre günlük
parçalara (data/YYYY-MM-DD.json) yazar. Ayrıca data/config.json (takvim)
ve data/health.json (çalışmayan kaynaklar) üretir.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote_plus

import feedparser
import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "Mozilla/5.0 (compatible; SabahMasasiFeed/1.0; +https://github.com)"
GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
GDELT_LANG = {
    "english": "en", "turkish": "tr", "french": "fr", "german": "de",
    "spanish": "es", "arabic": "ar", "chinese": "zh", "hebrew": "he",
}

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
PUNCT_RE = re.compile(r"\s+([.,;:!?…])")


def clean(text: str | None, limit: int) -> str:
    if not text:
        return ""
    t = WS_RE.sub(" ", html.unescape(TAG_RE.sub(" ", text))).strip()
    t = PUNCT_RE.sub(r"\1", t)
    return t if len(t) <= limit else t[: limit - 1].rstrip() + "…"


def title_key(title: str) -> str:
    t = unicodedata.normalize("NFKD", title.lower())
    t = "".join(ch for ch in t if ch.isalnum() or ch.isspace())
    return WS_RE.sub(" ", t).strip()[:80]


def item_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def entry_time(entry, now: datetime) -> datetime:
    st = entry.get("published_parsed") or entry.get("updated_parsed")
    if not st:
        return now
    dt = datetime(*st[:6], tzinfo=timezone.utc)
    return now if dt > now + timedelta(hours=1) else dt


def gnews_url(feed: dict, locales: dict) -> str:
    loc = locales[feed["lang"]]
    return (
        "https://news.google.com/rss/search?q=" + quote_plus(feed["q"])
        + f"&hl={loc['hl']}&gl={loc['gl']}&ceid={quote_plus(loc['ceid'])}"
    )


def fetch_feed(feed: dict, cfg: dict, now: datetime) -> tuple[list[dict], dict]:
    s = cfg["settings"]
    url = feed["url"] if feed["type"] == "rss" else gnews_url(feed, cfg["gnews_locales"])
    health = {"id": feed["id"], "lang": feed["lang"], "ok": False, "n": 0}
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=s["request_timeout"])
        r.raise_for_status()
        parsed = feedparser.parse(r.content)
        if parsed.bozo and not parsed.entries:
            raise ValueError(f"ayrıştırılamadı: {parsed.bozo_exception!r}"[:200])
    except Exception as e:  # noqa: BLE001
        health["error"] = str(e)[:200]
        return [], health

    items = []
    for e in parsed.entries:
        link, title = e.get("link"), e.get("title")
        if not link or not title:
            continue
        source = feed.get("name")
        summary = ""
        if feed["type"] == "gnews":
            # Google News başlığı "Başlık - Yayın" biçiminde gelir.
            pub = (e.get("source") or {}).get("title")
            if pub and title.endswith(" - " + pub):
                title = title[: -(len(pub) + 3)]
            source = source or pub or "Google News"
        else:
            summary = clean(e.get("summary") or e.get("description"), s["summary_chars"])
        items.append({
            "id": item_id(link), "t": clean(title, 220), "u": link, "s": source,
            "f": feed["id"], "l": feed["lang"], "b": feed.get("leaning", "?"),
            "sec": feed["sections"], "d": iso(entry_time(e, now)), "x": summary,
        })
    health.update(ok=True, n=len(items))
    return items, health


def fetch_gdelt(cfg: dict, now: datetime) -> tuple[list[dict], list[dict]]:
    g = cfg.get("gdelt") or {}
    items, healths = [], []
    for i, q in enumerate(g.get("queries", [])):
        if i:
            time.sleep(12)  # GDELT paylaşımlı IP'lerde sıkı hız sınırı uygular
        h = {"id": q["id"], "lang": "multi", "ok": False, "n": 0}
        params = {"query": q["query"], "mode": "ArtList", "format": "json",
                  "maxrecords": g.get("maxrecords", 40), "timespan": g.get("timespan", "1d"),
                  "sort": "DateDesc"}
        try:
            for attempt in range(2):
                r = requests.get(GDELT_URL, params=params, headers={"User-Agent": UA},
                                 timeout=cfg["settings"]["request_timeout"])
                if r.status_code != 429:
                    break
                time.sleep(30 * (attempt + 1))
            r.raise_for_status()
            try:
                data = r.json()
            except ValueError:
                raise ValueError("JSON değil: " + r.text[:150])
        except Exception as e:  # noqa: BLE001
            h["error"] = str(e)[:200]
            healths.append(h)
            continue
        for a in data.get("articles", []):
            if not a.get("url") or not a.get("title"):
                continue
            try:
                dt = datetime.strptime(a["seendate"], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            except (KeyError, ValueError):
                dt = now
            items.append({
                "id": item_id(a["url"]), "t": clean(a["title"], 220), "u": a["url"],
                "s": a.get("domain", "gdelt"), "f": q["id"],
                "l": GDELT_LANG.get(str(a.get("language", "")).lower(), "?"),
                "b": "karisik", "sec": q["sections"], "d": iso(dt), "x": "",
            })
            h["n"] += 1
        h["ok"] = True
        healths.append(h)
    return items, healths


def local_date(d_iso: str, tz: int) -> str:
    dt = datetime.strptime(d_iso, "%Y-%m-%dT%H:%M:%SZ") + timedelta(hours=tz)
    return dt.date().isoformat()


def merge(items: list[dict], cfg: dict, now: datetime) -> dict[str, int]:
    s = cfg["settings"]
    tz, cap = s["tz_offset_hours"], s["max_items_per_feed_per_day"]
    oldest = (now + timedelta(hours=tz)).date() - timedelta(days=s["retention_days"])

    by_day: dict[str, list[dict]] = {}
    for it in items:
        day = local_date(it["d"], tz)
        if datetime.fromisoformat(day).date() >= oldest:
            by_day.setdefault(day, []).append(it)

    stats = {}
    for day, new in by_day.items():
        path = DATA / f"{day}.json"
        shard = json.loads(path.read_text("utf-8")) if path.exists() else {"date": day, "items": []}
        by_id = {i["id"]: i for i in shard["items"]}
        by_title = {title_key(i["t"]): i for i in shard["items"]}
        per_feed: dict[str, int] = {}
        for i in shard["items"]:
            per_feed[i["f"]] = per_feed.get(i["f"], 0) + 1
        # En yeniler önce gelsin ki tavan dolarken taze haber kaybolmasın.
        for it in sorted(new, key=lambda x: x["d"], reverse=True):
            tk = title_key(it["t"])
            dup = by_id.get(it["id"]) or (by_title.get(tk) if tk else None)
            if dup:  # aynı haber başka bölümden de geldiyse bölümleri birleştir
                dup["sec"] = sorted(set(dup["sec"]) | set(it["sec"]))
                continue
            if per_feed.get(it["f"], 0) >= cap:
                continue
            shard["items"].append(it)
            by_id[it["id"]] = it
            if tk:
                by_title[tk] = it
            per_feed[it["f"]] = per_feed.get(it["f"], 0) + 1
        shard["items"].sort(key=lambda x: x["d"], reverse=True)
        path.write_text(json.dumps(shard, ensure_ascii=False, separators=(",", ":")), "utf-8")
        stats[day] = len(shard["items"])

    for p in DATA.glob("????-??-??.json"):
        if datetime.fromisoformat(p.stem).date() < oldest:
            p.unlink()
    return stats


def write_section_files(cfg: dict, now: datetime) -> None:
    """Geri bakışlı bölümler (lookback_days) için data/sec/<bölüm>.json yazar."""
    secdir = DATA / "sec"
    secdir.mkdir(exist_ok=True)
    shards = [json.loads(p.read_text("utf-8"))["items"] for p in sorted(DATA.glob("????-??-??.json"))]
    for sec, rule in cfg["schedule"].items():
        look = (rule or {}).get("lookback_days") if isinstance(rule, dict) else None
        if not look:
            continue
        since = iso(now - timedelta(days=look + 1))
        items = [i for sh in shards for i in sh if sec in i["sec"] and i["d"] >= since]
        items.sort(key=lambda x: x["d"], reverse=True)
        (secdir / f"{sec}.json").write_text(
            json.dumps({"section": sec, "items": items}, ensure_ascii=False, separators=(",", ":")), "utf-8")


def main() -> int:
    cfg = yaml.safe_load((ROOT / "sources.yaml").read_text("utf-8"))
    DATA.mkdir(exist_ok=True)
    now = datetime.now(timezone.utc)

    items, healths = [], []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for its, h in pool.map(lambda f: fetch_feed(f, cfg, now), cfg["feeds"]):
            items += its
            healths.append(h)
    g_items, g_health = fetch_gdelt(cfg, now)
    items += g_items
    healths += g_health

    stats = merge(items, cfg, now)
    write_section_files(cfg, now)

    (DATA / "config.json").write_text(json.dumps({
        "generated": iso(now),
        "tz_offset_hours": cfg["settings"]["tz_offset_hours"],
        "schedule": cfg["schedule"],
        "langs": list(cfg["gnews_locales"].keys()),
    }, ensure_ascii=False, indent=1), "utf-8")
    (DATA / "health.json").write_text(json.dumps({
        "generated": iso(now), "shards": stats,
        "failing": [h for h in healths if not h["ok"]],
        "empty": [h["id"] for h in healths if h["ok"] and h["n"] == 0],
        "ok_count": sum(1 for h in healths if h["ok"]), "total": len(healths),
    }, ensure_ascii=False, indent=1), "utf-8")

    bad = [h["id"] for h in healths if not h["ok"]]
    print(f"{len(items)} öğe toplandı · {len(healths) - len(bad)}/{len(healths)} kaynak çalıştı")
    if bad:
        print("Çalışmayan:", ", ".join(bad))
    return 0


if __name__ == "__main__":
    sys.exit(main())
