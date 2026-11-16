#!/usr/bin/env python3
"""Download ARC Raiders item data from several community sources, cross-check
stack sizes and crafting recipes, and write data/items.js for index.html.

Usage (from the ArcTool folder):
    python -I tools/update_data.py              download fresh data, then build
    python -I tools/update_data.py --offline    rebuild from the cached raw data
    python -I tools/update_data.py --only wiki  re-download one source (arctracker,
                                                metaforge, wiki, ardb), reuse the rest

Only the Python standard library is used.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT_JS = ROOT / "data" / "items.js"

USER_AGENT = "Mozilla/5.0 (compatible; ArcStashTool/1.0; personal stash-efficiency table)"

SOURCES = {
    "arctracker": {
        "name": "ArcTracker",
        "url": "https://arctracker.io/items",
        "api": "https://arctracker.io/api/items",
    },
    "metaforge": {
        "name": "MetaForge",
        "url": "https://metaforge.app/arc-raiders",
        "api": "https://metaforge.app/api/arc-raiders/items",
    },
    "wiki": {
        "name": "ARC Raiders Wiki",
        "url": "https://arcraiders.wiki/",
        "api": "https://arcraiders.wiki/w/api.php",
    },
    "ardb": {
        "name": "ARDB",
        "url": "https://ardb.app/",
        "api": "https://ardb.app/api/items",
    },
}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def http_get(url: str, *, retries: int = 4, timeout: int = 90) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
        },
    )
    delay = 2.0
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            if attempt == retries - 1:
                raise
            retry_after = e.headers.get("Retry-After") if e.headers else None
            wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
            print(f"    HTTP {e.code} for {url} - retrying in {wait:.0f}s")
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == retries - 1:
                raise
            print(f"    {type(e).__name__} for {url} - retrying in {delay:.0f}s")
            time.sleep(delay)
        delay *= 2
    raise RuntimeError("unreachable")


def get_json(url: str):
    return json.loads(http_get(url).decode("utf-8"))


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# Fetchers - each one writes the raw responses to data/raw/<source>/
# --------------------------------------------------------------------------- #
def fetch_arctracker() -> None:
    print("ArcTracker: downloading /api/items ...")
    data = get_json(SOURCES["arctracker"]["api"])
    save_json(RAW / "arctracker" / "items.json", data)
    print(f"  {len(data.get('items', []))} items (generated {data.get('generatedAt')})")


def fetch_metaforge() -> None:
    api = SOURCES["metaforge"]["api"]
    items, page = [], 1
    while True:
        qs = urllib.parse.urlencode({"page": page, "limit": 100, "includeComponents": "true"})
        print(f"MetaForge: page {page} ...")
        data = get_json(f"{api}?{qs}")
        items.extend(data.get("data", []))
        pag = data.get("pagination", {})
        if not pag.get("hasNextPage"):
            break
        page += 1
        time.sleep(1.5)  # be polite; the API asks consumers to cache
    save_json(RAW / "metaforge" / "items.json", {"fetchedAt": now_iso(), "items": items})
    print(f"  {len(items)} items")


WIKI_TEMPLATES = [
    "Template:Infobox item",
    "Template:Infobox weapon",
    "Template:Crafting",
    "Template:Weapon upgrades",
]
WIKI_AMPLIFIED_PAGE = "Amplified Weapons"  # amplification costs, documented per weapon
AMP_SYNONYMS = {"incendiarygrenades": "incendiaryrounds"}


def fetch_wiki() -> None:
    api = SOURCES["wiki"]["api"]
    titles: set[str] = set()
    for tpl in WIKI_TEMPLATES:
        cont: dict = {}
        while True:
            params = {
                "action": "query", "list": "embeddedin", "eititle": tpl,
                "einamespace": 0, "eilimit": 500, "format": "json", "formatversion": 2,
                **cont,
            }
            data = get_json(f"{api}?{urllib.parse.urlencode(params)}")
            for p in data.get("query", {}).get("embeddedin", []):
                titles.add(p["title"])
            if "continue" not in data:
                break
            cont = data["continue"]
            time.sleep(0.5)
        print(f"Wiki: {tpl} -> {len(titles)} pages so far")
    titles.add(WIKI_AMPLIFIED_PAGE)

    pages: dict[str, dict] = {}
    ordered = sorted(titles)
    for i in range(0, len(ordered), 50):
        batch = ordered[i:i + 50]
        params = {
            "action": "query", "prop": "revisions", "rvprop": "content|timestamp",
            "rvslots": "main", "titles": "|".join(batch), "redirects": 1,
            "format": "json", "formatversion": 2,
        }
        data = get_json(f"{api}?{urllib.parse.urlencode(params)}")
        for p in data.get("query", {}).get("pages", []):
            revs = p.get("revisions")
            if not revs:
                continue
            pages[p["title"]] = {
                "timestamp": revs[0].get("timestamp"),
                "content": revs[0]["slots"]["main"]["content"],
            }
        print(f"Wiki: fetched {min(i + 50, len(ordered))}/{len(ordered)} pages")
        time.sleep(1.0)
    save_json(RAW / "wiki" / "pages.json", {"fetchedAt": now_iso(), "pages": pages})


def fetch_ardb() -> None:
    api = SOURCES["ardb"]["api"]
    print("ARDB: downloading item list ...")
    listing = get_json(api)
    details: dict[str, dict] = {}
    cache = RAW / "ardb" / "details.json"
    for n, entry in enumerate(listing, 1):
        iid = entry["id"]
        try:
            d = get_json(f"{api}/{urllib.parse.quote(iid)}")
        except urllib.error.HTTPError as e:
            print(f"  {iid}: HTTP {e.code}, skipped")
            continue
        if d:
            details[iid] = d
        if n % 50 == 0:
            print(f"ARDB: {n}/{len(listing)} item details")
        time.sleep(0.25)
    save_json(cache, {"fetchedAt": now_iso(), "items": details})
    print(f"  {len(details)} item details")


FETCHERS = {
    "arctracker": fetch_arctracker,
    "metaforge": fetch_metaforge,
    "wiki": fetch_wiki,
    "ardb": fetch_ardb,
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- #
# Parsers - turn each source into {normalised name: record}
#
# record = {
#   "sid": id in that source, "name": str, "type": str, "rarity": str,
#   "stack": int | None, "icon": url | None, "updated": "YYYY-MM-DD" | None,
#   "recipes": [{"kind": "craft"|"upgrade", "inputs": {norm name: qty},
#                "out": int | None (None = source does not say), "station": str}],
# }
# --------------------------------------------------------------------------- #
ROMAN = ["", "I", "II", "III", "IV", "V", "VI"]

BENCH_NAMES = {
    "workbench": "Workbench",
    "weapon_bench": "Gunsmith",
    "equipment_bench": "Gear Bench",
    "med_station": "Medical Lab",
    "explosives_bench": "Explosives Station",
    "utility_bench": "Utility Station",
    "refiner": "Refiner",
    "in_raid": "In-raid",
}


def norm(name: str) -> str:
    """Normalise an item name so the same item matches across sources."""
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    s = s.lower().replace("&", "and")
    return re.sub(r"[^a-z0-9]+", "", s)


def as_int(v) -> int | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v) if v > 0 else None
    m = re.search(r"\d+", str(v).replace(",", ""))
    return int(m.group()) if m and int(m.group()) > 0 else None


def add_recipe(rec: dict, kind: str, inputs: dict, out, station: str | None) -> None:
    if not inputs:
        return
    for r in rec["recipes"]:  # de-duplicate (e.g. bench + in-raid variants)
        if r["inputs"] == inputs and (r["out"] == out or out is None or r["out"] is None):
            if r["out"] is None:
                r["out"] = out
            if station and station not in (r["station"] or ""):
                r["station"] = f"{r['station']}, {station}" if r["station"] else station
            return
    rec["recipes"].append({"kind": kind, "inputs": inputs, "out": out, "station": station})


def parse_arctracker() -> tuple[dict, dict]:
    raw = load_json(RAW / "arctracker" / "items.json")
    items = raw["items"]
    by_id = {it["id"]: it for it in items}

    def en(v):
        return v.get("en") if isinstance(v, dict) else v

    key_of: dict[str, str] = {}
    for it in items:
        key = norm(en(it["name"]))
        if key in key_of.values():  # two items share a name - keep them apart
            key = f"{key}#{it['id']}"
        key_of[it["id"]] = key

    def bench(it) -> str | None:
        b = it.get("craftBench")
        if not b:
            return None
        benches = b if isinstance(b, list) else [b]
        lvl = it.get("stationLevelRequired")
        names = []
        for x in benches:
            n = BENCH_NAMES.get(x, x.replace("_", " ").title())
            names.append(f"{n} {lvl}" if lvl and x not in ("in_raid",) else n)
        return ", ".join(names)

    def inputs_of(cost: dict) -> dict:
        return {key_of.get(k, norm(k)): int(v) for k, v in cost.items()}

    out: dict[str, dict] = {}
    for it in items:
        key = key_of[it["id"]]
        upd = it.get("updatedAt")
        try:
            upd = dt.datetime.strptime(upd, "%m/%d/%Y").strftime("%Y-%m-%d") if upd else None
        except ValueError:
            pass
        rec = {
            "sid": it["id"], "name": en(it["name"]), "type": it.get("type"),
            "rarity": it.get("rarity"), "stack": as_int(it.get("stackSize")),
            "icon": it.get("imageFilename"), "updated": upd, "recipes": [],
            "value": it.get("value"), "weight": it.get("weightKg"),
            "addedIn": it.get("addedIn"), "phasedOut": bool(it.get("phasedOut")),
            "blueprint": bool(it.get("blueprintLocked")),
            "recycle": inputs_of(it.get("recyclesInto") or {}) or None,
            "salvage": inputs_of(it.get("salvagesInto") or {}) or None,
        }
        out[key] = rec
        if it.get("recipe"):
            add_recipe(rec, "craft", inputs_of(it["recipe"]), as_int(it.get("craftQuantity")) or 1, bench(it))

    # Upgrades: X.upgradesTo = Y and Y.upgradeCost = cost  ->  Y = X + cost.
    # Amplified weapons branch: X.upgrades = [{"to": Y, "cost": {...}}, ...].
    for it in items:
        src = key_of[it["id"]]
        tgt = it.get("upgradesTo")
        if tgt in by_id and by_id[tgt].get("upgradeCost"):
            inputs = {src: 1, **inputs_of(by_id[tgt]["upgradeCost"])}
            add_recipe(out[key_of[tgt]], "upgrade", inputs, 1, bench(by_id[tgt]) or "Gunsmith")
        for up in it.get("upgrades") or []:
            tgt = up.get("to")
            if tgt in by_id and up.get("cost"):
                inputs = {src: 1, **inputs_of(up["cost"])}
                add_recipe(out[key_of[tgt]], "upgrade", inputs, 1, bench(by_id[tgt]) or "Gunsmith")
    meta = {"generatedAt": raw.get("generatedAt"), "version": raw.get("version"), "count": len(items)}
    return out, meta


METAFORGE_SKIP_TYPES = {"Cosmetic", "Outfits"}  # character cosmetics never sit in the stash


def parse_metaforge() -> tuple[dict, dict]:
    raw = load_json(RAW / "metaforge" / "items.json")
    items = [x for x in raw["items"] if x.get("item_type") not in METAFORGE_SKIP_TYPES]
    out: dict[str, dict] = {}
    key_of: dict[str, str] = {}
    for x in raw["items"]:
        key = norm(x["name"])
        if key in key_of.values():  # e.g. three rarities of "Colorful Shoes"
            key = f"{key}#{x['id']}"
        key_of[x["id"]] = key
    for x in items:
        key = key_of[x["id"]]
        sb = x.get("stat_block") or {}
        rec = {
            "sid": x["id"], "name": x["name"], "type": x.get("item_type"),
            "rarity": x.get("rarity"), "stack": as_int(sb.get("stackSize")),
            "icon": x.get("icon"), "updated": (x.get("updated_at") or "")[:10] or None,
            "recipes": [], "station": x.get("workbench"), "value": x.get("value"),
        }
        out[key] = rec
        ops = (x.get("relationships") or {}).get("operations") or []

        def amounts(entries, field):
            res = {}
            for e in entries or []:
                ref = e.get(field) or {}
                k = key_of.get(ref.get("id"), norm(ref.get("name") or ref.get("id") or ""))
                if k and as_int(e.get("quantity")):
                    res[k] = res.get(k, 0) + int(e["quantity"])
            return res or None

        rec["recycle"] = amounts(x.get("recycle_components"), "component")
        rec["salvage"] = None
        made = None  # output quantity, only known when the item is field-craftable
        for op in ops:
            if op.get("kind") == "field-crafting":
                for o in op.get("outputs") or []:
                    if o["item"]["id"] == x["id"]:
                        made = as_int(o.get("quantity"))
            if op.get("kind") == "salvage" and any(i["item"]["id"] == x["id"] for i in op.get("inputs") or []):
                rec["salvage"] = amounts(op.get("outputs"), "item")
        rec["_components"] = (x.get("components") or [], made)
    # Upgrade operations are listed on the item being upgraded: X --cost--> Y.
    # Research unlocks carry copies of these operations; they are not consumed.
    for x in items:
        if x.get("item_type") in ("Research", "Research Item"):
            continue
        for op in (x.get("relationships") or {}).get("operations") or []:
            if op.get("kind") != "upgrade":
                continue
            cost = {}
            for i in op.get("inputs") or []:
                k = key_of.get(i["item"]["id"], norm(i["item"].get("name") or i["item"]["id"]))
                cost[k] = cost.get(k, 0) + int(i["quantity"])
            for o in op.get("outputs") or []:
                tgt = key_of.get(o["item"]["id"])
                if tgt in out and cost:
                    add_recipe(out[tgt], "upgrade", {key_of[x["id"]]: 1, **cost}, 1, None)
    # Crafting components. Blueprints and research unlocks are listed as
    # components too, but they are requirements, not consumed ingredients.
    for rec in out.values():
        comps, made = rec.pop("_components")
        if not comps:
            continue
        types = [c["component"].get("item_type") for c in comps]
        if "Research" in types:  # amplified-weapon branches; covered by the upgrade ops
            continue
        has_weapon = "Weapon" in types
        if not has_weapon and any(r["kind"] == "upgrade" for r in rec["recipes"]):
            continue  # upgrade cost listed without the weapon being upgraded
        inputs = {}
        for c in comps:
            if c["component"].get("item_type") == "Blueprint":
                continue
            cid = c["component"]["id"]
            k = key_of.get(cid, norm(c["component"].get("name") or cid))
            inputs[k] = inputs.get(k, 0) + int(c["quantity"])
        add_recipe(rec, "upgrade" if has_weapon else "craft", inputs, made, rec.get("station"))
    return out, {"fetchedAt": raw.get("fetchedAt"), "count": len(items)}


def wiki_strip(s: str) -> str:
    s = re.sub(r"<!--[\s\S]*?-->", "", s)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)  # [[a|b]] -> b
    s = re.sub(r"<br\s*/?>", " + ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"'{2,}", "", s)
    return s.strip()


def wiki_templates(text: str, name: str):
    """Yield {param: value} for every {{name ...}} call in the wikitext."""
    pat = re.compile(r"\{\{\s*" + re.escape(name).replace(r"\ ", "[ _]") + r"\s*(?=[|}\n])", re.I)
    for m in pat.finditer(text):
        i, depth = m.end(), 1
        while i < len(text) and depth:
            if text.startswith("{{", i):
                depth, i = depth + 1, i + 2
            elif text.startswith("}}", i):
                depth, i = depth - 1, i + 2
            else:
                i += 1
        body = text[m.end():i - 2]
        parts, buf, d2 = [], "", 0
        j = 0
        while j < len(body):
            two = body[j:j + 2]
            if two in ("{{", "[["):
                d2 += 1; buf += two; j += 2; continue
            if two in ("}}", "]]"):
                d2 -= 1; buf += two; j += 2; continue
            if body[j] == "|" and d2 == 0:
                parts.append(buf); buf = ""; j += 1; continue
            buf += body[j]; j += 1
        parts.append(buf)
        params = {}
        for p in parts[1:]:
            if "=" in p:
                k, v = p.split("=", 1)
                params[k.strip().lower()] = v.strip()
        yield params


def wiki_ingredients(s: str) -> dict:
    out: dict[str, int] = {}
    for part in re.split(r"\s*(?:\+|,|\n)\s*", wiki_strip(s)):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^(\d+)\s*[x×]?\s+(.+)$", part) or re.match(r"^(\d+)[x×](.+)$", part)
        if m:
            qty, name = int(m.group(1)), m.group(2)
        else:
            m = re.match(r"^(.+?)\s*[x×]\s*(\d+)$", part)
            if not m:
                continue
            name, qty = m.group(1), int(m.group(2))
        k = norm(name)
        out[k] = out.get(k, 0) + qty
    return out


def parse_wiki() -> tuple[dict, dict]:
    raw = load_json(RAW / "wiki" / "pages.json")
    out: dict[str, dict] = {}

    def rec_for(name: str, page: dict, title: str) -> dict:
        k = norm(name)
        if k not in out:
            out[k] = {"sid": title, "name": name, "type": None, "rarity": None, "stack": None,
                      "icon": None, "updated": (page.get("timestamp") or "")[:10] or None,
                      "recipes": [], "recycle": None, "salvage": None}
        return out[k]

    for title, page in raw["pages"].items():
        text = page["content"]
        main = title
        for tpl in ("Infobox item", "Infobox mod", "Infobox augment", "Infobox shield", "Infobox weapon"):
            for p in wiki_templates(text, tpl):
                name = wiki_strip(p.get("name") or "") or title
                main = name
                rec = rec_for(name, page, title)
                rec["type"] = rec["type"] or wiki_strip(p.get("type") or "") or tpl.split()[-1].title()
                rec["rarity"] = rec["rarity"] or wiki_strip(p.get("rarity") or "") or None
                if tpl == "Infobox item" and as_int(p.get("stacksize")):
                    rec["stack"] = as_int(p.get("stacksize"))
        for p in wiki_templates(text, "Crafting"):
            result = wiki_strip(p.get("result") or "") or main
            inputs = wiki_ingredients(p.get("ingredients") or "")
            station = wiki_strip(p.get("station") or "") or None
            if "researchpoints" in inputs or "research" in (station or "").lower():
                continue  # blueprint research at the Research Station, not crafting
            if station and station.lower() == "inventory":
                station = "In-raid"
            add_recipe(rec_for(result, page, title), "craft", inputs, as_int(p.get("qty")) or 1, station)
        for p in wiki_templates(text, "Weapon upgrades"):
            base = wiki_strip(p.get("basename") or "") or main
            station = wiki_strip(p.get("station") or "") or None
            for lvl in range(2, 7):
                ing = p.get(f"level{lvl}-ingredients")
                if not ing:
                    continue
                inputs = {norm(f"{base} {ROMAN[lvl - 1]}"): 1, **wiki_ingredients(ing)}
                add_recipe(rec_for(f"{base} {ROMAN[lvl]}", page, title), "upgrade", inputs, 1, station)
        # {{Recycling table | input1 = Kettle I | recycling1 = 3 Metal Parts + ... | salvaging1 = ...}}
        for p in wiki_templates(text, "Recycling table"):
            for n in range(1, 12):
                if f"recycling{n}" not in p and f"salvaging{n}" not in p:
                    continue
                rec = rec_for(wiki_strip(p.get(f"input{n}") or "") or main, page, title)
                rec["recycle"] = rec["recycle"] or wiki_ingredients(p.get(f"recycling{n}") or "") or None
                rec["salvage"] = rec["salvage"] or wiki_ingredients(p.get(f"salvaging{n}") or "") or None
    meta = {"fetchedAt": raw.get("fetchedAt"), "count": len(raw["pages"])}
    amp_page = raw["pages"].get(WIKI_AMPLIFIED_PAGE)
    if amp_page:
        meta["amplified"] = {**parse_wiki_amplified(amp_page["content"]),
                             "updated": (amp_page.get("timestamp") or "")[:10] or None}
    return out, meta


def parse_wiki_amplified(text: str) -> dict:
    """Amplification module per rarity, and materials per amplification per weapon."""
    modules = {
        rar.lower(): mod.strip()
        for rar, mod in re.findall(
            r"^\|\s*(Common|Uncommon|Rare|Epic|Legendary)\s*\|\|\s*\[\[([^\]|]+)", text, re.M)
    }
    amps: dict[str, dict] = {}
    heads = list(re.finditer(r'<div id="([^"]+)"', text))
    for i, h in enumerate(heads):
        body = text[h.end(): heads[i + 1].start() if i + 1 < len(heads) else len(text)]
        costs = {}
        for tbl in body.split("{|")[1:]:
            name = re.search(r"^!.*\|\s*([^|\n]+?)\s*$", tbl, re.M)
            mats = re.search(r"'''Materials:'''\s*(.+?)(?:<br\s*/?>|\n|$)", tbl)
            if name and mats and wiki_ingredients(mats.group(1)):
                costs[norm(name.group(1))] = wiki_ingredients(mats.group(1))
        if costs:
            amps[norm(h.group(1))] = costs
    return {"modules": modules, "amps": amps}


def add_wiki_amplified(parsed: dict, amp: dict | None) -> None:
    """The wiki lists amplification costs per weapon, not per variant item.
    Turn them into recipes for ArcTracker's variant items ("Amplified Kettle ·
    Anti-Shield + Full-Auto" = "Amplified Kettle · Anti-Shield" + the wiki's
    Full-Auto materials) so each upgrade step can be compared."""
    if not amp or not parsed.get("arctracker"):
        return
    at, wiki = parsed["arctracker"], parsed["wiki"]
    for costs in amp["amps"].values():  # launchers: the wiki says Grenades, ArcTracker says Rounds
        for wiki_name, at_name in AMP_SYNONYMS.items():
            if wiki_name in costs:
                costs.setdefault(at_name, costs[wiki_name])
    index = {}
    for k, r in at.items():
        m = re.match(r"^Amplified (.+?)(?:\s*·\s*(.+))?$", r["name"] or "")
        if m and category_of(r.get("type")) == "Weapon":
            mods = frozenset(norm(a) for a in (m.group(2) or "").split("+") if a.strip())
            index[(norm(m.group(1)), mods)] = k
    for (fam, mods), k in index.items():
        recipes = []
        if not mods:  # Level IV weapon + the module matching its rarity
            rarity = (wiki.get(fam) or {}).get("rarity") or (at.get(fam + "i") or at.get(fam) or {}).get("rarity")
            module = amp["modules"].get(str(rarity).lower())
            base = fam + "iv" if fam + "iv" in at else fam
            if module and base in at:
                recipes.append({base: 1, norm(module): 1})
        else:
            costs = amp["amps"].get(fam) or {}
            for a in mods:
                src = index.get((fam, mods - {a}))
                if src and a in costs:
                    recipes.append({src: 1, **costs[a]})
        if not recipes:
            continue
        rec = wiki.setdefault(k, {"sid": WIKI_AMPLIFIED_PAGE, "name": at[k]["name"], "type": None,
                                  "rarity": None, "stack": None, "icon": None,
                                  "updated": amp.get("updated"), "recipes": []})
        for inputs in recipes:
            add_recipe(rec, "upgrade", inputs, 1, "Gunsmith 4")


ARDB_WEAPON_TYPES = {"assault rifle", "battle rifle", "SMG", "shotgun", "pistol", "sniper rifle",
                     "hand cannon", "LMG", "special"}


def parse_ardb() -> tuple[dict, dict]:
    raw = load_json(RAW / "ardb" / "details.json")
    out: dict[str, dict] = {}
    for iid, x in raw["items"].items():
        key = norm(x["name"])
        icon = x.get("icon")
        rec = {"sid": iid, "name": x["name"], "type": x.get("type"), "rarity": x.get("rarity"),
               "stack": as_int(x.get("stackSize")),
               "icon": f"https://ardb.app/static{icon}" if icon and icon.startswith("/") else None,
               "updated": (x.get("updatedAt") or "")[:10] or None, "recipes": [],
               "recycle": None, "salvage": None}  # ARDB's breaksInto is the recycling yield
        breaks = {}
        for b in x.get("breaksInto") or []:
            k = norm(b["item"]["name"])
            breaks[k] = breaks.get(k, 0) + int(b["amount"])
        rec["recycle"] = breaks or None
        if key in out:
            key = f"{key}#{iid}"
        out[key] = rec
        cr = x.get("craftingRequirement")
        if cr and cr.get("requiredItems"):
            inputs = {}
            for r in cr["requiredItems"]:
                k = norm(r["item"]["name"])
                inputs[k] = inputs.get(k, 0) + int(r["amount"])
            kind = "craft"
            # weapon upgrades are sometimes listed without the weapon being upgraded
            m = re.match(r"^(.*) (II|III|IV|V)$", x["name"])
            if m and x.get("type") in ARDB_WEAPON_TYPES:
                kind = "upgrade"
                prev = norm(f"{m.group(1)} {ROMAN[ROMAN.index(m.group(2)) - 1]}")
                inputs.setdefault(prev, 1)
            add_recipe(rec, kind, inputs, as_int(cr.get("outputAmount")) or 1, None)
    return out, {"fetchedAt": raw.get("fetchedAt"), "count": len(raw["items"])}


PARSERS = {
    "arctracker": parse_arctracker,
    "metaforge": parse_metaforge,
    "wiki": parse_wiki,
    "ardb": parse_ardb,
}


def resolve_aliases(recs: dict, known: set) -> dict:
    """Re-key a source's records (and their recipe inputs) onto ArcTracker's
    names where they only differ cosmetically, e.g. MetaForge's "Rascal" is
    "Rascal I" and "Bulwark Stencil" is just "Bulwark" elsewhere."""
    alias = {}
    for k, r in recs.items():
        if k in known:
            continue
        cands = [k + "i", re.sub(r"(stencil|rifle)$", "", k), norm(r.get("sid") or "")]
        if re.search(r"\sI$", r.get("name") or ""):  # wiki: "Aphelion I" is just "Aphelion"
            cands.append(norm(r["name"][:-2]))
        for cand in cands:
            if cand and cand != k and cand in known:
                alias[k] = cand
                break
    out: dict[str, dict] = {}
    for k in sorted(recs, key=lambda k: k in alias):  # direct matches first, aliases merge in
        r = dict(recs[k])
        r["recipes"] = [
            {**rc, "inputs": {alias.get(i, i): q for i, q in rc["inputs"].items()}}
            for rc in r["recipes"]
        ]
        for field in ("recycle", "salvage"):
            if r.get(field):
                r[field] = {alias.get(i, i): q for i, q in r[field].items()}
        tgt = alias.get(k, k)
        if tgt not in out:
            out[tgt] = r
            continue
        base = out[tgt]
        for rc in r["recipes"]:
            add_recipe(base, rc["kind"], rc["inputs"], rc["out"], rc.get("station"))
        for field in ("stack", "rarity", "type", "icon", "recycle", "salvage"):
            if base.get(field) is None and r.get(field) is not None:
                base[field] = r[field]
    return out


# Priority when sources tie: ArcTracker is the newest dump and datamined.
PRIORITY = ["arctracker", "metaforge", "wiki", "ardb"]

CATEGORIES = {
    "Weapon": {"Assault Rifle", "Battle Rifle", "Pistol", "Sniper Rifle", "SMG", "Shotgun",
               "Hand Cannon", "LMG", "Special", "Weapon"},
    "Material": {"Basic Material", "Refined Material", "Topside Material", "Nature", "Material"},
    "Recyclable": {"Recyclable"},
    "Quick Use": {"Quick Use"},
    "Ammo": {"Ammunition"},
    "Mod": {"Modification"},
    "Gear": {"Augment", "Shield"},
    "Trinket": {"Trinket"},
    "Key": {"Key", "Quest Item"},
    "Blueprint": {"Blueprint"},
    "Outpost": {"Outpost Furniture", "Furniture", "Design", "Outpost Room", "Stencil"},
    "Other": {"Misc", "Research", "Research Item"},
}


def category_of(t: str | None) -> str:
    for cat, types in CATEGORIES.items():
        if t in types:
            return cat
    return "Other"


def vote(values: dict) -> tuple:
    """values = {source: value}. Majority wins, ties go to PRIORITY order."""
    tally: dict = {}
    for s, v in values.items():
        tally.setdefault(v, []).append(s)
    best = max(tally.items(), key=lambda kv: (len(kv[1]), -min(PRIORITY.index(s) for s in kv[1])))
    return best[0], best[1]


def reconcile(parsed: dict) -> list[dict]:
    at = parsed["arctracker"]
    keys = list(at)
    # Items ArcTracker lacks: keep them when a second source confirms they exist
    # and they are real loot (have a sell value), not a variant ArcTracker has.
    mf = parsed["metaforge"]
    for k, r in mf.items():
        if k in at or "#" in k:
            continue
        if not any(k in parsed[s] for s in ("wiki", "ardb")):
            continue
        if not r.get("stack") or not r.get("value"):
            continue
        if any(a["name"].startswith(r["name"] + " (") for a in at.values()):
            continue
        keys.append(k)

    items = []
    for k in keys:
        recs = {s: parsed[s][k] for s in PRIORITY if k in parsed[s]}
        primary = recs.get("arctracker") or recs["metaforge"]

        stack_votes = {s: r["stack"] for s, r in recs.items() if r.get("stack")}
        stack, stack_src = vote(stack_votes) if stack_votes else (None, [])

        # Recycling / salvaging yields: the whole output list is one vote.
        yields = {}
        for field in ("recycle", "salvage"):
            votes = {s: tuple(sorted(r[field].items())) for s, r in recs.items() if r.get(field)}
            if not votes:
                yields[field] = None
                continue
            best, src = vote(votes)
            yields[field] = {
                "out": [[k, q] for k, q in best],
                "src": sorted(src, key=PRIORITY.index),
                "votes": ({s: [[k, q] for k, q in v] for s, v in votes.items()}
                          if len(set(votes.values())) > 1 else None),
            }

        # Recipes: every distinct ingredient list across sources, with supporters.
        groups: dict = {}
        for s, r in recs.items():
            if (r.get("type") or primary["type"]) == "Blueprint":
                continue  # blueprints are found or researched, not crafted from items
            for rc in r["recipes"]:
                sig = tuple(sorted(rc["inputs"].items()))
                g = groups.setdefault(sig, {"kind": rc["kind"], "inputs": rc["inputs"], "src": [],
                                            "outs": {}, "stations": {}})
                if s not in g["src"]:
                    g["src"].append(s)
                if rc["out"] is not None:
                    g["outs"][s] = rc["out"]
                if rc.get("station"):
                    g["stations"].setdefault(s, rc["station"])
        if "arctracker" in recs and recs["arctracker"]["recipes"]:
            chosen = [sig for sig, g in groups.items() if "arctracker" in g["src"]]
        elif groups:
            top = max(len(g["src"]) for g in groups.values())
            chosen = [sig for sig, g in groups.items() if len(g["src"]) == top]
        else:
            chosen = []

        def pack(sig, g):
            out, out_src = vote(g["outs"]) if g["outs"] else (1, [])
            station = next((g["stations"][s] for s in PRIORITY if s in g["stations"]), None)
            if station and not re.search(r"\d", station):
                # ArcTracker gives no level for weapon upgrades; take it from a source that does
                # ("Gunsmith" -> "Gunsmith 4"), as long as it names the same station.
                for s in PRIORITY:
                    alt = g["stations"].get(s) or ""
                    m = re.fullmatch(rf"({re.escape(station)})\s+(\d+)", alt.strip())
                    if m:
                        station = alt.strip()
                        break
            return {
                "kind": g["kind"],
                "inputs": [[i, q] for i, q in g["inputs"].items()],
                "out": out,
                "station": station,
                "src": sorted(g["src"], key=PRIORITY.index),
                "outVotes": g["outs"] if len(set(g["outs"].values())) > 1 else None,
            }

        recipes = [pack(sig, groups[sig]) for sig in chosen]
        others = [pack(sig, g) for sig, g in groups.items() if sig not in chosen]

        icons = [recs[s]["icon"] for s in ("arctracker", "ardb", "metaforge")  # small files first
                 if s in recs and recs[s].get("icon")]
        items.append({
            "key": k,
            "id": primary["sid"],
            "name": primary["name"],
            "type": primary.get("type"),
            "cat": category_of(primary.get("type")),
            "rarity": (primary.get("rarity") or "").title() or None,
            "value": primary.get("value"),
            "weight": primary.get("weight"),
            "icons": icons,
            "stack": stack,
            "stackSrc": sorted(stack_src, key=PRIORITY.index),
            "stackVotes": stack_votes if len(set(stack_votes.values())) > 1 else None,
            "recipes": recipes,
            "otherRecipes": others,
            "recycle": yields["recycle"],
            "salvage": yields["salvage"],
            "sources": {s: {"id": r["sid"], "updated": r.get("updated")} for s, r in recs.items()},
            "addedIn": primary.get("addedIn"),
            "phasedOut": primary.get("phasedOut") or False,
            "blueprint": primary.get("blueprint") or False,
        })
    return items


def load_sources() -> tuple[dict, dict]:
    parsed, meta = {}, {}
    for key, fn in PARSERS.items():
        try:
            parsed[key], meta[key] = fn()
        except FileNotFoundError:
            print(f"!! no cached data for {key}; run without --offline first")
            parsed[key], meta[key] = {}, {}
    add_wiki_amplified(parsed, meta.get("wiki", {}).pop("amplified", None))
    known = set(parsed.get("arctracker", {}))
    for key in parsed:
        if key != "arctracker":
            parsed[key] = resolve_aliases(parsed[key], known)
    return parsed, meta


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
def fmt_recipe(rc: dict, names: dict) -> str:
    s = " + ".join(f"{q} {names.get(i, i)}" for i, q in rc["inputs"])
    return s + (f" -> {rc['out']}" if rc["out"] != 1 else "")


def build(parsed: dict, meta: dict, report: bool) -> None:
    items = reconcile(parsed)
    names = {it["key"]: it["name"] for it in items}
    unknown = {}
    for it in items:
        keys = [k for rc in it["recipes"] + it["otherRecipes"] for k, _ in rc["inputs"]]
        for field in ("recycle", "salvage"):
            y = it[field]
            if y:
                keys += [k for k, _ in y["out"]]
                keys += [k for v in (y["votes"] or {}).values() for k, _ in v]
        for k in keys:
            if k not in names and k not in unknown:
                unknown[k] = next((parsed[s][k]["name"] for s in PRIORITY if k in parsed[s]), k)

    craftable = [it for it in items if it["recipes"]]
    stack_conf = [it for it in items if it["stackVotes"]]
    recipe_conf = [it for it in items if it["recipes"] and it["otherRecipes"]]
    multi = [it for it in craftable if any(len(r["src"]) >= 2 for r in it["recipes"])]
    recyclable = [it for it in items if it["recycle"]]
    recycle_multi = [it for it in recyclable if len(it["recycle"]["src"]) >= 2]
    recycle_conf = [it for it in recyclable if it["recycle"]["votes"]]
    print(f"\n{len(items)} items, {len(craftable)} craftable "
          f"({len(multi)} with a recipe confirmed by 2+ sources)")
    print(f"stack size disagreements: {len(stack_conf)}; items where another source lists a "
          f"different recipe: {len(recipe_conf)}; unknown ingredients: {len(unknown)}")
    print(f"{len(recyclable)} recyclable ({len(recycle_multi)} confirmed by 2+ sources, "
          f"{len(recycle_conf)} with disagreeing yields)")
    if report:
        all_names = {**names, **unknown}
        print("\n-- stack size disagreements (chosen value first) --")
        for it in stack_conf:
            print(f"  {it['name']}: {it['stack']}  votes={it['stackVotes']}")
        print("\n-- recipe disagreements --")
        for it in recipe_conf:
            print(f"  {it['name']}")
            for rc in it["recipes"]:
                print(f"     used : {fmt_recipe(rc, all_names)}   [{', '.join(rc['src'])}]")
            for rc in it["otherRecipes"]:
                print(f"     other: {fmt_recipe(rc, all_names)}   [{', '.join(rc['src'])}]")
        print("\n-- recycling yield disagreements (chosen first) --")
        for it in recycle_conf:
            print(f"  {it['name']}")
            for s, v in it["recycle"]["votes"].items():
                mark = "used " if s in it["recycle"]["src"] else "other"
                print(f"     {mark}: {' + '.join(f'{q} {all_names.get(k, k)}' for k, q in v)}   [{s}]")
        if unknown:
            print("\n-- ingredients that are not items --", unknown)

    payload = {
        "generated": now_iso(),
        "sources": {
            s: {"name": SOURCES[s]["name"], "url": SOURCES[s]["url"], **meta.get(s, {})}
            for s in PRIORITY
        },
        "items": items,
        "unknownIngredients": unknown,
    }
    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    OUT_JS.write_text(
        "// Generated by tools/update_data.py - do not edit by hand; re-run the script instead.\n"
        "window.ARC_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT_JS.relative_to(ROOT)} ({OUT_JS.stat().st_size // 1024} KB)")


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="do not download, rebuild from data/raw")
    ap.add_argument("--only", choices=sorted(FETCHERS), action="append",
                    help="download only this source (repeatable); others come from cache")
    ap.add_argument("--fetch-only", action="store_true", help="download but do not build")
    ap.add_argument("--report", action="store_true", help="print every disagreement between sources")
    args = ap.parse_args()

    if not args.offline:
        for key in args.only or list(FETCHERS):
            try:
                FETCHERS[key]()
            except Exception as e:  # keep going with the other sources
                print(f"!! {key} download failed: {e}")
    if args.fetch_only:
        return 0
    parsed, meta = load_sources()
    if not parsed.get("arctracker"):
        print("!! ArcTracker data is required (it is the base item list)")
        return 1
    build(parsed, meta, args.report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
