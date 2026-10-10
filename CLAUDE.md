# lithe — working agreements

## Commits

Keep commits **simple** and use **Conventional Commits**.

```
<type>(<optional scope>): <short, lowercase, imperative summary>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`.
Scopes used here: `core`, `app`, `cli`, `relay`, `examples`, `docs`, `ci`.

Rules:

- One logical change per commit. If the summary needs "and", split it.
- Summary line ≤ 72 characters, no trailing period.
- Body only when the *why* is not obvious. No restating the diff.
- Breaking changes: `feat(app)!: ...` plus a `BREAKING CHANGE:` footer.

```sh
# good
feat(core): add dyn node for layout-time sizing
fix(relay): ignore 0x0 window-change instead of resizing to it
docs: explain why ssh cannot terminate on a serverless function
chore(ci): publish packages on tag

# bad
Update stuff
fixed bug and added tests
feat: Added A New Feature To The Core Renderer That Does Layout.
```

## Project conventions

- `packages/core` has **zero dependencies** and must run on any JS runtime
  (Workers included). No Node built-ins, no FFI, no native code.
- The TypeScript and Go sides share three deliberate duplicates: key decoding,
  display width, and ANSI diffing. Change one, change the other, and keep
  `test/fixtures/` passing on both.
- The wire protocol is versioned. New fields are additive and optional.
- Run before committing: `bun run typecheck`, `bun test`, `cd relay && go test ./... && go vet ./...`.
