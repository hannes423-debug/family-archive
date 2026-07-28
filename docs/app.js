/* Family Archive — the published tree.
 *
 * No build step and no dependencies: this file is served as-is. It loads the
 * redacted payload written by tools/build_site.py, lays the graph out in
 * generation layers, and renders it as SVG.
 *
 * The layout is a small Sugiyama: people are grouped into "units" (a couple,
 * or a single person), units are assigned to a layer by generation, ordered
 * within the layer by repeated barycentre sweeps, then given real x positions
 * by a priority pass that pulls each unit toward its relatives and pushes
 * overlaps apart. That handles the thing a plain recursive tree layout cannot
 * — two separate ancestral lines that merge lower down when their descendants
 * marry, which is most of this tree.
 */
'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';

// The redaction rules, shared with the editor and the test suites. This file
// only ever reads them — deciding what is publishable is not the viewer's job.
const V = window.Visibility;

const SPOUSE_GAP = 26;   // between the two cards of a couple
const UNIT_GAP = 34;     // between neighbouring units in a layer

/**
 * Two ways to draw a person. The compact card is the dense one, which is what
 * lets five generations fit on a screen at once; the portrait card spends that
 * space on a face and the years under it, which is what people actually
 * recognise a relative by. Everything downstream reads the four dimensions, so
 * switching is a relayout and nothing more.
 */
const MODES = {
  compact:  { CARD_W: 204, CARD_H: 80,  GEN_H: 200, BUS_DROP: 58 },
  portrait: { CARD_W: 204, CARD_H: 152, GEN_H: 286, BUS_DROP: 76 },
};
const MODE_KEY = 'familyArchive.view.v1';

let viewMode = 'compact';
let CARD_W, CARD_H, GEN_H, BUS_DROP;

function applyMode(mode) {
  viewMode = MODES[mode] ? mode : 'compact';
  ({ CARD_W, CARD_H, GEN_H, BUS_DROP } = MODES[viewMode]);
  document.body.dataset.view = viewMode;
}

// ?view=portrait wins over the remembered choice, so a shared link can carry
// the card style the sender was looking at.
applyMode(new URLSearchParams(location.search).get('view')
  || localStorage.getItem(MODE_KEY) || 'compact');

// The portrait circle, in card-local coordinates.
const FACE = { cx: 102, cy: 44, r: 30 };

const el = (id) => document.getElementById(id);
const svg = el('tree');
const viewport = el('viewport');
const gLinks = el('layer-links');
const gNodes = el('layer-nodes');
const stage = el('stage');

/** @type {{people: any[], families: any[], stats: any}} */
let DATA = null;
const P = new Map();      // person id  -> person
const F = new Map();      // family id  -> family
const UNIT_OF = new Map(); // person id -> unit
const POS = new Map();    // person id -> {x, y}
let UNITS = [];
let selectedId = null;

// ── loading ──────────────────────────────────────────────────────────────────

// ?private=1 loads the unredacted local build, which is gitignored and only
// ever exists on the archivist's own machine. On the published site the fetch
// simply 404s and it falls back to the public file.
const wantsPrivate = new URLSearchParams(location.search).get('private') === '1';

let MEDIA = { items: [] };

/** The photograph catalogue. Optional: the tree renders fine without it. */
async function loadMedia() {
  try {
    const res = await fetch('./data/media.json', { cache: 'no-cache' });
    if (res.ok) MEDIA = await res.json();
  } catch (_) { /* no photographs published yet */ }
  MEDIA.byFile = new Map((MEDIA.items || []).map((m) => [m.file, m]));
}

/** Re-index the catalogue after the editor adds or removes an entry. */
function refreshMedia() {
  MEDIA.byFile = new Map((MEDIA.items || []).map((m) => [m.file, m]));
  const btn = el('gallery-btn');
  if (btn) btn.textContent = `\u{1F5BC} ${(MEDIA.items || []).length}`;
}

/** Photographs attached to a person. Living and withheld people never have any. */
function mediaFor(p) {
  if (!p || p.living || p.hidden || !Array.isArray(p.media)) return [];
  return p.media.map((f) => MEDIA.byFile.get(f)).filter(Boolean);
}

/**
 * The portrait to show on a card: the one chosen as primary, else the first
 * portrait attached, else nothing. Never for a living or withheld person —
 * `mediaFor` has already returned empty for them.
 */
function portraitFor(p) {
  const shots = mediaFor(p);
  if (!shots.length) return null;
  if (p.photo) {
    const chosen = shots.find((m) => m.file === p.photo);
    if (chosen) return chosen;
  }
  return shots.find((m) => m.kind === 'portrait') || null;
}

async function load() {
  const candidates = wantsPrivate
    ? ['./data/tree.private.json', './data/tree.json']
    : ['./data/tree.json'];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) continue;
      return await res.json();
    } catch (_) { /* try the next one */ }
  }
  throw new Error('Could not load the tree data.');
}

// ── model ────────────────────────────────────────────────────────────────────

/**
 * Fill in fields that older payloads predate, so the rest of the code can stop
 * asking whether they are there. `hidden` is always re-derived from
 * `visibility` rather than trusted, because the two disagreeing is exactly the
 * kind of thing that ends up publishing someone.
 */
function normalise(data) {
  for (const p of data.people) {
    if (!Array.isArray(p.media)) p.media = [];
    if (!Array.isArray(p.hideFields)) p.hideFields = [];
    if (!Array.isArray(p.aka)) p.aka = [];
    if (!Array.isArray(p.notes)) p.notes = [];
    if (!Array.isArray(p.spouseFamilies)) p.spouseFamilies = [];
    if (typeof p.visibility !== 'string') p.visibility = p.hidden ? 'hidden' : 'public';
    if (p.photo === undefined) p.photo = null;
    p.hidden = p.visibility === 'hidden';
  }
  for (const f of data.families) {
    if (!Array.isArray(f.children)) f.children = [];
  }
  return data;
}

function index(data) {
  P.clear(); F.clear();
  normalise(data);
  data.people.forEach((p) => P.set(p.id, p));
  data.families.forEach((f) => F.set(f.id, f));

  // Derived back-references the payload deliberately does not duplicate.
  for (const p of P.values()) {
    p._parents = [];
    p._children = [];
    p._siblings = [];
    p._spouses = [];
  }
  for (const f of F.values()) {
    const spouses = [f.husband, f.wife].filter(Boolean);
    for (const s of spouses) {
      const partner = spouses.find((o) => o !== s);
      if (partner) P.get(s)._spouses.push({ id: partner, family: f.id });
      for (const c of f.children) P.get(s)._children.push(c);
    }
    for (const c of f.children) {
      P.get(c)._parents.push(...spouses);
      P.get(c)._siblings.push(...f.children.filter((o) => o !== c));
    }
  }
}

/** Group people into units: a couple sits on one card pair, everyone else alone. */
function buildUnits() {
  UNITS = [];
  UNIT_OF.clear();

  const addUnit = (members, familyId) => {
    const u = {
      members,
      family: familyId,
      gen: Math.min(...members.map((id) => P.get(id).generation)),
      x: 0, order: 0, parents: [], children: [],
    };
    UNITS.push(u);
    members.forEach((id) => UNIT_OF.set(id, u));
    return u;
  };

  // Couples first, so partners always render side by side. A person already
  // placed by an earlier family stays there — someone with two marriages is
  // drawn beside the first, and the second shows up in their detail panel.
  for (const f of F.values()) {
    if (f.husband && f.wife && !UNIT_OF.has(f.husband) && !UNIT_OF.has(f.wife)) {
      addUnit([f.husband, f.wife], f.id);
    }
  }
  for (const p of DATA.people) {
    if (!UNIT_OF.has(p.id)) addUnit([p.id], null);
  }

  // Edges run parent-unit -> child-unit, one per family that has both.
  for (const f of F.values()) {
    const anchor = f.husband || f.wife;
    if (!anchor) continue;
    const pu = UNIT_OF.get(anchor);
    for (const c of f.children) {
      const cu = UNIT_OF.get(c);
      if (!cu || cu === pu) continue;
      pu.children.push({ unit: cu, family: f.id, child: c });
      cu.parents.push({ unit: pu, family: f.id, child: c });
    }
  }
}

function unitWidth(u) {
  return u.members.length * CARD_W + (u.members.length - 1) * SPOUSE_GAP;
}

// ── layout ───────────────────────────────────────────────────────────────────

function layout() {
  const maxGen = Math.max(...UNITS.map((u) => u.gen));
  const layers = [];
  for (let g = 0; g <= maxGen; g++) layers[g] = UNITS.filter((u) => u.gen === g);

  // 1. Initial order: depth-first from the units nobody descends from, so
  //    related branches start out adjacent instead of interleaved.
  let seq = 0;
  const seen = new Set();
  const visit = (u) => {
    if (seen.has(u)) return;
    seen.add(u);
    u.order = seq++;
    u.children.forEach((e) => visit(e.unit));
  };
  UNITS.filter((u) => u.parents.length === 0).forEach(visit);
  UNITS.forEach(visit); // anything left over (cycles cannot happen, but be safe)
  layers.forEach((layer) => layer.sort((a, b) => a.order - b.order));

  // 2. Barycentre sweeps: repeatedly reorder each layer by the mean position
  //    of its neighbours in the adjacent layer. Cuts edge crossings.
  const meanOf = (list) =>
    list.length ? list.reduce((s, e) => s + e.unit.order, 0) / list.length : null;

  const reorder = (layer, pick) => {
    const keys = new Map();
    layer.forEach((u, i) => {
      const m = meanOf(pick(u));
      keys.set(u, m === null ? i : m);
    });
    layer.sort((a, b) => keys.get(a) - keys.get(b));
    layer.forEach((u, i) => { u.order = i; });
  };

  for (let pass = 0; pass < 8; pass++) {
    for (let g = 1; g <= maxGen; g++) reorder(layers[g], (u) => u.parents);
    for (let g = maxGen - 1; g >= 0; g--) reorder(layers[g], (u) => u.children);
  }

  // 3. Seed x by packing each layer left to right in its final order.
  for (const layer of layers) {
    let cursor = 0;
    for (const u of layer) {
      u.x = cursor + unitWidth(u) / 2;
      cursor += unitWidth(u) + UNIT_GAP;
    }
  }

  // 4. Priority pass: pull each unit toward the average x of its relatives,
  //    then push overlaps apart. Alternating directions converges quickly.
  const separate = (layer) => {
    for (let i = 1; i < layer.length; i++) {
      const min = layer[i - 1].x + unitWidth(layer[i - 1]) / 2
                + UNIT_GAP + unitWidth(layer[i]) / 2;
      if (layer[i].x < min) layer[i].x = min;
    }
    for (let i = layer.length - 2; i >= 0; i--) {
      const max = layer[i + 1].x - unitWidth(layer[i + 1]) / 2
                - UNIT_GAP - unitWidth(layer[i]) / 2;
      if (layer[i].x > max) layer[i].x = max;
    }
  };

  const attract = (layer, pick) => {
    for (const u of layer) {
      const rel = pick(u);
      if (!rel.length) continue;
      u.x = rel.reduce((s, e) => s + e.unit.x, 0) / rel.length;
    }
    layer.sort((a, b) => a.x - b.x);
    separate(layer);
  };

  for (let pass = 0; pass < 30; pass++) {
    for (let g = 1; g <= maxGen; g++) attract(layers[g], (u) => u.parents);
    for (let g = maxGen - 1; g >= 0; g--) attract(layers[g], (u) => u.children);
  }

  // 5. Normalise to a positive origin and resolve each person's own box.
  const minX = Math.min(...UNITS.map((u) => u.x - unitWidth(u) / 2));
  POS.clear();
  for (const u of UNITS) {
    u.x -= minX;
    u.y = u.gen * GEN_H;
    let left = u.x - unitWidth(u) / 2;
    for (const id of u.members) {
      POS.set(id, { x: left + CARD_W / 2, y: u.y + CARD_H / 2 });
      left += CARD_W + SPOUSE_GAP;
    }
  }

  return { layers, maxGen };
}

// ── rendering ────────────────────────────────────────────────────────────────

function make(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

function lifeYears(p) {
  if (p.hidden) return '';
  if (p.living) return 'living';
  const b = p.birth && p.birth.date && p.birth.date.year;
  const d = p.death && p.death.date && p.death.date.year;
  if (b && d) return `${b} – ${d}`;
  if (b) return `b. ${b}`;
  if (d) return `d. ${d}`;
  return '';
}

/** True when a fact is absent because it was withheld, not because it is unknown. */
function withheld(p, field) {
  return !p.hidden && !p.living && (p.hideFields || []).includes(field);
}

/** The three lines of a card: what to call them, and what to say about dates. */
function cardLines(p) {
  if (p.hidden) {
    return { top: '—', mid: 'withheld', foot: 'not published' };
  }
  if (p.living) {
    return { top: p.surname || '—', mid: 'living', foot: 'details withheld' };
  }
  const years = lifeYears(p);
  const deathOnly = p.death && p.death.asserted && !years;
  const datesHidden = withheld(p, 'birth') && withheld(p, 'death');
  return {
    top: p.surname || p.name,
    mid: p.given || '',
    foot: years || (datesHidden ? 'dates withheld'
      : (deathOnly ? 'died, date unknown' : 'dates unknown')),
  };
}

function render(layout) {
  gLinks.textContent = '';
  gNodes.textContent = '';

  const width = Math.max(...UNITS.map((u) => u.x + unitWidth(u) / 2));

  // Generation guides, drawn first so everything else sits above them.
  for (let g = 0; g <= layout.maxGen; g++) {
    const y = g * GEN_H + CARD_H / 2;
    make('line', {
      class: 'gen-rule', x1: -40, y1: y, x2: width + 40, y2: y,
    }, gLinks);
    make('text', { class: 'gen-label', x: -56, y: y - 10, 'text-anchor': 'end' }, gLinks)
      .textContent = `Gen ${g + 1}`;
  }

  // Spouse bars.
  for (const u of UNITS) {
    if (u.members.length < 2) continue;
    const fam = F.get(u.family);
    const a = POS.get(u.members[0]);
    const b = POS.get(u.members[1]);
    const link = make('line', {
      class: `link spouse ${fam && fam.relation === 'engaged' ? 'engaged' : ''}`,
      x1: a.x + CARD_W / 2, y1: a.y, x2: b.x - CARD_W / 2, y2: b.y,
    }, gLinks);
    link.dataset.family = u.family;
  }

  // Parent -> child drops, one comb per family.
  for (const f of F.values()) {
    const spouses = [f.husband, f.wife].filter(Boolean);
    if (!spouses.length || !f.children.length) continue;

    const pts = spouses.map((id) => POS.get(id));
    const originX = pts.reduce((s, q) => s + q.x, 0) / pts.length;
    const originY = Math.max(...pts.map((q) => q.y)) + CARD_H / 2;
    const busY = originY + BUS_DROP;

    for (const c of f.children) {
      const cp = POS.get(c);
      if (!cp) continue;
      const path = make('path', {
        class: 'link',
        d: `M ${originX} ${originY} V ${busY} H ${cp.x} V ${cp.y - CARD_H / 2}`,
      }, gLinks);
      path.dataset.family = f.id;
      path.dataset.child = c;
    }
  }

  // Person cards.
  for (const p of DATA.people) {
    const pos = POS.get(p.id);
    if (!pos) continue;
    const sexClass = (p.living || p.hidden)
      ? (p.hidden ? 'withheld' : 'living')
      : ({ M: 'm', F: 'f' }[p.sex] || 'u');
    const g = make('g', {
      class: `node ${sexClass}${p.living ? ' living' : ''}${p.hidden ? ' withheld' : ''}`,
      transform: `translate(${pos.x - CARD_W / 2}, ${pos.y - CARD_H / 2})`,
      tabindex: '0', role: 'button',
      'aria-label': p.hidden ? 'A person whose details are withheld'
        : `${p.name}${lifeYears(p) ? ', ' + lifeYears(p) : ''}`,
    }, gNodes);
    g.dataset.id = p.id;

    make('rect', { class: 'card', x: 0, y: 0, width: CARD_W, height: CARD_H }, g);

    const lines = cardLines(p);
    if (viewMode === 'portrait') drawPortraitCard(g, p, lines);
    else drawCompactCard(g, p, lines);
  }

  // Deliberately no viewBox: SVG user units stay 1:1 with CSS pixels so the
  // pan/zoom transform is the only scale in play.
  return { width, height: layout.maxGen * GEN_H + CARD_H };
}

/** The dense card: a sex stripe and three lines of text, no image. */
function drawCompactCard(g, p, lines) {
  make('rect', { class: 'sexbar', x: 0, y: 8, width: 4, height: CARD_H - 16 }, g);

  // Surname first. Finnish patronymics ("Anna Emilia Matiaksentytar") are long
  // enough that a single-line name truncates the surname off the end, which is
  // the one part of the label a family tree cannot afford to lose.
  make('text', { class: 'nm', x: 16, y: 27 }, g).textContent = fit(lines.top, 23);
  make('text', { class: 'gv', x: 16, y: 46 }, g).textContent = fit(lines.mid, 26);
  make('text', { class: 'dt', x: 16, y: 66 }, g).textContent = lines.foot;

  const badge = cardBadge(p);
  if (badge) {
    make('text', { class: 'lock', x: CARD_W - 13, y: 24, 'text-anchor': 'end' }, g)
      .textContent = badge;
  }
}

/**
 * The portrait card: a face, the name, the years.
 *
 * `mediaFor` is what decides whether there is an image, and it returns nothing
 * for a living or withheld person — so the silhouette here is not a fallback
 * for "no photograph on file", it is the only thing those two can ever get.
 */
function drawPortraitCard(g, p, lines) {
  const shot = portraitFor(p);

  make('circle', { class: 'face-ring', cx: FACE.cx, cy: FACE.cy, r: FACE.r }, g);
  if (shot) {
    make('image', {
      class: 'face',
      href: mediaSrc(shot),
      x: FACE.cx - FACE.r, y: FACE.cy - FACE.r,
      width: FACE.r * 2, height: FACE.r * 2,
      preserveAspectRatio: 'xMidYMid slice',
      'clip-path': 'url(#face-clip)',
    }, g);
  } else {
    // A head-and-shoulders silhouette, drawn rather than fetched so it costs
    // nothing and cannot fail to load.
    make('path', {
      class: 'face-blank',
      d: `M ${FACE.cx} ${FACE.cy - 13} m -8 0 a 8 8 0 1 1 16 0 a 8 8 0 1 1 -16 0`
       + ` M ${FACE.cx - 15} ${FACE.cy + 19} a 15 13 0 0 1 30 0 z`,
      'clip-path': 'url(#face-clip)',
    }, g);
  }

  make('text', { class: 'nm', x: CARD_W / 2, y: 100, 'text-anchor': 'middle' }, g)
    .textContent = fit(lines.top, 24);
  make('text', { class: 'gv', x: CARD_W / 2, y: 119, 'text-anchor': 'middle' }, g)
    .textContent = fit(lines.mid, 27);
  make('text', { class: 'dt', x: CARD_W / 2, y: 139, 'text-anchor': 'middle' }, g)
    .textContent = lines.foot;

  const badge = cardBadge(p);
  if (badge) {
    make('text', { class: 'lock', x: CARD_W - 12, y: 22, 'text-anchor': 'end' }, g)
      .textContent = badge;
  }
}

/** The corner marker: why this card is thin, or that there is more to see. */
function cardBadge(p) {
  if (p.hidden) return '\u{1F6AB}';                     // withheld entirely
  if (p.living) return '\u{1F512}';                     // living, surname only
  if ((p.hideFields || []).length) return '\u{1F576}';  // partly withheld
  if (mediaFor(p).length) return '\u{1F5BC}';           // has photographs
  return '';
}

function fit(text, max) {
  text = String(text || '');
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

// ── pan / zoom ───────────────────────────────────────────────────────────────

const view = { x: 0, y: 0, k: 1 };
let BOUNDS = { width: 1000, height: 800 };

function applyView() {
  viewport.setAttribute('transform',
    `translate(${view.x} ${view.y}) scale(${view.k})`);
}

function fitView(animate = false) {
  const r = stage.getBoundingClientRect();
  const pad = 80;
  const k = Math.min(
    (r.width - pad * 2) / (BOUNDS.width + 130),
    (r.height - pad * 2) / BOUNDS.height,
    1.25,
  );
  view.k = Math.max(k, 0.08);
  view.x = (r.width - BOUNDS.width * view.k) / 2 + 60 * view.k;
  view.y = (r.height - BOUNDS.height * view.k) / 2;
  applyView();
  if (animate) pulse();
}

function zoomBy(factor, cx, cy) {
  const r = stage.getBoundingClientRect();
  const px = cx === undefined ? r.width / 2 : cx - r.left;
  const py = cy === undefined ? r.height / 2 : cy - r.top;
  const k = Math.min(3, Math.max(0.08, view.k * factor));
  // Keep the point under the cursor fixed.
  view.x = px - (px - view.x) * (k / view.k);
  view.y = py - (py - view.y) * (k / view.k);
  view.k = k;
  applyView();
}

function centreOn(id, scale) {
  const pos = POS.get(id);
  if (!pos) return;
  const r = stage.getBoundingClientRect();
  if (scale) view.k = scale;
  view.x = r.width / 2 - pos.x * view.k;
  view.y = r.height / 2 - pos.y * view.k;
  applyView();
}

function pulse() { /* reserved for future transitions */ }

function wireStage() {
  const pointers = new Map();
  let dragging = false;
  let last = null;
  let pinchStart = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;
    pointers.set(e.pointerId, e);
    stage.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      stage.classList.add('grabbing');
    } else if (pointers.size === 2) {
      dragging = false;
      const [a, b] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), k: view.k };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);

    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
      const target = Math.min(3, Math.max(0.08, pinchStart.k * (d / pinchStart.d)));
      zoomBy(target / view.k, mid.x, mid.y);
      return;
    }

    if (!dragging) return;
    view.x += e.clientX - last.x;
    view.y += e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    applyView();
    hideHint();
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) {
      dragging = false;
      stage.classList.remove('grabbing');
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(Math.pow(0.999, e.deltaY), e.clientX, e.clientY);
    hideHint();
  }, { passive: false });

  stage.addEventListener('keydown', (e) => {
    const step = 60;
    const moves = {
      ArrowUp: [0, step], ArrowDown: [0, -step],
      ArrowLeft: [step, 0], ArrowRight: [-step, 0],
    };
    if (moves[e.key]) {
      e.preventDefault();
      view.x += moves[e.key][0];
      view.y += moves[e.key][1];
      applyView();
    } else if (e.key === '+' || e.key === '=') { zoomBy(1.2); }
    else if (e.key === '-') { zoomBy(1 / 1.2); }
    else if (e.key === '0') { fitView(); }
  });

  el('zoom-in').addEventListener('click', () => zoomBy(1.25));
  el('zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
  el('zoom-fit').addEventListener('click', () => fitView());
  el('view-compact').addEventListener('click', () => setViewMode('compact'));
  el('view-portrait').addEventListener('click', () => setViewMode('portrait'));

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => fitView(), 150);
  });
}

let hintHidden = false;
function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  setTimeout(() => el('hint').setAttribute('hidden', ''), 600);
}

// ── selection ────────────────────────────────────────────────────────────────

function relatedTo(id) {
  const p = P.get(id);
  const set = new Set([id]);
  p._parents.forEach((x) => set.add(x));
  p._children.forEach((x) => set.add(x));
  p._spouses.forEach((s) => set.add(s.id));
  p._siblings.forEach((x) => set.add(x));
  return set;
}

function highlightSelection(id) {
  const kin = relatedTo(id);

  for (const node of gNodes.children) {
    const nid = node.dataset.id;
    node.classList.toggle('selected', nid === id);
    node.classList.toggle('dimmed', !kin.has(nid));
  }

  // A link matters if it belongs to a family the selected person is in.
  const p = P.get(id);
  const fams = new Set([
    ...(p.parentFamily ? [p.parentFamily] : []),
    ...p.spouseFamilies,
  ]);
  for (const link of gLinks.children) {
    if (!link.dataset.family) continue;
    link.classList.toggle('highlight', fams.has(link.dataset.family));
  }
}

function select(id, { centre = false } = {}) {
  selectedId = id;
  highlightSelection(id);
  showPanel(P.get(id));
  if (centre) centreOn(id, Math.max(view.k, 0.75));
  syncUrl(id);
  hideHint();
}

function clearSelection() {
  selectedId = null;
  for (const node of gNodes.children) node.classList.remove('selected', 'dimmed');
  for (const link of gLinks.children) link.classList.remove('highlight');
  el('panel').setAttribute('hidden', '');
  syncUrl(null);
}

function wireNodes() {
  gNodes.addEventListener('click', (e) => {
    const node = e.target.closest('.node');
    if (node) select(node.dataset.id);
  });
  gNodes.addEventListener('keydown', (e) => {
    const node = e.target.closest('.node');
    if (node && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      select(node.dataset.id);
    }
  });
  el('panel-close').addEventListener('click', clearSelection);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!el('results').hidden) { el('results').hidden = true; return; }
      clearSelection();
    }
  });
}

// ── detail panel ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function linkify(text) {
  // Notes arrive with wiki-style ''' emphasis and bare URLs, and CONC may have
  // split a URL mid-string, which the generator has already rejoined.
  return esc(text.replace(/'''/g, ''))
    .replace(/(https?:\/\/[^\s<]+)/g, (m) =>
      `<a href="${m}" target="_blank" rel="noopener noreferrer">${fit(m, 48)}</a>`);
}

function eventLine(ev) {
  if (!ev) return null;
  const bits = [];
  if (ev.date && ev.date.display) bits.push(ev.date.display);
  if (ev.place) bits.push(ev.place);
  if (!bits.length && ev.asserted) return 'recorded, no details';
  return bits.join(' · ') || null;
}

function personButton(id) {
  const p = P.get(id);
  if (!p) return '';
  const years = lifeYears(p);
  return `<button type="button" class="lnk${p.living ? ' is-living' : ''}" data-goto="${esc(id)}">`
       + `${esc(p.name)}</button>`
       + (years && !p.living ? ` <span class="rel">${esc(years)}</span>` : '');
}

function listSection(title, ids) {
  const unique = [...new Set(ids)].filter((id) => P.has(id));
  if (!unique.length) return '';
  const items = unique.map((id) => `<li>${personButton(id)}</li>`).join('');
  return `<section><h3>${esc(title)}</h3><ul class="people">${items}</ul></section>`;
}

function showPanel(p) {
  const panel = el('panel');
  const body = el('panel-body');

  // In edit mode the editor renders the panel instead of this read-only view.
  if (window.Tree && typeof window.Tree.onPanel === 'function'
      && window.Tree.onPanel(p, panel, body)) {
    return;
  }

  const out = [];

  out.push(`<h2>${esc(p.hidden ? 'Withheld' : p.name)}</h2>`);
  const years = lifeYears(p);
  if (years && !p.living) out.push(`<p class="lifespan">${esc(years)}</p>`);

  if (p.hidden) {
    out.push('<p class="redacted"><strong>This person is not published.</strong> '
      + 'The archivist has withheld their record entirely. They are drawn here '
      + 'only so the relatives on either side of them still join up — no name, '
      + 'no dates and no photograph for them exists anywhere on this site.</p>');
  } else if (p.living) {
    out.push('<p class="lifespan">Living</p>');
    out.push('<p class="redacted"><strong>Details withheld.</strong> '
      + 'This person is alive, so their given names, dates and places are kept '
      + 'out of the published site. The full record exists in the private '
      + 'archive.</p>');
  } else if ((p.hideFields || []).length) {
    const names = (p.hideFields || [])
      .map((k) => (V.FIELDS.find((f) => f.key === k) || {}).label || k);
    out.push('<p class="redacted"><strong>Some details are withheld.</strong> '
      + `Not published for this person: ${esc(names.join(', ').toLowerCase())}. `
      + 'Withheld is not the same as unknown — these facts are recorded, and '
      + 'the archivist has chosen not to publish them.</p>');
  }

  if (p.aka && p.aka.length) {
    out.push(`<section><h3>Also recorded as</h3><dl>${
      p.aka.map((n) => `<dt>—</dt><dd>${esc(n)}</dd>`).join('')}</dl></section>`);
  }

  const facts = [];
  const born = eventLine(p.birth);
  const died = eventLine(p.death);
  const buried = eventLine(p.burial);
  if (born) facts.push(['Born', born]);
  else if (withheld(p, 'birth')) facts.push(['Born', '— withheld —']);
  if (died) facts.push(['Died', died]);
  else if (withheld(p, 'death')) facts.push(['Died', '— withheld —']);
  if (buried) facts.push(['Buried', buried]);
  if (p.occupation) facts.push(['Occupation', p.occupation]);
  else if (withheld(p, 'occupation')) facts.push(['Occupation', '— withheld —']);
  if (p.married && p.married !== p.surname) facts.push(['Married name', p.married]);
  if (p.nick) facts.push(['Known as', p.nick]);
  if (facts.length) {
    out.push(`<section><h3>Life</h3><dl>${
      facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`);
  }

  // Marriages carry their own dates, so they get a row rather than a bare name.
  if (p._spouses.length) {
    const rows = p._spouses.map(({ id, family }) => {
      const f = F.get(family);
      const when = eventLine(f && f.event);
      const label = f ? f.relation : 'partner';
      return `<li>${personButton(id)}<br><span class="rel">${esc(label)}${
        when ? ' · ' + esc(when) : ''}</span></li>`;
    }).join('');
    out.push(`<section><h3>Partner</h3><ul class="people">${rows}</ul></section>`);
  }

  out.push(listSection('Parents', p._parents));
  out.push(listSection('Children', p._children));
  out.push(listSection('Siblings', p._siblings));

  const shots = mediaFor(p);
  if (shots.length) {
    out.push(`<section><h3>Photographs</h3><div class="shots">${
      shots.map((m) => `<figure class="shot"><img src="${esc(mediaSrc(m))}"
          alt="${esc(m.caption)}" loading="lazy" data-lightbox="${esc(m.file)}">
        <figcaption>${esc(m.kindLabel)}${
          m.pending ? ' · not published yet' : ''}</figcaption></figure>`).join('')}</div></section>`);
  }

  if (p.notes && p.notes.length) {
    out.push(`<section><h3>Notes &amp; sources</h3>${
      p.notes.map((n) => `<p class="note-body">${linkify(n)}</p>`).join('')}</section>`);
  }

  if (p.geniId) {
    out.push(`<section><h3>Upstream</h3><p class="note-body">`
      + `<a href="https://www.geni.com/people/x/${esc(p.geniId)}" target="_blank" `
      + `rel="noopener noreferrer">Geni profile ${esc(p.geniId)}</a></p></section>`);
  }

  out.push('<section class="share-row">'
    + '<button type="button" class="mini" id="share-person">Share this page</button>'
    + '</section>');

  body.innerHTML = out.join('');
  panel.removeAttribute('hidden');
  panel.classList.remove('editing');
  panel.scrollTop = 0;

  body.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => select(btn.dataset.goto, { centre: true }));
  });
  const share = el('share-person');
  if (share) share.addEventListener('click', () => sharePerson(p.id, share));
  wireLightbox(body);
}

// ── photographs ──────────────────────────────────────────────────────────────

function wireLightbox(scope) {
  scope.querySelectorAll('[data-lightbox]').forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.dataset.lightbox));
  });
}

/** Published images come from docs/media/; ones still queued are local blobs. */
function mediaSrc(m) {
  return m && m.dataUrl ? m.dataUrl : `./media/${m.file}`;
}

function openLightbox(file) {
  const item = MEDIA.byFile.get(file);
  if (!item) return;
  let box = el('lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lightbox';
    box.className = 'lightbox';
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('[data-close]')) closeLightbox();
    });
  }
  box.innerHTML = `<figure>
      <button type="button" class="lb-close" data-close aria-label="Close">×</button>
      <img src="${esc(mediaSrc(item))}" alt="${esc(item.caption)}">
      <figcaption><strong>${esc(item.kindLabel)}</strong> — ${esc(item.caption)}</figcaption>
    </figure>`;
  box.hidden = false;
  document.addEventListener('keydown', lightboxKeys);
}

function closeLightbox() {
  const box = el('lightbox');
  if (box) box.hidden = true;
  document.removeEventListener('keydown', lightboxKeys);
}

function lightboxKeys(e) { if (e.key === 'Escape') closeLightbox(); }

/** Everything published, including photographs not yet tied to anyone. */
function openGallery() {
  let box = el('lightbox');
  if (!box) { openLightbox((MEDIA.items[0] || {}).file); box = el('lightbox'); }
  if (!box) return;

  const attached = new Set();
  for (const p of DATA.people) (p.media || []).forEach((f) => attached.add(f));

  const card = (m) => `<figure class="shot">
      <img src="${esc(mediaSrc(m))}" alt="${esc(m.caption)}" loading="lazy"
           data-lightbox="${esc(m.file)}">
      <figcaption>${esc(m.caption)}${
        m.pending ? ' <em>· not published yet</em>' : ''}</figcaption></figure>`;

  const loose = MEDIA.items.filter((m) => !attached.has(m.file));
  box.innerHTML = `<div class="gallery">
      <button type="button" class="lb-close" data-close aria-label="Close">×</button>
      <h2>Photographs</h2>
      <p class="gal-note">${MEDIA.items.length} in the archive. Only people the
        archive treats as deceased can appear here.</p>
      ${loose.length ? `<h3>Not yet linked to anyone</h3>
        <div class="shots wide">${loose.map(card).join('')}</div>` : ''}
      <h3>Linked to someone in the tree</h3>
      <div class="shots wide">${MEDIA.items.filter((m) => attached.has(m.file))
        .map(card).join('')}</div>
    </div>`;
  box.hidden = false;
  box.querySelectorAll('[data-lightbox]').forEach((img) => {
    img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(img.dataset.lightbox); });
  });
  document.addEventListener('keydown', lightboxKeys);
}

// ── search ───────────────────────────────────────────────────────────────────

// Escaped rather than literal: the combining-mark range must survive being
// copied, re-encoded and diffed without turning into mojibake.
const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function wireSearch() {
  const input = el('search');
  const results = el('results');
  let matches = [];
  let cursor = -1;

  const close = () => { results.hidden = true; cursor = -1; };

  const draw = () => {
    if (!matches.length) {
      results.innerHTML = '<li class="r-empty">No one by that name</li>';
      results.hidden = false;
      return;
    }
    results.innerHTML = matches.map((p, i) =>
      `<li role="option" data-id="${esc(p.id)}" aria-selected="${i === cursor}">`
      + `${esc(p.name)} <span class="r-dates">${esc(lifeYears(p))}</span></li>`).join('');
    results.hidden = false;
  };

  input.addEventListener('input', () => {
    const q = fold(input.value.trim());
    if (!q) { close(); return; }
    matches = DATA.people
      .filter((p) => fold(p.name).includes(q)
                  || (p.aka || []).some((a) => fold(a).includes(q))
                  || fold(p.surname || '').includes(q))
      .slice(0, 8);
    cursor = matches.length ? 0 : -1;
    draw();
  });

  input.addEventListener('keydown', (e) => {
    if (results.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = (cursor + 1) % matches.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = (cursor - 1 + matches.length) % matches.length; draw(); }
    else if (e.key === 'Enter' && matches[cursor]) {
      e.preventDefault();
      select(matches[cursor].id, { centre: true });
      close();
      input.blur();
    }
  });

  results.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    select(li.dataset.id, { centre: true });
    close();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) close();
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────

/**
 * Assign a generation index across the whole graph: parents one less than
 * their children, spouses equal. A mirror of assign_generations() in
 * tools/build_site.py, needed here because a structural edit in the browser
 * changes the answer and there is no server to recompute it.
 */
function assignGenerations() {
  const gen = new Map();
  const remaining = new Set(P.keys());

  while (remaining.size) {
    const seed = [...remaining].sort()[0];
    gen.set(seed, 0);
    let frontier = [seed];
    while (frontier.length) {
      const next = [];
      for (const pid of frontier) {
        const g = gen.get(pid);
        const p = P.get(pid);
        for (const fid of p.spouseFamilies) {
          const fam = F.get(fid);
          if (!fam) continue;
          for (const other of [fam.husband, fam.wife]) {
            if (other && !gen.has(other)) { gen.set(other, g); next.push(other); }
          }
          for (const child of fam.children) {
            if (!gen.has(child)) { gen.set(child, g + 1); next.push(child); }
          }
        }
        const fam = F.get(p.parentFamily);
        if (fam) {
          for (const parent of [fam.husband, fam.wife]) {
            if (parent && !gen.has(parent)) { gen.set(parent, g - 1); next.push(parent); }
          }
          for (const sib of fam.children) {
            if (!gen.has(sib)) { gen.set(sib, g); next.push(sib); }
          }
        }
      }
      frontier = next;
    }
    for (const id of gen.keys()) remaining.delete(id);
  }

  const base = Math.min(...gen.values());
  for (const [pid, g] of gen) P.get(pid).generation = g - base;
}

/** Re-derive everything from DATA and repaint. Safe to call after any edit. */
function rebuild({ keepView = true, repaintPanel = true } = {}) {
  // Children render in the order the family lists them, so an explicit order
  // survives a reload. Birth order is a property of the family record, not a
  // personal detail, which is why it is safe to keep even for living people.
  for (const f of DATA.families) {
    if (Array.isArray(f.childOrder) && f.childOrder.length) {
      const rank = new Map(f.childOrder.map((id, i) => [id, i]));
      f.children.sort((a, b) =>
        (rank.has(a) ? rank.get(a) : 1e9) - (rank.has(b) ? rank.get(b) : 1e9));
    }
  }

  index(DATA);
  assignGenerations();
  buildUnits();
  const l = layout();
  const view0 = { ...view };
  BOUNDS = render(l);
  if (keepView) { Object.assign(view, view0); applyView(); } else { fitView(); }

  DATA.stats = {
    people: DATA.people.length,
    families: DATA.families.length,
    living: DATA.people.filter((p) => p.living).length,
    withheld: DATA.people.filter((p) => p.hidden).length,
    redacted: DATA.people.filter((p) => p.living || p.hidden).length,
    generations: DATA.people.length
      ? Math.max(...DATA.people.map((p) => p.generation)) + 1 : 0,
  };
  updateSubtitle();
  // Repainting the panel rebuilds its form controls, which would steal focus
  // mid-edit — so a field change asks for the tree to update but not the form.
  if (repaintPanel && selectedId && P.has(selectedId)) {
    select(selectedId, { centre: false });
  } else if (selectedId && P.has(selectedId)) {
    highlightSelection(selectedId);
  }
}

function updateSubtitle() {
  // Counted from the people actually loaded rather than read from the payload's
  // `stats`, which an older or hand-edited file may not carry.
  const s = {
    people: DATA.people.length,
    families: DATA.families.length,
    living: DATA.people.filter((p) => p.living && !p.hidden).length,
    withheld: DATA.people.filter((p) => p.hidden).length,
    generations: DATA.people.length
      ? Math.max(...DATA.people.map((p) => p.generation)) + 1 : 0,
  };
  const kept = [];
  if (s.living) kept.push(`${s.living} living`);
  if (s.withheld) kept.push(`${s.withheld} withheld`);
  el('subtitle').textContent =
    `${s.people} people · ${s.families} families · ${s.generations} generations`
    + (DATA.redacted
        ? (kept.length ? ` · ${kept.join(' and ')} kept private` : '')
        : ' · UNREDACTED LOCAL BUILD');
}

/** Switch card style. A full relayout, because the card box changed size. */
function setViewMode(mode) {
  if (mode === viewMode) return;
  applyMode(mode);
  try { localStorage.setItem(MODE_KEY, viewMode); } catch (_) { /* private mode */ }
  paintViewButtons();
  rebuild({ keepView: false });
}

function paintViewButtons() {
  const a = el('view-compact');
  const b = el('view-portrait');
  if (!a || !b) return;
  a.classList.toggle('active', viewMode === 'compact');
  b.classList.toggle('active', viewMode === 'portrait');
  a.setAttribute('aria-pressed', String(viewMode === 'compact'));
  b.setAttribute('aria-pressed', String(viewMode === 'portrait'));
}

// ── sharing ──────────────────────────────────────────────────────────────────

/**
 * A link to one person. Anyone may hold one — it addresses a card in a public
 * tree, and following it shows exactly what the site would have shown anyway.
 * Nothing about a withheld or living person becomes reachable through it.
 */
function shareUrl(id) {
  const u = new URL(location.href);
  u.hash = '';
  // Never carry the local unredacted build's flag into a link meant for others.
  u.searchParams.delete('private');
  if (id) u.searchParams.set('person', id); else u.searchParams.delete('person');
  if (viewMode === 'portrait') u.searchParams.set('view', 'portrait');
  else u.searchParams.delete('view');
  return u.toString();
}

/** Keep the address bar pointing at the selection, without stacking history. */
function syncUrl(id) {
  try { history.replaceState(null, '', shareUrl(id)); } catch (_) { /* file:// */ }
}

/**
 * Share, or fall back to the clipboard, or fall back to selecting the text.
 * `navigator.share` needs a user gesture and a secure context, and `clipboard`
 * needs permission — on a phone the first works and on a desktop the second
 * does, so both paths are load-bearing rather than belt-and-braces.
 */
async function sharePerson(id, button) {
  const p = P.get(id);
  const url = shareUrl(id);
  const title = p && !p.hidden && !p.living ? p.name : 'Family Archive';
  const say = (msg) => {
    if (!button) return;
    const was = button.textContent;
    button.textContent = msg;
    setTimeout(() => { button.textContent = was; }, 1800);
  };

  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (err) {
      // AbortError means they closed the sheet on purpose; say nothing.
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    say('Link copied');
  } catch (_) {
    window.prompt('Copy this link', url);
  }
}

// Surface for editor.js, which is a separate classic script. An explicit
// object beats relying on cross-script access to top-level `let` bindings.
window.Tree = {
  get data() { return DATA; },
  set data(v) { DATA = v; },
  P, F, POS,
  rebuild, select, clearSelection, showPanel, fitView, centreOn, highlightSelection,
  lifeYears, eventLine, esc, linkify, personButton, listSection, mediaSrc,
  get media() { return MEDIA; }, mediaFor, refreshMedia, portraitFor,
  wireLightbox, openLightbox, openGallery,
  cardLines, cardBadge, withheld, normalise,
  setViewMode, paintViewButtons, get viewMode() { return viewMode; },
  shareUrl, sharePerson,
  get selectedId() { return selectedId; },
  onPanel: null,   // editor.js installs a renderer here
};

(async function main() {
  try {
    [DATA] = await Promise.all([load(), loadMedia()]);
  } catch (err) {
    el('loading').textContent = err.message;
    el('subtitle').textContent = 'Data unavailable';
    return;
  }

  index(DATA);
  buildUnits();
  const l = layout();
  BOUNDS = render(l);

  updateSubtitle();
  if (!DATA.redacted) {
    el('privacy-note').innerHTML =
      '<strong>Local build — shows living people in full. Do not share.</strong>';
  }

  el('loading').remove();
  if (MEDIA.items && MEDIA.items.length) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'edit-toggle';
    btn.id = 'gallery-btn';
    btn.title = 'All photographs';
    btn.textContent = `\u{1F5BC} ${MEDIA.items.length}`;
    btn.addEventListener('click', openGallery);
    document.querySelector('.controls').appendChild(btn);
  }
  wireStage();
  wireNodes();
  wireSearch();
  paintViewButtons();
  fitView();

  // A shared link opens on the person it names. An id that is no longer in the
  // tree — deleted, or withheld and then renumbered — just opens the tree.
  const wanted = new URLSearchParams(location.search).get('person');
  if (wanted && P.has(wanted)) select(wanted, { centre: true });
  else if (wanted) syncUrl(null);

  setTimeout(hideHint, 6000);

  // editor.js is a separate script and may parse either side of this point,
  // so announce readiness both ways rather than depending on the order.
  window.Tree.ready = true;
  window.dispatchEvent(new CustomEvent('tree-ready'));
})();
