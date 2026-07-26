# Research — the maternal line (Kemijärvi)

Method follows the [Genealogy Research Agent skill](https://gist.github.com/peas/ee5b0bcdb54a809b6ddee83caff51ca6):
documents are the source of truth, own documents are exhausted before going
online, conflicts are documented rather than silently resolved, and
`confidence: low` beats a guess.

## Scope

The line runs upward from the archivist's mother (living — recorded in the tree
only as *Living Kaakkurivaara*, and not discussed here) through:

- **Kaakkurivaara** — Ylikylä / Öfverby, Kemijärvi
- **Talvensaari** — Ylikylä / Öfverby, Kemijärvi
- **Autioniemi** — Ylikylä, Kemijärvi
- **Sipovaara** — Isokylä / Storby, Kemijärvi *(different village — see the
  open question on Amanda Serafiina)*

Everyone written up here is deceased. That is not incidental: this repository is
public, and the archive records nothing about living people. Living relatives
and research contacts stay in the gitignored `data/` folder.

## Layout

```
research/people/    One YAML per person. The single source of truth for what is
                    known, what it rests on, and how confident it is.
research/journal/   Dated, append-only log. Never edited — corrections get a new
                    entry in a later file.
research/sources/   Raw captures: query results, transcriptions, citations.
research/TODO.md    Prioritised, split by who can actually do each item.
```

## Where this stands

Two generations are solid. The generation above them is the frontier, and the
single most valuable fact in the whole file is this:

> The GEDCOM records **both** great-grandparent marriages with a date and a
> place but **no spouses** — Kemijärvi, 25 Apr 1898 and 5 Jul 1899. Somebody
> knew those marriages happened and did not record who married.

Finding those two records is the highest-value action available, and it unlocks
both maternal quarters at once. See `TODO.md`.
