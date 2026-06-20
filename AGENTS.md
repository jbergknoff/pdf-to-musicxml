# Agent notes (monorepo root)

This repository is being reorganized from the single-purpose `pdf-to-musicxml`
OMR app into **`musicxml-editor`**: a WYSIWYG MusicXML editor whose eventual
"import from an image/PDF" feature is the old OMR pipeline. The two apps are
**not integrated yet** — this is purely the structural reorg.

## Layout

```
editor/         The WYSIWYG MusicXML editor (Preact). The intended primary app.
                Self-contained; only dependency is preact. Copied from
                jbergknoff/piano-practice PR #89. See editor/PLAN.md.

import-image/   The original pdf-to-musicxml OMR pipeline, moved here wholesale
                and unchanged. Fully self-contained: its own Makefile,
                docker-compose.yml, netlify config, package.json, and tests.
                Run its targets from inside the directory. See
                import-image/AGENTS.md and import-image/PLAN.md for everything
                about that app.
```

## Root tooling (the editor)

The repo root is a Bun workspace whose member is `editor/`. Local requirements
are `make` and `docker` (Bun/Biome/tsc run in the `oven/bun` container via
docker-compose), matching the import-image conventions.

```sh
make build        # bun build editor/src/main.tsx -> editor/dist (the deploy target)
make dev          # build, then rebuild on change
make format       # biome format --write
make lint         # biome lint
make typecheck    # tsc --noEmit
make unit-test    # bun test editor
make pr-ready     # format, lint, typecheck, build, unit-test
```

`editor/src/test-setup.ts` (linkedom DOM globals) is preloaded for the editor's
tests via root `bunfig.toml` — it was not part of the copied PR directory, which
relied on the piano-practice root setup.

## Deployment

Netlify **currently still deploys `import-image/`** (the OMR app), unchanged: the
root `netlify.toml` sets `base = "import-image"` so its build, publish dir, and
functions resolve exactly as before. The editor build is wired up
(`make build-editor`) but its deploy is intentionally not flipped on until it has
been verified — see the comment in `netlify.toml` for the one-time switch.

## Conventions

Same as import-image (carried from the sibling piano-practice repo): full words
in names, braces around every conditional/loop body, `PascalCase` components and
`kebab-case` everything else, `lib/` runtime-agnostic. Run the relevant
`make pr-ready` (root for the editor, `import-image/` for the OMR app) before
committing.
