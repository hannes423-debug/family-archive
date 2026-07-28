#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prove that the browser and the build script redact identically.

    python3 tools/crosscheck.py

The redaction rules exist three times over — `docs/visibility.js` for the
browser, `redact()` in `build_site.py` for the generator, and the checks in
`verify_public.py` for the pre-push hook. That duplication is deliberate: each
is meant to catch the others being wrong. It is also the obvious place for a
silent divergence, and a divergence here does not throw an error, it publishes
somebody.

So this builds a synthetic tree containing every case that matters, runs it
through both redactors, and fails if they disagree on a single field. Node is
required because `visibility.js` is the browser's copy and is tested as such
rather than reimplemented here.

The tree is synthetic on purpose. Given names are Finnish spellings of Greek
letters and the surnames and places are invented, so the fixture is recognisably
people and recognisably nobody. That is not decoration: a plausible Finnish name
WILL eventually collide with a real living relative's, at which point the
pre-push leak check blocks the push and the obvious-looking fix is to weaken the
check. `check_fixture_is_fictional` below catches that here instead, where the
answer is to rename a fixture rather than to argue with a guard.
"""
import datetime
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VISIBILITY_JS = os.path.join(ROOT, "docs", "visibility.js")

sys.path.insert(0, HERE)
import build_site  # noqa: E402
import verify_public  # noqa: E402

THIS_YEAR = datetime.date.today().year


def person(pid, **kw):
    """A full record, in the shape the working copy holds before redaction."""
    base = {
        "id": pid, "given": "", "surname": "", "married": "", "nick": "",
        "name": "", "aka": [], "sex": "U",
        "birth": None, "death": None, "burial": None,
        "occupation": None, "notes": [], "geniId": None,
        "media": [], "photo": None,
        "generation": 0, "parentFamily": None, "spouseFamilies": [],
        "visibility": "public", "hideFields": [],
    }
    base.update(kw)
    base["name"] = " ".join(x for x in (base["given"], base["surname"]) if x) or "Unknown"
    return base


def dated(year, place=None):
    return {"date": {"source": str(year), "display": str(year),
                     "year": year, "precision": "year"}, "place": place,
            "asserted": False}


def build_fixture():
    """One person per case the rules distinguish."""
    long_ago = THIS_YEAR - 180
    lately = THIS_YEAR - 10

    people = [
        # Plainly deceased, published in full. The control.
        person("@P1@", given="Alfa", surname="Ääkkölä", sex="M",
               birth=dated(long_ago, "Esimerkkilä"), death=dated(long_ago + 70, "Näytekylä"),
               occupation="seppä", notes=["A parish book reference."],
               geniId="123", media=["a.jpg"], photo="a.jpg", generation=0,
               spouseFamilies=["@F1@"]),

        # Living by every route: recent birth, no death.
        person("@P2@", given="Beeta", surname="Ääkkölä", sex="F",
               birth=dated(lately, "Tyhjölä"), notes=["Should never be published."],
               generation=1, parentFamily="@F1@"),

        # Withheld entirely, and deceased. Sits between P1/P5 and P4, so the
        # tree has to reach across them.
        person("@P3@", given="Gamma", surname="Ääkkölä", sex="F",
               birth=dated(long_ago + 40), death=dated(long_ago + 110),
               occupation="opettaja", media=["b.jpg"], photo="b.jpg",
               visibility="hidden", generation=1,
               parentFamily="@F1@", spouseFamilies=["@F2@"]),

        # Withheld entirely, and living. Must not be handed an asserted death.
        person("@P4@", given="Delta", surname="Ääkkölä", sex="M",
               birth=dated(lately), visibility="hidden", generation=2,
               parentFamily="@F2@"),

        # The "name and dates only" preset.
        person("@P5@", given="Epsilon", surname="Öölampi", sex="M",
               birth=dated(long_ago + 20, "Mallikylä"),
               death=dated(long_ago + 95, "Mallikylä"),
               burial={"date": None, "place": "Mallikylä", "asserted": True},
               occupation="suutari", notes=["Withheld note."], geniId="456",
               media=["c.jpg"], photo="c.jpg", generation=0,
               visibility="limited", spouseFamilies=["@F1@"]),

        # Individually withheld fields, mixed with published ones.
        person("@P6@", given="Zeeta", surname="Öölampi", sex="F",
               birth=dated(long_ago + 25, "Mallikylä"),
               death=dated(long_ago + 100, "Kuvitteela"),
               occupation="emäntä", notes=["Kept."],
               hideFields=["birthPlace", "occupation"], generation=0,
               spouseFamilies=["@F3@"]),

        # THE INTERESTING ONE. Deceased only by the hundred-year presumption,
        # then asked to withhold the birth date that presumed it. Both sides
        # must repair this the same way or the record contradicts itself.
        person("@P7@", given="Eeta", surname="Yrjänvaara", sex="F",
               birth=dated(THIS_YEAR - 120, "Mallikylä"),
               hideFields=["birth"], generation=0),

        # Withholding the given names, leaving a surname.
        person("@P8@", given="Theeta Ioota", surname="Yrjänvaara", sex="M",
               nick="Theetta", aka=["Theeta Ääkkölä"],
               birth=dated(long_ago), death=dated(long_ago + 60),
               hideFields=["given"], generation=0, spouseFamilies=["@F3@"]),

        # Married to a living person; deceased and published himself.
        person("@P9@", given="Kappa", surname="Zirkkala", sex="M",
               birth=dated(long_ago + 60), death=dated(long_ago + 130),
               generation=1, spouseFamilies=["@F4@"]),
    ]

    families = [
        {"id": "@F1@", "husband": "@P1@", "wife": "@P5@",
         "children": ["@P2@", "@P3@"], "childOrder": ["@P2@", "@P3@"],
         "relation": "married", "event": dated(long_ago + 25, "Esimerkkilä"),
         "divorced": False},
        # A marriage whose only spouse is withheld: the event must go too.
        {"id": "@F2@", "husband": "@P3@", "wife": None,
         "children": ["@P4@"], "childOrder": ["@P4@"],
         "relation": "married", "event": dated(long_ago + 60, "Tyhjölä"),
         "divorced": False},
        {"id": "@F3@", "husband": "@P8@", "wife": "@P6@",
         "children": [], "childOrder": [],
         "relation": "married", "event": dated(long_ago + 30, "Mallikylä"),
         "divorced": False},
        # A marriage with a LIVING spouse: the date identifies them as surely
        # as their own birth date would, so it goes.
        {"id": "@F4@", "husband": "@P9@", "wife": "@P2@",
         "children": [], "childOrder": [],
         "relation": "married", "event": dated(THIS_YEAR - 12, "Tyhjölä"),
         "divorced": False},
    ]
    return people, families


def redact_with_python(people, families):
    pmap = {p["id"]: json.loads(json.dumps(p)) for p in people}
    fmap = {f["id"]: json.loads(json.dumps(f)) for f in families}
    build_site.mark_living(pmap, THIS_YEAR)
    build_site.redact(pmap, fmap, THIS_YEAR)
    return {"people": [pmap[p["id"]] for p in people],
            "families": [fmap[f["id"]] for f in families]}


def redact_with_javascript(people, families):
    """Run the browser's own file, under node, with a fake `window`."""
    script = """
const fs = require('fs');
global.window = {};
new Function(fs.readFileSync(process.argv[2], 'utf8'))();
const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
for (const p of input.people) p.living = window.Visibility.deriveLiving(p);
const out = window.Visibility.publicTree(input);
process.stdout.write(JSON.stringify(out));
"""
    payload = json.dumps({"people": people, "families": families},
                         ensure_ascii=False)
    tmp = os.path.join(HERE, ".crosscheck.input.json")
    runner = os.path.join(HERE, ".crosscheck.runner.js")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
        with open(runner, "w", encoding="utf-8") as fh:
            fh.write(script)
        proc = subprocess.run(["node", runner, VISIBILITY_JS, tmp],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            sys.exit("node failed:\n" + proc.stderr)
        return json.loads(proc.stdout)
    finally:
        for path in (tmp, runner):
            if os.path.exists(path):
                os.remove(path)


# Fields the two sides are not expected to agree on, because they are not part
# of the published record: the viewer's derived back-references, and ordering
# helpers. Kept explicit so that adding one is a decision rather than an
# accident.
IGNORED = {"_parents", "_children", "_siblings", "_spouses", "childOrder"}


def compare(py, js):
    problems = []
    pj = {p["id"]: p for p in js["people"]}
    for p in py["people"]:
        other = pj.get(p["id"])
        if other is None:
            problems.append(f"{p['id']}: missing from the JavaScript output")
            continue
        keys = (set(p) | set(other)) - IGNORED
        for k in sorted(keys):
            a, b = p.get(k), other.get(k)
            # [] and None both mean "nothing here" across the two languages.
            if not a and not b:
                continue
            if a != b:
                problems.append(f"{p['id']}.{k}: python={a!r} javascript={b!r}")

    fj = {f["id"]: f for f in js["families"]}
    for f in py["families"]:
        other = fj.get(f["id"])
        if other is None:
            problems.append(f"{f['id']}: missing from the JavaScript output")
            continue
        for k in sorted((set(f) | set(other)) - IGNORED):
            a, b = f.get(k), other.get(k)
            if not a and not b:
                continue
            if a != b:
                problems.append(f"{f['id']}.{k}: python={a!r} javascript={b!r}")
    return problems


def expectations(out):
    """Assertions about the redacted tree that hold whichever side produced it.

    These are the claims the feature actually makes, written independently of
    both redactors so that the two agreeing on something wrong still fails.
    """
    problems = []
    by_id = {p["id"]: p for p in out["people"]}

    def check(cond, msg):
        if not cond:
            problems.append(msg)

    p1 = by_id["@P1@"]
    check(p1["given"] == "Alfa", "P1: a published person lost their given name")
    check(p1["occupation"] == "seppä", "P1: a published person lost their occupation")
    check(p1["notes"], "P1: a published person lost their notes")

    p2 = by_id["@P2@"]
    check(p2["living"] is True, "P2: a recent birth did not derive as living")
    check(p2["name"] == "Living Ääkkölä", f"P2: name is {p2['name']!r}")
    check(not p2["given"] and not p2["birth"] and not p2["notes"],
          "P2: a living person kept detail")

    p3 = by_id["@P3@"]
    check(p3["name"] == "Withheld", f"P3: withheld name is {p3['name']!r}")
    check(p3["sex"] == "U", "P3: a withheld person kept their sex")
    check(not p3["surname"] and not p3["given"], "P3: a withheld person kept a name")
    check(not p3["media"] and not p3["photo"], "P3: a withheld person kept a photograph")
    check(p3["living"] is False, "P3: a deceased withheld person derived as living")
    check(p3["death"] == {"date": None, "place": None, "asserted": True},
          f"P3: withheld deceased death record is {p3['death']!r}")
    check(p3["parentFamily"] == "@F1@" and p3["spouseFamilies"] == ["@F2@"],
          "P3: a withheld person lost the tree position that is the point of keeping them")

    p4 = by_id["@P4@"]
    check(p4["living"] is True, "P4: a living withheld person derived as deceased")
    check(p4["death"] is None,
          "P4: a LIVING withheld person was given a death assertion — that is a false claim")

    p5 = by_id["@P5@"]
    check(p5["given"] == "Epsilon", "P5: 'name and dates only' removed the name")
    check(p5["birth"] and p5["birth"]["date"], "P5: 'name and dates only' removed the dates")
    check(p5["birth"]["place"] is None, "P5: 'name and dates only' kept the birth place")
    check(p5["burial"] is None, "P5: 'name and dates only' kept the burial")
    check(not p5["occupation"] and not p5["notes"] and not p5["geniId"],
          "P5: 'name and dates only' kept occupation/notes/geni")
    check(not p5["media"] and not p5["photo"], "P5: 'name and dates only' kept a photograph")

    p6 = by_id["@P6@"]
    check(p6["birth"]["place"] is None, "P6: withheld birth place survived")
    check(p6["birth"]["date"] is not None, "P6: withholding a place removed the date too")
    check(p6["death"]["place"] == "Kuvitteela", "P6: an unwithheld death place was removed")
    check(p6["occupation"] is None, "P6: withheld occupation survived")
    check(p6["notes"], "P6: withholding one field removed an unrelated one")

    p7 = by_id["@P7@"]
    check(p7["birth"] is None or p7["birth"]["date"] is None,
          "P7: withheld birth date survived")
    check(p7["birth"] and p7["birth"]["place"] == "Mallikylä",
          "P7: withholding the birth DATE also removed the birth PLACE, "
          "which was not withheld")
    check(p7["living"] is False,
          "P7: withholding the birth date flipped a deceased person back to living")
    check(p7["death"] == {"date": None, "place": None, "asserted": True},
          f"P7: expected a bare death assertion to keep the record consistent, got {p7['death']!r}")

    p8 = by_id["@P8@"]
    check(not p8["given"] and not p8["nick"] and not p8["aka"],
          "P8: withheld given names survived")
    check(p8["surname"] == "Yrjänvaara", "P8: withholding given names took the surname")
    check(p8["name"] == "Yrjänvaara", f"P8: name is {p8['name']!r}")

    fams = {f["id"]: f for f in out["families"]}
    # F1's spouses are both published and deceased. A living or withheld CHILD
    # is not a reason to withhold their parents' marriage.
    check(fams["@F1@"]["event"]["date"] is not None,
          "F1: a marriage date was removed because of a child, not a spouse")
    check(fams["@F2@"]["event"]["date"] is None,
          "F2: a marriage date survived for a withheld person")
    check(fams["@F3@"]["event"]["date"] is not None,
          "F3: a marriage date was removed for a couple who are both published")
    check(fams["@F4@"]["event"]["date"] is None,
          "F4: a marriage date survived for a couple including a living person")
    check(fams["@F4@"]["event"]["asserted"] is True,
          "F4: withholding the date deleted the marriage instead of keeping the fact of it")
    return problems


def run_verifiers(out):
    """The pre-push hook's own checks must accept what the redactors produced."""
    verify_public.problems.clear()
    payload = {"redacted": True, "people": out["people"], "families": out["families"],
               "stats": {}}
    tmp = os.path.join(HERE, ".crosscheck.tree.json")
    real = verify_public.TREE
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        verify_public.TREE = tmp
        verify_public.check_tree_json()
        found = list(verify_public.problems)
    finally:
        verify_public.TREE = real
        verify_public.problems.clear()
        if os.path.exists(tmp):
            os.remove(tmp)
    return found + build_site.verify_no_leak(payload)


def negative_tests():
    """Prove the guards actually fire. A check that cannot fail is not a check.

    Each case takes a correctly redacted tree, reintroduces exactly one leak,
    and requires that something objects.
    """
    problems = []
    people, families = build_fixture()

    def leaked(mutate, what):
        out = redact_with_python(people, families)
        mutate(out)
        if not run_verifiers(out):
            problems.append(f"a leak went unnoticed: {what}")

    def find(out, pid):
        return next(p for p in out["people"] if p["id"] == pid)

    leaked(lambda o: find(o, "@P3@").update(name="Gamma Ääkkölä"),
           "a withheld person given their name back")
    leaked(lambda o: find(o, "@P3@").update(surname="Ääkkölä"),
           "a withheld person given their surname back")
    leaked(lambda o: find(o, "@P3@").update(sex="F"),
           "a withheld person given their sex back")
    leaked(lambda o: find(o, "@P3@").update(media=["b.jpg"]),
           "a withheld person given a photograph back")
    leaked(lambda o: find(o, "@P3@")["death"].update(date=dated(1900)["date"]),
           "a withheld person given a death date")
    leaked(lambda o: find(o, "@P2@").update(given="Beeta"),
           "a living person given their name back")
    leaked(lambda o: find(o, "@P6@").update(occupation="emäntä"),
           "a withheld field put back while still marked withheld")
    leaked(lambda o: find(o, "@P5@")["birth"].update(place="Mallikylä"),
           "a place withheld by the 'name and dates only' preset put back")
    leaked(lambda o: o["families"][1].update(event=dated(1900, "Tyhjölä")),
           "a marriage date restored for a withheld spouse")
    leaked(lambda o: find(o, "@P7@").update(death=None),
           "a presumed-dead person left deriving as living")
    return problems


def check_fixture_is_fictional(people):
    """The fixture must not accidentally name a real living person.

    This file is committed to a public repository, so a fixture name that
    happens to match a living relative's given name is a leak — and the
    pre-push hook will say so, at the worst possible moment and in a way that
    makes weakening the hook look like the fix. Catch it here instead, where
    the answer is obviously to rename a fixture.

    Only runs where the private build exists, which is the only place the real
    answer is known; elsewhere it quietly passes, exactly like the pre-push
    cross-check it is standing in for.
    """
    private = os.path.join(ROOT, "docs", "data", "tree.private.json")
    if not os.path.exists(private):
        return []

    with open(private, encoding="utf-8") as fh:
        real = json.load(fh)

    # A name already published for someone deceased identifies nobody new.
    published = set()
    for p in real.get("people", []):
        if p.get("living"):
            continue
        for field in ("given", "surname", "married", "nick"):
            published.update((p.get(field) or "").split())

    sensitive = set()
    for p in real.get("people", []):
        if not p.get("living"):
            continue
        for field in ("given", "nick"):
            for token in (p.get(field) or "").split():
                if len(token) > 3 and token not in published:
                    sensitive.add(token.lower())

    # Reports which fixture PERSON to rename, never the token that matched:
    # in a collision the offending token is a living person's given name, and
    # printing it would put it into terminal scrollback and CI logs.
    problems = []
    for p in people:
        tokens = set()
        for field in ("given", "surname", "married", "nick"):
            tokens.update(t.lower() for t in (p.get(field) or "").split())
        tokens.update(t.lower() for name in p.get("aka") or [] for t in name.split())
        if tokens & sensitive:
            problems.append(f"{p['id']}: one of its names matches a living person's "
                            f"given name — rename it in build_fixture()")
    return problems


def main():
    people, families = build_fixture()

    py = redact_with_python(people, families)
    js = redact_with_javascript(people, families)

    print("crosschecking the redaction rules...")
    print(f"  {len(people)} synthetic people, {len(families)} families")

    failures = []

    fictional = check_fixture_is_fictional(people)
    if fictional:
        failures.append(("the fixture names a real living person", fictional))
    else:
        print("  the fixture names nobody real")

    drift = compare(py, js)
    if drift:
        failures.append(("build_site.py and docs/visibility.js disagree", drift))
    else:
        print("  python and javascript agree field for field")

    for label, out in (("python", py), ("javascript", js)):
        bad = expectations(out)
        if bad:
            failures.append((f"the {label} output breaks the rules", bad))
        else:
            print(f"  {label} output satisfies every expectation")

    for label, out in (("python", py), ("javascript", js)):
        bad = run_verifiers(out)
        if bad:
            failures.append((f"the verifiers reject the {label} output", bad))
        else:
            print(f"  verify_public.py accepts the {label} output")

    bad = negative_tests()
    if bad:
        failures.append(("a deliberately planted leak was not caught", bad))
    else:
        print("  every planted leak was caught")

    if failures:
        print("\nFAILED — %d group(s):" % len(failures))
        for title, items in failures:
            print(f"\n{title}:")
            for item in items:
                print("  ✗", item)
        sys.exit(1)

    print("\nthe browser and the build script redact identically.")


if __name__ == "__main__":
    main()
