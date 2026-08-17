# gitopolis

A desktop toy: a 3D city that is a live view of a git repository.

Every tracked (or untracked-but-not-ignored) file is a building. File size sets height,
directory sets district, uncommitted files wear scaffolding and a crane, and committing
drops every crane at once. An in-game day runs in five real minutes, so the city has
weather, traffic, lit windows and a night sky of its own.

```bash
npm install
npm run build
node server.mjs <path-to-any-repo>   # http://localhost:4173
```

The city is a pure projection of the working tree and is never persisted: restarting
produces an identical city, and `git checkout`, rebase, amend and force-push all morph it
for free. No assets — every texture and mesh is generated at runtime.

`npm test` runs the derivation checks in `test.mjs`. See `CLAUDE.md` for the architecture.
