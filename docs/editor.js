/* Family Archive — the browser editor.
 *
 * Edits the published tree in place and commits it straight back to GitHub via
 * the REST API. There is no server anywhere in this: the page holds a token you
 * paste, and GitHub itself is the only thing that decides whether you may write.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * This repository is public and there is no private store. So a living person
 * may carry a surname, a sex, and their position in the tree — nothing else,
 * ever, not even for the archivist. Every editing path here is built so that
 * recording a living person's given name or date is not a thing you can do:
 *
 *   - the form does not render those fields for a living person
 *   - `scrub()` strips them again on every write, so a stale value cannot survive
 *   - `verify()` re-reads the finished payload and refuses to publish on any hit
 *
 * "Living" is derived, never free-form: someone born within the last 100 years
 * with no death date IS living, and you cannot tick a box to say otherwise. To
 * record detail for such a person you must record their death — which is the
 * honest thing the data is actually claiming.
 */
'use strict';

(function () {

const T = window.Tree;
const el = (id) => document.getElementById(id);

const REPO_OWNER = 'hannes423-debug';
const REPO_NAME = 'family-archive';
const FILE_PATH = 'docs/data/tree.json';
const BRANCH = 'main';

const PRESUMED_DEAD_AFTER_YEARS = 100;   // matches tools/build_site.py
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

// Below this age, "deceased" needs an actual death date rather than a bare
// assertion. Claiming a small child has died is not something anyone should be
// able to do by mis-clicking a checkbox, and that is the case where getting it
// wrong publishes a minor's details.
const ASSERTION_FLOOR_YEARS = 25;

/**
 * Living is derived from the record, never asserted by the user.
 * A death or burial proves death; otherwise a birth long enough ago presumes
 * it; everyone else — including anyone with no dates at all — is living.
 *
 * The one lever the archivist has is asserting a death with no date — GEDCOM's
 * own bare DEAT tag valued Y, meaning it happened and nothing further is
 * recorded. That is what makes it possible to name an ancestor whose dates are
 * unknown, which is most of them.
 */
function deriveLiving(p) {
  const year = p.birth && p.birth.date && p.birth.date.year;
  const bornRecently = year && (thisYear - year) < ASSERTION_FLOOR_YEARS;

  // A death with an actual date is a specific factual claim and always counts.
  const datedDeath = (p.death && p.death.date) || (p.burial && p.burial.date);
  if (datedDeath) return false;

  // A bare "deceased, date unknown" is trusted for an ancestor, but it must not
  // outrank a recent birth date — otherwise ticking a box and then typing a
  // birth year would publish a child. Order of entry must not change the answer.
  if ((p.death || p.burial) && !bornRecently) return false;

  return !(year && thisYear - year >= PRESUMED_DEAD_AFTER_YEARS);
}

// ── the invariant ───────────────────────────────────────────────────────────

const LIVING_KEEPS = ['id', 'surname', 'sex', 'living', 'generation',
                      'parentFamily', 'spouseFamilies'];

/**
 * Force a person into a shape the public repo may hold. Applied on EVERY write,
 * not just when toggling status, so a value entered before someone was known to
 * be living cannot linger.
 */
function scrub(p) {
  p.living = deriveLiving(p);
  if (!p.living) {
    p.name = [p.given, p.surname].filter(Boolean).join(' ') || 'Unknown';
    return p;
  }
  const kept = {};
  for (const k of LIVING_KEEPS) kept[k] = p[k];
  Object.assign(p, kept, {
    name: ('Living ' + (p.surname || '')).trim(),
    given: '', married: '', nick: '', aka: [],
    birth: null, death: null, burial: null,
    occupation: null, notes: [], geniId: null,
    media: [],   // a living person may not be pictured either
  });
  return p;
}

/** Independent re-check of the finished payload. The last gate before a push. */
function verify(data, media) {
  const problems = [];
  const byId = new Map(data.people.map((p) => [p.id, p]));

  for (const p of data.people) {
    if (!p.living) continue;
    for (const f of ['given', 'married', 'nick', 'occupation', 'geniId']) {
      if (p[f]) problems.push(`${p.name || p.id}: still carries ${f}`);
    }
    for (const f of ['birth', 'death', 'burial']) {
      if (p[f]) problems.push(`${p.name || p.id}: still carries a ${f} record`);
    }
    if ((p.aka || []).length || (p.notes || []).length) {
      problems.push(`${p.name || p.id}: still carries aka/notes`);
    }
    if ((p.media || []).length) {
      problems.push(`${p.name || p.id}: still has a photograph attached`);
    }
    if (!/^Living\b/.test(p.name || '')) {
      problems.push(`${p.id}: name is not masked (${p.name})`);
    }
    if (deriveLiving(p) !== true) {
      problems.push(`${p.id}: flagged living but the record says otherwise`);
    }
  }
  for (const p of data.people) {
    if (!p.living && deriveLiving(p)) {
      problems.push(`${p.name || p.id}: marked deceased but the record says living`);
    }
  }
  // A marriage date identifies a living spouse as surely as a birth date.
  for (const f of data.families) {
    const spouses = [f.husband, f.wife].filter(Boolean);
    if (!spouses.some((s) => byId.get(s) && byId.get(s).living)) continue;
    if (f.event && (f.event.date || f.event.place)) {
      problems.push(`a family event exposes a date or place for a living couple`);
    }
  }
  // Structural integrity, so a bad edit cannot publish a broken tree.
  for (const p of data.people) {
    if (p.parentFamily && !data.families.some((f) => f.id === p.parentFamily)) {
      problems.push(`${p.name}: parent family does not exist`);
    }
    for (const fid of p.spouseFamilies) {
      if (!data.families.some((f) => f.id === fid)) {
        problems.push(`${p.name}: spouse family does not exist`);
      }
    }
  }
  for (const f of data.families) {
    for (const c of f.children) {
      if (!byId.has(c)) problems.push(`a family lists a child who does not exist`);
    }
  }

  if (media) {
    const known = new Set((media.items || []).map((m) => m.file));
    for (const m of media.items || []) {
      // Generated names only: an uploaded filename could be anything, and a
      // path publishes as surely as a file.
      if (!/^[a-z0-9.\-]+$/.test(m.file)) {
        problems.push(`photograph filename is not URL-safe: ${m.file}`);
      }
      if (!m.caption) problems.push(`a photograph has no caption`);
    }
    for (const p of data.people) {
      for (const ref of p.media || []) {
        if (!known.has(ref)) {
          problems.push(`${p.name}: references a photograph that is not in the catalogue`);
        }
      }
    }
  }
  return problems;
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
    name: '', aka: [], sex: 'U', media: [],
    birth: null, death: null, burial: null,
    occupation: null, notes: [], geniId: null,
    generation: 0, parentFamily: null, spouseFamilies: [],
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
        + '</div></section>');
    }
  }

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

  // Live-apply on every change, so there is no save button to forget.
  body.querySelectorAll('input, textarea, select').forEach((input) => {
    input.addEventListener('change', () => applyForm(p.id, body));
  });
  body.querySelectorAll('[data-media]').forEach((box) => {
    box.addEventListener('change', () => {
      commitChange(() => {
        const person = T.data.people.find((x) => x.id === p.id);
        const set = new Set(person.media || []);
        if (box.checked) set.add(box.dataset.media); else set.delete(box.dataset.media);
        person.media = [...set];
      }, { repaintPanel: false });
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

function buildPayload() {
  const people = T.data.people.map(scrub);
  return {
    generated: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
    source: T.data.source || 'edited in browser',
    redacted: true,
    editedInBrowser: true,
    stats: {
      people: people.length,
      families: T.data.families.length,
      living: people.filter((p) => p.living).length,
      redacted: people.filter((p) => p.living).length,
      generations: people.length ? Math.max(...people.map((p) => p.generation)) + 1 : 0,
    },
    people: people
      .map((p) => {
        const c = { ...p };
        // Derived at load time; not part of the stored record.
        delete c._parents; delete c._children; delete c._siblings; delete c._spouses;
        return c;
      })
      .sort((a, b) => a.generation - b.generation || a.name.localeCompare(b.name)),
    families: [...T.data.families].sort((a, b) => a.id.localeCompare(b.id)),
  };
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
  el('auth-save').addEventListener('click', () => {
    const value = el('auth-token').value.trim();
    if (!value) return;
    setToken(value, el('auth-remember').checked);
    el('auth').setAttribute('hidden', '');
    paintBar();
    publish();
  });
  el('auth-forget').addEventListener('click', () => {
    setToken('', false);
    el('auth').setAttribute('hidden', '');
    paintBar();
  });
}

// ── the edit bar ────────────────────────────────────────────────────────────

function paintBar() {
  const bar = el('editbar');
  if (!bar) return;
  bar.hidden = !editing;
  el('edit-toggle').textContent = editing ? 'Done' : 'Edit';
  el('edit-toggle').classList.toggle('active', editing);
  el('pub-count').textContent = dirty
    ? `${dirty} unpublished change${dirty === 1 ? '' : 's'}` : 'No changes yet';
  el('btn-publish').disabled = dirty === 0;
  el('btn-undo').disabled = undoStack.length === 0;
  el('btn-token').textContent = getToken() ? 'Change token' : 'Add token';
}

function setEditing(on) {
  editing = on;
  document.body.classList.toggle('edit-mode', on);
  T.onPanel = on ? renderEditor : null;
  paintBar();
  if (T.selectedId) T.select(T.selectedId, { centre: false });
}

// ── boot ────────────────────────────────────────────────────────────────────

async function init() {
  buildChrome();
  wireAuth();
  wireUpload();

  el('edit-toggle').addEventListener('click', () => setEditing(!editing));
  el('btn-publish').addEventListener('click', publish);
  el('btn-undo').addEventListener('click', undo);
  el('btn-token').addEventListener('click', openAuth);
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

  const draft = loadDraft();
  if (draft && draft.people) {
    const when = new Date(draft.saved).toLocaleString();
    if (confirm(`You have unpublished changes from ${when}. Restore them?`)) {
      T.data.people = draft.people;
      T.data.families = draft.families;
      T.rebuild({ keepView: false });
      dirty = 1;
      setEditing(true);
    } else {
      clearDraft();
    }
  }
  paintBar();
}

function buildChrome() {
  const controls = document.querySelector('.controls');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'edit-toggle';
  toggle.className = 'edit-toggle';
  toggle.textContent = 'Edit';
  controls.appendChild(toggle);

  const bar = document.createElement('div');
  bar.id = 'editbar';
  bar.className = 'editbar';
  bar.hidden = true;
  bar.innerHTML = `
    <span id="pub-count" class="pub-count">No changes yet</span>
    <button type="button" class="mini" id="btn-undo">Undo</button>
    <button type="button" class="mini" id="btn-upload">Add photograph</button>
    <button type="button" class="mini" id="btn-download">Download</button>
    <button type="button" class="mini" id="btn-token">Add token</button>
    <button type="button" class="mini" id="btn-discard">Discard</button>
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
      <h2>Publishing needs a GitHub token</h2>
      <p>Create a <strong>fine-grained</strong> personal access token limited to
         <code>${REPO_OWNER}/${REPO_NAME}</code> with <strong>Contents: read and
         write</strong>. Nothing else. Give it a short expiry.</p>
      <p><a href="https://github.com/settings/personal-access-tokens/new"
            target="_blank" rel="noopener">Create one on GitHub →</a></p>
      <label class="fld"><span>Token</span>
        <input type="password" id="auth-token" autocomplete="off" spellcheck="false"
               placeholder="github_pat_…"></label>
      <label class="check"><input type="checkbox" id="auth-remember">
        Remember on this device</label>
      <p class="auth-warn">The token stays in this browser and goes only to
         github.com. Leave the box unticked on a shared machine and it is
         forgotten when you close the tab.</p>
      <div class="btn-row">
        <button type="button" class="mini" id="auth-forget">Forget token</button>
        <button type="button" class="mini" id="auth-cancel">Cancel</button>
        <button type="button" class="mini primary" id="auth-save">Save &amp; publish</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
}

window.Editor = { init, setEditing, verify, scrub, deriveLiving, parseDate,
                  buildPayload, buildMediaPayload, stageUpload, removePhotograph,
                  processImage, generatedName,
                  get dirty() { return dirty; },
                  get pending() { return pendingUploads; },
                  get deletes() { return pendingDeletes; } };

if (window.Tree && window.Tree.ready) init();
else window.addEventListener('tree-ready', init, { once: true });

})();
