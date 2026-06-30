Gemini (Google Generative AI) setup and remediation
===============================================

This document collects steps to get the Google Generative AI (Gemini) key working, verify it locally, and remediate any accidental commits of `.env`.

1) Quick checks (local)
- Ensure your `backend/.env` contains `GEMINI_API_KEY=...` and `AI_PROVIDER=gemini`.
- Run the diagnostics script (will mask the key when printing):

  node tests/check-gemini-key.js

  - `keyMask` shows a masked preview (e.g. `AIza...here`).
  - `testCall` will attempt a lightweight `ping` to the model and return structured errors.

2) Common failure reasons and fixes
- Error: "API key not valid. Please pass a valid API key." (400 / API_KEY_INVALID)
  - Ensure the key is an *API key* created in Google Cloud (not an OAuth client ID or service account JSON string).
  - Ensure the Generative AI API (generativelanguage.googleapis.com) is enabled for the GCP project that owns the key.
  - Restriction: if the API key is restricted by API or referrers, either remove the restriction for testing or add the calling origin (server IP/hostname).

- Error: "Method doesn't allow unregistered callers" (403)
  - The call reached Google but the caller doesn't have an established identity. This often means the key is invalid or not enabled for the Generative API.

3) How to create a working API key (GCP Console)
- Go to https://console.cloud.google.com/
- Select or create a project.
- In the left menu, go to "APIs & Services" → "Library" and enable "Generative Language API" (or search "Generative Language").
- Go to "APIs & Services" → "Credentials" → Create Credentials → API key.
- (Optional) Under "Application restrictions" choose "None" for initial testing. Later restrict by IP or referrer.
- Copy the API key and add it to `backend/.env` as `GEMINI_API_KEY=YOUR_KEY`.

4) Service account alternative (recommended for production)
- For server-to-server calls, create a Service Account and grant required roles. Use OAuth or signed JWT flow as described in GCP docs. The Node SDK may require an API key for the generative endpoint; read the SDK docs for service-account usage.

5) Verify via our code
- Start the backend (nodemon or node):

  npm run dev

- Run the local checker again:

  node tests/check-gemini-key.js

6) If `.env` was committed (remediation)
- Rotate any keys immediately (create a new key and update deployments).
- To remove `.env` from local & remote history (destructive): use `git filter-repo` or BFG. Example with `git filter-repo`:

  # install git-filter-repo (https://github.com/newren/git-filter-repo)
  pip install git-filter-repo
  cd backend
  git checkout --orphan temp-branch
  git commit -m "Recreate without history" --allow-empty
  git branch -M cleaned
  git filter-repo --invert-paths --paths .env

  # Force-push cleaned history to remote (requires coordination)
  git push --force origin main

- Alternatively use BFG (simpler UI). Both approaches rewrite history — coordinate with teammates and backups.

7) Post-remediation
- Update secrets in your deployment (CI, server env vars). NEVER store secrets in the repo.

8) If you want me to proceed
- I can:
  - Walk you through enabling the API and creating a working key step-by-step (I can open a checklist here).
  - Run `git filter-repo` locally to scrub `.env` (I will not push without your approval).
  - Create a new API key locally and test it here (I can't create GCP keys for you; you'll need to paste the new key into `.env`).

Contact me which of the above you want me to perform next.
