# ROLLBACK

How to reverse changes safely.

> **Repository note.** SmartDialer lives inside the `~/Developer` workspace repository,
> which contains unrelated projects and had unrelated pending staged changes when this
> project began (D-001). **Every command here is scoped to the `smartdialer/` path.** Never
> run a bare `git reset --hard` or `git checkout .` in this repository — it would discard
> the user's unrelated staged work.

---

## Current stable point

| | |
|---|---|
| Stable commit | *(uncommitted working-tree state — the project has not been committed)* |
| Last verified state | **Complete, milestones 1–12.** 446 tests passing, typecheck and lint clean, `vite build` succeeds, all 8 scenarios pass expectations and invariants, dashboard verified by browser automation |

This table is updated whenever a milestone is verified.

---

## Reverting the most recent feature

Scoped to this project only:

```bash
# See what changed under smartdialer/ only
git status --short -- smartdialer/
git diff -- smartdialer/

# Discard uncommitted changes to a specific file
git checkout HEAD -- smartdialer/<path>

# Revert a committed change without rewriting history
git revert <commit>
```

If the change is not yet committed and you want to abandon all of it, delete only the files
the feature added — do not use repo-wide reset commands.

---

## Restoring database state

The database is a disposable local artifact (`data/smartdialer.db`, gitignored). It is
never the source of truth for anything that matters, so the correct recovery for almost any
data problem is to rebuild it:

```bash
npm run db:reset     # deletes the database file, re-runs all migrations
npm run seed         # reloads deterministic seed data
```

To keep a copy before something risky:

```bash
cp data/smartdialer.db data/smartdialer.backup.db
# restore:
cp data/smartdialer.backup.db data/smartdialer.db
```

---

## Reverting migrations

Migrations are numbered, forward-only `.sql` files in `src/db/migrations/`, tracked in the
`schema_migrations` table. **There are no down-migrations**, deliberately: for a prototype
whose database is disposable, a down-migration is code that is written, never exercised,
and wrong when finally needed.

To undo a schema change: delete (or fix) the offending migration file and run
`npm run db:reset`. If you need to preserve data across a schema change, write a new
forward migration that transforms it.

---

## Restarting the system

```bash
# stop: Ctrl-C in the dev terminal
npm run dev          # API + dashboard

# if a port is stuck
lsof -ti:3000 | xargs kill
```

There is no persistent background process, queue or external service to clean up. All
dialer state that matters is either in SQLite or is in-memory state that is *supposed* to
be discarded on restart (concurrency leases — see D-007).

---

## Tests to re-run after any rollback

In this order; stop at the first failure.

```bash
npm run typecheck      # backend and web
npm run lint
npm run test:unit
npm run test:integration
npm run test:concurrency
npm run test:failure
npm run test:simulation
npm run build          # catches a frontend break the tests cannot
```

Then confirm the safety properties specifically, since those are the ones whose regression
would matter most:

```bash
npm run scenario -- dnc              # expect: zero calls to DO_NOT_CALL contacts
npm run scenario -- emergency-stop   # expect: no new calls after stop engages
npm run scenario -- race             # expect: INVARIANTS: PASSED
```

---

## Rollback plans for risky changes

Recorded *before* the change is made, per `CONSTRAINTS.md` §5.

*(None outstanding.)*
