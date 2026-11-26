# Private branch previews

These are for visual review, not for testing production sign-in or synced
notebooks. A preview has no production Clerk or tldraw config, and points to an
unreachable relay by default.

## Before enabling

1. Enable **Preview access** (Cloudflare Access) on the Pages project. Test an
   innocuous preview without signing in. Both its branch alias and its immutable
   deployment URL must require authentication. Limit who can sign in. Leave
   production's custom domain unchanged. An unlisted Pages URL isn't private.
2. In GitHub's **pages-preview** environment, restrict deployment branches to
   **main**. Set the environment variables `CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_PAGES_PROJECT`, and `CLOUDFLARE_PAGES_HOSTNAME` (the project's
   `.pages.dev` hostname, with no scheme). Add a dedicated Pages Edit token
   scoped to the Cloudflare account as `CLOUDFLARE_API_TOKEN`. Cloudflare Pages
   Edit is account-level; use a different Cloudflare account if you need hard
   isolation from production credentials.
3. Only then set the repository variable `WEFT_PRIVATE_PREVIEWS_ENABLED` to
   `true`. Remove it to stop future previews. This does not delete previously
   uploaded deployments or change their Access policies.

## Usage

A maintainer adds `preview` to an open PR from a branch in this repo targeting
`main`. The next successful CI run for its current head builds a preview.
If CI already passed before labeling, use **Actions → Preview Weft Pages →
Run workflow** from `main` and enter the PR number. Look in the job summary
or the environment link for the stable `pr-N.<project>.pages.dev` URL.

Forks cannot preview. The branch build runs with read-only GitHub permissions
and no Pages or production secrets. A fresh upload runner never checks out or
executes the branch code and rejects Pages Functions and symbolic links. It
checks the PR label and head again, and refuses to upload to the Pages
production branch. Removing the label stops future uploads; old preview
deployments remain protected by Cloudflare Access until removed.
