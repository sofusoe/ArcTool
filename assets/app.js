"use strict";

(function () {
  const D = window.ARC_DATA;
  const tbody = document.getElementById("rows");
  if (!D || !Array.isArray(D.items)) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="empty">No item data found. Open a terminal in the ArcTool folder, run ' +
      "<code>python -I tools/update_data.py</code>, then reload this page.</td></tr>";
    return;
  }

  // ---------------------------------------------------------------- setup
  const SRC = ["arctracker", "metaforge", "wiki", "ardb"];
  const SHORT = { arctracker: "AT", metaforge: "MF", wiki: "WK", ardb: "DB" };
  const SNAME = {};
  for (const s of SRC) SNAME[s] = (D.sources[s] && D.sources[s].name) || s;
  const CAT_ORDER = ["Weapon", "Quick Use", "Ammo", "Mod", "Gear", "Material", "Recyclable",
    "Trinket", "Key", "Blueprint", "Outpost", "Other"];

  const items = D.items;
  const byKey = new Map(items.map((it) => [it.key, it]));
  const unknown = D.unknownIngredients || {};
  const nameOf = (k) => (byKey.has(k) ? byKey.get(k).name : unknown[k] || k);
  const stackOf = (k) => (byKey.has(k) ? byKey.get(k).stack : null);

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // Search text: lowercase, accents removed, apostrophes dropped ("Mountaineer's" →
  // "mountaineers"), any other punctuation turned into a space.
  const fold = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  // True when token t is within a few typos of some part of word w (missing, extra, wrong or
  // swapped letters). Short tokens must match exactly; 4–6 letters allow 1 typo, longer ones 2.
  function fuzzyIn(t, w) {
    const k = t.length < 4 ? 0 : t.length < 7 ? 1 : 2;
    if (!k || w.length < t.length - k) return false;
    // approximate substring match (Sellers): matching may start anywhere in w, transpositions cost 1
    let prev2 = null, prev = new Array(w.length + 1).fill(0);
    for (let i = 1; i <= t.length; i++) {
      const cur = [i];
      for (let j = 1; j <= w.length; j++) {
        const cost = t[i - 1] === w[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && t[i - 1] === w[j - 2] && t[i - 2] === w[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur.push(v);
      }
      prev2 = prev; prev = cur;
    }
    return Math.min(...prev) <= k;
  }
  const fmtEff = (n) => (n == null ? "—" : n >= 100 ? n.toFixed(0) : n.toFixed(2));
  const fmtSlots = (n) => (n == null ? "—" : n >= 10 ? n.toFixed(1) : n.toFixed(3));
  const fmtQty = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));

  // ---------------------------------------------------------------- math
  // Stash slots taken by `out` crafted items vs. by the ingredients of one craft.
  function recipeStats(it, rc) {
    const outSlots = it.stack ? rc.out / it.stack : null;
    let inSlots = 0;
    let missing = 0;
    const lines = rc.inputs.map(([k, q]) => {
      const st = stackOf(k);
      const slots = st ? q / st : null;
      if (slots == null) missing++;
      else inSlots += slots;
      return { k, q, st, slots };
    });
    const eff = outSlots != null && !missing && inSlots > 0 ? outSlots / inSlots : null;
    return { rc, outSlots, inSlots, eff, lines };
  }

  for (const it of items) {
    it._stats = it.recipes.map((rc) => recipeStats(it, rc));
    it._other = it.otherRecipes.map((rc) => recipeStats(it, rc));
    let best = 0;
    it._stats.forEach((s, i) => {
      const b = it._stats[best].eff;
      if (s.eff != null && (b == null || s.eff < b)) best = i;
    });
    it._best = best;
    it._eff = it._stats.length ? it._stats[best].eff : null;
  }

  // Base materials for ONE unit of `key`; items that cannot be crafted are leaves.
  const rawMemo = new Map();
  function rawOf(key, path) {
    if (rawMemo.has(key)) return rawMemo.get(key);
    const it = byKey.get(key);
    const st = it && it._stats.length ? it._stats[it._best] : null;
    if (!st || path.has(key)) return new Map([[key, 1]]);
    path.add(key);
    const res = new Map();
    for (const [k, q] of st.rc.inputs) {
      for (const [rk, rq] of rawOf(k, path)) res.set(rk, (res.get(rk) || 0) + (rq * q) / st.rc.out);
    }
    path.delete(key);
    rawMemo.set(key, res);
    return res;
  }

  function rawStats(it) {
    if (!it._stats.length) return null;
    const st = it._stats[it._best];
    const mats = new Map();
    for (const [k, q] of st.rc.inputs) {
      for (const [rk, rq] of rawOf(k, new Set([it.key]))) mats.set(rk, (mats.get(rk) || 0) + rq * q);
    }
    let inSlots = 0;
    let missing = 0;
    const lines = [...mats].map(([k, q]) => {
      const s = stackOf(k);
      const slots = s ? q / s : null;
      if (slots == null) missing++;
      else inSlots += slots;
      return { k, q, st: s, slots };
    });
    lines.sort((a, b) => (b.slots || 0) - (a.slots || 0));
    const eff = st.outSlots != null && !missing && inSlots > 0 ? st.outSlots / inSlots : null;
    const deep = st.rc.inputs.some(([k]) => byKey.has(k) && byKey.get(k).recipes.length > 0);
    return { rc: st.rc, outSlots: st.outSlots, inSlots, eff, lines, deep };
  }

  for (const it of items) {
    it._raw = rawStats(it);
    it._rawEff = it._raw ? it._raw.eff : null;
  }

  // Recycling: slots the recycled materials take vs. the slot share of one item.
  // Same direction as crafting (space after ÷ space before), so lower is better.
  function yieldStats(it, list) {
    if (!list || !list.length) return null;
    const itemSlots = it.stack ? 1 / it.stack : null;
    let outSlots = 0;
    let missing = 0;
    const lines = list.map(([k, q]) => {
      const st = stackOf(k);
      const slots = st ? q / st : null;
      if (slots == null) missing++;
      else outSlots += slots;
      return { k, q, st, slots };
    });
    const eff = itemSlots != null && !missing ? outSlots / itemSlots : null;
    return { lines, itemSlots, outSlots, eff };
  }

  for (const it of items) {
    it._rec = yieldStats(it, it.recycle && it.recycle.out);
    it._recEff = it._rec ? it._rec.eff : null;
    it._salv = yieldStats(it, it.salvage && it.salvage.out);
  }

  // ---------------------------------------------------------------- source agreement
  for (const it of items) {
    // Per source: "agree" = confirms every value we show (stack, recipe, recycling yield),
    // "partial" = lists the item but not the recipe and/or the recycling yield,
    // "conflict" = gives a different value for something, "absent" = no such item.
    const states = {};
    const notes = {};
    const conflict = new Set();
    const craftable = it.recipes.length > 0;
    for (const s of SRC) {
      if (!it.sources[s]) {
        states[s] = "absent";
        continue;
      }
      const confirms = it.recipes.some((r) => r.src.includes(s));
      const listsOther = it.otherRecipes.some((r) => r.src.includes(s));
      const confirmsRec = !!(it.recycle && it.recycle.src.includes(s));
      const stackOff = it.stackVotes && it.stackVotes[s] != null && it.stackVotes[s] !== it.stack;
      const outOff = it.recipes.some((r) => r.outVotes && r.outVotes[s] != null && r.outVotes[s] !== r.out);
      const recOff = !!(it.recycle && it.recycle.votes && it.recycle.votes[s] && !confirmsRec);
      const off = [];
      if (stackOff) off.push("stack size");
      if (outOff || (listsOther && !confirms)) off.push("recipe");
      if (recOff) off.push("recycling yield");
      const missing = [];
      if (craftable && !confirms && !listsOther) missing.push("recipe");
      if (it.recycle && !confirmsRec && !recOff) missing.push("recycling yield");
      if (off.length) {
        states[s] = "conflict";
        conflict.add(s);
      } else if (missing.length) {
        states[s] = "partial";
      } else {
        states[s] = "agree";
      }
      notes[s] = off.length ? `disagrees on ${off.join(", ")}`
        : missing.length ? "matches what it lists" : "agrees on everything shown";
      if (missing.length) notes[s] += ` · lists no ${missing.join(" or ")}`;
    }
    it._states = states;
    it._notes = notes;
    it._conflict = conflict;
    it._agree = SRC.filter((s) => states[s] === "agree").length;
    it._hay = fold([it.name, it.type, it.cat, ...it.recipes.flatMap((r) => r.inputs.map(([k]) => nameOf(k))),
      ...(it.recycle ? it.recycle.out.map(([k]) => nameOf(k)) : [])].join(" "));
    it._nameF = fold(it.name);
    it._nameWords = [...new Set(it._nameF.split(" ").filter(Boolean))];
    it._words = [...new Set(it._hay.split(" ").filter(Boolean))];
  }

  // Stations that craft each item, e.g. "In-raid, Refiner 2" -> [{name: "In-raid", lvl: null}, {name: "Refiner", lvl: 2}]
  const STATION_ORDER = ["Workbench", "Gunsmith", "Gear Bench", "Medical Lab", "Explosives Station",
    "Utility Station", "Refiner", "In-raid"];
  const stationLevels = new Map(); // name -> Set of levels seen
  for (const it of items) {
    const seen = new Map();
    for (const rc of it.recipes) {
      for (const part of String(rc.station || "").split(",")) {
        const m = part.trim().match(/^(.*?)(?:\s+(\d+))?$/);
        if (!m || !m[1]) continue;
        const name = m[1];
        const lvl = m[2] ? Number(m[2]) : null;
        const prev = seen.get(name);
        // keep the lowest level the item needs at this station (null = level not stated)
        if (!seen.has(name) || (lvl != null && (prev == null || lvl < prev))) seen.set(name, lvl);
        if (!stationLevels.has(name)) stationLevels.set(name, new Set());
        if (lvl != null) stationLevels.get(name).add(lvl);
      }
    }
    it._stations = seen;
  }

  const usedIn = new Map();
  for (const it of items) {
    for (const rc of it.recipes) {
      for (const [k, q] of rc.inputs) {
        if (!usedIn.has(k)) usedIn.set(k, []);
        const list = usedIn.get(k);
        if (!list.some((u) => u.it === it)) list.push({ it, q });
      }
    }
  }
  const recycledFrom = new Map();
  for (const it of items) {
    for (const [k, q] of (it.recycle ? it.recycle.out : [])) {
      if (!recycledFrom.has(k)) recycledFrom.set(k, []);
      recycledFrom.get(k).push({ it, q });
    }
  }

  // ---------------------------------------------------------------- state
  // hiddenCats: categories switched off; every category is shown by default
  const DEFAULTS = { mode: "direct", sort: "eff", dir: 1, hiddenCats: [], station: "", stLevels: {}, craftable: false, recyclable: false,
    disputed: false, phased: false };
  let state = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem("arc-stash-efficiency") || "null");
    if (saved && typeof saved === "object") state = { ...state, ...saved };
  } catch (e) { /* storage unavailable */ }
  delete state.cats; // pre-toggle setting
  if (!Array.isArray(state.hiddenCats)) state.hiddenCats = [];
  if (!state.stLevels || typeof state.stLevels !== "object") state.stLevels = {};
  if (String(state.station).includes("|")) state.station = state.station.split("|")[0]; // old dropdown format
  state.q = "";
  const save = () => {
    try {
      const { q, ...rest } = state;
      localStorage.setItem("arc-stash-efficiency", JSON.stringify(rest));
    } catch (e) { /* storage unavailable */ }
  };
  const open = new Set();

  const effOf = (it) => (state.mode === "raw" ? it._rawEff : it._eff);

  // ---------------------------------------------------------------- rendering helpers
  const rarityClass = (it) => "r-" + String(it.rarity || "common").toLowerCase();

  function iconHTML(it, cls) {
    const icons = (it && it.icons) || [];
    if (!icons.length) return `<span class="${cls === "mini" ? "mini " : ""}ph">${esc((it ? it.name : "?").charAt(0))}</span>`;
    return `<img src="${esc(icons[0])}" data-key="${esc(it.key)}" data-i="0" alt="" loading="lazy" decoding="async"${cls ? ` class="${cls}"` : ""}>`;
  }

  // Swap to the next icon source when one fails to load.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.key) return;
    const it = byKey.get(img.dataset.key);
    const next = Number(img.dataset.i) + 1;
    if (it && it.icons[next]) {
      img.dataset.i = String(next);
      img.src = it.icons[next];
    } else {
      const ph = document.createElement("span");
      ph.className = img.classList.contains("mini") ? "mini ph" : "ph";
      ph.textContent = it ? it.name.charAt(0) : "?";
      img.replaceWith(ph);
    }
  }, true);

  function effClass(e) {
    if (e == null) return "";
    if (e < 0.995) return "good";
    if (e > 1.005) return "bad";
    return "even";
  }

  function gaugeHTML(e) {
    if (e == null) return "";
    // log2 scale: 1/4 .. 4 fills one half of the track
    const x = Math.max(-1, Math.min(1, Math.log2(e) / 2));
    const w = Math.abs(x) * 50;
    if (w < 0.5) return '<div class="gauge"></div>';
    return `<div class="gauge"><i class="${x < 0 ? "good" : "bad"}" style="width:${w.toFixed(1)}%"></i></div>`;
  }

  function ingChips(list, prevKind) {
    return list.map(([k, q]) => {
      const ing = byKey.get(k);
      const isPrev = prevKind && ing && ing.cat === "Weapon";
      return `<span class="ing${isPrev ? " prev" : ""}" title="${esc(nameOf(k))}${ing && ing.stack ? ` · stack ${ing.stack}` : ""}">` +
        `${iconHTML(ing || { key: k, name: nameOf(k), icons: [] }, "mini")}<span class="q">${q}×</span>${esc(nameOf(k))}</span>`;
    }).join("");
  }

  function srcBadges(it) {
    return SRC.map((s) => {
      const st = it._states[s];
      const info = it.sources[s];
      let tip = `${SNAME[s]}: `;
      if (st === "absent") tip += "does not list this item";
      else {
        const sv = it.stackVotes ? it.stackVotes[s] : null;
        tip += it._notes[s];
        if (sv != null) tip += ` · stack ${sv}`;
        if (info && info.updated) tip += ` · updated ${info.updated}`;
      }
      return `<span class="sb ${st}" title="${esc(tip)}">${SHORT[s]}</span>`;
    }).join("");
  }

  function rowHTML(it) {
    const e = effOf(it);
    const isOpen = open.has(it.key);
    const tags = [];
    if (it.phasedOut) tags.push('<span class="tag">phased out</span>');
    if (it.blueprint) tags.push('<span class="tag" title="Needs a learned blueprint to craft">blueprint</span>');

    let recipe = '<span class="none">Not craftable</span>';
    if (it._stats.length) {
      const st = it._stats[it._best];
      const rc = st.rc;
      const extra = it._stats.length > 1 ? ` · ${it._stats.length - 1} more recipe${it._stats.length > 2 ? "s" : ""}` : "";
      recipe = `<div class="ings">${ingChips(rc.inputs, rc.kind === "upgrade")}` +
        (rc.out !== 1 ? `<span class="out">→ <b>${rc.out}</b> per craft</span>` : "") + "</div>" +
        `<div class="station">${rc.kind === "upgrade" ? "Upgrade" : "Craft"}${rc.station ? " · " + esc(rc.station) : ""}${extra}</div>`;
    }
    if (it.recycle) {
      recipe += `<div class="ings recy"><span class="lbl-recy" title="Recycles into">♻</span>${ingChips(it.recycle.out, false)}</div>`;
    }

    let note = "";
    if (state.mode === "raw" && it._raw && !it._raw.deep && e != null) note = "same as direct";
    else if (it._stats.length && e != null) {
      const sup = it._stats[it._best].rc.src.length;
      note = `recipe: ${sup} source${sup === 1 ? "" : "s"}`;
    }
    const re = it._recEff;
    let recNote = "";
    if (re != null) {
      const sup = it.recycle.src.length;
      recNote = `yield: ${sup} source${sup === 1 ? "" : "s"}${it.recycle.votes ? " · disputed" : ""}`;
    }

    const stackDot = it.stackVotes ? '<span class="dot" title="Sources disagree on the stack size"></span>' : "";
    return `<tr class="row ${rarityClass(it)}${isOpen ? " open" : ""}" data-key="${esc(it.key)}" aria-expanded="${isOpen}">` +
      `<td class="c-icon"><div class="ic">${iconHTML(it)}</div></td>` +
      `<td class="c-name"><div class="nm">${esc(it.name)}${tags.join("")}</div>` +
      `<div class="sub"><span class="rar">${esc(it.rarity || "")}</span> · ${esc(it.type || it.cat)}</div></td>` +
      `<td class="c-stack num"><span class="stk">${it.stack ?? "?"}</span>${stackDot}</td>` +
      `<td class="c-recipe">${recipe}</td>` +
      `<td class="c-eff"><div class="eff"><span class="v ${effClass(e)}" title="${e == null ? "Not craftable" : "crafting efficiency " + e.toFixed(4)}">${fmtEff(e)}</span>${gaugeHTML(e)}` +
      `${note ? `<span class="note">${note}</span>` : ""}</div></td>` +
      `<td class="c-rec"><div class="eff"><span class="v ${effClass(re)}" title="${re == null ? "Not recyclable" : "recycling efficiency " + re.toFixed(4)}">${fmtEff(re)}</span>${gaugeHTML(re)}` +
      `${recNote ? `<span class="note${it.recycle.votes ? " disp" : ""}">${recNote}</span>` : ""}</div></td>` +
      `<td class="c-src"><div class="srcs">${srcBadges(it)}</div></td></tr>` +
      (isOpen ? detailHTML(it) : "");
  }

  // ---------------------------------------------------------------- detail panel
  function verdict(e) {
    if (e == null) return "Cannot be computed (an ingredient has no known stack size).";
    if (e < 0.995) {
      return `<b class="good">${fmtEff(e)}</b>: the crafted item needs only <b>${Math.round(e * 100)}%</b> of the stash space of its ingredients, so crafting frees space.`;
    }
    if (e > 1.005) {
      return `<b class="bad">${fmtEff(e)}</b>: the crafted item takes <b>${fmtEff(e)}×</b> the stash space of its ingredients, so the ingredients are more compact.`;
    }
    return `<b>${fmtEff(e)}</b>: about the same space either way.`;
  }

  function calcTable(it, lines, outQty, outSlots, inSlots) {
    const body = lines.map((l) =>
      `<tr><td><span class="lnk" data-jump="${esc(l.k)}">${esc(nameOf(l.k))}</span></td><td class="num">${fmtQty(l.q)}</td>` +
      `<td class="num">${l.st ?? "?"}</td><td class="num">${fmtSlots(l.slots)}</td></tr>`).join("");
    return `<table class="calc"><thead><tr><th>Ingredient</th><th>Qty</th><th>Stack</th><th>Slots</th></tr></thead><tbody>${body}` +
      `<tr class="sum"><td>Ingredients total</td><td></td><td></td><td class="num">${fmtSlots(inSlots)}</td></tr>` +
      `<tr class="out"><td>Crafted: ${esc(it.name)}</td><td class="num">${fmtQty(outQty)}</td><td class="num">${it.stack ?? "?"}</td>` +
      `<td class="num">${fmtSlots(outSlots)}</td></tr></tbody></table>`;
  }

  const srcList = (list) => list.map((s) => SNAME[s]).join(", ");

  // "listed by A, B · not by C" (C has the item but not this value)
  function byline(it, src, what) {
    const lacking = SRC.filter((s) => it.sources[s] && !src.includes(s));
    return `listed by ${esc(srcList(src))}` +
      (lacking.length ? ` <span class="lack" title="These sources have the item but not this ${what}">· not by ${esc(srcList(lacking))}</span>` : "");
  }

  function recVerdict(e) {
    if (e == null) return "Cannot be computed (a material has no known stack size).";
    if (e < 0.995) {
      return `<b class="good">${fmtEff(e)}</b>: the materials take only <b>${Math.round(e * 100)}%</b> of the item's stash space, so recycling frees <b>${Math.round((1 - e) * 100)}%</b>.`;
    }
    if (e > 1.005) {
      return `<b class="bad">${fmtEff(e)}</b>: the materials take <b>${fmtEff(e)}×</b> the item's stash space, so keeping the item is more compact.`;
    }
    return `<b>${fmtEff(e)}</b>: about the same space either way.`;
  }

  function yieldTable(it, r) {
    const body = r.lines.map((l) =>
      `<tr><td><span class="lnk" data-jump="${esc(l.k)}">${esc(nameOf(l.k))}</span></td><td class="num">${fmtQty(l.q)}</td>` +
      `<td class="num">${l.st ?? "?"}</td><td class="num">${fmtSlots(l.slots)}</td></tr>`).join("");
    return `<table class="calc"><thead><tr><th>Recycled into</th><th>Qty</th><th>Stack</th><th>Slots</th></tr></thead><tbody>` +
      `<tr class="out"><td>Recycled: ${esc(it.name)}</td><td class="num">1</td><td class="num">${it.stack ?? "?"}</td>` +
      `<td class="num">${fmtSlots(r.itemSlots)}</td></tr>${body}` +
      `<tr class="sum"><td>Materials total</td><td></td><td></td><td class="num">${fmtSlots(r.outSlots)}</td></tr></tbody></table>`;
  }

  function recipeCard(it, st, label) {
    const rc = st.rc;
    return `<div class="rcard"><div class="rhead"><span class="lbl">${label} · ${rc.kind === "upgrade" ? "Upgrade" : "Craft"}${rc.station ? " · " + esc(rc.station) : ""}</span>` +
      `<span class="by">${byline(it, rc.src, "recipe")}</span></div>` +
      calcTable(it, st.lines, rc.out, st.outSlots, st.inSlots) +
      `<div class="verdict">${fmtSlots(st.outSlots)} ÷ ${fmtSlots(st.inSlots)} = ${verdict(st.eff)}</div>` +
      (rc.outVotes ? `<div class="alt">Output per craft differs: ${esc(Object.entries(rc.outVotes).map(([s, v]) => `${SNAME[s]} ${v}`).join(", "))}</div>` : "") +
      "</div>";
  }

  function link(s, it) {
    const info = it.sources[s];
    if (!info) return "";
    const id = encodeURIComponent(info.id);
    const url = {
      arctracker: `https://arctracker.io/items/${id}`,
      metaforge: `https://metaforge.app/arc-raiders/item/${id}`,
      wiki: `https://arcraiders.wiki/wiki/${encodeURIComponent(String(info.id).replace(/ /g, "_"))}`,
      ardb: `https://ardb.app/db/items/${id}`,
    }[s];
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(SNAME[s])}</a>`;
  }

  function detailHTML(it) {
    const left = [];
    const right = [];
    if (it._stats.length) {
      left.push("<h3>How the number is calculated</h3>");
      it._stats.forEach((st, i) => {
        const label = it._stats.length > 1 ? `Recipe ${i + 1}${i === it._best ? " (used)" : ""}` : "Recipe";
        left.push(recipeCard(it, st, label));
      });
      if (it._raw && it._raw.deep) {
        const r = it._raw;
        left.push("<h3>Broken down to base materials</h3>");
        left.push(`<div class="rcard">${calcTable(it, r.lines, r.rc.out, r.outSlots, r.inSlots)}` +
          `<div class="verdict">${fmtSlots(r.outSlots)} ÷ ${fmtSlots(r.inSlots)} = ${verdict(r.eff)}</div>` +
          '<div class="small">Every craftable ingredient is replaced by its own recipe (the one used above), down to items that cannot be crafted.</div></div>');
      }
      if (it._other.length) {
        left.push("<h3>Recipes other sources list</h3>");
        for (const st of it._other) {
          const confirmsToo = st.rc.src.every((s) => it.recipes.some((r) => r.src.includes(s)));
          left.push(`<div class="alt">${esc(srcList(st.rc.src))}: ${st.rc.inputs.map(([k, q]) => `${q}× ${esc(nameOf(k))}`).join(" + ")}` +
            `${st.rc.out !== 1 ? ` → ${st.rc.out}` : ""}${st.rc.station ? ` (${esc(st.rc.station)})` : ""}` +
            ` · efficiency <b>${fmtEff(st.eff)}</b>${confirmsToo ? " · alternative recipe" : " · <span class=\"warn\">conflicts with the recipe used</span>"}</div>`);
        }
      }
    } else {
      left.push('<h3>Crafting</h3><p class="small">No source lists a crafting recipe for this item, so it has no crafting efficiency.</p>');
    }

    if (it._rec) {
      const r = it._rec;
      left.push("<h3>Recycling</h3>");
      left.push(`<div class="rcard"><div class="rhead"><span class="lbl">Recycle 1× ${esc(it.name)}</span>` +
        `<span class="by">${byline(it, it.recycle.src, "recycling yield")}</span></div>` +
        yieldTable(it, r) +
        `<div class="verdict">${fmtSlots(r.outSlots)} ÷ ${fmtSlots(r.itemSlots)} = ${recVerdict(r.eff)}</div>`);
      if (it.recycle.votes) {
        for (const [s, v] of Object.entries(it.recycle.votes)) {
          if (it.recycle.src.includes(s)) continue;
          const alt = yieldStats(it, v);
          left.push(`<div class="alt"><span class="warn">${esc(SNAME[s])} says</span>: ${v.map(([k, q]) => `${q}× ${esc(nameOf(k))}`).join(" + ")}` +
            ` · efficiency <b>${fmtEff(alt && alt.eff)}</b></div>`);
        }
      }
      if (it._salv) {
        left.push(`<div class="alt">Salvaging in a raid gives ${it.salvage.out.map(([k, q]) => `${q}× ${esc(nameOf(k))}`).join(" + ")}` +
          ` · efficiency <b>${fmtEff(it._salv.eff)}</b> <span class="small">(${esc(srcList(it.salvage.src))})</span></div>`);
      }
      left.push("</div>");
    } else {
      left.push('<h3>Recycling</h3><p class="small">No source lists a recycling yield for this item.</p>');
    }

    right.push("<h3>Stack size by source</h3><dl class=\"kv\">");
    for (const s of SRC) {
      if (!it.sources[s]) continue;
      const v = it.stackVotes ? it.stackVotes[s] : it.stack;
      const off = it.stackVotes && v != null && v !== it.stack;
      const upd = it.sources[s].updated ? ` <span class="small">(updated ${esc(it.sources[s].updated)})</span>` : "";
      right.push(`<dt>${esc(SNAME[s])}</dt><dd class="${off ? "warn" : ""}">${v ?? (it.stackSrc.includes(s) ? it.stack : "not listed")}${upd}</dd>`);
    }
    right.push("</dl>");
    if (it.stackVotes) right.push(`<p class="small">Using ${it.stack}, the value most sources agree on.</p>`);

    const uses = usedIn.get(it.key) || [];
    if (uses.length) {
      right.push(`<h3>Used in (${uses.length})</h3><div class="used">`);
      for (const u of uses.slice(0, 60)) {
        right.push(`<span class="ing" data-jump="${esc(u.it.key)}">${iconHTML(u.it, "mini")}<span class="q">${u.q}×</span>${esc(u.it.name)}</span>`);
      }
      if (uses.length > 60) right.push(`<span class="small">…and ${uses.length - 60} more</span>`);
      right.push("</div>");
    }

    const from = recycledFrom.get(it.key) || [];
    if (from.length) {
      right.push(`<h3>Recycled from (${from.length})</h3><div class="used">`);
      for (const u of from.slice(0, 60)) {
        right.push(`<span class="ing" data-jump="${esc(u.it.key)}">${iconHTML(u.it, "mini")}${esc(u.it.name)}<span class="q">→ ${u.q}×</span></span>`);
      }
      if (from.length > 60) right.push(`<span class="small">…and ${from.length - 60} more</span>`);
      right.push("</div>");
    }

    const facts = [];
    if (it.value != null) facts.push(`Sell value ${it.value.toLocaleString()}`);
    if (it.weight != null) facts.push(`weight ${it.weight} kg`);
    if (it.addedIn) facts.push(`added in ${it.addedIn === "base" ? "launch" : "update " + esc(it.addedIn)}`);
    right.push(`<h3>Item</h3><p class="small">${facts.join(" · ")}</p>`);
    right.push(`<h3>Open on</h3><div class="links">${SRC.map((s) => link(s, it)).join("")}</div>`);

    return `<tr class="detail" data-for="${esc(it.key)}"><td colspan="7"><div class="dgrid"><div>${left.join("")}</div><div>${right.join("")}</div></div></td></tr>`;
  }

  // ---------------------------------------------------------------- filter / sort / render
  const $q = document.getElementById("q");
  const $count = document.getElementById("count");
  const $cats = document.getElementById("cats");
  const $craftable = document.getElementById("craftable");
  const $recyclable = document.getElementById("recyclable");
  const $stations = document.getElementById("stations");

  // Station filter: state.station = "" (any) or a station name. state.stLevels remembers the
  // level picked per station; without one the station's highest level is used, which means
  // "everything this station makes". A lower level shows what that bench level can already craft.
  const maxLevel = (name) => Math.max(0, ...stationLevels.get(name));
  const levelOf = (name) => {
    const l = state.stLevels[name];
    return l && l < maxLevel(name) ? l : maxLevel(name);
  };
  function matchesStation(it, name = state.station, level = name ? levelOf(name) : 0) {
    if (!name) return true;
    if (!it._stations.has(name)) return false;
    if (level >= maxLevel(name)) return true; // top level: everything, incl. unknown levels
    const lvl = it._stations.get(name);
    return lvl != null && lvl <= level;
  }

  function renderStations() {
    const shown = items.filter((it) => state.phased || !it.phasedOut);
    const count = (name, level) => shown.filter((it) => matchesStation(it, name, level)).length;
    const names = [...stationLevels.keys()].sort((a, b) =>
      (STATION_ORDER.indexOf(a) + 1 || 99) - (STATION_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    if (state.station && !stationLevels.has(state.station)) state.station = "";
    let html = '<span class="lbl">Station</span>' +
      `<span class="stchip${state.station ? "" : " on"}"><button type="button" class="stbtn" data-st="" ` +
      `aria-pressed="${!state.station}">Any</button></span>`;
    for (const name of names) {
      const on = state.station === name;
      const levels = [...stationLevels.get(name)].sort((a, b) => a - b);
      const hasPicker = levels.length > 1;
      const cur = levelOf(name);
      const lowered = hasPicker && cur < maxLevel(name);
      html += `<span class="stchip${hasPicker ? " lv" : ""}${on ? " on" : ""}">` +
        `<button type="button" class="stbtn" data-st="${esc(name)}" aria-pressed="${on}" ` +
        `title="Show items crafted at the ${esc(name)}${lowered ? ` (level ${cur} or lower)` : ""}">${esc(name)}` +
        `${lowered ? `<span class="lv">≤ Lv ${cur}</span>` : ""}<span class="n">${count(name, cur)}</span></button>`;
      if (hasPicker) {
        html += `<span class="starrow"><select class="stlvl" data-st="${esc(name)}" aria-label="${esc(name)} level" ` +
          `title="Pick a ${esc(name)} level to see only what that level (and below) can craft">` +
          levels.map((l) => `<option value="${l}"${l === cur ? " selected" : ""}>` +
            `${l === maxLevel(name) ? `Lv ${l} · everything` : `Up to Lv ${l}`} (${count(name, l)})</option>`).join("") +
          "</select></span>";
      }
      html += "</span>";
    }
    $stations.innerHTML = html;
  }
  const $disputed = document.getElementById("disputed");
  const $phased = document.getElementById("phased");

  // Search runs in tiers: exact substrings anywhere (name, type, category, ingredients,
  // recycling outputs). Only when nothing matches exactly does it fall back to close matches,
  // first against item names, then against everything, so typos like "arc ruber" still find
  // ARC Flex Rubber without exact searches getting noisy.
  let searchNote = "";
  function visibleItems() {
    const tokens = fold(state.q).split(" ").filter(Boolean);
    const hidden = new Set(state.hiddenCats);
    const pool = items.filter((it) => {
      if (!state.phased && it.phasedOut) return false;
      if (state.craftable && !it.recipes.length) return false;
      if (state.recyclable && !it.recycle) return false;
      if (!matchesStation(it)) return false;
      if (state.disputed && !it._conflict.size) return false;
      return !hidden.has(it.cat);
    });
    searchNote = "";
    if (!tokens.length) return pool;
    const exact = pool.filter((it) => tokens.every((t) => it._hay.includes(t)));
    if (exact.length) return exact;
    const byName = pool.filter((it) => tokens.every((t) => it._nameF.includes(t) || it._nameWords.some((w) => fuzzyIn(t, w))));
    const close = byName.length ? byName
      : pool.filter((it) => tokens.every((t) => it._hay.includes(t) || it._words.some((w) => fuzzyIn(t, w))));
    if (close.length) searchNote = `no exact match for “${state.q.trim()}”, showing close matches`;
    return close;
  }

  function sortItems(list) {
    const dir = state.dir;
    const byName = (a, b) => a.name.localeCompare(b.name);
    const cmp = {
      name: (a, b) => dir * byName(a, b),
      stack: (a, b) => dir * ((a.stack || 0) - (b.stack || 0)) || byName(a, b),
      src: (a, b) => dir * (b._agree - a._agree) || byName(a, b),
      eff: (a, b) => byValue(effOf(a), effOf(b)) || byName(a, b),
      rec: (a, b) => byValue(a._recEff, b._recEff) || byName(a, b),
    }[state.sort] || ((a, b) => byName(a, b));
    function byValue(x, y) {
      if (x == null && y == null) return 0;
      if (x == null) return 1; // items without a value always go last
      if (y == null) return -1;
      return dir * (x - y);
    }
    return list.sort(cmp);
  }

  function renderCats() {
    const counts = {};
    for (const it of items) if (state.phased || !it.phasedOut) counts[it.cat] = (counts[it.cat] || 0) + 1;
    const hidden = new Set(state.hiddenCats);
    $cats.innerHTML =
      `<button type="button" class="chip quick" data-all="1" title="Show every category">All</button>` +
      `<button type="button" class="chip quick" data-all="0" title="Hide every category">None</button>` +
      CAT_ORDER.filter((c) => counts[c]).map((c) => {
        const on = !hidden.has(c);
        return `<button type="button" class="chip${on ? " on" : ""}" data-cat="${esc(c)}" aria-pressed="${on}" ` +
          `title="Click to ${on ? "hide" : "show"} ${esc(c)}">${esc(c)}<span class="n">${counts[c]}</span></button>`;
      }).join("");
  }

  function render() {
    const list = sortItems(visibleItems());
    tbody.innerHTML = list.length
      ? list.map(rowHTML).join("")
      : '<tr><td colspan="7" class="empty">No items match these filters.</td></tr>';
    const withEff = list.filter((it) => effOf(it) != null).length;
    const withRec = list.filter((it) => it._recEff != null).length;
    $count.textContent = `Showing ${list.length} of ${items.length} items · ${withEff} craftable · ${withRec} recyclable` +
      (searchNote ? ` · ${searchNote}` : "");
    document.querySelectorAll("th button[data-sort]").forEach((b) => {
      if (b.dataset.sort === state.sort) b.setAttribute("aria-sort", state.dir > 0 ? "ascending" : "descending");
      else b.removeAttribute("aria-sort");
    });
    document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
    $reset.disabled = !filtersActive();
  }

  // "Clear all filters": search, checkboxes, station (and its levels) and categories.
  // The comparison mode and the sort order are views, not filters, so they stay.
  const $reset = document.getElementById("reset");
  const filtersActive = () => !!($q.value || state.q || state.craftable || state.recyclable || state.disputed ||
    state.phased || state.station || state.hiddenCats.length || Object.keys(state.stLevels).length);
  function resetFilters() {
    clearTimeout(qTimer);
    $q.value = "";
    Object.assign(state, { q: "", craftable: false, recyclable: false, disputed: false, phased: false,
      station: "", stLevels: {}, hiddenCats: [] });
    for (const el of [$craftable, $recyclable, $disputed, $phased]) el.checked = false;
    syncClear();
    save();
    renderCats();
    renderStations();
    render();
  }

  // ---------------------------------------------------------------- events
  const $qclear = document.getElementById("qclear");
  const syncClear = () => { $qclear.hidden = !$q.value; };
  function clearSearch() {
    clearTimeout(qTimer);
    $q.value = "";
    state.q = "";
    syncClear();
    render();
  }
  let qTimer = 0;
  $q.addEventListener("input", () => {
    syncClear();
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = $q.value; render(); }, 120);
  });
  $q.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearSearch();
  });
  $reset.addEventListener("click", resetFilters);
  $qclear.addEventListener("click", () => {
    clearSearch();
    $q.focus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $q && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      $q.focus();
    }
  });

  for (const [el, key] of [[$craftable, "craftable"], [$recyclable, "recyclable"], [$disputed, "disputed"], [$phased, "phased"]]) {
    el.checked = !!state[key];
    el.addEventListener("change", () => {
      state[key] = el.checked;
      save();
      if (key === "phased") { renderCats(); renderStations(); }
      render();
    });
  }

  $cats.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cat], button[data-all]");
    if (!b) return;
    if (b.dataset.all) {
      state.hiddenCats = b.dataset.all === "1" ? [] : [...CAT_ORDER];
    } else {
      const c = b.dataset.cat;
      state.hiddenCats = state.hiddenCats.includes(c)
        ? state.hiddenCats.filter((x) => x !== c)
        : [...state.hiddenCats, c];
    }
    save();
    renderCats();
    render();
  });

  document.querySelector(".seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b || b.dataset.mode === state.mode) return;
    state.mode = b.dataset.mode;
    save();
    render();
  });

  document.querySelector("thead").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    const s = b.dataset.sort;
    if (state.sort === s) state.dir = -state.dir;
    else { state.sort = s; state.dir = 1; }
    save();
    render();
  });

  function jumpTo(key) {
    const it = byKey.get(key);
    if (!it) return;
    $q.value = it.name;
    syncClear();
    state.q = it.name;
    state.hiddenCats = [];
    state.craftable = false;
    state.recyclable = false;
    state.station = "";
    state.disputed = false;
    $craftable.checked = false;
    $recyclable.checked = false;
    renderStations();
    $disputed.checked = false;
    if (it.phasedOut) { state.phased = true; $phased.checked = true; }
    open.add(key);
    renderCats();
    render();
    const row = tbody.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
    if (row) row.scrollIntoView({ block: "center" });
  }

  tbody.addEventListener("click", (e) => {
    const j = e.target.closest("[data-jump]");
    if (j) { jumpTo(j.dataset.jump); return; }
    if (e.target.closest("a")) return;
    const row = e.target.closest("tr.row");
    if (!row) return;
    const key = row.dataset.key;
    const it = byKey.get(key);
    if (open.has(key)) {
      open.delete(key);
      const d = row.nextElementSibling;
      if (d && d.classList.contains("detail")) d.remove();
      row.classList.remove("open");
      row.setAttribute("aria-expanded", "false");
    } else {
      open.add(key);
      row.insertAdjacentHTML("afterend", detailHTML(it));
      row.classList.add("open");
      row.setAttribute("aria-expanded", "true");
    }
  });

  // keep the table header just under the sticky controls
  const controls = document.getElementById("controls");
  const syncHeader = () => document.documentElement.style.setProperty("--controls-h", controls.offsetHeight + "px");
  window.addEventListener("resize", syncHeader);

  // ---------------------------------------------------------------- header / footer text
  const at = D.sources.arctracker || {};
  const fetched = (D.sources.metaforge && D.sources.metaforge.fetchedAt) || D.generated;
  const day = (s) => (s ? String(s).slice(0, 10) : "?");
  document.getElementById("meta").innerHTML =
    `${items.length} items · data from ` +
    SRC.map((s) => `<a href="${esc(D.sources[s].url)}" target="_blank" rel="noopener noreferrer">${esc(SNAME[s])}</a>`).join(", ") +
    ` · ArcTracker dump ${day(at.generatedAt)} · downloaded ${day(fetched)} · built ${day(D.generated)}`;

  const nStackConf = items.filter((it) => it.stackVotes).length;
  const nRecipeConf = items.filter((it) => [...it._conflict].some((s) => it.otherRecipes.some((r) => r.src.includes(s)))).length;
  const nRecConf = items.filter((it) => it.recycle && it.recycle.votes).length;
  document.getElementById("footer").innerHTML = `
    <p><b>How values are chosen.</b> Stack sizes, recipes and recycling yields are cross-checked across four community sources:
      ArcTracker (game-data dump), MetaForge, the ARC Raiders Wiki and ARDB. When they disagree, the value most sources
      agree on is used, and ties go to ArcTracker as the newest source. Disagreements are marked in amber
      (${nStackConf} stack sizes, ${nRecipeConf} recipes, ${nRecConf} recycling yields in this build); open a row to see every source's value.</p>
    <p><b>Recycling efficiency</b> = slots taken by the materials you get from recycling one item ÷ the slot share of that item.
      Below 1 means recycling frees space (0.20 frees 80%). It measures space only, not whether the materials are worth more than the item.
      Salvaging (in-raid) yields are shown when you open a row.</p>
    <p><b>What counts as an ingredient.</b> Weapon upgrades (II–IV, Amplified and each amplification) count the weapon being
      upgraded as one ingredient, since it occupies a slot until you upgrade it. Batch crafts use the batch size (e.g. 25 Light Ammo
      per craft). Blueprints and research unlocks are not ingredients, because they are not used up.</p>
    <p><b>vs. base materials</b> replaces every craftable ingredient with its own recipe, all the way down to items that cannot
      be crafted, and compares against that pile instead.</p>
    <p><b>Updating.</b> After a game patch, run <code>python -I tools/update_data.py</code> in this folder and reload.
      Add <code>--report</code> to list every disagreement between the sources.</p>
    <p>Item data and icons: <a href="https://arctracker.io" target="_blank" rel="noopener noreferrer">ArcTracker</a>,
      <a href="https://metaforge.app/arc-raiders" target="_blank" rel="noopener noreferrer">MetaForge</a>,
      <a href="https://arcraiders.wiki/" target="_blank" rel="noopener noreferrer">ARC Raiders Wiki</a>,
      <a href="https://ardb.app/" target="_blank" rel="noopener noreferrer">ARDB</a>.
      ARC Raiders is a trademark of Embark Studios; this is an unofficial fan tool.</p>`;

  $stations.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-st]");
    if (!b) return;
    const name = b.dataset.st;
    state.station = state.station === name ? "" : name; // clicking the active station turns it off
    save();
    renderStations();
    render();
  });
  $stations.addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-st]");
    if (!sel) return;
    state.stLevels = { ...state.stLevels, [sel.dataset.st]: Number(sel.value) };
    state.station = sel.dataset.st; // picking a level also selects that station
    save();
    renderStations();
    render();
  });

  renderStations();
  renderCats();
  render();
  syncHeader();
})();
