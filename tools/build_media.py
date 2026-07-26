#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Publish family photographs, and catalogue what they are.

    python3 tools/build_media.py            # dry run: show what would happen
    python3 tools/build_media.py --write    # copy into docs/media/ + write the catalogue

Reads the private drop folder (`Family photos/`, gitignored), copies each image
to `docs/media/` under a safe filename, and writes `docs/data/media.json`
describing them.

WHY THE FILENAMES ARE REWRITTEN
-------------------------------
A path is published just as surely as a file. The original folders were named
after a living relative, so the directory listing alone would have leaked what
the tree redacts. Everything here is therefore renamed to ASCII, and every
resulting name is checked against the same rule the rest of the archive uses:
a name may only appear if it belongs to someone the archive treats as deceased.

Photographs are attached to people in tree.json (`person.media`), not here, so
that the browser editor can change attachments with a single commit. This file
is the catalogue of what exists.
"""
import argparse, datetime, hashlib, json, os, re, shutil, sys, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_DIR = os.path.join(ROOT, "Family photos")
OUT_DIR = os.path.join(ROOT, "docs", "media")
CATALOGUE = os.path.join(ROOT, "docs", "data", "media.json")
TREE = os.path.join(ROOT, "docs", "data", "tree.json")

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".gif", ".webp")

# Folder and filename hints that say what kind of thing an image is.
KINDS = [
    (re.compile(r"hautakiv|muisto|grave", re.I), "memorial",
     "Gravestone or memorial"),
    (re.compile(r"kuolinilmoitus|ilmoitus|obituar", re.I), "document",
     "Death notice"),
    (re.compile(r"henkil[oö]kuv|portrait|potret", re.I), "portrait",
     "Portrait"),
]

YEARS_RE = re.compile(r"\b(1[6-9]\d\d|20\d\d)\b")


def slugify(text):
    """ASCII, lowercase, hyphenated. Finnish ä/ö fold to a/o rather than vanish."""
    text = text.replace("ä", "a").replace("ö", "o").replace("å", "a")
    text = text.replace("Ä", "A").replace("Ö", "O").replace("Å", "A")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return re.sub(r"-{2,}", "-", text)


def caption_from(name):
    """Turn a filename into something readable, keeping the names and dates."""
    stem = os.path.splitext(name)[0]
    stem = re.sub(r"\s+", " ", stem.replace("_", " ")).strip()
    # A stray trailing letter after a year is a typo in the source names.
    stem = re.sub(r"(\d{4})i\b", r"\1", stem)
    return stem


def classify(path, name):
    hay = path + " " + name
    for pattern, kind, label in KINDS:
        if pattern.search(hay):
            return kind, label
    return "photograph", "Photograph"


def load_tree():
    if not os.path.exists(TREE):
        return {"people": []}
    with open(TREE, encoding="utf-8") as fh:
        return json.load(fh)


def suggest_people(caption, tree):
    """Guess which people in the tree a photo is of, by surname + year.

    Only ever suggests someone the tree treats as deceased — a living person
    cannot be linked to a photograph at all, so there is nothing to suggest.
    """
    years = set(YEARS_RE.findall(caption))
    words = {w for w in re.split(r"[^A-Za-zÀ-ÿ]+", caption.lower()) if len(w) > 3}
    hits = []
    for p in tree.get("people", []):
        if p.get("living"):
            continue
        surname = (p.get("surname") or "").lower()
        given = (p.get("given") or "").lower()
        if not surname:
            continue
        surname_hit = slugify(surname) in slugify(caption)
        given_hit = any(g in words for g in given.split() if len(g) > 3)
        year_hit = False
        for ev in ("birth", "death"):
            y = ((p.get(ev) or {}).get("date") or {}).get("year")
            if y and str(y) in years:
                year_hit = True
        if surname_hit and (given_hit or year_hit):
            hits.append(p["id"])
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true",
                    help="actually copy files and write the catalogue")
    ap.add_argument("--source", default=SRC_DIR)
    ap.add_argument("--attach", action="store_true",
                    help="also write the suggested attachments into tree.json")
    args = ap.parse_args()

    if not os.path.isdir(args.source):
        sys.exit(f"no such folder: {args.source}\n"
                 "The drop folder is gitignored — it is not in a fresh clone by design.")

    tree = load_tree()
    entries, seen_names, problems = [], {}, []

    for dirpath, _dirnames, filenames in os.walk(args.source):
        for filename in sorted(filenames):
            if not filename.lower().endswith(IMAGE_SUFFIXES):
                continue
            full = os.path.join(dirpath, filename)
            rel_dir = os.path.relpath(dirpath, args.source)
            rel_dir = "" if rel_dir == "." else rel_dir

            caption = caption_from(filename)
            kind, label = classify(rel_dir, filename)
            ext = os.path.splitext(filename)[1].lower()
            ext = ".jpg" if ext == ".jpeg" else ext

            base = slugify(caption) or "photo"
            safe = base + ext
            # Collisions get a short content hash rather than a counter, so the
            # published name is stable across runs and re-orderings.
            if safe in seen_names and seen_names[safe] != full:
                with open(full, "rb") as fh:
                    digest = hashlib.sha1(fh.read()).hexdigest()[:8]
                safe = f"{base}-{digest}{ext}"
            seen_names[safe] = full

            if re.search(r"[^a-z0-9.\-]", safe):
                problems.append(f"{safe}: unsafe characters survived slugify()")

            entry = {
                "file": safe,
                "caption": caption,
                "kind": kind,
                "kindLabel": label,
                "group": rel_dir.replace(os.sep, " / ") or None,
                "bytes": os.path.getsize(full),
                "origin": "drop-folder",
                "suggestedFor": suggest_people(caption, tree),
            }
            entries.append((full, entry))

    entries.sort(key=lambda e: (e[1]["kind"], e[1]["file"]))

    print(f"found {len(entries)} image(s) in {os.path.relpath(args.source, ROOT)!r}")
    for _src, e in entries:
        who = f"  -> suggests {len(e['suggestedFor'])} person(s)" if e["suggestedFor"] else ""
        print(f"  {e['kind']:<11} {e['file']}{who}")

    if problems:
        print("\nPROBLEMS:")
        for p in problems:
            print("  x", p)
        sys.exit(1)

    if not args.write:
        print("\ndry run — pass --write to copy the files and write the catalogue")
        return

    os.makedirs(OUT_DIR, exist_ok=True)

    # Photographs uploaded from the browser have no counterpart in the drop
    # folder, so pruning "anything not found locally" would silently delete
    # them. Only files this tool put there are its to remove.
    kept = []
    if os.path.exists(CATALOGUE):
        with open(CATALOGUE, encoding="utf-8") as fh:
            kept = [i for i in json.load(fh).get("items", [])
                    if i.get("origin") == "browser"]
    protected = {i["file"] for i in kept}

    wanted = {e["file"] for _s, e in entries} | protected
    for existing in os.listdir(OUT_DIR):
        if existing not in wanted:
            os.remove(os.path.join(OUT_DIR, existing))
            print(f"  removed stale {existing}")
    if protected:
        print(f"  kept {len(protected)} browser-uploaded photograph(s)")

    for src, e in entries:
        shutil.copy2(src, os.path.join(OUT_DIR, e["file"]))

    # Browser uploads stay in the catalogue; they are not ours to forget.
    entries = entries + [(None, item) for item in kept]

    payload = {
        "generated": datetime.datetime.now(
            datetime.timezone.utc).replace(microsecond=0).isoformat(),
        "count": len(entries),
        "items": [e for _s, e in entries],
    }
    with open(CATALOGUE, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    print(f"\nwrote {len(entries)} file(s) to docs/media/ and docs/data/media.json")

    if args.attach:
        attach(tree, [e for _s, e in entries])


def attach(tree, items):
    """Seed person.media from the suggestions, once. After this the attachments
    are the archivist's to change in the browser, so existing links are kept and
    only genuinely new ones are added."""
    by_id = {p["id"]: p for p in tree.get("people", [])}
    added = 0
    for item in items:
        for pid in item["suggestedFor"]:
            person = by_id.get(pid)
            if not person or person.get("living"):
                continue
            media = person.setdefault("media", [])
            if item["file"] not in media:
                media.append(item["file"])
                added += 1
                print(f"  attached {item['file']} -> {person['name']}")

    # A living person may not hold a photograph at all. Belt and braces: the
    # loop above already skips them, and this catches anything already there.
    stripped = 0
    for p in tree.get("people", []):
        if p.get("living") and p.get("media"):
            p["media"] = []
            stripped += 1

    with open(TREE, "w", encoding="utf-8") as fh:
        json.dump(tree, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(f"  {added} attachment(s) written to tree.json"
          + (f", {stripped} stripped from living people" if stripped else ""))


if __name__ == "__main__":
    main()
