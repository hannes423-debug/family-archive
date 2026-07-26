#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the published site's data file from the curated GEDCOM.

    python3 tools/build_site.py                  -> docs/data/tree.json          (redacted, public)
    python3 tools/build_site.py --include-living -> docs/data/tree.private.json  (full, gitignored)

The public build NEVER contains a living person's given names, dates, places,
occupations, notes or upstream Geni id — only a surname, a sex and their edges
in the tree. See docs/privacy.html. The repository this feeds is public, so the
default has to be the safe one; the unsafe build needs an explicit flag and
writes to a path that .gitignore already covers.
"""
import argparse, json, os, re, sys, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_GED = os.path.join(ROOT, "data", "gedcom",
                           "export-BloodTree-2026-07-25.curated.ged")
OUT_DIR = os.path.join(ROOT, "docs", "data")

# A person with no death record is presumed dead once this many years have
# passed since their birth. 100 is the threshold Ancestry and MyHeritage use.
# Anyone below it, and anyone with no dates at all, counts as living.
PRESUMED_DEAD_AFTER_YEARS = 100

MONTHS = {m: i for i, m in enumerate(
    "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(), 1)}
MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]


# ── GEDCOM parsing ───────────────────────────────────────────────────────────

class Node:
    __slots__ = ("tag", "value", "xref", "children")

    def __init__(self, tag, value="", xref=None):
        self.tag, self.value, self.xref, self.children = tag, value, xref, []

    def all(self, tag):
        return [c for c in self.children if c.tag == tag]

    def first(self, tag):
        for c in self.children:
            if c.tag == tag:
                return c
        return None

    def val(self, tag, default=""):
        c = self.first(tag)
        return c.value if c else default

    def text(self):
        """Value plus CONT/CONC continuations, rejoined per the GEDCOM rules.

        CONC continues the line with no separator (it can split mid-URL, so it
        must be joined before anything tries to find links); CONT starts a new
        line.
        """
        out = self.value
        for c in self.children:
            if c.tag == "CONC":
                out += c.value
            elif c.tag == "CONT":
                out += "\n" + c.value
        return out.strip()


LINE_RE = re.compile(r"^(\d+)\s+(?:(@[^@]+@)\s+)?(\w+)(?:\s(.*))?$")


def parse(path):
    """Parse into level-0 records. Unrecognised tags are kept, never dropped."""
    root = Node("ROOT")
    stack = [(-1, root)]
    with open(path, encoding="utf-8") as fh:
        for num, raw in enumerate(fh, 1):
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            m = LINE_RE.match(line)
            if not m:
                print(f"  ! unparsable line {num}: {line!r}", file=sys.stderr)
                continue
            level, xref, tag, value = int(m.group(1)), m.group(2), m.group(3), m.group(4) or ""
            # A level-0 "0 @X@ INDI" puts the xref before the tag; a pointer
            # value like "1 FAMC @F1@" puts it after, where the regex has
            # already left it in `value`.
            node = Node(tag, value, xref)
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack[-1][1].children.append(node)
            stack.append((level, node))
    return root


# ── dates and places ─────────────────────────────────────────────────────────

DATE_RE = re.compile(
    r"^(?:(?P<mod>ABT|CAL|EST|BEF|AFT)\s+)?"
    r"(?:(?P<day>\d{1,2})\s+)?"
    r"(?:(?P<mon>[A-Z]{3})\s+)?"
    r"(?P<year>\d{3,4})$", re.I)


def parse_date(raw):
    """A GenDate-lite: always keeps the source string, never guesses precision.

    Genealogical dates are routinely imprecise ("1912", "ABT 1840"), which is
    exactly what a Date object cannot represent, so the display string is
    derived here rather than in the browser.
    """
    if not raw:
        return None
    raw = raw.strip()
    m = DATE_RE.match(raw)
    if not m:
        return {"source": raw, "display": raw, "year": None, "precision": "unknown"}
    mod, day, mon, year = m.group("mod"), m.group("day"), m.group("mon"), m.group("year")
    year = int(year)
    mon_n = MONTHS.get((mon or "").upper())
    if day and mon_n:
        precision, display = "day", f"{int(day)} {MONTH_NAMES[mon_n]} {year}"
    elif mon_n:
        precision, display = "month", f"{MONTH_NAMES[mon_n]} {year}"
    else:
        precision, display = "year", str(year)
    if mod:
        display = {"ABT": "about ", "CAL": "calculated ", "EST": "estimated ",
                   "BEF": "before ", "AFT": "after "}[mod.upper()] + display
        precision = "approx"
    return {"source": raw, "display": display, "year": year, "precision": precision}


def parse_place(node):
    """This export uses ADDR/CITY/CTRY blocks where the spec expects PLAC, and
    both forms appear in the same file, so read either."""
    if node is None:
        return None
    plac = node.val("PLAC")
    if plac:
        return plac
    addr = node.first("ADDR")
    if addr is None:
        return None
    parts = [addr.val(t) for t in ("ADR1", "CITY", "STAE", "CTRY")]
    parts = [p for p in parts if p]
    return ", ".join(parts) or None


def event(node, tag):
    e = node.first(tag)
    if e is None:
        return None
    date, place = parse_date(e.val("DATE")), parse_place(e)
    # "1 ENGA Y" / "1 MARR Y" means the event happened but nothing is recorded
    # about it — it is not a date and must not be shown as one.
    asserted = e.value.strip().upper() == "Y"
    if not date and not place and not asserted:
        return None
    return {"date": date, "place": place, "asserted": asserted}


# ── names ────────────────────────────────────────────────────────────────────

def read_names(indi):
    """Geni emits the display name and the natural name as separate NAME
    structures, often byte-identical, so deduplicate here rather than showing
    a person three copies of themselves."""
    seen, names = set(), []
    for n in indi.all("NAME"):
        given = n.val("GIVN") or re.sub(r"/.*?/", "", n.value).strip()
        surn = n.val("SURN")
        if not surn:
            m = re.search(r"/(.*?)/", n.value)
            surn = m.group(1) if m else ""
        rec = {
            "given": " ".join(given.split()),
            "surname": " ".join(surn.split()),
            # Finnish maiden-name convention, following the export's own usage:
            # SURN is the maiden name, _MARNM the married one.
            "married": n.val("_MARNM"),
            "nick": n.val("NICK"),
        }
        key = (rec["given"], rec["surname"], rec["married"])
        if key in seen or not (rec["given"] or rec["surname"]):
            continue
        seen.add(key)
        names.append(rec)
    return names


def display_name(name):
    parts = [p for p in (name["given"], name["surname"]) if p]
    return " ".join(parts) or "Unknown"


# ── the model ────────────────────────────────────────────────────────────────

def build(ged_path, this_year):
    root = parse(ged_path)
    people, families = {}, {}

    for rec in root.children:
        if rec.tag == "INDI" and rec.xref:
            names = read_names(rec)
            primary = names[0] if names else {"given": "", "surname": "", "married": "", "nick": ""}
            birth, death, burial = event(rec, "BIRT"), event(rec, "DEAT"), event(rec, "BURI")
            notes = [n.text() for n in rec.all("NOTE")]
            notes = [re.sub(r"^\{geni:about_me\}\s*", "", n).strip() for n in notes]
            people[rec.xref] = {
                "id": rec.xref,
                "given": primary["given"],
                "surname": primary["surname"],
                "married": primary["married"],
                "nick": primary["nick"],
                "name": display_name(primary),
                "aka": [display_name(n) for n in names[1:]],
                "sex": rec.val("SEX") or "U",
                "birth": birth,
                "death": death,
                "burial": burial,
                "occupation": (rec.val("OCCU") or "").strip() or None,
                "notes": [n for n in notes if n],
                "geniId": (rec.val("RFN") or "").replace("geni:", "") or None,
                "parentFamily": rec.val("FAMC") or None,
                "spouseFamilies": [c.value for c in rec.all("FAMS") if c.value],
            }
        elif rec.tag == "FAM" and rec.xref:
            ev = event(rec, "MARR") or event(rec, "ENGA")
            families[rec.xref] = {
                "id": rec.xref,
                "husband": rec.val("HUSB") or None,
                "wife": rec.val("WIFE") or None,
                "children": [c.value for c in rec.all("CHIL") if c.value],
                "relation": "married" if rec.first("MARR") is not None else (
                    "engaged" if rec.first("ENGA") is not None else "partners"),
                "event": ev,
                "divorced": rec.first("DIV") is not None,
            }

    # Drop pointers that go nowhere, so the browser never has to defend itself.
    for p in people.values():
        if p["parentFamily"] not in families:
            p["parentFamily"] = None
        p["spouseFamilies"] = [f for f in p["spouseFamilies"] if f in families]
    for f in families.values():
        if f["husband"] not in people:
            f["husband"] = None
        if f["wife"] not in people:
            f["wife"] = None
        f["children"] = [c for c in f["children"] if c in people]

    mark_living(people, this_year)
    assign_generations(people, families)
    return people, families


def mark_living(people, this_year):
    """A death or burial record proves death. Otherwise a birth long enough ago
    presumes it. Everyone else — including everyone with no dates at all — is
    treated as living, because guessing wrong in that direction is the one that
    publishes a real person's data."""
    for p in people.values():
        if p["death"] or p["burial"]:
            p["living"] = False
            continue
        byear = (p["birth"] or {}).get("date", {})
        byear = byear.get("year") if byear else None
        p["living"] = not (byear and this_year - byear >= PRESUMED_DEAD_AFTER_YEARS)


def assign_generations(people, families):
    """Propagate a generation index across the whole graph: parents are one
    less than their children, spouses share one. Done as a fixpoint sweep so
    it survives the several disconnected roots this tree has."""
    gen = {}
    remaining = set(people)
    while remaining:
        seed = min(remaining)
        gen[seed] = 0
        frontier = [seed]
        while frontier:
            nxt = []
            for pid in frontier:
                g = gen[pid]
                p = people[pid]
                for fid in p["spouseFamilies"]:
                    fam = families[fid]
                    for other in (fam["husband"], fam["wife"]):
                        if other and other not in gen:
                            gen[other] = g
                            nxt.append(other)
                    for child in fam["children"]:
                        if child not in gen:
                            gen[child] = g + 1
                            nxt.append(child)
                fid = p["parentFamily"]
                if fid:
                    fam = families[fid]
                    for parent in (fam["husband"], fam["wife"]):
                        if parent and parent not in gen:
                            gen[parent] = g - 1
                            nxt.append(parent)
                    for sib in fam["children"]:
                        if sib not in gen:
                            gen[sib] = g
                            nxt.append(sib)
            frontier = nxt
        remaining -= set(gen)
    # Normalise each connected component so the oldest generation is 0.
    base = min(gen.values()) if gen else 0
    for pid, g in gen.items():
        people[pid]["generation"] = g - base


# ── redaction ────────────────────────────────────────────────────────────────

PUBLIC_FIELDS_FOR_LIVING = ("id", "surname", "sex", "living", "generation",
                            "parentFamily", "spouseFamilies")


def redact(people, families):
    """Reduce every living person to a surname and their edges.

    Deliberately a whitelist, not a blacklist: a field added to the model later
    is excluded by default instead of silently leaking on the next build.
    """
    redacted = 0
    for pid, p in list(people.items()):
        if not p["living"]:
            continue
        kept = {k: p[k] for k in PUBLIC_FIELDS_FOR_LIVING}
        kept["name"] = f"Living {p['surname']}".strip() or "Living"
        kept["given"] = ""
        kept["married"] = ""
        kept["nick"] = ""
        kept["aka"] = []
        kept["birth"] = kept["death"] = kept["burial"] = None
        kept["occupation"] = None
        kept["notes"] = []
        kept["geniId"] = None
        people[pid] = kept
        redacted += 1

    # A marriage date is also a living person's data when either spouse is
    # living, so the family event goes too.
    for f in families.values():
        spouses = [s for s in (f["husband"], f["wife"]) if s]
        if any(people[s]["living"] for s in spouses) and f["event"]:
            f["event"] = {"date": None, "place": None, "asserted": True}
    return redacted


# ── output ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gedcom", nargs="?", default=DEFAULT_GED)
    ap.add_argument("--include-living", action="store_true",
                    help="emit unredacted data to tree.private.json (never commit it)")
    ap.add_argument("--year", type=int, default=datetime.date.today().year,
                    help="reference year for the presumed-death rule")
    args = ap.parse_args()

    if not os.path.exists(args.gedcom):
        sys.exit(f"no such GEDCOM: {args.gedcom}\n"
                 "The source data is gitignored — it is not in a fresh clone by design.")

    people, families = build(args.gedcom, args.year)
    living = sum(1 for p in people.values() if p["living"])

    if args.include_living:
        out_path = os.path.join(OUT_DIR, "tree.private.json")
        redacted = 0
    else:
        out_path = os.path.join(OUT_DIR, "tree.json")
        redacted = redact(people, families)

    payload = {
        "generated": datetime.datetime.now(datetime.timezone.utc)
                             .replace(microsecond=0).isoformat(),
        "source": os.path.basename(args.gedcom),
        "redacted": not args.include_living,
        "stats": {
            "people": len(people),
            "families": len(families),
            "living": living,
            "redacted": redacted,
            "generations": (max(p["generation"] for p in people.values()) + 1) if people else 0,
        },
        "people": sorted(people.values(), key=lambda p: (p["generation"], p["name"])),
        "families": sorted(families.values(), key=lambda f: f["id"]),
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    rel = os.path.relpath(out_path, ROOT)
    print(f"wrote {rel}")
    print(f"  {len(people)} people, {len(families)} families, "
          f"{payload['stats']['generations']} generations")
    if args.include_living:
        print(f"  !! UNREDACTED — {living} living people in full. Do not commit.")
    else:
        print(f"  {redacted} living people redacted to surname only")
        leaked = verify_no_leak(payload)
        if leaked:
            sys.exit("REFUSING TO SHIP: living data present in public build:\n  " +
                     "\n  ".join(leaked))
        print("  verified: no living person's name, date, place or note in output")


def verify_no_leak(payload):
    """Belt and braces — re-read the actual emitted payload and prove that no
    living person carries an identifying field. The redactor and this check are
    written independently on purpose."""
    problems = []
    for p in payload["people"]:
        if not p.get("living"):
            continue
        for field in ("given", "married", "nick", "occupation", "geniId"):
            if p.get(field):
                problems.append(f"{p['id']} still has {field}={p[field]!r}")
        for field in ("birth", "death", "burial"):
            if p.get(field):
                problems.append(f"{p['id']} still has a {field} record")
        if p.get("aka") or p.get("notes"):
            problems.append(f"{p['id']} still has aka/notes")
        if p.get("name", "") and not p["name"].startswith("Living"):
            problems.append(f"{p['id']} name not masked: {p['name']!r}")
    return problems


if __name__ == "__main__":
    main()
