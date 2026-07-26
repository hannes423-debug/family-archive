# HisKi — Kemijärvi parish (0188)

[HisKi](https://hiski.genealogia.fi/) is the Finnish Genealogical Society's index
of parish history books. Queried 2026-07-27.

## Coverage — read this before planning any search

| Book | Kemijärvi coverage |
|---|---|
| Kastetut (baptisms) | 1698–1860 |
| Vihityt (marriages) | 1698–1860 |
| Haudatut (burials) | 1697–1862 |
| Sisään/poismuuttaneet | scattered, 1751–1779 |

**HisKi as a whole runs to 1899, but Kemijärvi stops at 1860.** This is the
single most important practical fact found today: the 1898 and 1899 marriages
that would identify both sets of great-grandparents are *not* in HisKi and no
amount of searching it will produce them. They need the digitised parish books
(Kansallisarkisto / SSHY) instead.

What HisKi *is* good for here is the generations before 1860 — and it delivered.

## Querying it

The search is a POST to `/hiski` with `komento=haku`, `srk=0188`,
`kirja=vihityt|kastetut|haudatut`, `kieli=fi`. Useful fields:
`isukunimi` (groom / father / deceased surname), `asukunimi` (bride / mother),
`ietunimi`/`aetunimi`, `ipatronyymi`/`apatronyymi`, `ikyla`/`akyla`,
`alkuvuosi`/`loppuvuosi`, `maxkpl`.

Two traps, both of which cost time today:

1. **An unrecognised field name is silently ignored**, and the query returns the
   *entire parish*. A search for `lsukunimi` (which does not exist) returned
   ~620 "hits" for every surname tried, all of them meaningless. Always run an
   unfiltered control query and compare counts.
2. **The results table never closes its `<TR>` or `<TD>` tags.** Splitting on
   the opening tags works; matching pairs returns nothing.

Encoding is ISO-8859-1 throughout, not UTF-8.

## Village names

The books use Swedish village names. **Öfverby = Ylikylä** ("upper village"),
**Storby = Isokylä** ("big village"), Nederby = Alakylä. This matters: the
Autioniemi death notice places the family in *Ylikylä*, and every Kaakkurivaara
and Talvensaari event below is in *Öfverby* — the same place.

## Kaakkurivaara (Öfverby / Ylikylä)

| Date | Event |
|---|---|
| 15.12.1845 | Buried: *Rotfatt. enkl.* And. Kaakkurivaara, aged 82y 4m 10d → born ~1763. Earliest Kaakkurivaara found. |
| 6.8.1848 | Married: Drg. Joh. Fredr. Kaakkurivaara × Pig. Anna Greta Larsdotter Sedig |
| 29.2.1849 | Born: Sus:a Gust:a, to Joh. Fredr. Kaakkurivaara & Anna Gretha (28) |
| **19.1.1850** | **Married: Drg. Matts Simonsson Kaakkurivaara × Pig. Anna Greta Johansdotter Peldoniemi** |
| 14.12.1854 | Born: Anna Walborg, to Matts Sim. Kaakkurivaara & Anna Greta (31) |
| **14.4.1856** | **Born: Karl, Ylikylä, to Backst. Matts Simonsson Kaakkurivaara & Anna Greta (33)** |
| 2.5.1858 | Married: Bd.s. Olof Eriksson Talvensaari × Bd.d:tr Brita Maria Eriksdotter Kaakkurivaara |

The two bolded rows are the basis of hypothesis **H2**.

Note the 1858 marriage: **Talvensaari and Kaakkurivaara were already
intermarrying in Öfverby in 1858**, three generations before the 1947 marriage
this line descends from.

## Talvensaari (Öfverby / Ylikylä)

38 events, 1810–1859. Recurring men: Erik, Johan, Henrik, Matts Johansson,
Michel Eriksson, Olof Eriksson. Buried: Bdn Johan Talvensaari d. 1.2.1832 aged
77 (→ born ~1755), the earliest Talvensaari found.

Full capture in `hiski-raw.json`.

## Sipovaara (Storby / Isokylä)

20 events, 1812–1858, and **all of them in Storby/Isokylä, not Öfverby**.
Recurring: Matts Eriksson Sipovaara & Sophia (children 1846–1858), Johan Erik
Eriksson, Erik Olofsson. Relevant to the open question about Amanda Serafiina's
maiden name: Sipovaara is a genuine Kemijärvi farm name, but from a different
village than the Kaakkurivaara/Talvensaari cluster.

## Autioniemi, Perälä, Helistekangas

Almost nothing before 1860 — one Helistekangas baptism (3.1.1818, Nybygg. Erik
Helistekangas) and no Autioniemi or Perälä events at all. Consistent with these
being later settler farm names in Kemijärvi, which fits Autioniemi appearing as
an established house by 1930.
