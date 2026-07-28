/* Family Archive — the browser editor.
 *
 * Edits the tree in place and commits it straight back to GitHub via the REST
 * API. There is no server anywhere in this: the page holds a token you paste,
 * and GitHub itself is the only thing that decides whether you may write.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * `docs/data/tree.json` sits on a public web server, so whatever reaches it is
 * published whether or not the interface draws it. A living person may carry a
 * surname, a sex, and their position in the tree — nothing else, ever. Someone
 * the archivist has withheld carries less than that. Both are enforced the same
 * way, three times over and deliberately independently:
 *
 *   - the form does not render the fields it may not record
 *   - `redactForPublication()` re-derives the public tree from the working one
 *   - `verify()` re-reads the finished payload and refuses to publish on any hit
 *
 * The rules themselves live in `visibility.js`, shared with the viewer and the
 * test suites, and mirrored in `tools/verify_public.py`. They are not restated
 * here — one definition, checked from several directions.
 *
 * WORKING COPY vs PUBLISHED COPY
 * ------------------------------
 * With a private companion repository wired up, the working copy is the *full*
 * record — hidden people included — and redaction happens only on the way out.
 * Without one there is nowhere safe to keep withheld detail, so the working
 * copy is scrubbed on every write exactly as it always was, and withholding
 * something discards it. `fullRecord` is which of those two we are in.
 */
'use strict';

(function () {

const T = window.Tree;
const V = window.Visibility;
const el = (id) => document.getElementById(id);

const REPO_OWNER = 'hannes423-debug';
const REPO_NAME = 'family-archive';
const FILE_PATH = 'docs/data/tree.json';
const BRANCH = 'main';

// The private companion. Holds the full record — every field, every withheld
// person — and GitHub, not this page, is what keeps a guest out of it.
const PRIVATE_REPO = 'family-archive-private';
const PRIVATE_FILE = 'tree.full.json';

const DRAFT_KEY = 'familyArchive.draft.v1';
const TOKEN_KEY = 'familyArchive.token.v1';

const MONTHS = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ');
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let editing = false;
let dirty = 0;
let baseSha = null;        // sha of the tree.json we loaded, for conflict detection
let headSha = null;        // branch head when we loaded, for conflict detection
const undoStack = [];

// True once the private companion repository has answered for itself. Until
// then the working copy is the public one and is scrubbed on every write.
let fullRecord = false;
let privateSha = null;     // blob sha of tree.full.json, for conflict detection

// Photographs chosen but not yet committed. Held as bytes plus a local blob URL
// so they render immediately; uploaded as blobs when you publish.
const pendingUploads = [];
const pendingDeletes = new Set();

// Uploaded images are re-encoded to at most this edge length. That keeps the
// repository from filling with 5 MB phone photographs, and — the reason that
// actually matters — re-encoding through a canvas discards EXIF, which on a
// modern photograph carries GPS coordinates and a timestamp.
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;

// ── identity ────────────────────────────────────────────────────────────────

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(value, remember) {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  if (!value) return;
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value);
}

// ── who is using this page ──────────────────────────────────────────────────

/**
 * Two roles: guest and archivist.
 *
 * A guest reads the tree, searches it and shares links to it. That is not a
 * restriction imposed by this page — it is everything the published data can
 * do. An archivist additionally writes, and what makes that a real boundary
 * rather than a pretend one is that it is not enforced here at all: GitHub
 * decides, by refusing a push and by refusing to serve the private repository,
 * to anyone whose token does not carry the access.
 *
 * So be clear about what the role does and does not do. It gates WRITING, and
 * it gates the PRIVATE record. It does not hide published data from a guest,
 * and nothing in a browser could — `docs/data/tree.json` is a plain file on a
 * public web server. That is why withholding happens before publication, not
 * in the interface.
 */
let role = 'guest';
let account = null;      // the GitHub login behind the token, once verified

const isAdmin = () => role === 'admin';

/**
 * Ask GitHub whether this token may write here. The answer is advisory — the
 * authority is the push itself, which will fail regardless of what this said —
 * but it lets the page refuse to show an editing interface that could not work.
 */
async function checkToken(token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.permissions || !body.permissions.push) return null;
    return body;
  } catch (_) {
    return null;   // offline, or GitHub is having a day
  }
}

// ── dates ───────────────────────────────────────────────────────────────────

const DATE_RE = new RegExp(
  '^(?:(ABT|CAL|EST|BEF|AFT)\\s+)?(?:(\\d{1,2})\\s+)?(?:([A-Za-z]{3})\\s+)?(\\d{3,4})$', 'i');

/** Parse a typed date into the same GenDate shape build_site.py emits. */
function parseDate(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  const m = DATE_RE.exec(raw);
  if (!m) return { source: raw, display: raw, year: null, precision: 'unknown' };
  const [, mod, day, mon, yearStr] = m;
  const year = parseInt(yearStr, 10);
  const monN = mon ? MONTHS.indexOf(mon.toUpperCase()) + 1 : 0;
  let precision, display;
  if (day && monN) { precision = 'day'; display = `${parseInt(day, 10)} ${MONTH_NAMES[monN]} ${year}`; }
  else if (monN) { precision = 'month'; display = `${MONTH_NAMES[monN]} ${year}`; }
  else { precision = 'year'; display = String(year); }
  if (mod) {
    display = ({ ABT: 'about ', CAL: 'calculated ', EST: 'estimated ',
                 BEF: 'before ', AFT: 'after ' })[mod.toUpperCase()] + display;
    precision = 'approx';
  }
  return { source: raw, display, year, precision };
}

const thisYear = new Date().getFullYear();
const ASSERTION_FLOOR_YEARS = V.ASSERTION_FLOOR_YEARS;

// The rules themselves live in visibility.js. These are the names this file
// already used, kept as aliases so there is exactly one definition to audit.
const deriveLiving = V.deriveLiving;
const verify = V.problems;

/** The public tree, derived from whatever the working copy currently is. */
function redactForPublication() {
  return V.publicTree({ people: T.data.people, families: T.data.families });
}

// ── the invariant ───────────────────────────────────────────────────────────

/**
 * Bring the working copy back into step after a write.
 *
 * Without a private companion repository there is nowhere for a living person's
 * details to live, so they are stripped here and now — a value entered before
 * someone was known to be living cannot be allowed to linger in a copy that is
 * one Publish away from the open web.
 *
 * With one, the working copy is allowed to be the full record and only the
 * derived fields are refreshed; `redactForPublication()` is then the thing that
 * decides what leaves. Note what this means in practice: in that mode the
 * localStorage draft on the archivist's own machine does hold living people's
 * details. That is the point of having somewhere private to put them.
 */
function scrub(p) {
  p.living = deriveLiving(p);
  p.name = p.living
    ? ('Living ' + (p.surname || '')).trim()
    : ([p.given, p.surname].filter(Boolean).join(' ') || 'Unknown');
  if (!p.living || fullRecord) return p;

  const kept = {};
  for (const k of V.LIVING_KEEPS) kept[k] = p[k];
  Object.assign(p, kept, {
    name: ('Living ' + (p.surname || '')).trim(),
    given: '', married: '', nick: '', aka: [],
    birth: null, death: null, burial: null,
    occupation: null, notes: [], geniId: null,
    media: [], photo: null,   // a living person may not be pictured either
  });
  return p;
}

// ── mutation helpers ────────────────────────────────────────────────────────

function snapshot() {
  undoStack.push(JSON.stringify({ people: T.data.people, families: T.data.families }));
  if (undoStack.length > 50) undoStack.shift();
}

function markDirty() {
  dirty++;
  saveDraft();
  paintBar();
}

function commitChange(fn, { repaintPanel = true } = {}) {
  snapshot();
  fn();
  T.data.people.forEach(scrub);
  T.rebuild({ repaintPanel });
  markDirty();
}

function undo() {
  if (!undoStack.length) return;
  const prev = JSON.parse(undoStack.pop());
  T.data.people = prev.people;
  T.data.families = prev.families;
  T.rebuild();
  dirty++;
  saveDraft();
  paintBar();
}

let nextIdCounter = Date.now();
const newId = (kind) => `@${kind}W${(nextIdCounter++).toString(36).toUpperCase()}@`;

function addPerson(fields = {}) {
  const p = Object.assign({
    id: newId('I'), given: '', surname: '', married: '', nick: '',
    name: '', aka: [], sex: 'U', media: [], photo: null,
    birth: null, death: null, burial: null,
    occupation: null, notes: [], geniId: null,
    generation: 0, parentFamily: null, spouseFamilies: [],
    visibility: 'public', hideFields: [],
  }, fields);
  scrub(p);
  T.data.people.push(p);
  return p;
}

function addFamily(fields = {}) {
  const f = Object.assign({
    id: newId('F'), husband: null, wife: null, children: [], childOrder: [],
    relation: 'partners', event: null, divorced: false,
  }, fields);
  T.data.families.push(f);
  return f;
}

function familyOf(id) { return T.data.families.find((f) => f.id === id); }

/** Attach `child` to `family`, keeping the explicit order list in step. */
function linkChild(family, childId) {
  if (!family.children.includes(childId)) family.children.push(childId);
  family.childOrder = family.childOrder || [];
  if (!family.childOrder.includes(childId)) family.childOrder.push(childId);
  const person = T.data.people.find((p) => p.id === childId);
  if (person) person.parentFamily = family.id;
}

function linkSpouse(family, personId, role) {
  family[role] = personId;
  const person = T.data.people.find((p) => p.id === personId);
  if (person && !person.spouseFamilies.includes(family.id)) {
    person.spouseFamilies.push(family.id);
  }
}

/** The ancestor flow: give someone a parent, creating the family if needed. */
function addParent(personId, role) {
  commitChange(() => {
    const person = T.data.people.find((p) => p.id === personId);
    let fam = person.parentFamily ? familyOf(person.parentFamily) : null;
    if (!fam) {
      fam = addFamily();
      linkChild(fam, personId);
    }
    const parent = addPerson({ surname: role === 'husband' ? person.surname : '',
                               sex: role === 'husband' ? 'M' : 'F' });
    linkSpouse(fam, parent.id, role);
    pendingFocus = parent.id;
  });
}

function addSpouse(personId) {
  commitChange(() => {
    const person = T.data.people.find((p) => p.id === personId);
    const role = person.sex === 'F' ? 'wife' : 'husband';
    const otherRole = role === 'wife' ? 'husband' : 'wife';
    let fam = person.spouseFamilies.map(familyOf)
      .find((f) => f && !f[otherRole]);
    if (!fam) {
      fam = addFamily();
      linkSpouse(fam, personId, role);
    }
    const spouse = addPerson({ sex: person.sex === 'M' ? 'F' : 'M' });
    linkSpouse(fam, spouse.id, otherRole);
    pendingFocus = spouse.id;
  });
}

function addChild(personId) {
  commitChange(() => {
    const person = T.data.people.find((p) => p.id === personId);
    let fam = person.spouseFamilies.map(familyOf).find(Boolean);
    if (!fam) {
      fam = addFamily();
      linkSpouse(fam, personId, person.sex === 'F' ? 'wife' : 'husband');
    }
    const child = addPerson({ surname: person.surname });
    linkChild(fam, child.id);
    pendingFocus = child.id;
  });
}

function addSibling(personId) {
  commitChange(() => {
    const person = T.data.people.find((p) => p.id === personId);
    let fam = person.parentFamily ? familyOf(person.parentFamily) : null;
    if (!fam) {
      fam = addFamily();
      linkChild(fam, personId);
    }
    const sib = addPerson({ surname: person.surname });
    linkChild(fam, sib.id);
    pendingFocus = sib.id;
  });
}

function removePerson(personId) {
  commitChange(() => {
    T.data.people = T.data.people.filter((p) => p.id !== personId);
    for (const f of T.data.families) {
      if (f.husband === personId) f.husband = null;
      if (f.wife === personId) f.wife = null;
      f.children = f.children.filter((c) => c !== personId);
      f.childOrder = (f.childOrder || []).filter((c) => c !== personId);
    }
    // Drop families that no longer describe anything.
    const dead = new Set(T.data.families
      .filter((f) => !f.husband && !f.wife && f.children.length < 2)
      .map((f) => f.id));
    T.data.families = T.data.families.filter((f) => !dead.has(f.id));
    for (const p of T.data.people) {
      if (dead.has(p.parentFamily)) p.parentFamily = null;
      p.spouseFamilies = p.spouseFamilies.filter((fid) => !dead.has(fid));
    }
    pendingFocus = null;
  });
}

let pendingFocus = null;

// ── drafts ──────────────────────────────────────────────────────────────────

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      saved: new Date().toISOString(), baseSha,
      people: T.data.people, families: T.data.families,
    }));
  } catch (_) { /* quota — the copy in memory is still authoritative */ }
}

function clearDraft() { localStorage.removeItem(DRAFT_KEY); }

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); }
  catch (_) { return null; }
}

// ── the edit form ───────────────────────────────────────────────────────────

function field(label, name, value, opts = {}) {
  const attrs = `id="f-${name}" name="${name}"`
    + (opts.placeholder ? ` placeholder="${T.esc(opts.placeholder)}"` : '');
  const input = opts.rows
    ? `<textarea ${attrs} rows="${opts.rows}">${T.esc(value || '')}</textarea>`
    : `<input type="text" ${attrs} value="${T.esc(value || '')}">`;
  return `<label class="fld"><span>${T.esc(label)}</span>${input}${
    opts.hint ? `<em class="hint-txt">${T.esc(opts.hint)}</em>` : ''}</label>`;
}

/**
 * What the archivist chooses to publish about this person.
 *
 * The preview underneath is not decoration. The whole feature turns on knowing
 * what a stranger will see, and the only trustworthy answer is the one produced
 * by the same function that will actually do the redacting — so it renders
 * `V.publicPerson(p)` rather than describing what it is expected to contain.
 */
function visibilitySection(p) {
  const lvl = V.level(p);
  const hide = V.effectiveHides(p);
  const preset = new Set(lvl === 'limited' ? V.LIMITED_HIDES : []);
  const out = ['<section class="vis"><h3>What to publish</h3>'];

  out.push('<div class="vis-levels">' + V.LEVELS.map((l) => `
    <label class="vis-level${lvl === l.key ? ' on' : ''}">
      <input type="radio" name="vis-level" value="${l.key}"${lvl === l.key ? ' checked' : ''}>
      <span class="vis-name">${T.esc(l.label)}</span>
      <em>${T.esc(l.hint)}</em>
    </label>`).join('') + '</div>');

  if (lvl !== 'hidden') {
    out.push('<p class="hint-txt">Withhold individual facts. A withheld fact is '
      + 'shown as withheld rather than as unknown — the tree does not pretend '
      + 'the record is empty.</p>');
    out.push('<div class="vis-fields">' + V.FIELDS.map((f) => {
      const locked = preset.has(f.key);   // implied by the level, not separately chosen
      return `<label class="check${locked ? ' locked' : ''}">
        <input type="checkbox" data-hide="${f.key}"${hide.has(f.key) ? ' checked' : ''}
               ${locked ? 'disabled' : ''}>
        ${T.esc(f.label)}${f.hint ? ` <em class="hint-txt">${T.esc(f.hint)}</em>` : ''}</label>`;
    }).join('') + '</div>');
  }

  if (p.living) {
    out.push('<p class="hint-txt">This person is living, so everything is '
      + 'withheld already, whatever is ticked above.</p>');
  }
  if (!fullRecord && (lvl !== 'public' || hide.size)) {
    out.push('<p class="redacted"><strong>Nowhere to keep it.</strong> Without '
      + 'the private repository, whatever you withhold here is dropped on the '
      + 'next publish rather than stored — the public tree is the only copy.</p>');
  }

  out.push(`<div class="vis-preview"><h4>What a visitor sees</h4>${
    previewOf(p)}</div>`);
  return out.join('') + '</section>';
}

/** Render the actual redacted record, not a description of it. */
function previewOf(p) {
  const shown = V.publicPerson(p);
  const rows = [];
  const line = (k, v) => rows.push(
    `<dt>${T.esc(k)}</dt><dd>${v ? T.esc(v) : '<span class="gone">—</span>'}</dd>`);

  line('Name', shown.hidden ? 'Withheld' : shown.name);
  line('Years', T.lifeYears(shown) || (shown.death && shown.death.asserted
    ? 'died, date unknown' : ''));
  line('Born', T.eventLine(shown.birth));
  line('Died', T.eventLine(shown.death));
  line('Occupation', shown.occupation);
  line('Notes', (shown.notes || []).length
    ? `${shown.notes.length} note(s)` : '');
  line('Photographs', (shown.media || []).length
    ? `${shown.media.length} attached` : '');
  return `<dl class="preview">${rows.join('')}</dl>`;
}

function renderEditor(p, panel, body) {
  const out = [];
  const living = p.living;

  out.push(`<h2 class="edit-title">${T.esc(p.name || 'Unnamed')}</h2>`);
  out.push(`<p class="lifespan">${living ? 'Living' : (T.lifeYears(p) || 'no dates')}</p>`);

  if (living) {
    out.push('<p class="redacted"><strong>Living — surname only.</strong> '
      + 'This archive keeps no private store, so a living person can hold a '
      + 'surname, a sex and their place in the tree, and nothing else. '
      + 'To record their life, record their death date first.</p>');
  }

  out.push('<section><h3>Identity</h3>');
  out.push(field('Surname', 'surname', p.surname,
    { placeholder: 'Pirttisalo', hint: 'Maiden name, by this archive’s convention' }));
  out.push(`<label class="fld"><span>Sex</span><select id="f-sex" name="sex">
      <option value="M"${p.sex === 'M' ? ' selected' : ''}>Male</option>
      <option value="F"${p.sex === 'F' ? ' selected' : ''}>Female</option>
      <option value="U"${p.sex !== 'M' && p.sex !== 'F' ? ' selected' : ''}>Unknown</option>
    </select></label>`);

  if (!living) {
    out.push(field('Given names', 'given', p.given, { placeholder: 'Juho Heikki Aaponpoika' }));
    out.push(field('Known as', 'nick', p.nick, { placeholder: 'nickname' }));
    out.push(field('Married name', 'married', p.married));
  }
  out.push('</section>');

  // Dates are what decide living/deceased, so they are always editable — that
  // is the only lever the archivist has, and it is a factual one.
  out.push('<section><h3>Dates</h3>');
  out.push(field('Born', 'birthDate', p.birth && p.birth.date && p.birth.date.source,
    { placeholder: '15 SEP 1877 · 1877 · ABT 1840' }));
  if (!living) {
    out.push(field('Birth place', 'birthPlace', p.birth && p.birth.place,
      { placeholder: 'Haapavesi, Finland' }));
  }
  out.push(field('Died', 'deathDate', p.death && p.death.date && p.death.date.source,
    { placeholder: 'blank if unknown' }));

  const birthYear = p.birth && p.birth.date && p.birth.date.year;
  const tooYoung = birthYear && (thisYear - birthYear) < ASSERTION_FLOOR_YEARS;
  const assertedOnly = !!(p.death && p.death.asserted && !(p.death.date));
  if (tooYoung) {
    out.push('<p class="hint-txt">Born within the last '
      + ASSERTION_FLOOR_YEARS + ' years — recording a death for this person '
      + 'needs an actual date, not just a tick.</p>');
  } else {
    out.push(`<label class="check"><input type="checkbox" id="f-deathAsserted"
        ${assertedOnly ? 'checked' : ''}>
        Deceased, date unknown</label>`
      + '<p class="hint-txt">Tick this to record an ancestor whose name you know '
      + 'but whose dates you do not. It is what lets you name them at all.</p>');
  }
  if (!living) {
    out.push(field('Death place', 'deathPlace', p.death && p.death.place));
    out.push(field('Burial place', 'burialPlace', p.burial && p.burial.place));
  }
  out.push('</section>');

  if (!living) {
    out.push('<section><h3>Life</h3>');
    out.push(field('Occupation', 'occupation', p.occupation, { placeholder: 'suutari' }));
    out.push(field('Notes & sources', 'notes', (p.notes || []).join('\n\n'),
      { rows: 5, placeholder: 'Parish books, archive references, stories…' }));
    out.push(field('Geni id', 'geniId', p.geniId, { placeholder: '6000000093179262822' }));
    out.push('</section>');
  }

  if (!living) {
    const cat = (T.media && T.media.items) || [];
    if (cat.length) {
      const mine = new Set(p.media || []);
      out.push('<section><h3>Photographs</h3><div class="pick-list">'
        + cat.map((m) => `<div class="pick-row"><label class="pick">
             <input type="checkbox" data-media="${T.esc(m.file)}"
                    ${mine.has(m.file) ? 'checked' : ''}>
             <img src="${T.esc(T.mediaSrc(m))}" alt="" loading="lazy">
             <span>${T.esc(m.caption)}${m.pending ? ' · queued' : ''}</span></label>
             <button type="button" class="drop-photo" data-drop-media="${T.esc(m.file)}"
                     title="Remove from the archive">\u00d7</button></div>`).join('')
        + '</div>');

      // Which of them is the face on the tree. Only a picture actually attached
      // to this person can be it.
      const attached = cat.filter((m) => mine.has(m.file));
      if (attached.length) {
        out.push('<h4 class="sub">Portrait on the tree</h4><div class="pick-list">'
          + `<label class="pick"><input type="radio" name="portrait"
               data-portrait=""${p.photo ? '' : ' checked'}>
             <span>None \u2014 show a silhouette</span></label>`
          + attached.map((m) => `<label class="pick">
               <input type="radio" name="portrait" data-portrait="${T.esc(m.file)}"
                      ${p.photo === m.file ? 'checked' : ''}>
               <img src="${T.esc(T.mediaSrc(m))}" alt="" loading="lazy">
               <span>${T.esc(m.caption)}</span></label>`).join('')
          + '</div>');
      }
      out.push('</section>');
    }
  }

  out.push(visibilitySection(p));

  out.push(`<section><h3>Add a relative</h3><div class="btn-row">
      <button type="button" class="mini" data-add="father">+ Father</button>
      <button type="button" class="mini" data-add="mother">+ Mother</button>
      <button type="button" class="mini" data-add="spouse">+ Partner</button>
      <button type="button" class="mini" data-add="child">+ Child</button>
      <button type="button" class="mini" data-add="sibling">+ Sibling</button>
    </div></section>`);

  const rel = (title, ids) => T.listSection(title, ids);
  out.push(rel('Parents', p._parents));
  out.push(rel('Children', p._children));
  out.push(rel('Siblings', p._siblings));
  out.push(rel('Partner', p._spouses.map((s) => s.id)));

  out.push(`<section class="danger"><button type="button" class="mini danger-btn"
      data-delete="1">Remove this person</button></section>`);

  body.innerHTML = out.join('');
  panel.removeAttribute('hidden');
  panel.classList.add('editing');

  // Live-apply on every change, so there is no save button to forget. Scoped to
  // the `f-` fields specifically: the visibility, portrait and photograph
  // controls are inputs too, and they own their own commits.
  body.querySelectorAll('[id^="f-"]').forEach((input) => {
    input.addEventListener('change', () => applyForm(p.id, body));
  });
  body.querySelectorAll('[data-media]').forEach((box) => {
    box.addEventListener('change', () => {
      commitChange(() => {
        const person = T.data.people.find((x) => x.id === p.id);
        const set = new Set(person.media || []);
        if (box.checked) set.add(box.dataset.media); else set.delete(box.dataset.media);
        person.media = [...set];
        // Detaching the picture that was the portrait must not leave the card
        // pointing at something this person no longer has.
        if (person.photo && !set.has(person.photo)) person.photo = null;
      }, { repaintPanel: false });
    });
  });
  body.querySelectorAll('[data-portrait]').forEach((radio) => {
    radio.addEventListener('change', () => {
      commitChange(() => {
        const person = T.data.people.find((x) => x.id === p.id);
        person.photo = radio.dataset.portrait || null;
      }, { repaintPanel: false });
    });
  });
  body.querySelectorAll('[name="vis-level"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      commitChange(() => {
        const person = T.data.people.find((x) => x.id === p.id);
        // Only the level changes. `hideFields` holds the individually chosen
        // withholdings and nothing else — the ones a level implies live in
        // `effectiveHides` and are never written here — so clearing any of it
        // on a level change would silently republish a fact the archivist
        // withheld on purpose.
        person.visibility = radio.value;
      });
      T.select(p.id, { centre: false });
    });
  });
  body.querySelectorAll('[data-hide]').forEach((box) => {
    box.addEventListener('change', () => {
      commitChange(() => {
        const person = T.data.people.find((x) => x.id === p.id);
        const set = new Set(person.hideFields || []);
        if (box.checked) set.add(box.dataset.hide); else set.delete(box.dataset.hide);
        person.hideFields = [...set];
      });
      T.select(p.id, { centre: false });
    });
  });
  body.querySelectorAll('[data-drop-media]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const file = btn.dataset.dropMedia;
      if (!confirm('Remove this photograph from the archive entirely?')) return;
      removePhotograph(file);
      T.select(p.id, { centre: false });
    });
  });
  body.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.add;
      if (kind === 'father') addParent(p.id, 'husband');
      else if (kind === 'mother') addParent(p.id, 'wife');
      else if (kind === 'spouse') addSpouse(p.id);
      else if (kind === 'child') addChild(p.id);
      else if (kind === 'sibling') addSibling(p.id);
      if (pendingFocus) T.select(pendingFocus, { centre: true });
    });
  });
  body.querySelector('[data-delete]').addEventListener('click', () => {
    if (!confirm(`Remove ${p.name} from the tree? Their relatives stay.`)) return;
    removePerson(p.id);
    T.clearSelection();
  });
  body.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => T.select(btn.dataset.goto, { centre: true }));
  });
  return true;
}

function applyForm(personId, body) {
  const person = T.data.people.find((p) => p.id === personId);
  if (!person) return;
  const get = (n) => {
    const node = body.querySelector(`#f-${n}`);
    return node ? node.value.trim() : '';
  };
  const wasLiving = person.living;

  // repaintPanel:false — rebuilding the form under the cursor would drop focus
  // and lose the next keystroke.
  commitChange(() => {
    person.surname = get('surname');
    person.sex = get('sex') || 'U';

    const birthDate = parseDate(get('birthDate'));
    const deathDate = parseDate(get('deathDate'));
    const birthPlace = get('birthPlace') || null;
    const deathPlace = get('deathPlace') || null;
    const burialPlace = get('burialPlace') || null;

    person.birth = (birthDate || birthPlace)
      ? { date: birthDate, place: birthPlace, asserted: false } : null;

    const assertBox = body.querySelector('#f-deathAsserted');
    const by = birthDate && birthDate.year;
    const tooYoung = by && (thisYear - by) < ASSERTION_FLOOR_YEARS;
    const asserted = !!(assertBox && assertBox.checked) && !tooYoung;

    person.death = (deathDate || deathPlace)
      ? { date: deathDate, place: deathPlace, asserted: false }
      : (asserted ? { date: null, place: null, asserted: true } : null);
    person.burial = burialPlace
      ? { date: null, place: burialPlace, asserted: false } : null;

    // Only meaningful for the deceased; scrub() clears them otherwise.
    person.given = get('given');
    person.nick = get('nick');
    person.married = get('married');
    person.occupation = get('occupation') || null;
    person.geniId = get('geniId') || null;
    const notes = get('notes');
    person.notes = notes ? notes.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean) : [];
  }, { repaintPanel: false });

  // Crossing the living/deceased line changes which fields exist, so redraw.
  if (T.P.get(personId) && T.P.get(personId).living !== wasLiving) {
    T.select(personId, { centre: false });
  }
}

// ── uploading ───────────────────────────────────────────────────────────────

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Re-encode an uploaded image: downscale, strip metadata, return raw bytes.
 *
 * Going through a canvas is what removes EXIF. A phone photograph carries the
 * time it was taken and often the coordinates of the place — which, for a
 * picture taken in someone's house, is exactly the kind of thing this archive
 * spends the rest of its effort not publishing.
 */
async function processImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close && bitmap.close();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, width: w, height: h };
}

/**
 * Name the file, deliberately without reference to what it was called.
 *
 * An uploaded filename is whatever was on someone's phone, and it may well be a
 * living person's name. The browser cannot check for that — under this
 * archive's model those names are not stored anywhere, so there is nothing to
 * check against. So the name is generated instead, and the meaning lives in the
 * caption, which is typed on purpose.
 */
function generatedName(kind, hash) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
              + String(d.getDate()).padStart(2, '0');
  return `${kind}-${stamp}-${hash.slice(0, 10)}.jpg`;
}

const KIND_LABELS = {
  portrait: 'Portrait',
  memorial: 'Gravestone or memorial',
  document: 'Document',
  photograph: 'Photograph',
};

async function stageUpload(file, { caption, kind }) {
  const { bytes, width, height } = await processImage(file);
  const hash = await sha256Hex(bytes);

  const already = (T.media.items || []).find((m) => m.sha256 === hash);
  if (already) return { skipped: already };

  const name = generatedName(kind, hash);
  const entry = {
    file: name,
    caption: caption.trim() || 'Untitled',
    kind,
    kindLabel: KIND_LABELS[kind] || 'Photograph',
    group: null,
    bytes: bytes.length,
    width, height,
    sha256: hash,
    origin: 'browser',
    suggestedFor: [],
    pending: true,
    dataUrl: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })),
  };

  pendingUploads.push({ entry, base64: bytesToBase64(bytes) });
  T.media.items = (T.media.items || []).concat([entry]);
  T.refreshMedia();
  markDirty();
  return { entry };
}

function removePhotograph(file) {
  const item = (T.media.items || []).find((m) => m.file === file);
  if (!item) return;

  const queuedIndex = pendingUploads.findIndex((u) => u.entry.file === file);
  if (queuedIndex >= 0) {
    URL.revokeObjectURL(pendingUploads[queuedIndex].entry.dataUrl);
    pendingUploads.splice(queuedIndex, 1);
  } else {
    pendingDeletes.add(file);   // already published: needs deleting on the server
  }

  T.media.items = T.media.items.filter((m) => m.file !== file);
  T.refreshMedia();
  commitChange(() => {
    for (const p of T.data.people) {
      if ((p.media || []).includes(file)) p.media = p.media.filter((f) => f !== file);
    }
  });
}

// ── publishing ──────────────────────────────────────────────────────────────

/** btoa() throws on anything non-Latin1, and this tree is full of ä and ö. */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Fields the viewer hangs off a person at load time, not part of the record. */
function stripDerived(p) {
  const c = { ...p };
  delete c._parents; delete c._children; delete c._siblings; delete c._spouses;
  return c;
}

/** What goes to the PUBLIC repository. Redacted, always, without exception. */
function buildPayload() {
  const { people, families } = redactForPublication();
  return {
    generated: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    source: T.data.source || 'edited in browser',
    redacted: true,
    editedInBrowser: true,
    stats: {
      people: people.length,
      families: families.length,
      living: people.filter((p) => p.living).length,
      withheld: people.filter((p) => p.hidden).length,
      redacted: people.filter((p) => p.living || p.hidden).length,
      generations: people.length ? Math.max(...people.map((p) => p.generation)) + 1 : 0,
    },
    people: people.map(stripDerived)
      .sort((a, b) => a.generation - b.generation || a.name.localeCompare(b.name)),
    families: families.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * What goes to the PRIVATE repository: the working copy exactly as it stands,
 * unredacted. This is the archive's real record, and the only reason it is safe
 * to write is that GitHub will not serve that repository to anyone without a
 * token that has been granted access to it.
 */
function buildPrivatePayload() {
  return {
    generated: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    source: T.data.source || 'edited in browser',
    redacted: false,
    note: 'The full record. Never copy this into the public repository.',
    stats: {
      people: T.data.people.length,
      families: T.data.families.length,
      withheld: T.data.people.filter((p) => V.level(p) === 'hidden').length,
    },
    people: T.data.people.map(stripDerived)
      .sort((a, b) => a.generation - b.generation
        || String(a.name).localeCompare(String(b.name))),
    families: [...T.data.families].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ── the private companion ───────────────────────────────────────────────────

/**
 * Try to open the private record.
 *
 * Three outcomes, and the difference matters because it decides whether the
 * working copy is allowed to hold anything the public one may not:
 *
 *   loaded  — the repository and the file are both there. The working copy
 *             becomes the full record; redaction happens on the way out.
 *   empty   — the repository is there but has no file yet. Same mode; the
 *             first publish seeds it from what is on screen.
 *   missing — no repository. Stay on the public record and scrub every write,
 *             because there is nowhere safe to put anything else.
 */
async function openPrivateRecord() {
  const path = `/repos/${REPO_OWNER}/${PRIVATE_REPO}/contents/${PRIVATE_FILE}`;
  try {
    const file = await api(path);
    privateSha = file.sha;
    fullRecord = true;
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
    return { state: 'loaded', data: JSON.parse(text) };
  } catch (err) {
    if (err.status !== 404) return { state: 'missing', error: err };
    // A 404 is ambiguous — no file, or no repository, or no access to it.
    try {
      await api(`/repos/${REPO_OWNER}/${PRIVATE_REPO}`);
      privateSha = null;
      fullRecord = true;
      return { state: 'empty' };
    } catch (_) {
      privateSha = null;
      fullRecord = false;
      return { state: 'missing' };
    }
  }
}

/** Write the full record. Always before the public one — see `publish`. */
async function pushPrivateRecord(message) {
  const payload = buildPrivatePayload();
  const body = {
    message,
    content: toBase64(JSON.stringify(payload, null, 1) + '\n'),
    branch: BRANCH,
  };
  if (privateSha) body.sha = privateSha;
  const res = await api(
    `/repos/${REPO_OWNER}/${PRIVATE_REPO}/contents/${PRIVATE_FILE}`,
    { method: 'PUT', body: JSON.stringify(body) });
  privateSha = res.content.sha;
  return res;
}

async function api(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `GitHub returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function buildMediaPayload() {
  const items = (T.media.items || []).map((m) => {
    const c = { ...m };
    delete c.pending;
    delete c.dataUrl;
    return c;
  });
  return {
    generated: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    count: items.length,
    items,
  };
}

/**
 * Commit everything at once through the Git Data API.
 *
 * An upload touches three things — the image, the catalogue and the tree — and
 * the Contents API can only write one file per call, which would mean three
 * commits and three chances to land half a change. This builds one tree and one
 * commit instead: blobs, then a tree on top of the current one, then a commit,
 * then a single fast-forward of the branch.
 */
async function publish() {
  const status = el('pub-status');
  const treePayload = buildPayload();
  const mediaPayload = buildMediaPayload();

  const problems = verify(treePayload, mediaPayload);
  if (problems.length) {
    status.className = 'pub-status bad';
    status.innerHTML = '<strong>Not published.</strong> '
      + T.esc(problems.slice(0, 4).join(' · '))
      + (problems.length > 4 ? ` (+${problems.length - 4} more)` : '');
    return;
  }

  if (!getToken()) { openAuth(); return; }

  status.className = 'pub-status';
  status.textContent = pendingUploads.length
    ? `Uploading ${pendingUploads.length} photograph(s)…` : 'Publishing…';

  const repo = `/repos/${REPO_OWNER}/${REPO_NAME}`;
  try {
    // The full record goes first, deliberately. If the second write fails the
    // archive has still kept everything and the public site is merely stale;
    // the other order risks publishing a redaction whose original was never
    // saved anywhere, which is the one failure that loses data for good.
    if (fullRecord) {
      status.textContent = 'Saving the full record…';
      await pushPrivateRecord(`Update the full record (${dirty} edit${dirty === 1 ? '' : 's'})`);
    }

    const ref = await api(`${repo}/git/ref/heads/${BRANCH}`);
    const parent = ref.object.sha;
    if (headSha && parent !== headSha) {
      status.className = 'pub-status bad';
      status.innerHTML = '<strong>Someone else changed the archive.</strong> '
        + 'Reload to get their version — publishing now would discard it.';
      return;
    }
    const headCommit = await api(`${repo}/git/commits/${parent}`);

    const entries = [];

    // Images first: each becomes a blob, uploaded base64.
    for (let i = 0; i < pendingUploads.length; i++) {
      const up = pendingUploads[i];
      status.textContent = `Uploading photograph ${i + 1} of ${pendingUploads.length}…`;
      const blob = await api(`${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: up.base64, encoding: 'base64' }),
      });
      entries.push({ path: `docs/media/${up.entry.file}`, mode: '100644',
                     type: 'blob', sha: blob.sha });
    }

    // A null sha removes a path from the new tree.
    for (const file of pendingDeletes) {
      entries.push({ path: `docs/media/${file}`, mode: '100644',
                     type: 'blob', sha: null });
    }

    entries.push({ path: 'docs/data/tree.json', mode: '100644', type: 'blob',
                   content: JSON.stringify(treePayload, null, 1) + '\n' });
    entries.push({ path: 'docs/data/media.json', mode: '100644', type: 'blob',
                   content: JSON.stringify(mediaPayload, null, 1) + '\n' });

    status.textContent = 'Committing…';
    const tree = await api(`${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }),
    });

    const bits = [];
    if (dirty) bits.push(`${dirty} edit${dirty === 1 ? '' : 's'}`);
    if (pendingUploads.length) bits.push(`${pendingUploads.length} photograph(s) added`);
    if (pendingDeletes.size) bits.push(`${pendingDeletes.size} removed`);

    const commit = await api(`${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `Update the family archive (${bits.join(', ') || 'no changes'})`,
        tree: tree.sha,
        parents: [parent],
      }),
    });

    await api(`${repo}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });

    headSha = commit.sha;
    for (const up of pendingUploads) {
      delete up.entry.pending;
      URL.revokeObjectURL(up.entry.dataUrl);
      delete up.entry.dataUrl;
    }
    pendingUploads.length = 0;
    pendingDeletes.clear();
    dirty = 0;
    clearDraft();
    T.refreshMedia();
    paintBar();

    status.className = 'pub-status good';
    status.innerHTML = 'Published. GitHub Pages rebuilds in about a minute — '
      + `<a href="https://github.com/${REPO_OWNER}/${REPO_NAME}/commit/${commit.sha}" `
      + 'target="_blank" rel="noopener">see the commit</a>.';
  } catch (err) {
    status.className = 'pub-status bad';
    if (err.status === 401 || err.status === 403) {
      status.innerHTML = '<strong>GitHub refused the token.</strong> '
        + 'It needs Contents: read and write on this repository. '
        + '<button type="button" class="linkish" id="reauth">Use a different token</button>';
      const b = el('reauth');
      if (b) b.addEventListener('click', openAuth);
    } else if (err.status === 409 || err.status === 422) {
      status.textContent = 'The branch moved under us — reload and try again.';
    } else {
      status.textContent = err.message;
    }
  }
}

function downloadJson() {
  const payload = buildPayload();
  const blob = new Blob([JSON.stringify(payload, null, 1) + '\n'],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tree.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── token dialog ────────────────────────────────────────────────────────────

function openAuth() {
  const dlg = el('auth');
  el('auth-token').value = '';
  el('auth-note').textContent = '';
  el('auth-note').className = 'auth-note';
  dlg.removeAttribute('hidden');
  el('auth-token').focus();
}

function wireUpload() {
  const dlg = el('upload');
  const input = el('up-file');
  const preview = el('up-preview');
  const confirmBox = el('up-confirm');
  const addBtn = el('up-add');
  let chosen = [];

  const refresh = () => {
    addBtn.disabled = !(chosen.length && confirmBox.checked);
    preview.innerHTML = chosen.map((f, i) =>
      `<span class="chip">${T.esc(f.name)}
         <button type="button" data-drop="${i}" aria-label="Remove">×</button></span>`).join('');
    preview.querySelectorAll('[data-drop]').forEach((b) => {
      b.addEventListener('click', () => {
        chosen.splice(Number(b.dataset.drop), 1);
        refresh();
      });
    });
  };

  const take = (files) => {
    chosen = chosen.concat([...files].filter((f) => f.type.startsWith('image/')));
    refresh();
  };

  el('up-browse').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { take(input.files); input.value = ''; });
  confirmBox.addEventListener('change', refresh);

  const zone = el('dropzone');
  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('over');
    }));
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('over');
    }));
  zone.addEventListener('drop', (e) => take(e.dataTransfer.files));

  el('up-cancel').addEventListener('click', () => {
    chosen = [];
    refresh();
    dlg.setAttribute('hidden', '');
  });

  addBtn.addEventListener('click', async () => {
    const caption = el('up-caption').value;
    const kind = el('up-kind').value;
    addBtn.disabled = true;
    addBtn.textContent = 'Processing…';
    let added = 0, skipped = 0;
    for (const file of chosen) {
      try {
        const result = await stageUpload(file, {
          caption: chosen.length > 1 ? `${caption} (${file.name})`.trim() : caption,
          kind,
        });
        if (result.skipped) skipped++; else added++;
      } catch (err) {
        console.error('could not process', file.name, err);
      }
    }
    chosen = [];
    el('up-caption').value = '';
    confirmBox.checked = false;
    addBtn.textContent = 'Add';
    refresh();
    dlg.setAttribute('hidden', '');
    const status = el('pub-status');
    status.className = 'pub-status';
    status.textContent = `${added} photograph(s) queued`
      + (skipped ? `, ${skipped} already in the archive` : '')
      + '. Publish to upload.';
    if (T.selectedId) T.select(T.selectedId, { centre: false });
  });
}

function openUpload() { el('upload').removeAttribute('hidden'); }

function wireAuth() {
  el('auth-cancel').addEventListener('click', () => el('auth').setAttribute('hidden', ''));
  el('auth-save').addEventListener('click', async () => {
    const value = el('auth-token').value.trim();
    if (!value) return;
    const note = el('auth-note');
    const btn = el('auth-save');
    btn.disabled = true;
    note.textContent = 'Asking GitHub…';
    note.className = 'auth-note';

    const repo = await checkToken(value);
    btn.disabled = false;
    if (!repo) {
      note.className = 'auth-note bad';
      note.textContent = 'GitHub would not accept that token for this repository. '
        + 'It needs Contents: read and write on '
        + `${REPO_OWNER}/${REPO_NAME}, and it must not have expired.`;
      return;
    }

    setToken(value, el('auth-remember').checked);
    account = repo.owner && repo.owner.login;
    el('auth').setAttribute('hidden', '');
    note.textContent = '';
    await becomeAdmin();
  });
  el('auth-forget').addEventListener('click', () => {
    setToken('', false);
    el('auth').setAttribute('hidden', '');
    signOut();
  });
}

// ── switching roles ─────────────────────────────────────────────────────────

/**
 * Take the archivist's seat: reveal the editing chrome, then try to open the
 * private record. Editing still works if that fails — it just falls back to the
 * old behaviour where the working copy is the public one, and says so.
 */
async function becomeAdmin() {
  role = 'admin';
  document.body.classList.add('is-admin');
  paintBar();

  const status = el('pub-status');
  status.className = 'pub-status';
  status.textContent = 'Opening the private record…';

  const result = await openPrivateRecord();

  if (result.state === 'loaded') {
    // Only adopt it if nothing has been typed yet — otherwise the archivist
    // watches their own work vanish, which is a worse outcome than a stale base.
    if (dirty === 0) {
      T.data.people = T.normalise(result.data).people;
      T.data.families = result.data.families;
      T.rebuild({ keepView: false });
    }
    status.className = 'pub-status good';
    status.textContent = `Editing the full record from ${PRIVATE_REPO}.`;
  } else if (result.state === 'empty') {
    status.className = 'pub-status good';
    status.textContent = `${PRIVATE_REPO} is ready but empty — publishing will `
      + 'seed it with the full record.';
  } else {
    status.className = 'pub-status warn';
    status.innerHTML = '<strong>No private record.</strong> Editing the public '
      + 'tree directly, so withholding a detail discards it. '
      + `<a href="https://github.com/new?name=${PRIVATE_REPO}&visibility=private" `
      + 'target="_blank" rel="noopener">Create the private repository →</a>';
  }
  paintBar();
  if (T.selectedId) T.select(T.selectedId, { centre: false });
}

function signOut() {
  if (dirty > 0 && !confirm(
      'There are unpublished changes. Leaving the archivist seat discards them. Continue?')) {
    return;
  }
  role = 'guest';
  account = null;
  fullRecord = false;
  privateSha = null;
  document.body.classList.remove('is-admin');
  setEditing(false);
  clearDraft();
  paintBar();
  // The working copy may be the full record; it must not outlive the session.
  location.reload();
}

// ── the edit bar ────────────────────────────────────────────────────────────

function paintBar() {
  const bar = el('editbar');
  if (!bar) return;
  const admin = isAdmin();

  // A guest is shown no editing affordances at all — not disabled ones. An
  // interface full of greyed-out buttons invites people to go looking for the
  // way round them.
  el('unlock').hidden = admin;
  el('edit-toggle').hidden = !admin;
  bar.hidden = !(admin && editing);
  if (!admin) return;

  el('edit-toggle').textContent = editing ? 'Done' : 'Edit';
  el('edit-toggle').classList.toggle('active', editing);
  el('pub-count').textContent = dirty
    ? `${dirty} unpublished change${dirty === 1 ? '' : 's'}` : 'No changes yet';
  el('btn-publish').disabled = dirty === 0;
  el('btn-undo').disabled = undoStack.length === 0;
  el('btn-signout').textContent = account ? `Sign out (${account})` : 'Sign out';

  const store = el('record-store');
  store.textContent = fullRecord ? 'full record' : 'public tree only';
  store.className = 'record-store ' + (fullRecord ? 'ok' : 'warn');
  store.title = fullRecord
    ? `Editing ${PRIVATE_REPO}/${PRIVATE_FILE}. Withheld detail is kept there.`
    : 'No private repository, so anything you withhold is discarded on publish.';
}

function setEditing(on) {
  editing = isAdmin() && on;
  document.body.classList.toggle('edit-mode', editing);
  T.onPanel = editing ? renderEditor : null;
  paintBar();
  if (T.selectedId) T.select(T.selectedId, { centre: false });
}

// ── boot ────────────────────────────────────────────────────────────────────

async function init() {
  buildChrome();
  wireAuth();
  wireUpload();

  el('unlock').addEventListener('click', openAuth);
  el('edit-toggle').addEventListener('click', () => setEditing(!editing));
  el('btn-publish').addEventListener('click', publish);
  el('btn-undo').addEventListener('click', undo);
  el('btn-signout').addEventListener('click', signOut);
  el('btn-upload').addEventListener('click', openUpload);
  el('btn-download').addEventListener('click', downloadJson);
  el('btn-discard').addEventListener('click', () => {
    if (!confirm('Discard every unpublished change and reload the published tree?')) return;
    clearDraft();
    location.reload();
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  // Learn where the branch is, so a change made elsewhere is a conflict rather
  // than a silent overwrite. Works without a token — the repository is public.
  try {
    const ref = await (await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BRANCH}`
    )).json();
    headSha = (ref.object && ref.object.sha) || null;
    baseSha = headSha;
  } catch (_) { headSha = null; }

  // A token that was remembered on this device signs back in on its own, but
  // only after GitHub has agreed it is still good — an expired one must drop
  // the page back to a guest rather than show an editor that cannot save.
  paintBar();
  const remembered = getToken();
  if (remembered) {
    const repo = await checkToken(remembered);
    if (repo) {
      account = repo.owner && repo.owner.login;
      await becomeAdmin();
    } else {
      setToken('', false);
    }
  }

  // A draft is the archivist's unpublished work and can hold the full record,
  // so it is only ever offered to someone who has signed back in.
  const draft = loadDraft();
  if (draft && draft.people) {
    if (!isAdmin()) {
      clearDraft();
    } else {
      const when = new Date(draft.saved).toLocaleString();
      if (confirm(`You have unpublished changes from ${when}. Restore them?`)) {
        T.data.people = T.normalise(draft).people;
        T.data.families = draft.families;
        T.rebuild({ keepView: false });
        dirty = 1;
        setEditing(true);
      } else {
        clearDraft();
      }
    }
  }
  paintBar();
}

function buildChrome() {
  const controls = document.querySelector('.controls');

  // The only way in. Deliberately quiet — it is not a feature to be discovered
  // by a visitor, and pressing it achieves nothing without a token GitHub likes.
  const unlock = document.createElement('button');
  unlock.type = 'button';
  unlock.id = 'unlock';
  unlock.className = 'edit-toggle unlock';
  unlock.title = 'Archivist sign-in';
  unlock.setAttribute('aria-label', 'Archivist sign-in');
  unlock.textContent = '\u{1F511}';
  controls.appendChild(unlock);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'edit-toggle';
  toggle.className = 'edit-toggle';
  toggle.textContent = 'Edit';
  toggle.hidden = true;
  controls.appendChild(toggle);

  const bar = document.createElement('div');
  bar.id = 'editbar';
  bar.className = 'editbar';
  bar.hidden = true;
  bar.innerHTML = `
    <span id="pub-count" class="pub-count">No changes yet</span>
    <span id="record-store" class="record-store"></span>
    <button type="button" class="mini" id="btn-undo">Undo</button>
    <button type="button" class="mini" id="btn-upload">Add photograph</button>
    <button type="button" class="mini" id="btn-download">Download</button>
    <button type="button" class="mini" id="btn-discard">Discard</button>
    <button type="button" class="mini" id="btn-signout">Sign out</button>
    <button type="button" class="mini primary" id="btn-publish">Publish to GitHub</button>
    <span id="pub-status" class="pub-status"></span>`;
  document.querySelector('.topbar').insertAdjacentElement('afterend', bar);

  const up = document.createElement('div');
  up.id = 'upload';
  up.className = 'auth';
  up.hidden = true;
  up.innerHTML = `
    <div class="auth-card">
      <h2>Add a photograph</h2>
      <div class="dropzone" id="dropzone">
        <input type="file" id="up-file" accept="image/*" multiple hidden>
        <p><strong>Drop images here</strong> or
           <button type="button" class="linkish" id="up-browse">choose files</button></p>
        <p class="dz-note">Resized to ${MAX_EDGE}px and re-encoded, which also
           strips EXIF — the timestamp and GPS coordinates a phone writes into
           every photograph.</p>
      </div>
      <div id="up-preview" class="up-preview"></div>
      <label class="fld"><span>Caption</span>
        <input type="text" id="up-caption"
               placeholder="Who or what this is, and when"></label>
      <label class="fld"><span>Kind</span>
        <select id="up-kind">
          <option value="portrait">Portrait</option>
          <option value="photograph">Photograph</option>
          <option value="memorial">Gravestone or memorial</option>
          <option value="document">Document</option>
        </select></label>
      <label class="check"><input type="checkbox" id="up-confirm">
        Everyone pictured here has died</label>
      <p class="auth-warn">This archive publishes nothing about living people,
         and that has to include photographs of them. Nothing can check an image
         for you — this one is on your word.</p>
      <div class="btn-row">
        <button type="button" class="mini" id="up-cancel">Cancel</button>
        <button type="button" class="mini primary" id="up-add" disabled>Add</button>
      </div>
    </div>`;
  document.body.appendChild(up);

  const dlg = document.createElement('div');
  dlg.id = 'auth';
  dlg.className = 'auth';
  dlg.hidden = true;
  dlg.innerHTML = `
    <div class="auth-card">
      <h2>Archivist sign-in</h2>
      <p>Everyone can read and share this tree. Changing it needs a
         <strong>fine-grained</strong> personal access token with
         <strong>Contents: read and write</strong> on
         <code>${REPO_OWNER}/${REPO_NAME}</code> — and, to reach the withheld
         records, on <code>${REPO_OWNER}/${PRIVATE_REPO}</code> as well.
         Give it a short expiry.</p>
      <p><a href="https://github.com/settings/personal-access-tokens/new"
            target="_blank" rel="noopener">Create one on GitHub →</a></p>
      <label class="fld"><span>Token</span>
        <input type="password" id="auth-token" autocomplete="off" spellcheck="false"
               placeholder="github_pat_…"></label>
      <label class="check"><input type="checkbox" id="auth-remember">
        Remember on this device</label>
      <p id="auth-note" class="auth-note"></p>
      <p class="auth-warn">The token stays in this browser and goes only to
         github.com. Leave the box unticked on a shared machine and it is
         forgotten when you close the tab. Nothing here checks the token itself —
         GitHub does, every time, which is what makes this a real boundary and
         not a password on a public page.</p>
      <div class="btn-row">
        <button type="button" class="mini" id="auth-forget">Forget token</button>
        <button type="button" class="mini" id="auth-cancel">Cancel</button>
        <button type="button" class="mini primary" id="auth-save">Sign in</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
}

// `becomeAdmin` is exported for the test suites as well as the sign-in flow.
// That is not a way past anything: it reveals the editing interface, and every
// write that interface can attempt is still refused by GitHub without a token
// it accepts. The role decides what is drawn, never what is permitted.
window.Editor = { init, setEditing, verify, scrub, deriveLiving, parseDate,
                  buildPayload, buildPrivatePayload, buildMediaPayload,
                  redactForPublication, stageUpload, removePhotograph,
                  processImage, generatedName,
                  becomeAdmin, signOut, checkToken, openPrivateRecord,
                  get role() { return role; },
                  get fullRecord() { return fullRecord; },
                  set fullRecord(v) { fullRecord = !!v; },
                  get dirty() { return dirty; },
                  get pending() { return pendingUploads; },
                  get deletes() { return pendingDeletes; } };

if (window.Tree && window.Tree.ready) init();
else window.addEventListener('tree-ready', init, { once: true });

})();
