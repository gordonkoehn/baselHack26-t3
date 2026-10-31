# Deployed smoke check (#73)

`bash code/scripts/smoke.sh` preserves local mode: it starts the existing built
frontend on port 3000 and backend on port 8000 and checks `/api/health` through
the frontend proxy and `/`. Build the frontend first (or use `make smoke`). Busy
local ports fail before startup. Cleanup signals only process groups created by
this invocation, including their children. Private per-run logs are removed on
exit; raw logs, response bodies and credentials are never printed.
If an owned backend or frontend process exits during startup, the diagnostic names
that service and its numeric exit status. Exit status zero also fails readiness;
negative statuses indicate termination by a signal. Cleanup still covers only
this invocation's process groups.

Remote mode never starts or terminates servers:

```bash
export SMOKE_ALLOWED_ORIGIN=https://your-owned-project.vercel.app
export SMOKE_PERSONA_ID=p_deployment_smoke
bash code/scripts/smoke.sh "$SMOKE_ALLOWED_ORIGIN"
```

Remote mode requires an explicit trusted origin and a pre-existing synthetic
persona. It checks health and root with HTTP 200, creates one session with HTTP
201, then reads it with HTTP 200 and compares the complete response. No persona
extraction, interview, realtime token, avatar or LLM call is made. Missing Redis
credentials, unavailable store, missing fixture, failed proxy, unexpected
redirect/auth page or mismatched stored session makes the job fail.
Optional provider health booleans are omitted per the brief: health contracts
remain unchanged and provider availability is not tested.

## Owner setup (OPEN; not performed by this implementation)

1. Configure the deployed frontend's `BACKEND_URL` and backend's
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in deployment settings.
   Never place these values in Actions variables or smoke-script arguments.
2. Provision a synthetic persona in that deployment's Redis using the existing
   persona contract (`code/shared/examples/persona.json`) and normal store
   serialization/key format (`ot:persona:<id>`). This is an owner/admin fixture,
   not a new public endpoint. Do not use persona extraction to set it up; that
   invokes a provider. Persona keys expire after seven days under the current
   store TTL; arrange renewal before expiry. Missing fixtures fail visibly.
   Prefer a dedicated synthetic store/project.
3. Add repository Actions variable `DEPLOYED_SMOKE_CREATOR_ID`: the verified numeric
   GitHub account ID of the trusted Vercel integration creating both deployment
   and status events. Verify the actual integration identity, not a display name.
4. Add repository variable `DEPLOYED_SMOKE_TARGETS`, an exact administrator-approved
   mapping of GitHub deployment environment names to owned origins and persona IDs:

   ```json
   {
     "Preview": {"origin": "https://owned-preview.example", "persona_id": "p_smoke_preview"},
     "Production": {"origin": "https://owned-production.example", "persona_id": "p_smoke_production"}
   }
   ```

   Replace these placeholders. Origins must be HTTPS with no path/trailing slash,
   query, fragment or userinfo. Wildcard `*.vercel.app` is never accepted. Confirm
   each origin belongs to the intended repository's Vercel project. For changing
   immutable preview URLs, update the mapping before the success event, or use a
   project-owned stable preview alias if it is the actual event URL. Unknown
   environments/URLs fail without sending secrets.
5. Resolve the trusted-workflow and secret-policy gate below BEFORE configuring
   smoke secrets. Configure access protection only after that owner review.
   Exercise preview and production and intentionally
   remove a required store env var on a disposable preview to verify a red check.
   This live validation is OPEN. The job reports smoke results; it does not undo
   deployments or automatically establish a pre-merge branch protection requirement.

   Confirm that the integration actually emits GitHub Deployment and
   `deployment_status` events. A read-only repository API check during implementation
   returned no Deployment records; Vercel commit checks alone do not trigger this
   workflow. Event emission and the current Vercel account/deployment issue remain
   owner setup prerequisites. A stale live page is not evidence for current `main`.

Each remote run creates one synthetic session with the existing seven-day TTL.
There is no delete-session API; smoke invents no cleanup endpoint. POST is never
retried. An ambiguous write timeout may leave a session that expires naturally.
Create/read checks the deployed store path, not provider readiness or durability
under load. No deployed requests or store writes were made during implementation.

## Manual run (workflow_dispatch)

No GitHub Deployment records exist yet, so `deployment_status` does not fire. An
owner can run the check by hand: Actions, deployed-smoke, Run workflow, on the
default branch. `target_url` must exactly equal an `origin` in
`DEPLOYED_SMOKE_TARGETS` (no trailing slash, path, query or port change). An
optional `persona_id` must equal that origin's configured persona. Anything else,
or a run from another branch, fails before the secret step. Inputs are read from
the event file, never interpolated into shell. The workflow must be on the default
branch before it can be dispatched, so the first manual run happens after merge.

## Authentication and demo-passcode PR108

Optional repository variable `DEPLOYED_SMOKE_AUTH_HEADER_NAME` and secret
`DEPLOYED_SMOKE_AUTH_HEADER_VALUE` provide one authentication header on all four
requests. Direct script equivalents: `SMOKE_AUTH_HEADER_NAME` and
`SMOKE_AUTH_HEADER_VALUE`. Set both or neither. Values go to curl via stdin,
never command arguments or logs. Header control characters are rejected.

None of these four smoke routes uses `require_passcode`: `/api/health` returns a
static status, `/` serves the frontend, and session create/read use the store
without checking `X-Demo-Passcode`. Supplying that header therefore does not
validate `DEMO_PASSCODE`. On Vercel, a missing passcode makes protected routes
return 503 while this smoke can still pass. A wrong passcode similarly remains
undetected here. Session creation supplies its own synthetic guide and calls no
provider. The create/read roundtrip covers the persona lookup and session store
through the frontend `/api/*` rewrite (`BACKEND_URL`), not paid-route readiness.

Demo-passcode configuration and rejection/acceptance on protected routes, realtime
and avatar token minting, and actual provider availability require separate owner
validation. Do not invoke a paid route merely to make this smoke green. The local
mock suite verifies optional header transport only; protected deployment and
provider compatibility remain OPEN. No passcode bypass or login endpoint is added.
If Vercel Deployment Protection applies, optional secret
`DEPLOYED_SMOKE_VERCEL_BYPASS_TOKEN` (script: `SMOKE_VERCEL_BYPASS_TOKEN`) supplies
`x-vercel-protection-bypass`. Never put credentials in target URLs.

## Workflow security and bounds

Only successful deployment statuses run the job, with `contents: read` and a
five-minute deadline. Checkout fetches the default-branch script and disables
persisted credentials. This does not choose or secure the workflow definition.
GitHub's `deployment_status` event table specifies `GITHUB_SHA` as the deployment
commit and `GITHUB_REF` as the deployment ref, not the default branch. A deployment
branch can therefore carry a changed job definition; an inline validator in that
definition cannot establish its own trust. Default-branch checkout alone does not
protect repository secrets from such a workflow.

**OPEN owner gate before enabling secrets:** establish which deployment refs may
run workflows and whether those refs can modify jobs with access to repository
secrets. Review the actual workflow provenance and repository secret/Actions
policy. Either restrict all secret-capable deployment refs to trusted, reviewed
code, or separately design and review a trusted workflow execution boundary with
enforced secret access (for example, a protected environment with suitable ref
restrictions and approval). The current job declares no protected environment;
none of those external controls has been configured or verified by this change.
Do not add smoke secrets until the owner demonstrates that an untrusted deployment
ref cannot access them. Choosing a new event topology is a separate checkpoint.

Within the current workflow definition, validation
checks the repository, both creator IDs, deployment environment and exact approved
origin before exposing optional secrets to the request step. Approve only preview
targets whose deployed code may receive these credentials: trusted checkout alone
does not make untrusted deployed code safe. Credentials should be project-limited.
The job uses repository secrets/variables, not environment-scoped secrets, and does
not create recursive deployment records.

Event text stays data in the event file/environment, never shell source. All
requests refuse redirects, disable curlrc and have a three-second connect timeout,
ten-second transfer deadline, twelve-second subprocess deadline and zero retries.
Remote mode makes exactly four requests without polling. Local readiness has at
most thirty requests and twenty-nine one-second sleeps. Cleanup is bounded and
preserves failure status. Python 3, bash and curl are required; no dependency
installation or untrusted shell download runs in the workflow.

Official GitHub references (event-table semantics supplied in the checkpoint
brief; no network verification in this checkpoint):

- [Deployment status event, deployment commit and deployment ref](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#deployment_status)
- [Secrets availability, including fork and missing-secret behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [Treat event text as untrusted data](https://docs.github.com/en/actions/concepts/security/script-injections)

## Focused verification

```bash
cd code
make fix
bash -n scripts/smoke.sh
cd backend
uv run pytest -q tests/test_deployed_smoke.py tests/test_sessions.py tests/test_store.py tests/test_smoke.py
```

Tests fake curl/process/socket operations and exercise the workflow validator with
synthetic events. No ports or real services are used. Full `make check` runs in the
next external workflow node rather than this sandbox.

## Next small checkpoints (not implemented here)

1. Capture a sanitized real frontend preview event with its immutable URL and
   project identity. Review the smallest explicit project/URL trust rule and add
   accepted/rejected event tests before changing exact-origin handling. Unknown
   or dynamic URLs currently fail closed; no wildcard is accepted, and a manual
   dispatch URL must exactly match a configured origin.
2. Capture a sanitized backend-project event and agree how to identify and skip
   that project before exposing secrets or making requests. Add a backend-event
   regression separately; do not map the API origin to the frontend smoke, which
   requires `/` to return 200. Backend events currently fail rather than skip.
3. Resolve the trusted-workflow/secret-policy gate with the owner before enabling
   credentials. Then prove actual event delivery, a fresh frontend preview and
   production smoke, and a deliberately missing store variable on a disposable
   preview producing a red check. Passcode/provider acceptance remains separate.

This checkpoint is part of #73, not closure. PR118 must retain an open operational
acceptance list; the publishing owner should use `Refs #73` until live acceptance
is proved. No account, deployment, secret, provider or store settings were changed.
