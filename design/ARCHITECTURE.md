# Family Archive — Architecture

**Status:** DRAFT — awaiting review/approval. No application code written yet.
**Date:** 2026-07-25
**Working name:** `family-archive` (codename *Perintö*)

---

## 0. Reading guide

This document answers the ten questions in the brief, in order:

1. [Application architecture](#1-application-architecture)
2. [Folder structure](#2-folder-structure)
3. [Data model](#3-data-model)
4. [Synchronization strategy](#4-synchronization-strategy)
5. [GitHub authentication](#5-github-authentication)
6. [Media handling](#6-media-handling)
7. [Future scalability](#7-future-scalability)
8. [Improvements over existing genealogy software](#8-improvements-over-existing-genealogy-software)
9. [Technical risks](#9-technical-risks)
10. [Phased implementation roadmap](#10-phased-implementation-roadmap)

Sections 9 and 10 contain the things that need your decisions. **Section 9 contains four
findings that change the shape of the product** — please read it even if you skim the rest.

---

## 1. Application architecture

### 1.1 The one idea the whole system is built on

Most genealogy software stores **conclusions**: `Person.birthDate = 1897-03-04`. When a second
source disagrees, the software either overwrites the value or bolts on an "alternate facts" list
as an afterthought. Every downstream problem — merge conflicts, un-revertable imports, no real
verification status, "where did this date come from?" — comes from that one decision.

This archive stores **assertions**, and derives conclusions from them.

```
Source ──cites──> Assertion ──about──> Entity
                      │
                      ├─ field:      "birth.date"
                      ├─ value:      { kind: "about", year: 1897 }
                      ├─ confidence: verified | likely | unverified | rumor
                      ├─ origin:     manual | import:gedcom:xyz | ai-suggestion
                      └─ status:     accepted | rejected | pending
```

A **Person** record as displayed in the UI is a *projection*: for each field, take the accepted
assertion with the highest confidence, and keep the rest visible as "other claims". That single
change buys, for free:

- **Verification system** — it is a property of the assertion, not a badge glued to a person.
- **Sources** — citation is intrinsic, not an optional extra field.
- **Conflict detection** — two accepted assertions on one field *is* the conflict; no heuristics.
- **Non-destructive import** — an import writes assertions with `status: pending`. It is
  physically incapable of overwriting your data, because it never touches the projection.
- **Revision history** — the assertion log *is* the history.
- **AI safety** — an AI suggestion is an assertion with `origin: ai` and `status: pending`. The
  "AI can never change data" rule is enforced by the type system, not by discipline.
- **Time Machine** — a projection is already a pure function of the log; making it a function of
  `(log, year)` is a small step, not a feature.

This is close to how GEDCOM-X and Gramps model genealogy, and it is the reason those formats
survive decades. It costs more up-front than `person.birthDate = x` and pays for itself by Phase 4.

Projections are **cached** in Dexie (a `people_projected` table), so the UI never pays the cost of
re-deriving. The cache is invalidated per-entity on assertion change. Reads are as fast as a naive
model; writes do a little more work.

### 1.2 Layers

```
┌──────────────────────────────────────────────────────────────────┐
│  ROUTES  (React Router, lazy per module)                         │
│  Dashboard · People · Tree · Timeline · Maps · Media · …          │
├──────────────────────────────────────────────────────────────────┤
│  FEATURES  (feature folder = UI + hooks + local state)           │
│  Nothing here talks to storage directly.                          │
├──────────────────────────────────────────────────────────────────┤
│  DOMAIN  (pure TypeScript — zero React, zero Dexie)              │
│  entities · assertions · projection · genealogical dates ·        │
│  relationship algebra · validation rules · GEDCOM model           │
│  ← unit-tested exhaustively; this is the part that must outlive   │
│    React, Vite, and probably me                                   │
├──────────────────────────────────────────────────────────────────┤
│  SERVICES  (side effects behind interfaces)                       │
│  RepositoryPort · SyncPort · MediaStorePort · SearchPort ·        │
│  AuthPort · AiPort · OcrPort                                      │
├──────────────────────────────────────────────────────────────────┤
│  ADAPTERS  (swappable implementations)                            │
│  Dexie · GitHub REST · OPFS · Fuse.js / inverted-index worker ·   │
│  Device-Flow auth · Anthropic API · Tesseract.js                  │
└──────────────────────────────────────────────────────────────────┘
```

**Rule:** dependencies point downward only. `domain/` imports nothing but TypeScript. That is what
makes the archive future-proof — in 2040 the React layer will be replaced and the domain layer
will be copy-pasted.

Every service is a **port** (interface) with at least one adapter. This is not architecture
astronomy; it is the concrete mechanism by which the media-storage decision (§9.1) can be deferred
and later changed without a rewrite.

### 1.3 State management

Three distinct kinds of state, three mechanisms — mixing them is the usual cause of rot:

| Kind | Mechanism | Examples |
|---|---|---|
| **Server/persistent data** | Dexie live queries (`dexie-react-hooks` `useLiveQuery`) | people, media, events |
| **Global UI state** | Zustand slices | theme, sync status, current user, selection, tree viewport |
| **Local/ephemeral** | `useState` | form drafts, hover, dialogs |

Zustand stores are **sliced by feature** (`useTreeStore`, `useSyncStore`, `useUiStore`) — never one
god store. `useLiveQuery` means a write in one tab/panel updates every view with no manual
invalidation.

### 1.4 Workers

Four Web Workers, all off the main thread — this is what keeps it fast at scale:

- **search.worker** — index build + query
- **media.worker** — thumbnail/derivative generation, EXIF, hashing (`OffscreenCanvas`)
- **sync.worker** — GitHub push/pull, diffing, batching
- **import.worker** — GEDCOM/CSV parsing (a 100 MB GEDCOM must not freeze the UI)

AI/OCR run in workers where the library allows (Tesseract.js does).

---

## 2. Folder structure

### 2.1 Source tree

```
family-archive/
├─ docs/
│  ├─ ARCHITECTURE.md            ← this file
│  ├─ DATA-MODEL.md              ← generated from Zod schemas + hand notes
│  ├─ REPO-FORMAT.md             ← the on-disk JSON contract (versioned!)
│  └─ adr/                       ← Architecture Decision Records, numbered
│     └─ 0001-assertion-model.md
├─ public/
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ routes/                    ← route defs + lazy() boundaries only
│  │  └─ index.tsx
│  │
│  ├─ domain/                    ← PURE. no React, no IO, no browser APIs.
│  │  ├─ entities/               person.ts, place.ts, event.ts, source.ts,
│  │  │                            media.ts, union.ts, relationship.ts, user.ts
│  │  ├─ assertions/             assertion.ts, confidence.ts, projection.ts
│  │  ├─ dates/                  gendate.ts  ← genealogical date type + parser
│  │  ├─ relations/              graph.ts, kinship.ts, paths.ts
│  │  ├─ validation/             rules/impossible-dates.ts, rules/cycles.ts, …
│  │  ├─ history/                op.ts, revision.ts, revert.ts
│  │  └─ schema/                 zod schemas + JSON-Schema emitters
│  │
│  ├─ services/                  ← ports (interfaces) + orchestration
│  │  ├─ repository/             RepositoryPort.ts + dexie/ adapter
│  │  ├─ sync/                   SyncPort.ts + github/ adapter
│  │  ├─ media/                  MediaStorePort.ts + opfs/, github/, remote/
│  │  ├─ search/                 SearchPort.ts + fuse/, inverted/
│  │  ├─ auth/                   AuthPort.ts + deviceFlow/, pat/
│  │  ├─ ai/                     AiPort.ts + anthropic/
│  │  └─ ocr/                    OcrPort.ts + tesseract/
│  │
│  ├─ features/                  ← one folder per module in the brief
│  │  ├─ dashboard/
│  │  ├─ people/
│  │  │  ├─ components/          PersonHeader, FactRow, RelationshipEditor…
│  │  │  ├─ hooks/               usePerson, usePersonTimeline
│  │  │  ├─ sections/            ← the person page is composed of these
│  │  │  │  ├─ registry.ts       ← ordered, lazy, feature-flagged section list
│  │  │  │  ├─ BiographySection.tsx
│  │  │  │  ├─ GallerySection.tsx
│  │  │  │  └─ …
│  │  │  └─ PersonPage.tsx
│  │  ├─ tree/  timeline/  maps/  media/  documents/  events/  places/
│  │  ├─ sources/  search/  import/  export/  history/  settings/
│  │  ├─ users/  assistant/  timemachine/
│  │
│  ├─ ui/                        ← the design system. no domain knowledge.
│  │  ├─ primitives/             Button, Input, Dialog, Tooltip, Menu…
│  │  ├─ patterns/               DataList, VirtualGrid, EmptyState, ConfirmBar
│  │  ├─ feedback/               Toast, ConfidenceBadge, SyncIndicator
│  │  └─ tokens.css              CSS custom properties (light/dark/contrast)
│  │
│  ├─ workers/                   search.worker.ts, media.worker.ts, …
│  ├─ lib/                       tiny generic helpers (id, retry, chunk)
│  └─ types/
│
├─ tests/
│  ├─ unit/                      Vitest — domain has ~90% coverage target
│  ├─ fixtures/                  small anonymised GEDCOM/CSV samples
│  └─ e2e/                       Playwright — critical paths only
└─ …config
```

**Why `features/people/sections/registry.ts` matters:** the brief lists ~35 person sections and says
"allow future expansion". Hard-coding 35 components into one `PersonPage.tsx` guarantees a
2,000-line file within a year. The registry makes each section an independently lazy-loaded,
reorderable, hideable plugin:

```ts
export const personSections: PersonSection[] = [
  { id: 'biography', title: 'Biography', icon: BookIcon,
    load: () => import('./BiographySection'),
    isEmpty: (p) => !p.biography,          // hide when empty, for elderly-friendly calm
    minRole: 'viewer' },
  { id: 'medical',   title: 'Medical history', privacy: 'private', minRole: 'editor', … },
]
```

Adding "DNA visualization" in 2029 = one file + one registry line. Nothing else changes.

### 2.2 Archive repository structure (the data)

Exactly as the brief specifies, plus sharding and metadata:

```
family-archive-data/                 ← a SEPARATE GitHub repo from the code
├─ archive.json                      ← schema version, archive id, settings pointer
├─ SCHEMA.md                         ← human-readable format doc, committed
├─ schema/                           ← JSON Schema files, versioned
├─ people/     ab/ab3f….json         ← 2-char shard by id prefix (256 dirs)
├─ unions/     ab/….json             ← marriages/partnerships
├─ events/     ab/….json
├─ places/     ab/….json
├─ sources/    ab/….json
├─ media/
│  ├─ index/   ab/….json             ← metadata ONLY (always in git)
│  ├─ photos/  ab/ab3f….jpg          ← bytes — see §6/§9.1 for where these live
│  ├─ videos/  audio/  documents/
├─ assertions/ ab/….json             ← optional split-out for hot files
├─ history/    2026/07/….jsonl       ← append-only op log, monthly files
├─ imports/    2026-07-25-geni.json  ← raw import payload, kept forever
├─ exports/
├─ users/      hannes423.json        ← roles + permissions
└─ settings/   archive.json, ui.json
```

**Sharding by id prefix** keeps directories at ~400 files each for 100k people. Git handles a flat
100k-file directory, but the GitHub Contents API listing, your file manager, and `git status` all
degrade badly. 2-char sharding is the standard fix (it is what git itself does with objects).

**One file per entity** is the critical choice for git: two people editing different relatives
produce zero merge conflicts. A single `people.json` would conflict on every concurrent edit.

Files are `JSON` with 2-space indent and **stable key ordering** — so `git diff` is human-readable
and a diff on a birth date is one line, not a reformatted blob.

---

## 3. Data model

### 3.1 Core entities

```ts
type Id = string;                      // UUIDv7 — time-sortable, no coordination needed

interface EntityBase {
  id: Id;
  type: EntityType;
  createdAt: string;                   // ISO 8601 UTC
  updatedAt: string;
  createdBy: UserId;
  schemaVersion: number;               // per-entity, enables lazy migration
  externalIds?: Record<string, string>; // { gedcom: "@I123@", geni: "6000000012", … }
  tags?: string[];
  deletedAt?: string;                  // soft delete — an archive never truly deletes
}
```

| Entity | Purpose | Notes |
|---|---|---|
| `Person` | A human being | Projection of assertions + identity core |
| `Union` | Marriage/partnership | GEDCOM `FAM`; holds spouses, children, marriage/divorce events |
| `Relationship` | Typed edge | `parent-child` (with `biological\|adopted\|step\|foster`), `partner`, `godparent`, custom |
| `Event` | Reusable occurrence | Wedding, war, migration, reunion. Links people+places+media+sources |
| `Place` | Stored **once**, referenced | Hierarchical: `parentPlaceId`. Historical names with date ranges |
| `Source` | Citation target | Church book, archive, interview, newspaper, Geni… |
| `Citation` | Source + page/URL/quote | Many assertions → one source |
| `MediaItem` | File metadata | Bytes live elsewhere; see §6 |
| `Assertion` | A claim about a field | The heart of the model |
| `Note` | Free text, privacy-classified | Private notes, DNA notes, medical |
| `Story` / `Memory` / `Quote` | Narrative objects | Can be attached to several people |
| `User` | Contributor | GitHub identity + role |
| `Operation` | One atomic change | The revision log entry |

**Why both `Union` and `Relationship`:** unions model the GEDCOM-compatible family unit (needed for
lossless GEDCOM round-trip and for "who are the children of this marriage"); relationships model
arbitrary edges the tree needs (adoption, godparents, unknown-parentage links). Storing only one of
the two forces ugly workarounds — this is a lesson from Gramps.

### 3.2 The Person record

```ts
interface Person extends EntityBase {
  type: 'person';
  // Identity — the ONLY required field in the entire system
  names: PersonName[];               // [{ kind:'birth'|'married'|'nickname'|'religious',
                                     //    given, surname, patronymic, prefix, suffix,
                                     //    sortKey, script?, fromDate?, toDate? }]
  sex?: 'male' | 'female' | 'unknown' | 'other';
  genderIdentity?: string;           // free text, separate from biological sex on purpose

  // Everything below is derived from assertions and cached
  vitals: { birth?: VitalFact; death?: VitalFact; baptism?: VitalFact; burial?: VitalFact };
  facts: Fact[];                     // occupation, education, military, religion,
                                     // languages, residence, award … OPEN-ENDED
  biography?: RichDoc;               // Tiptap JSON + rendered HTML cache
  privacy: PrivacyClass;             // public | family | private
  living?: boolean;                  // computed + overridable — drives redaction
  confidence: Confidence;            // worst-case rollup of identity assertions
}

interface Fact {
  id: Id;
  kind: FactKind;                    // string union, EXTENSIBLE via custom:*
  date?: GenDate;
  place?: Id;
  value?: string;
  description?: RichDoc;
  citations: Id[];
  confidence: Confidence;
  privacy: PrivacyClass;
}
```

`FactKind` is `'occupation' | 'education' | … | \`custom:${string}\``. That template-literal type is
how "allow future expansion" becomes real: a family can add `custom:emigration-ship` in 2031 with
no schema migration, and it still type-checks.

### 3.3 Genealogical dates — a purpose-built type

`date-fns` is excellent and **cannot represent a genealogical date.** Real archive data looks like
"about 1840", "before 12 March 1897", "between 1901 and 1903", "1723/24" (dual dating across the
Julian new-year), "Q2 1888" (a quarter register), or "1897-03-04 (Julian) = 1897-03-16 (Gregorian)".
Forcing these into `Date` destroys information permanently — this is the #1 way archives lose data.

```ts
type GenDate =
  | { kind: 'exact';   date: PartialDate }
  | { kind: 'about';   date: PartialDate; }
  | { kind: 'before' | 'after'; date: PartialDate }
  | { kind: 'between'; from: PartialDate; to: PartialDate }
  | { kind: 'range';   from?: PartialDate; to?: PartialDate }   // "1920–1935"
  | { kind: 'phrase';  text: string }                            // unparseable — kept verbatim
  ;
interface PartialDate {
  year?: number; month?: number; day?: number;                   // any may be absent
  calendar?: 'gregorian' | 'julian' | 'hebrew' | 'french-republican';
  dualYear?: number;                                             // 1723/24
  original: string;                                              // ALWAYS keep source text
}
```

Every `GenDate` carries `original`. Round-tripping a GEDCOM must return the original string
byte-for-byte where we could not improve on it. `date-fns` is then used only for the *derived*
sortable instants (`earliestPossible` / `latestPossible`), which is what timelines and Time Machine
actually query.

### 3.4 Assertions and projection

```ts
interface Assertion extends EntityBase {
  type: 'assertion';
  subject: Id;                        // entity this claims something about
  field: string;                      // dotted path: "vitals.birth.date", "facts[occupation]"
  value: unknown;                     // typed per field via the schema registry
  confidence: 'verified' | 'likely' | 'unverified' | 'rumor';
  status: 'accepted' | 'pending' | 'rejected' | 'superseded';
  citations: Id[];
  origin: { kind: 'manual' | 'import' | 'ai' | 'merge'; ref?: string; at: string; by: UserId };
  rationale?: string;                 // why the user believes it — this is gold in 40 years
}
```

`project(assertions): Person` is a pure function, unit-tested to death:
accepted > pending; verified > likely > unverified > rumor; ties broken by `updatedAt`; everything
not chosen remains queryable as "other claims" and renders as a conflict chip in the UI.

### 3.5 Verification, visually

| Confidence | Colour | Icon | Meaning |
|---|---|---|---|
| Verified | green | ✓ shield | Primary source seen and cited |
| Likely | blue | ~ | Secondary/derived, strongly supported |
| Unverified | amber | ? | **Default for everything imported** |
| Rumor | grey | ⚑ | Family lore, kept on purpose |

Shown as a small chip on the *fact row*, never as a giant banner — the brief says "never overwhelm".
A per-person rollup appears in the header; a whole-archive "verification progress" gauge lives on
the Dashboard (this turns tedious source work into a visible, motivating number).

### 3.6 Revision history

Append-only operation log, event-sourced:

```ts
interface Operation {
  id: Id; at: string; by: UserId;
  op: 'create' | 'update' | 'delete' | 'merge' | 'revert' | 'import';
  entity: { type: EntityType; id: Id };
  patch: JsonPatch;        // RFC 6902 — both forward and inverse stored
  inverse: JsonPatch;      // makes revert O(1) and exact
  comment?: string;
  parents: Id[];           // op DAG — survives concurrent edits from two family members
}
```

Stored in Dexie and flushed to `history/YYYY/MM/*.jsonl` (JSON Lines: append-only, git-diff-friendly,
readable by `grep` in 2050). Git commits carry the same message. Revert = apply `inverse`, recorded
as a new op — nothing is ever destroyed. This is the "like Git" requirement, done properly.

---

## 4. Synchronization strategy

### 4.1 Model

**Local-first.** IndexedDB is the working copy; GitHub is the durable, versioned, portable remote.
The app is fully usable offline — sync is a background nicety, never a blocker.

```
 Dexie (working copy)  ──push──>  GitHub repo (main)  ──pull──>  other family member
        ▲                              │
        └──── outbox queue ────────────┘
```

### 4.2 Push

1. Every write enqueues an op in an `outbox` table with the entity id.
2. `sync.worker` debounces (default 30 s, or manual "Sync now").
3. Coalesce: N ops on one person = **one** file write.
4. Read remote `HEAD`; if unchanged since our `baseSha`, use the **Git Data API** to build one
   commit containing all changed blobs (one tree, one commit, one ref update) — not N Contents-API
   calls. This is the difference between 1 request and 300, and it is the single most important
   performance decision in the sync layer.
5. On success store the new `baseSha` and clear the outbox.

### 4.3 Pull & conflicts

Poll `HEAD` (cheap, ETag-conditional, doesn't count against rate limit when 304) plus on-focus and
on-demand. On change, fetch the compare diff and apply changed files.

Conflict handling, in order of preference:

- **Different entities changed** → auto-merge. This is 95%+ of cases and is why one-file-per-entity
  matters so much.
- **Same entity, different fields** → auto-merge at field level (we have per-field ops, not blobs).
- **Same entity, same field** → **do not guess.** Both values become assertions; the field is
  flagged; a Conflicts inbox on the Dashboard asks a human. Consistent with the whole verification
  philosophy: the software never silently decides what is true.

Deletion vs edit → resurrect and flag. An archive should be biased toward keeping things.

### 4.4 Guarantees and non-goals

- **Guarantee:** no data loss. Every remote state is a git commit; every local op is in the log.
- **Non-goal:** real-time collaboration. Two people editing the same person *simultaneously* is not
  supported beyond the conflict inbox. Adding a CRDT (Yjs) for the Tiptap biography is a
  Phase-11 option if it proves necessary; for a family archive the natural editing pattern
  ("I'll do grandma's side this weekend") makes this a low-value complication today. ADR-0004.

---

## 5. GitHub authentication

### 5.1 The constraint that shapes this

**A pure static SPA cannot complete the standard OAuth web flow**, because the token exchange
requires a `client_secret`, and anything shipped to a browser is public. Every "GitHub OAuth in a
static app" tutorial that ignores this is leaking a secret. Three legitimate options:

| Option | Backend needed | UX | Verdict |
|---|---|---|---|
| **A. OAuth Device Flow** | **None** | Show an 8-char code, user pastes it at `github.com/login/device`, approve | **Recommended default** |
| **B. Tiny serverless proxy** | Cloudflare Worker (free tier) | Standard one-click redirect | Recommended if you want polish |
| **C. Fine-grained PAT** | None | User pastes a token | Keep as power-user/CI fallback |

Device Flow is designed exactly for public clients, needs no secret, no server, and no hosting bill
— it costs one extra user step, once, on each device. For elderly relatives who will mostly *view*,
the read-only public-repo path needs no auth at all.

**Recommendation:** Ship **A** in Phase 6, keep **C** as a fallback from day one (it makes
development and scripted testing trivial), and add **B** later only if the extra step annoys people.
All three sit behind a single `AuthPort`, so this is a config change, not a rewrite.

### 5.2 Token handling

- Stored in IndexedDB (**not** `localStorage` — narrower XSS surface, and it survives being large).
- Optionally wrapped with WebCrypto AES-GCM under a passphrase-derived key (PBKDF2, 600k iters) for
  shared machines.
- Scopes: minimum viable. `repo` for a private archive; `public_repo` if public. Fine-grained PATs
  should be scoped to the two archive repos only.
- Never logged, never in a URL, never sent anywhere but `api.github.com`.
- Explicit "Sign out & forget token" in Settings.

### 5.3 Roles and permissions

Roles are stored **in the repo** (`users/*.json`) and enforced in the UI, but the real enforcement
is GitHub's own repo permissions — a Viewer without write access to the repo simply cannot push,
regardless of what the client believes. Client-side roles are for UX, not security. Being honest
about that distinction now prevents a false sense of safety later.

```ts
type Role = 'viewer' | 'contributor' | 'editor' | 'admin';
// granular overrides on top of role defaults:
interface Permissions {
  canEditPeople, canDeletePeople, canApproveAssertions, canManageUsers,
  canViewPrivate, canViewMedical, canExport, canImport, canRevert: boolean;
}
```

`canViewPrivate` / `canViewMedical` gate the sensitive sections. Note the honest limitation: if a
user can clone the repo, they can read anything in it. **True privacy for medical notes therefore
requires either a separate private repo or client-side encryption** — see §9.4.

---

## 6. Media handling

### 6.1 The problem, stated plainly

The brief asks for 500,000 photos synced through GitHub. That is not possible as stated:

- GitHub recommends repos stay **under 1 GB**, strongly warns above 5 GB.
- Max file size 100 MB (hard block at 100 MB via API; warning at 50 MB).
- Git LFS free tier: **1 GB storage, 1 GB/month bandwidth**, then paid data packs.
- Git stores every version of a binary forever — one re-crop of a 6 MB scan costs another 6 MB.
- 500k photos at a modest 3 MB ≈ **1.5 TB**. Your machine has 22 GB free.

So media bytes need a storage strategy that is *not* "commit them to the archive repo". Options in
§9.1 — this needs your decision. The architecture makes it swappable either way:

```ts
interface MediaStorePort {
  put(file: Blob, meta: MediaMeta): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Blob>;
  getUrl(ref: MediaRef, variant: 'thumb'|'preview'|'original'): Promise<string>;
  delete(ref: MediaRef): Promise<void>;
  stat(ref: MediaRef): Promise<MediaStat>;
}
```

Adapters: `OpfsMediaStore` (local), `GitHubBlobStore` (small archives), `GitHubReleaseStore`
(release assets: 2 GB/file, not in git history, free), `RemoteMediaStore` (S3/R2/Backblaze),
`FolderMediaStore` (File System Access API pointed at a local/NAS folder).

### 6.2 Metadata always in git, bytes maybe not

`media/index/ab/ab3f….json` — the metadata record — is **always** committed. It is small, diffable,
and it is what actually matters historically:

```ts
interface MediaItem extends EntityBase {
  kind: 'image'|'video'|'audio'|'pdf'|'document'|'archive';
  filename: string;                  // original name — never lose it
  mime: string; bytes: number;
  hash: string;                      // SHA-256 → dedupe + integrity check
  ref: MediaRef;                     // where the bytes live (adapter-specific)
  width?, height?, duration?: number;
  takenAt?: GenDate; exif?: Record<string, unknown>;
  description?: RichDoc;
  placeId?: Id; eventId?: Id;
  people: { personId: Id; region?: [x,y,w,h]; confidence: Confidence }[];  // face regions
  photographer?: string; sourceId?: Id;
  ocr?: { text: string; lang: string; engine: string; at: string };
  aiTags?: { tag: string; score: number; approved: boolean }[];
  privacy: PrivacyClass;
}
```

Face **regions** are stored from day one even though face recognition is a future feature — adding
the coordinate field later would require re-processing 500k photos. Cheap now, expensive later.

### 6.3 Ingest pipeline

`react-dropzone` → `media.worker`:

1. Hash (SHA-256) → **dedupe**: identical file already present? offer to link instead of re-add.
2. Extract EXIF (date, GPS → suggests a Place; camera → suggests photographer).
3. Generate derivatives: `thumb` 320px WebP, `preview` 1600px WebP, keep **original untouched**
   (an archive never re-encodes the master).
4. PDFs → first-page thumbnail + text layer extraction; scanned images → queue for OCR.
5. Videos → poster frame via `<video>`+canvas; no transcoding client-side.
6. Write metadata, enqueue bytes for the media store.

Derivatives are regenerable, so they can live in OPFS only and never be synced — a big bandwidth
saving, and a clean separation of "irreplaceable" vs "cache".

### 6.4 Display

`VirtualGrid` (TanStack Virtual) + `IntersectionObserver` + an LRU `blob:` URL cache with explicit
`revokeObjectURL` (leaking blob URLs is the classic way a photo gallery eats 4 GB of RAM). Full-size
originals load only in the lightbox, never in grids.

---

## 7. Future scalability

**Rendering.** Virtualize every list and grid (people, media, search, timeline, history). Nothing
maps over an unbounded array.

**Family tree at scale.** React Flow cannot render 100,000 nodes — it is a DOM-based renderer, and
it will die somewhere around 2–5k. This is fine, because *nobody wants to look at 100k nodes*. The
tree renders a **windowed subgraph**: from the focus person, N generations up/down (default 3),
collapsed branches as summary nodes ("+ 47 descendants"), plus viewport culling. Practical ceiling
~1,500 visible nodes, which is far past what is legible. Layout runs in a worker (ELK/dagre) so
large expansions never block. If a genuine whole-tree overview is wanted later, that is a
**canvas/WebGL** view (a different renderer behind the same data), not React Flow — designed for,
not built now.

**Search at scale.** Fuse.js builds its index in memory and is comfortable to ~10–20k documents.
Beyond that it stalls on load. So `SearchPort` has two adapters: `fuse` (default, small archives)
and `inverted` (custom trigram + inverted index in a worker, persisted to Dexie, incrementally
updated). Swap by config; the UI never knows.

**Data at scale.** Dexie compound indexes on the queries that matter (`surname+given`,
`birthYear`, `placeId`, `personId` on media links). Never load all people; paginate/virtualize.
Projections cached, invalidated per entity.

**Sync at scale.** Git Data API batching (§4.2), delta pulls via compare, and — if an archive really
reaches 100k people — a packed-shard format where cold entities live in per-shard bundles and only
hot entities are individual files. Designed for; not built until needed.

**Prepared-for future features** (architecture support, no code now):

| Feature | What exists now to make it cheap later |
|---|---|
| Face recognition | `people[].region` + `confidence` fields; media.worker infra |
| Speech transcription | `MediaItem.transcript?` slot; OcrPort generalizes to a `TranscribePort` |
| Handwriting recognition | Same OCR pipeline, different engine adapter |
| Image colorization | Derivative-variant system already supports named variants |
| Historical map overlays | Leaflet layer registry + `Place.historicalNames[]` with date ranges |
| DNA visualization | `Note{kind:'dna'}` + relationship graph already typed |
| 3D tree | Tree layout is data-only; renderer is swappable |
| Story mode / Time Machine | Projections are already `f(log)`; Time Machine is `f(log, year)` |
| Offline mobile | Already offline-first + PWA; Capacitor wrap is a build target |

---

## 8. Improvements over existing genealogy software

Where this design deliberately beats Ancestry / MyHeritage / Geni / Gramps / FTM:

1. **You own the data, in plain readable JSON, in your own git repo.** No subscription can hold your
   family history hostage. If this app dies, `people/ab/ab3f….json` is still readable in Notepad.
2. **Sources are structural, not decorative.** Commercial tools make citation optional, so nobody
   does it, so nobody knows where anything came from 20 years later. Here a fact without a source
   *looks* incomplete, by design.
3. **Import can never overwrite.** Every genealogist has a horror story about a merge that mangled
   30 years of work. Structurally impossible here: imports write pending assertions.
4. **Real version history with revert.** Ancestry has none. Gramps has undo within a session. This
   has a git-backed permanent log with per-field revert and attribution.
5. **Person page as archive, not data sheet.** Existing tools centre the *tree*; the person is a
   node with dates. Here the tree is one *view*, and the person is a rich page — stories, letters,
   voice recordings, quotes. That is what descendants will actually want to read.
6. **Uncertainty is a first-class value, not a hack.** "About 1840" stays "about 1840" instead of
   silently becoming 1840-01-01 — and everyone downstream can see the difference.
7. **Time Machine.** Genuinely rare. "Show me the family in 1918" makes an archive *experiential*
   rather than a database, and it is nearly free given event sourcing.
8. **Built for the elderly, not for power users.** Big type, high contrast, calm layouts,
   empty-sections-hidden, no dense grids of icons. Most genealogy UIs are 1998 Windows software
   with a facelift.
9. **AI as a proposer, never an author.** Every AI output lands in an approval queue with its
   reasoning visible. Commercial "AI hints" that silently attach wrong records are actively
   polluting the world's genealogy data; this design refuses to participate.
10. **Offline-first and fast.** Works on a laptop in a church archive basement with no signal.
11. **Multi-family safe.** One person can appear in the archive without a login, permissions are
    granular, and privacy classes travel with the data through export.
12. **Print output that people actually want** — a real book (PDF), not a 12-page fan chart.

---

## 9. Technical risks

Ranked by how much they change the plan. The first four need a decision from you.

### 9.1 🔴 Media at the stated scale will not fit GitHub

Covered in §6.1: 500k photos ≈ 1.5 TB vs a repo that should stay under ~5 GB, LFS free tier of 1 GB,
and 22 GB free on your disk. **Mitigation:** `MediaStorePort` makes this swappable, and my
recommendation is a tiered default — metadata + small images in git, everything large in
GitHub **Release assets** (free, 2 GB/file, outside git history) with an S3/R2 adapter available if
the archive ever gets big. Decision needed (see the question at the end).

### 9.2 🔴 GitHub API rate limits

5,000 requests/hour authenticated; 60/hour unauthenticated. A naive "one Contents API call per file"
sync of 100k people would need 100k requests — 20 hours. **Mitigation:** Git Data API tree batching
(one commit = ~4 requests regardless of file count), conditional requests with ETags (304s are free),
aggressive local caching, and a visible rate-limit meter in the UI. This is designed-in from Phase 6,
not retrofitted.

### 9.3 🟠 IndexedDB is evictable

Browsers can evict IndexedDB under storage pressure, and Safari clears it after ~7 days of no use.
Losing local-only work would be catastrophic. **Mitigation:** call
`navigator.storage.persist()` on first run and *show* the result; a persistent warning banner if not
granted; encourage frequent sync so GitHub is the source of truth; a one-click "Download full
backup ZIP". Never let unsynced work be the only copy — the sync indicator shows unsynced-op count
at all times.

### 9.4 🟠 Privacy of medical/private data is not real if the repo is readable

Anyone who can clone the repo can read `private notes` and `medical history`, regardless of UI
roles. **Mitigation options:** (a) private repo + trusted collaborators only — simple, sufficient
for most families; (b) a *second*, more restricted private repo for the `private/` tree; (c)
client-side AES-GCM encryption of private fields under a shared family passphrase — strongest, but
lose the passphrase and the data is gone forever, which is a real risk in a 50-year archive. I
recommend (a) now, with the encryption hook designed in (b/c) as opt-in later. Also: **living
people** should be redacted from any public export by default (a legal requirement in some
jurisdictions, GDPR-adjacent in the EU).

### 9.5 🟠 Node 18 vs the toolchain

Your machine has **Node 18.19.1**. Vite 7 and current Vitest require Node 20+. **Mitigation:**
either upgrade to Node 22 LTS (recommended — 10 minutes with `nvm`) or pin Vite 5.x. I'd rather
upgrade Node than start a 10-year project on an EOL runtime.

### 9.6 🟡 GEDCOM is a swamp

GEDCOM 5.5.1 vs 7.0 are meaningfully different; ANSEL encoding still appears in older exports;
every vendor emits custom `_TAGS`; MyHeritage/Geni/Ancestry each break the spec differently.
**Mitigation:** encoding sniffing (ANSEL/UTF-8/UTF-16/CP1252), a permissive line parser that never
throws, **preserve every unrecognised line verbatim** in `person.raw.gedcom[]` so nothing is lost
and export can round-trip, and an import report showing exactly what was and wasn't understood. I
will tune the parser against **your actual file** — this is why sending it early is valuable.

### 9.7 🟡 Scope

This brief is roughly 18 modules and ~60 substantial features — comfortably 6–12 months of
full-time work for one experienced developer. The risk is not that it's impossible; it's building
40% of everything and having nothing usable. **Mitigation:** the roadmap below is strictly ordered
so that **every phase ends with a working, useful application**. If we stop after Phase 5, you have
a genuinely good family archive. Everything after that is enrichment.

### 9.8 🟡 Assorted

- **Tiptap content longevity** — store the ProseMirror JSON *and* rendered HTML; JSON is the source
  of truth, HTML is the 2050 fallback if Tiptap is gone.
- **Leaflet tiles** — OSM tile usage policy forbids heavy automated use; add attribution, cache
  tiles, and offer a provider setting.
- **AI API keys in a browser** — a key in client-side storage is exposed to any XSS. Bring-your-own-key
  stored locally with a clear warning; a proxy option later if AI becomes central.
- **Bundle size** — 15+ heavy libraries. Enforce route-level code splitting and a CI bundle budget
  from Phase 1, or the "fast, lightweight" goal quietly dies.
- **Photo re-encoding** — never touch the original bytes. Ever.
- **Test data** — real family data must not go into the repo's test fixtures; anonymised samples only.

---

## 10. Phased implementation roadmap

Each phase is independently shippable and leaves the app fully functional.

### Phase 0 — Foundation *(~1 session)*
Vite + React + strict TS + Tailwind + router skeleton; design tokens, light/dark, typography scale;
`ui/primitives`; app shell (sidebar, command palette stub, keyboard shortcut infrastructure);
Vitest + Playwright wired; ESLint/Prettier; CI bundle budget; ADR folder.
**Ships:** an empty but beautiful, accessible, dark-mode-capable shell.

### Phase 1 — Domain core *(~1–2 sessions)*
`domain/` in full: entities, `GenDate` + parser, assertions + projection, relationship graph +
kinship algebra, validation rules, Zod schemas + JSON Schema emit. ~90% unit coverage.
**Ships:** no UI change — but the irreplaceable part exists and is proven.

### Phase 2 — Storage & People *(~2 sessions)*
Dexie schema + `RepositoryPort`; People list (virtualized); **Person page with the section
registry**; create/edit people; names, vitals, facts; confidence chips; relationship editing.
**Ships:** 🎉 a usable archive — you can enter and browse your family.

### Phase 3 — GEDCOM import *(~1–2 sessions, needs your file)*
Import worker, encoding sniffing, 5.5.1 + 7.0, raw-line preservation, **import review UI** with
conflicts, everything landing as `unverified`, import report, undo-whole-import.
**Ships:** your real family data, in the app, safely.

### Phase 4 — Places, Events, Sources *(~2 sessions)*
Place entity + hierarchy + geocoding assist; Leaflet map view, residence history, migration paths;
Event objects linking people/places/media/sources; Source + Citation UI; "cite this fact" everywhere.
**Ships:** the archive becomes a *history*, not a list of names.

### Phase 5 — Media & Documents *(~2 sessions)*
`MediaStorePort` + OPFS adapter; dropzone ingest, hashing/dedupe, EXIF, derivatives; virtualized
gallery; lightbox; people tagging with regions; PDF/document viewer; media on person pages.
**Ships:** photos, letters, certificates — the emotional core of the product.

### Phase 6 — Sync & Auth *(~2 sessions)*
`AuthPort` (PAT first, then Device Flow); repo bootstrap/clone; Git Data API batched push; delta
pull; outbox + sync indicator + rate-limit meter; conflict inbox; `users/*.json` + roles.
**Ships:** multi-device, multi-person, backed-up-forever.

### Phase 7 — Family tree *(~2 sessions)*
React Flow with windowed subgraph, worker layout, ancestors/descendants/hourglass layouts, collapse/
expand, focus, minimap, search-in-tree, relationship finder ("how am I related to X?"), SVG/PNG
export, print stylesheet.
**Ships:** the view everyone asks for first — done well and fast.

### Phase 8 — Search, Timeline, Dashboard *(~1–2 sessions)*
`SearchPort` + Fuse adapter + worker; global command-palette search over everything incl. OCR text;
zoomable person + archive timelines; Dashboard with recent activity, verification progress, "on this
day", conflicts inbox, suggestions.
**Ships:** the archive becomes navigable and *inviting*.

### Phase 9 — Export & History *(~1–2 sessions)*
GEDCOM 7 + 5.5.1 export, JSON, CSV/Excel, ZIP bundle, PDF person/family reports, printable book,
tree PNG/SVG; History browser with diffs and per-field revert; backup/restore.
**Ships:** no lock-in, provably. Worth doing before AI — it's the promise the project is built on.

### Phase 10 — AI Assistant *(~2 sessions)*
`AiPort` (Anthropic adapter, BYO key); **suggestion queue** with approve/reject/edit as the only
write path; biography drafting from facts; duplicate detection; impossible-date/relation checks
(these two are pure-logic and ship even with no API key); OCR via Tesseract; image captions;
document summarization; conflict detection.
**Ships:** intelligence, with humans firmly in charge.

### Phase 11 — Time Machine *(~1–2 sessions)*
Year scrubber; living-people projection; residences/marriages/children/events/photos as of year Y;
map + tree + gallery all filtered by the same projection; historical context lane.
**Ships:** the flagship, wow-factor feature.

### Phase 12 — Polish & hardening *(ongoing)*
Accessibility audit (WCAG 2.2 AA, screen-reader pass, focus management); elderly-user testing pass;
performance profiling at 100k synthetic people; PWA/offline; keyboard shortcut reference; onboarding;
docs; i18n scaffolding (Finnish/English — worth designing for given the family).

**Suggested order change from the brief:** it lists Import before basically everything. I've put the
domain core and People UI first (Phases 1–2) because importing into a data model that hasn't been
validated against real UI needs is how you end up importing twice. Your GEDCOM lands in Phase 3 —
early, but on solid ground.

---

## Appendix A — Dependency notes

| Library | Use | Note |
|---|---|---|
| React 19 + TS 5.7 strict | core | `noUncheckedIndexedAccess` on |
| Vite | build | **needs Node 20+** (§9.5) |
| Tailwind 4 | styling | CSS-variable tokens for theming |
| React Router 7 | routing | data router, lazy routes |
| React Flow 12 | tree | windowed subgraph only (§7) |
| Leaflet + react-leaflet | maps | OSM attribution required |
| Tiptap 2 | biography | store JSON + HTML |
| Zustand 5 | UI state | sliced stores |
| Framer Motion | animation | respect `prefers-reduced-motion` |
| Dexie 4 + dexie-react-hooks | storage | `useLiveQuery` everywhere |
| Fuse.js | search | swappable via `SearchPort` (§7) |
| date-fns | derived instants | *not* the genealogical date type (§3.3) |
| react-dropzone | ingest | |
| Zod | schema | single source for TS types + JSON Schema |
| TanStack Virtual | virtualization | **added** — required for the scale targets |
| Vitest + Playwright | tests | **added** |

Two additions to the stack (TanStack Virtual, Zod) and one clarification (date-fns is not the date
model). Everything else is exactly as specified.

## Appendix B — Decisions

Resolved 2026-07-25.

| # | Decision | Choice | Consequences for the build |
|---|---|---|---|
| 1 | Media storage (§9.1) | **Tiered: git + GitHub Releases** | `MediaStorePort` ships with three adapters: `OpfsMediaStore` (local working copy, always), `GitHubBlobStore` (images < 1 MB, committed), `GitHubReleaseStore` (everything larger, as release assets — outside git history). Derivatives are local-only and never synced. `RemoteMediaStore` (S3/R2) stays defined but unimplemented until needed. Practical ceiling ~50–100 GB at no cost. |
| 2 | Auth (§5.1) | **PAT first, Device Flow after** | Phase 6 ships `PatAuthAdapter` (paste a fine-grained token, stored in IndexedDB, optional passphrase wrap). `DeviceFlowAuthAdapter` follows immediately behind the same `AuthPort`. No server component, ever. |
| 3 | Scale (§9.7) | **Hundreds → ~5,000 people** | `FuseSearchAdapter` is the default and the only one built now; `InvertedIndexAdapter` remains an interface-level plan. React Flow windowed subgraph still applies (it's about legibility, not just performance). No packed-shard format. 2-char id sharding is kept anyway — it costs nothing and is painful to retrofit. Virtualization still used throughout: it is cheap and makes the media grid smooth regardless. |
| 4 | Privacy (§9.4) | **Single private repo, trusted collaborators** | UI roles/permissions are built as specified but documented as UX-level, not a security boundary. `PrivacyClass` still travels with every fact and media item, and export redaction of living people is still implemented — those matter for what leaves the archive. Field-level encryption is designed for (a `privateBlob` slot) but not built. |
| 5 | Node / toolchain (§9.5) | **Pending — see below** | Default plan: pin Vite 5.x + Vitest 2.x so Phase 0 runs on Node 18.19.1 unchanged. If Node is upgraded to 22 LTS, we take Vite 7 instead. |
