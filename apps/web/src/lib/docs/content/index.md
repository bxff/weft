---
title: Introduction
description: A sync API for reMarkable tablets. Full docs land with the public release.
---

weft is a sync service for reMarkable tablets. A hosted cloud server speaks
the same protocol as the on-device daemon, exposing your notebooks, pages,
ink, and page assets to the browser editor and, later, to your own apps.

weft is in **private beta**. Sign-ups are invite-only while the sync core
settles.

## What lands here

The full documentation is being rewritten for the public release:

- Authentication: API keys and device pairing
- HTTP API reference
- WebSocket events
- Build your own client
- Self-hosting

The API already exists and is the same one this web app uses, scoped to your
account with keys you create and revoke in [settings](/settings/keys). If you
are in the beta and want to build against it before the reference ships, ask
and we will walk you through the current surface.
