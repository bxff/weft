---
title: API
description: Read notebooks, page data, and edit history from the relay.
---

## Create a key

Open [Settings → Devices & API keys](/settings/keys) and create an API key.
It acts on your account and isn’t read-only. Keep it out of browser bundles
and Git. You can revoke it from the same screen.

## List your notebooks

Set `WEFT_API_KEY` in your shell to the key you just created. Use
`https://api.weft.page` for hosted Weft, or your own relay URL if you self-host.

```bash
WEFT_URL=https://api.weft.page
curl -fsS -H "x-api-key: ${WEFT_API_KEY}" "${WEFT_URL}/api/documents"
```

The response has a `documents` array. Pick a notebook with pages and copy its
`id` and one of its `pages[].id` values.

## Download a page

Set `DOC_ID` and `PAGE_ID` to those two values, then run:

```bash
curl -fsS -H "x-api-key: ${WEFT_API_KEY}" \
  "${WEFT_URL}/api/documents/${DOC_ID}/pages/${PAGE_ID}/rm" \
  -o page.rm
```

This saves the page in the tablet’s native `.rm` format. It isn’t a full
notebook export: linked assets and browser-only shape metadata are separate.

## Read the rest of a page

Use the same `x-api-key` header for these requests. Page routes below start
with `/api/documents/{doc}/pages/{page}`.

- `GET …/overlay` returns the browser’s shape data as JSON.
- `GET …/assets` lists filenames in `files`. Download each with
  `GET …/assets/{file}`.
- `GET /api/documents/{doc}/file` returns the original PDF or EPUB if the
  relay has a copy. A `204` means the source isn’t on the relay; it may still
  be on the tablet.

## Read edit history

- `GET …/history` returns `points`, the latest edit sequence `head`, and
  `floor`, the oldest sequence the relay can still reconstruct. It returns
  the newest 1,000 points by default; set `?limit=` for up to 5,000.
- `GET …/at?seq={seq}` reads an older page without restoring it. It returns a
  binary snapshot containing both the native page and its overlay, not a raw
  `.rm` file. Use the repo’s
  [snapshot decoder](https://github.com/bxff/weft/blob/main/packages/sync-engine/src/snapshot.ts)
  to unpack it. A sequence below the retention floor returns `410`.

## Follow changes

`GET /api/changes?since=0` returns a `changes` array, oldest first, with up to
500 entries. Pass the last entry’s `seq` as `since` on the next request. An
empty array means there are no newer entries in this feed.

These are read examples for scripts and integrations, not a reference for the
browser and tablet sync protocol. The API is still evolving.
