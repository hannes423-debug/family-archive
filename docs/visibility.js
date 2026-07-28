/* Family Archive — what may be published, and what may not.
 *
 * This file is the single definition of the redaction rules, shared by the
 * viewer and the editor. It touches no DOM and holds no state, so the test
 * suites can call it directly and `tools/verify_public.py` can be checked
 * against it line by line.
 *
 * There are three reasons a fact does not reach the public tree, and they are
 * applied in this order, because the earlier ones are absolute:
 *
 *   1. HIDDEN     — the archivist withheld this person entirely. They survive
 *                   as an unlabelled connector so the tree still joins up.
 *   2. LIVING      — derived from the record, never asserted. Unchanged rule.
 *   3. PER-FIELD   — the archivist withheld particular facts about someone who
 *                   is otherwise published.
 *
 * The important property: this is a *publish-time* filter, not a display one.
 * `docs/data/tree.json` is a plain file on a public web server, so anything
 * that reaches it is published whether or not the interface draws it. Hiding
 * something in the viewer alone would be theatre.
 */
(function () {
'use strict';

// Both mirrored in tools/build_site.py and tools/verify_public.py.
const PRESUMED_DEAD_AFTER_YEARS = 100;

// Below this age, "deceased" needs an actual death date rather than a bare
// assertion. Claiming a small child has died is not something anyone should be
// able to do by mis-clicking a checkbox, and that is the case where getting it
// wrong publishes a minor's details.
const ASSERTION_FLOOR_YEARS = 25;

const thisYear = () => new Date().getFullYear();

// ── living ──────────────────────────────────────────────────────────────────

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
  const now = thisYear();
  const year = p.birth && p.birth.date && p.birth.date.year;
  const bornRecently = year && (now - year) < ASSERTION_FLOOR_YEARS;

  // A death with an actual date is a specific factual claim and always counts.
  const datedDeath = (p.death && p.death.date) || (p.burial && p.burial.date);
  if (datedDeath) return false;

  // A bare "deceased, date unknown" is trusted for an ancestor, but it must not
  // outrank a recent birth date — otherwise ticking a box and then typing a
  // birth year would publish a child. Order of entry must not change the answer.
  if ((p.death || p.burial) && !bornRecently) return false;

  return !(year && now - year >= PRESUMED_DEAD_AFTER_YEARS);
}

// ── the visibility vocabulary ───────────────────────────────────────────────

const LEVELS = [
  { key: 'public',  label: 'Published',
    hint: 'Everything recorded about them is published.' },
  { key: 'limited', label: 'Name and dates only',
    hint: 'Their name and years are published; places, occupation, notes and photographs are not.' },
  { key: 'hidden',  label: 'Withheld entirely',
    hint: 'Nothing about them is published. They appear as an unnamed connector so their relatives still join up.' },
];

const LEVEL_KEYS = LEVELS.map((l) => l.key);

/** The facts an archivist may withhold one at a time. */
const FIELDS = [
  { key: 'given',      label: 'Given names',    hint: 'Leaves the surname' },
  { key: 'birth',      label: 'Birth date' },
  { key: 'birthPlace', label: 'Birth place' },
  { key: 'death',      label: 'Death date' },
  { key: 'deathPlace', label: 'Death place' },
  { key: 'burial',     label: 'Burial' },
  { key: 'occupation', label: 'Occupation' },
  { key: 'notes',      label: 'Notes & sources' },
  { key: 'media',      label: 'Photographs' },
  { key: 'geniId',     label: 'Geni link' },
];

const FIELD_KEYS = FIELDS.map((f) => f.key);

/** What "name and dates only" expands to. Kept as a preset over the same
 *  mechanism rather than a separate code path, so there is one thing to audit. */
const LIMITED_HIDES = ['birthPlace', 'deathPlace', 'burial',
                       'occupation', 'notes', 'media', 'geniId'];

function level(p) {
  return LEVEL_KEYS.includes(p.visibility) ? p.visibility : 'public';
}

/** Every field withheld for this person, preset and individual picks merged. */
function effectiveHides(p) {
  const set = new Set(level(p) === 'limited' ? LIMITED_HIDES : []);
  for (const k of p.hideFields || []) if (FIELD_KEYS.includes(k)) set.add(k);
  return set;
}

/** Sorted, so the published file does not churn on the order things were
 *  ticked in — and so it matches what build_site.py writes byte for byte. */
const hideList = (p) => [...effectiveHides(p)].sort();

// ── redaction ───────────────────────────────────────────────────────────────

/** The only fields a living person may carry into the public repository. */
const LIVING_KEEPS = ['id', 'surname', 'sex', 'living', 'generation',
                      'parentFamily', 'spouseFamilies'];

/** The only fields a withheld person may carry. Structure, and nothing else. */
const HIDDEN_KEEPS = ['id', 'generation', 'parentFamily', 'spouseFamilies'];

const BLANK = {
  given: '', surname: '', married: '', nick: '', aka: [],
  birth: null, death: null, burial: null,
  occupation: null, notes: [], geniId: null, media: [], photo: null,
};

/**
 * A withheld person, reduced to a connector.
 *
 * Their `living` flag survives, because it has to: every other guard re-derives
 * it from the record and would otherwise read the blank placeholder as a living
 * person and start complaining. For a deceased one that means stamping the bare
 * "died, date unknown" assertion — which is not a leak but a true statement,
 * and the same one already used for undated ancestors.
 */
function hiddenPerson(p) {
  const out = {};
  for (const k of HIDDEN_KEEPS) out[k] = p[k];
  const living = deriveLiving(p);
  return Object.assign(out, BLANK, {
    hidden: true,
    living,
    visibility: 'hidden',
    hideFields: [],
    sex: 'U',                 // a sex is a fact about them like any other
    name: 'Withheld',
    death: living ? null : { date: null, place: null, asserted: true },
  });
}

/**
 * A living person: a surname, a sex, a place in the tree, and nothing else.
 *
 * Their per-field withholdings are dropped rather than published. Everything is
 * withheld for them anyway, and a list naming which facts exist to be withheld
 * is itself a small disclosure about someone whose whole record is meant to be
 * absent.
 */
function livingPerson(p) {
  const out = {};
  for (const k of LIVING_KEEPS) out[k] = p[k];
  return Object.assign(out, BLANK, {
    hidden: false,
    living: true,
    visibility: 'public',
    hideFields: [],
    surname: p.surname || '',
    name: ('Living ' + (p.surname || '')).trim(),
  });
}

/**
 * Apply the per-field withholdings to someone who is otherwise published.
 *
 * Hiding a birth date can knock the record out of step with itself: someone
 * deceased only by the hundred-year presumption loses the very date that
 * presumed it, and every guard downstream would then re-derive them as living.
 * Stamping the bare death assertion keeps the published record self-consistent
 * without publishing anything that is not true.
 */
function limitedPerson(p) {
  const hide = effectiveHides(p);
  const out = { ...p, hidden: false, living: false,
                visibility: level(p), hideFields: hideList(p) };

  if (hide.has('given')) { out.given = ''; out.nick = ''; out.aka = []; }
  if (hide.has('birth')) {
    out.birth = out.birth && out.birth.place && !hide.has('birthPlace')
      ? { date: null, place: out.birth.place, asserted: false } : null;
  }
  if (hide.has('birthPlace') && out.birth) out.birth = { ...out.birth, place: null };
  if (hide.has('death')) {
    out.death = out.death && out.death.place && !hide.has('deathPlace')
      ? { date: null, place: out.death.place, asserted: false } : null;
  }
  if (hide.has('deathPlace') && out.death) out.death = { ...out.death, place: null };
  if (hide.has('burial')) out.burial = null;
  if (hide.has('occupation')) out.occupation = null;
  if (hide.has('notes')) out.notes = [];
  if (hide.has('media')) { out.media = []; out.photo = null; }
  if (hide.has('geniId')) out.geniId = null;

  // An empty event object is noise; drop it rather than publish a husk.
  for (const k of ['birth', 'death', 'burial']) {
    const e = out[k];
    if (e && !e.date && !e.place && !e.asserted) out[k] = null;
  }

  out.name = [out.given, out.surname].filter(Boolean).join(' ')
    || out.surname || 'Unknown';

  if (deriveLiving(out)) {
    out.death = { date: null, place: null, asserted: true };
  }
  return out;
}

/** The public view of one person. Hidden beats living beats per-field. */
function publicPerson(p) {
  if (level(p) === 'hidden') return hiddenPerson(p);
  if (deriveLiving(p)) return livingPerson(p);
  return limitedPerson(p);
}

/** True when a family's own event (a marriage date and place) must be withheld,
 *  because it identifies a spouse as surely as their own dates would. */
function familyEventWithheld(f, byId) {
  return [f.husband, f.wife].filter(Boolean).some((id) => {
    const s = byId.get(id);
    return s && (s.living || s.hidden);
  });
}

/**
 * The public view of the whole tree. Pure: the input is not touched.
 *
 * A withheld family event becomes the bare assertion rather than nothing —
 * "they married, and when is not recorded here" is both true and the same
 * husk `build_site.py` writes. Emitting null instead would quietly delete the
 * relationship itself.
 */
function publicTree(data) {
  const people = data.people.map(publicPerson);
  const byId = new Map(people.map((p) => [p.id, p]));
  const families = data.families.map((f) => (
    (f.event && familyEventWithheld(f, byId))
      ? { ...f, event: { date: null, place: null, asserted: true } }
      : { ...f }
  ));
  return { people, families };
}

// ── verification ────────────────────────────────────────────────────────────

/**
 * An independent re-check of a finished payload — the last gate before a push,
 * and deliberately written as a re-derivation rather than a re-run of the
 * redaction above, so that a mistake in one is caught by the other.
 */
function problems(data, media) {
  const found = [];
  const byId = new Map(data.people.map((p) => [p.id, p]));
  const say = (m) => found.push(m);

  for (const p of data.people) {
    const who = p.name || p.id;

    if (p.hidden) {
      for (const f of ['given', 'surname', 'married', 'nick', 'occupation', 'geniId']) {
        if (p[f]) say(`${p.id}: withheld, but still carries ${f}`);
      }
      if (p.birth || p.burial) say(`${p.id}: withheld, but still carries a date record`);
      if (p.death && (p.death.date || p.death.place)) {
        say(`${p.id}: withheld, but its death record carries a date or place`);
      }
      if ((p.aka || []).length || (p.notes || []).length) {
        say(`${p.id}: withheld, but still carries aka/notes`);
      }
      if ((p.media || []).length || p.photo) {
        say(`${p.id}: withheld, but still has a photograph attached`);
      }
      if (p.sex && p.sex !== 'U') say(`${p.id}: withheld, but still carries a sex`);
      if (p.name !== 'Withheld') say(`${p.id}: withheld, but its name is ${p.name}`);
      continue;
    }

    if (p.living) {
      for (const f of ['given', 'married', 'nick', 'occupation', 'geniId']) {
        if (p[f]) say(`${who}: still carries ${f}`);
      }
      for (const f of ['birth', 'death', 'burial']) {
        if (p[f]) say(`${who}: still carries a ${f} record`);
      }
      if ((p.aka || []).length || (p.notes || []).length) {
        say(`${who}: still carries aka/notes`);
      }
      if ((p.media || []).length || p.photo) {
        say(`${who}: still has a photograph attached`);
      }
      if (!/^Living\b/.test(p.name || '')) say(`${p.id}: name is not masked (${p.name})`);
      if (deriveLiving(p) !== true) {
        say(`${p.id}: flagged living but the record says otherwise`);
      }
      continue;
    }

    if (deriveLiving(p)) say(`${who}: marked deceased but the record says living`);

    // Whatever the archivist withheld must actually be absent.
    const hide = effectiveHides(p);
    const carries = {
      given: p.given || p.nick || (p.aka || []).length,
      birth: p.birth && p.birth.date,
      birthPlace: p.birth && p.birth.place,
      death: p.death && p.death.date,
      deathPlace: p.death && p.death.place,
      burial: p.burial,
      occupation: p.occupation,
      notes: (p.notes || []).length,
      media: (p.media || []).length || p.photo,
      geniId: p.geniId,
    };
    for (const key of hide) {
      if (carries[key]) say(`${who}: ${key} is withheld but was published anyway`);
    }
  }

  // A marriage date identifies a withheld or living spouse as surely as a
  // birth date would.
  for (const f of data.families) {
    if (!f.event || !(f.event.date || f.event.place)) continue;
    if (familyEventWithheld(f, byId)) {
      say('a family event exposes a date or place for a withheld or living couple');
    }
  }

  // Structural integrity, so a bad edit cannot publish a broken tree.
  for (const p of data.people) {
    if (p.parentFamily && !data.families.some((f) => f.id === p.parentFamily)) {
      say(`${p.name}: parent family does not exist`);
    }
    for (const fid of p.spouseFamilies || []) {
      if (!data.families.some((f) => f.id === fid)) {
        say(`${p.name}: spouse family does not exist`);
      }
    }
  }
  for (const f of data.families) {
    for (const c of f.children) {
      if (!byId.has(c)) say('a family lists a child who does not exist');
    }
  }

  if (media) {
    const known = new Set((media.items || []).map((m) => m.file));
    for (const m of media.items || []) {
      // Generated names only: an uploaded filename could be anything, and a
      // path publishes as surely as a file.
      if (!/^[a-z0-9.\-]+$/.test(m.file)) {
        say(`photograph filename is not URL-safe: ${m.file}`);
      }
      if (!m.caption) say('a photograph has no caption');
    }
    for (const p of data.people) {
      for (const ref of p.media || []) {
        if (!known.has(ref)) {
          say(`${p.name}: references a photograph that is not in the catalogue`);
        }
      }
      if (p.photo && !known.has(p.photo)) {
        say(`${p.name}: portrait is not in the catalogue`);
      }
    }
  }
  return found;
}

window.Visibility = {
  deriveLiving, publicPerson, publicTree, problems,
  level, effectiveHides, familyEventWithheld,
  LEVELS, LEVEL_KEYS, FIELDS, FIELD_KEYS, LIMITED_HIDES,
  LIVING_KEEPS, HIDDEN_KEEPS,
  PRESUMED_DEAD_AFTER_YEARS, ASSERTION_FLOOR_YEARS,
};

})();
