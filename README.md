# ARC Raiders Stash Efficiency

A local, single-page table of every ARC Raiders item with its icon, stack size, recipe and
**stash efficiency**: how much stash space the crafted item takes compared with the
ingredients it is made from.

```
efficiency = (output qty / item stack) / Σ (ingredient qty / ingredient stack)
```

Bandage: 5 Fabric → 1 Bandage; Bandage stacks to 5, Fabric to 50, so
(1/5) / (5/50) = **2.00**, which means the bandage takes twice the space of its fabric.
Below 1 means crafting frees stash space; lower is better.

It also shows **recycling efficiency**, measured the same way (space after ÷ space before):

```
recycling = Σ (material qty / material stack) / (1 / item stack)
```

A Bandage recycles into 2 Fabric: (2/50) / (1/5) = **0.20**, so recycling it frees 80% of its
space. A few items are better kept whole: Ion Sputter scores 3.40, so its materials take 3.4× the space.
Salvage (in-raid) yields are shown in each item's details. Recycling yields are cross-checked
across the same four sources as recipes.

## Use it

Open `index.html` in your browser (double-click it). No server or install is needed, but
icons are loaded from the internet.

- Click a column header to sort, and click a row to see the full calculation, each source's
  stack size, other recipes the sources list, what the item is used in, and links to it on each site.
- **vs. base materials** breaks every craftable ingredient down recursively (e.g. Kettle IV →
  Kettle III → … → Metal/Rubber/Plastic Parts) and compares against that pile instead.
- **Disputed only** shows items where the sources disagree.
- Press `/` to jump to the search box. Search also matches ingredients and recycling outputs.
  When nothing matches exactly it shows close matches, so typos like "arc ruber" still find
  ARC Flex Rubber.

## Update the data after a patch

```
python -I tools/update_data.py
```

This downloads all four sources (about 5 minutes, mostly ARDB's per-item API), cross-checks
them and rewrites `data/items.js`. Reload the page afterwards. Other options:

- `--report` lists every disagreement between the sources.
- `--offline` rebuilds from the cached downloads in `data/raw/` without downloading anything.
- `--only wiki` re-downloads one source (`arctracker`, `metaforge`, `wiki` or `ardb`).

Only the Python standard library is used (Python 3.10+).

## Where the numbers come from

| Source | What it provides | Freshness when built |
|---|---|---|
| [ArcTracker](https://arctracker.io) public API | Base item list (game-data dump), stack sizes, recipes, upgrade costs, icons | dump of 2026-11-05 (after patch 2.4.0) |
| [MetaForge](https://metaforge.app/arc-raiders) API | Stack sizes, crafting components, upgrade and field-crafting operations | records updated Oct–Nov 2026 |
| [ARC Raiders Wiki](https://arcraiders.wiki/) | `stacksize`, `{{Crafting}}`, `{{Weapon upgrades}}`, the *Amplified Weapons* page | edits up to the download day |
| [ARDB](https://ardb.app/) API | Stack sizes and recipes for 500 items | last updated April 2026, so it is the stalest |

For each stack size, recipe and batch size, the value most sources agree on is used. Ties go
to ArcTracker, the newest source and one built from game data. Every disagreement is
flagged in the table rather than hidden. In the build from 2026-11-10:

- 13 of 993 stack sizes disagree. In all 13, ArcTracker and MetaForge agree and the outlier is
  ARDB or a wiki page. One worth checking yourself is **Emperor Beacon**: ArcTracker and MetaForge say 3,
  but a wiki editor changed it to 1 on 2026-11-10 with the note "fix stacksize".
- 30 items have a recipe that some source lists differently. Most look like outdated recipes still
  listed by ARDB or in MetaForge's component lists (e.g. Anvil I, Snap Hook), while ArcTracker and
  recent wiki edits agree on the newer one.
- 319 of 321 craftable items have their recipe confirmed by at least two sources. Banjo and
  Mountaineer's Detector are only listed by ArcTracker.

Modelling choices:

- Weapon upgrades (II–IV, Amplified, and each amplification) count the weapon being upgraded
  as an ingredient, since it occupies a slot until you upgrade it.
- Batch crafts use the batch size, e.g. 25 Light Ammo per craft.
- Blueprints and research unlocks are not ingredients, because crafting does not use them up.
- When an item has several recipes (amplification paths), the table shows the lowest efficiency.
  Every recipe is shown when you open the row.
- Character cosmetics are left out because they never take stash space. Items only MetaForge
  lists (mostly unreleased datamined items) are left out unless a second source confirms them.

## Files

```
index.html              the tool
assets/app.js           table, filters and efficiency math
assets/style.css        styling (dark and light theme)
data/items.js           generated data (do not edit; re-run the script)
data/raw/               cached raw downloads (not committed; created by the script)
tools/update_data.py    downloader + cross-checker
```

Unofficial fan tool. ARC Raiders is a trademark of Embark Studios. Item data and icons are
from the sites listed above.
