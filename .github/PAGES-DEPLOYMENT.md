# Deploy the hosted frontend

For maintainers of a Cloudflare Pages Direct Upload project. This job only
deploys the static frontend; the relay has its own deployment and credentials.

Set up a GitHub Actions environment named `pages-production`, restricted to the
`main` branch. Use a dedicated Cloudflare API token with Cloudflare Pages edit
access limited to the relevant Cloudflare account. Do not use a personal
Wrangler OAuth session or an account-wide global API key in Actions.

| Environment setting | Type | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Pages account ID |
| `CLOUDFLARE_PAGES_PROJECT` | Variable | Name of the existing Direct Upload project |
| `CLOUDFLARE_PAGES_PRODUCTION_BRANCH` | Variable | Production branch shown in **Pages → Settings**, not necessarily the GitHub branch |
| `PUBLIC_CLOUD_URL` | Variable | Public relay origin |
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | Variable | Browser-facing Clerk key, never the Clerk secret key |
| `PUBLIC_TLDRAW_LICENSE_KEY` | Secret | tldraw key licensed for the production hostname; included in the client build |
| `CLOUDFLARE_API_TOKEN` | Secret | Dedicated Pages deployment token, used only for the upload |

The existing Pages project can keep its production branch name even if
the GitHub repo uses `main`. If the Pages setting changes, update the
environment variable before the next deploy.

A successful CI run on a push to `main` starts the deployment automatically.
Pull requests and failed CI runs do not deploy. The workflow checks out the
exact tested commit and checks that it is still the current head of `main`
before uploading. If needed, use **Actions → Deploy Weft Pages → Run workflow**
on `main` as a manual fallback; the same checks apply.

Confirm in the Pages dashboard that the new deployment is marked Production
and that the custom domain still serves the app. For a rollback, use the
previous known-good production deployment in the Pages dashboard.
