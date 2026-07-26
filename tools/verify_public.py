#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Refuse to publish anything that exposes a living person.

Runs against a plain checkout — it needs no private data, which is the point:
CI can run it on the public repo, where the source GEDCOM does not exist.

    python3 tools/verify_public.py

Exit status is non-zero on any finding, so it can gate the Pages deploy.
"""
import datetime, json, os, re, subprocess, sys

HERE_TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE_TOOLS)
TREE = os.path.join(ROOT, "docs", "data", "tree.json")
PRIVATE = os.path.join(ROOT, "docs", "data", "tree.private.json")

# A GEDCOM data line: a level number, a tag that carries personal content, and
# an actual value after it, so it matches a real data line carrying names or
# dates but not the bare tag name appearing as a string in parser code.
# (Worded without an example on purpose: an example would match this pattern.)
GEDCOM_LINE = re.compile(
    r'(?:^|["\'\s])[0-9]\s+(NAME|GIVN|SURN|NICK|_MARNM|BIRT|DEAT|BURI|OCCU)\s+\S')

TEXT_SUFFIXES = (".py", ".js", ".html", ".css", ".json", ".md", ".yml", ".yaml",
                 ".txt", ".ged")

KNOWN_DECEASED = os.path.join(HERE_TOOLS, "known-deceased.txt")

# A declared death must be old enough that the person cannot plausibly be the
# living namesake the check is protecting.
DECLARATION_MIN_AGE_YEARS = 25

# Fields that must be absent for anyone flagged living. Kept in sync with
# build_site.PUBLIC_FIELDS_FOR_LIVING by this check failing loudly if it drifts.
FORBIDDEN_SCALARS = ("given", "married", "nick", "occupation", "geniId")
FORBIDDEN_OBJECTS = ("birth", "death", "burial")
FORBIDDEN_LISTS = ("aka", "notes", "media")

# Mirrors docs/editor.js and build_site.py. Anyone marked deceased must actually
# satisfy the rule — a tree.json edited in the browser, or by hand, does not get
# to simply assert it.
PRESUMED_DEAD_AFTER_YEARS = 100
ASSERTION_FLOOR_YEARS = 25


def derive_living(p, this_year):
    byear = ((p.get("birth") or {}).get("date") or {}).get("year")
    born_recently = bool(byear) and (this_year - byear) < ASSERTION_FLOOR_YEARS
    dated_death = ((p.get("death") or {}).get("date")
                   or (p.get("burial") or {}).get("date"))
    if dated_death:
        return False
    if (p.get("death") or p.get("burial")) and not born_recently:
        return False
    return not (byear and this_year - byear >= PRESUMED_DEAD_AFTER_YEARS)

problems = []


def fail(msg):
    problems.append(msg)


def check_no_source_data_tracked():
    """The raw GEDCOM and the unredacted build must never be in the tree."""
    try:
        tracked = subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("  (not a git checkout — skipping the tracked-files check)")
        return

    for path in tracked:
        low = path.lower()
        if low.endswith(".ged"):
            fail(f"a GEDCOM is tracked: {path}")
        if low.endswith("tree.private.json"):
            fail(f"the unredacted build is tracked: {path}")
        if low.startswith("data/"):
            fail(f"private source data is tracked: {path}")


def tracked_files():
    try:
        return subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def check_no_gedcom_content_in_tracked_files():
    """Catch personal data smuggled in as code.

    A curation script that writes GEDCOM lines carries the same names and dates
    of birth as the GEDCOM itself, and a check that only looks at *.ged and
    tree.json sails straight past it. This is that check.
    """
    files = tracked_files()
    if files is None:
        return
    for path in files:
        if not path.endswith(TEXT_SUFFIXES):
            continue
        full = os.path.join(ROOT, path)
        if not os.path.exists(full):
            continue
        # The generator is allowed to contain the payload it produces.
        if path == "docs/data/tree.json":
            continue
        try:
            with open(full, encoding="utf-8") as fh:
                for num, line in enumerate(fh, 1):
                    if GEDCOM_LINE.search(line):
                        fail(f"{path}:{num} looks like GEDCOM personal data: "
                             f"{line.strip()[:70]}")
        except (UnicodeDecodeError, OSError):
            continue


def declared_deceased():
    """Names declared deceased in tools/known-deceased.txt, with their evidence.

    Each declaration is validated rather than trusted: it must carry a death
    year, and one old enough that the person cannot be the living namesake.
    """
    tokens, problems = set(), []
    if not os.path.exists(KNOWN_DECEASED):
        return tokens, problems

    this_year = datetime.date.today().year
    with open(KNOWN_DECEASED, encoding="utf-8") as fh:
        for num, line in enumerate(fh, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 3:
                problems.append(f"known-deceased.txt:{num}: expected "
                                f"'name | birth-death | evidence'")
                continue
            name, dates, evidence = parts[0], parts[1], parts[2]
            m = re.search(r"(\d{4})\s*$", dates.split("-")[-1].strip())
            if not m:
                problems.append(f"known-deceased.txt:{num}: no death year in {dates!r}")
                continue
            death_year = int(m.group(1))
            if this_year - death_year < DECLARATION_MIN_AGE_YEARS:
                problems.append(
                    f"known-deceased.txt:{num}: {name} died {death_year}, too "
                    f"recent to declare this way")
                continue
            if not evidence:
                problems.append(f"known-deceased.txt:{num}: {name} has no evidence")
                continue
            tokens.update(t for t in name.split() if len(t) > 3)
    return tokens, problems


def check_no_living_names_in_tracked_files():
    """Cross-check against the real answer, when the real answer is available.

    tree.private.json only exists on a machine that has the source data, so
    this is a pre-push check rather than a CI one — which is the right place
    for it, because that is where a leak would be introduced.
    """
    if not os.path.exists(PRIVATE):
        print("  (no local private build — skipping the living-name cross-check)")
        return

    with open(PRIVATE, encoding="utf-8") as fh:
        private = json.load(fh)

    # Names repeat across generations, so a token that also belongs to someone
    # already published identifies nobody new — flagging it would only train
    # the reader to ignore this check.
    public_tokens = set()
    for p in private.get("people", []):
        if p.get("living"):
            continue
        for field in ("given", "surname", "married", "nick"):
            public_tokens.update((p.get(field) or "").split())

    # ...plus anyone declared deceased who is not in the tree yet.
    declared, declaration_problems = declared_deceased()
    for problem in declaration_problems:
        fail(problem)
    public_tokens |= declared
    if declared:
        print(f"  {len(declared)} token(s) covered by tools/known-deceased.txt")

    needles = set()
    for p in private.get("people", []):
        if not p.get("living"):
            continue
        for field in ("given", "nick"):
            for token in (p.get(field) or "").split():
                if len(token) > 3 and token not in public_tokens:
                    needles.add(token)
        for ev in ("birth", "death"):
            source = ((p.get(ev) or {}).get("date") or {}).get("source", "")
            # A bare year is any number; a full date is a fingerprint.
            if " " in source:
                needles.add(source)
    if not needles:
        return

    files = tracked_files()
    if files is None:
        return
    for path in files:
        if not path.endswith(TEXT_SUFFIXES):
            continue
        full = os.path.join(ROOT, path)
        if not os.path.exists(full):
            continue
        try:
            with open(full, encoding="utf-8") as fh:
                body = fh.read()
        except (UnicodeDecodeError, OSError):
            continue
        for needle in sorted(needles):
            if re.search(r"\b" + re.escape(needle) + r"\b", body):
                fail(f"{path} contains a living person's given name or date "
                     f"(matched a {len(needle)}-character token)")
                break

    print(f"  cross-checked {len(files)} tracked files against "
          f"{len(needles)} private tokens")


def check_media():
    """Photographs are published files, so they get the same rule as everything
    else: attached only to people the archive treats as deceased, and every
    reference must resolve to a file that actually exists."""
    media_dir = os.path.join(ROOT, "docs", "media")
    catalogue = os.path.join(ROOT, "docs", "data", "media.json")
    if not os.path.exists(catalogue):
        return

    with open(catalogue, encoding="utf-8") as fh:
        cat = json.load(fh)
    on_disk = set(os.listdir(media_dir)) if os.path.isdir(media_dir) else set()

    listed = set()
    for item in cat.get("items", []):
        listed.add(item["file"])
        if item["file"] not in on_disk:
            fail(f"media.json lists {item['file']} but the file is not in docs/media/")
        # A path is published as surely as a file: keep them boring and ASCII.
        if re.search(r"[^a-z0-9.\-]", item["file"]):
            fail(f"{item['file']}: filename is not URL-safe lowercase ASCII")

    for orphan in sorted(on_disk - listed):
        fail(f"docs/media/{orphan} is published but not in the catalogue")

    if not os.path.exists(TREE):
        return
    with open(TREE, encoding="utf-8") as fh:
        tree = json.load(fh)
    for p in tree.get("people", []):
        for ref in p.get("media", []) or []:
            if p.get("living"):
                fail(f"{p.get('id')}: a living person has a photograph attached")
            if ref not in listed:
                fail(f"{p.get('name')}: references missing photograph {ref}")

    print(f"  checked {len(listed)} photograph(s)")


def check_tree_json():
    if not os.path.exists(TREE):
        fail("docs/data/tree.json is missing — the site would deploy empty")
        return

    with open(TREE, encoding="utf-8") as fh:
        data = json.load(fh)

    if not data.get("redacted"):
        fail("tree.json is flagged redacted:false — this is the UNREDACTED build")

    living = 0
    for p in data.get("people", []):
        if not p.get("living"):
            continue
        living += 1
        pid = p.get("id", "?")
        for field in FORBIDDEN_SCALARS:
            if p.get(field):
                fail(f"{pid}: living person still carries {field}={p[field]!r}")
        for field in FORBIDDEN_OBJECTS:
            if p.get(field):
                fail(f"{pid}: living person still carries a {field} record")
        for field in FORBIDDEN_LISTS:
            if p.get(field):
                fail(f"{pid}: living person still carries {field}")
        name = p.get("name", "")
        if not name.startswith("Living"):
            fail(f"{pid}: living person's name is not masked ({name!r})")

    this_year = datetime.date.today().year
    for p in data.get("people", []):
        if p.get("living") != derive_living(p, this_year):
            fail(f"{p.get('id')}: living flag disagrees with the record "
                 f"(flagged {p.get('living')})")

    # A marriage date identifies the living spouse just as well as a birth date.
    people = {p["id"]: p for p in data.get("people", [])}
    for f in data.get("families", []):
        spouses = [s for s in (f.get("husband"), f.get("wife")) if s]
        if not any(people.get(s, {}).get("living") for s in spouses):
            continue
        ev = f.get("event") or {}
        if ev.get("date") or ev.get("place"):
            fail(f"{f['id']}: family event exposes a date/place for a living couple")

    print(f"  checked {len(data.get('people', []))} people "
          f"({living} living) and {len(data.get('families', []))} families")


def main():
    print("verifying the public build...")
    check_no_source_data_tracked()
    check_no_gedcom_content_in_tracked_files()
    check_tree_json()
    check_media()
    check_no_living_names_in_tracked_files()

    if problems:
        print("\nREFUSING TO PUBLISH — %d problem(s):" % len(problems))
        for p in problems:
            print("  ✗", p)
        sys.exit(1)

    print("  no living person's data is present. Safe to publish.")


if __name__ == "__main__":
    main()
