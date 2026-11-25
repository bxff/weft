---
title: API
description: List your synced notebooks and download a page from the relay.
---

## Create a key

Open [Settings → Devices & API keys](/settings/keys) and create an API key.
It’s scoped to your account. Keep it out of browser bundles and Git. You can
revoke it from the same screen.

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
The API is still evolving.
