# musicxml-editor

A browser-based, WYSIWYG **MusicXML editor**. Add, move, and remove notes on a
staff and import/export MusicXML — everything client-side, no backend.

This repository is mid-reorganization from the single-purpose `pdf-to-musicxml`
optical-music-recognition app into the editor. The two apps are not integrated
yet; the OMR pipeline will eventually become the editor's "import from an
image/PDF" feature.

## Layout

- **`editor/`** — the WYSIWYG MusicXML editor (Preact). The intended primary
  app. See [`editor/PLAN.md`](editor/PLAN.md).
- **`import-image/`** — the original `pdf-to-musicxml` OMR pipeline, moved here
  wholesale and self-contained (its own Makefile, docker-compose, Netlify
  config, and tests). See [`import-image/README.md`](import-image/README.md).

## Development

Requires only `make` and `docker`.

```sh
make build       # build the editor into editor/dist
make dev         # build + rebuild on change
make pr-ready    # format, lint, typecheck, build, unit-test
```

For the OMR app, work from inside `import-image/` with its own `make` targets.

## Deployment

Netlify currently deploys `import-image/` (unchanged). The editor build is wired
up but its deploy is not flipped on until verified — see `netlify.toml`.
