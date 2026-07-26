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

const CARD_W = 204;
const CARD_H = 80;
const SPOUSE_GAP = 26;   // between the two cards of a couple
const UNIT_GAP = 34;     // between neighbouring units in a layer
const GEN_H = 200;       // vertical distance between generations
const BUS_DROP = 58;     // how far below a couple the sibling bus line sits

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

function index(data) {
  P.clear(); F.clear();
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
  if (p.living) return 'living';
  const b = p.birth && p.birth.date && p.birth.date.year;
  const d = p.death && p.death.date && p.death.date.year;
  if (b && d) return `${b} – ${d}`;
  if (b) return `b. ${b}`;
  if (d) return `d. ${d}`;
  return '';
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
    const sexClass = p.living ? 'living' : ({ M: 'm', F: 'f' }[p.sex] || 'u');
    const g = make('g', {
      class: `node ${sexClass}${p.living ? ' living' : ''}`,
      transform: `translate(${pos.x - CARD_W / 2}, ${pos.y - CARD_H / 2})`,
      tabindex: '0', role: 'button',
      'aria-label': `${p.name}${lifeYears(p) ? ', ' + lifeYears(p) : ''}`,
    }, gNodes);
    g.dataset.id = p.id;

    make('rect', { class: 'card', x: 0, y: 0, width: CARD_W, height: CARD_H }, g);
    make('rect', { class: 'sexbar', x: 0, y: 8, width: 4, height: CARD_H - 16 }, g);

    // Surname first. Finnish patronymics ("Anna Emilia Matiaksentytar") are long
    // enough that a single-line name truncates the surname off the end, which is
    // the one part of the label a family tree cannot afford to lose.
    make('text', { class: 'nm', x: 16, y: 27 }, g)
      .textContent = fit(p.surname || p.name, 23);

    make('text', { class: 'gv', x: 16, y: 46 }, g)
      .textContent = p.living ? 'living' : fit(p.given || '', 26);

    make('text', { class: 'dt', x: 16, y: 66 }, g)
      .textContent = p.living ? 'details withheld' : (lifeYears(p) || 'dates unknown');

    if (p.living) {
      make('text', { class: 'lock', x: CARD_W - 13, y: 24, 'text-anchor': 'end' }, g)
        .textContent = '\u{1F512}';
    }
  }

  // Deliberately no viewBox: SVG user units stay 1:1 with CSS pixels so the
  // pan/zoom transform is the only scale in play.
  return { width, height: layout.maxGen * GEN_H + CARD_H };
}

function fit(text, max) {
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

function select(id, { centre = false } = {}) {
  selectedId = id;
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

  showPanel(p);
  if (centre) centreOn(id, Math.max(view.k, 0.75));
  hideHint();
}

function clearSelection() {
  selectedId = null;
  for (const node of gNodes.children) node.classList.remove('selected', 'dimmed');
  for (const link of gLinks.children) link.classList.remove('highlight');
  el('panel').setAttribute('hidden', '');
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
  const out = [];

  out.push(`<h2>${esc(p.name)}</h2>`);
  const years = lifeYears(p);
  if (years && !p.living) out.push(`<p class="lifespan">${esc(years)}</p>`);

  if (p.living) {
    out.push('<p class="lifespan">Living</p>');
    out.push('<p class="redacted"><strong>Details withheld.</strong> '
      + 'This person is alive, so their given names, dates and places are kept '
      + 'out of the published site. The full record exists in the private '
      + 'archive.</p>');
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
  if (died) facts.push(['Died', died]);
  if (buried) facts.push(['Buried', buried]);
  if (p.occupation) facts.push(['Occupation', p.occupation]);
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

  if (p.notes && p.notes.length) {
    out.push(`<section><h3>Notes &amp; sources</h3>${
      p.notes.map((n) => `<p class="note-body">${linkify(n)}</p>`).join('')}</section>`);
  }

  if (p.geniId) {
    out.push(`<section><h3>Upstream</h3><p class="note-body">`
      + `<a href="https://www.geni.com/people/x/${esc(p.geniId)}" target="_blank" `
      + `rel="noopener noreferrer">Geni profile ${esc(p.geniId)}</a></p></section>`);
  }

  body.innerHTML = out.join('');
  panel.removeAttribute('hidden');
  panel.scrollTop = 0;

  body.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => select(btn.dataset.goto, { centre: true }));
  });
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

(async function main() {
  try {
    DATA = await load();
  } catch (err) {
    el('loading').textContent = err.message;
    el('subtitle').textContent = 'Data unavailable';
    return;
  }

  index(DATA);
  buildUnits();
  const l = layout();
  BOUNDS = render(l);

  const s = DATA.stats;
  el('subtitle').textContent =
    `${s.people} people · ${s.families} families · ${s.generations} generations`
    + (DATA.redacted ? ` · ${s.redacted} living kept private` : ' · UNREDACTED LOCAL BUILD');
  if (!DATA.redacted) {
    el('privacy-note').innerHTML =
      '<strong>Local build — shows living people in full. Do not share.</strong>';
  }

  el('loading').remove();
  wireStage();
  wireNodes();
  wireSearch();
  fitView();
  setTimeout(hideHint, 6000);
})();
