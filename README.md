# weft

Open, local-first sync between a reMarkable tablet and [tldraw](https://tldraw.dev)
in the browser. Draw on paper, see it in the browser; edit in the browser, watch
it appear in e-ink, in the tablet's own `.rm` format.

```bash
bun install
bun run dev     # web app at http://localhost:5173 (docs at /docs)
bun run test    # workspace, web, relay, and installer tests
```

See [self-hosting](./SELFHOST.md) for the relay, web app, and tablet setup.

Weft source is under the [MIT License](./LICENSE). The tldraw SDK uses its
[own license](https://tldraw.dev/community/license); a public web deployment
needs a valid key for its domain.

The browser uses the bundled open Noto fonts for tablet text; line wrapping
can differ from the tablet. Font notices are in [the bundled licenses](./apps/web/static/licenses).
