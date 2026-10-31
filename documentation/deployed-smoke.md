# Deployed smoke check (#73)

`bash code/scripts/smoke.sh` preserves local mode: it starts the existing built
frontend on port 3000 and backend on port 8000 and checks `/api/health` through
the frontend proxy and `/`. Build the frontend first (or use `make smoke`). Busy
local ports fail before startup. Cleanup signals only process groups created by
this invocation, including their children. Private per-run logs are removed on
exit; raw logs, response bodies and credentials are never printed.

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
5. Configure access protection below if needed. Merge the workflow onto the default
   branch so it can trigger. Exercise preview and production and intentionally
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

## Authentication and demo-passcode PR108

Optional repository variable `DEPLOYED_SMOKE_AUTH_HEADER_NAME` and secret
`DEPLOYED_SMOKE_AUTH_HEADER_VALUE` provide one authentication header on all four
requests. Direct script equivalents: `SMOKE_AUTH_HEADER_NAME` and
`SMOKE_AUTH_HEADER_VALUE`. Set both or neither. Values go to curl via stdin,
never command arguments or logs. Header control characters are rejected.

PR108 is present on the integration base. Set the header name to `X-Demo-Passcode`
and its secret value to the deployment's `DEMO_PASSCODE` when that protection is
enabled. Smoke does not invent a passcode bypass or speculative login endpoint.
The local mock suite verifies header transport; compatibility against an actual
protected deployment remains open.
If Vercel Deployment Protection applies, optional secret
`DEPLOYED_SMOKE_VERCEL_BYPASS_TOKEN` (script: `SMOKE_VERCEL_BYPASS_TOKEN`) supplies
`x-vercel-protection-bypass`. Never put credentials in target URLs.

## Workflow security and bounds

Only successful deployment statuses run the job, with `contents: read` and a
five-minute deadline. Checkout uses the default branch, disables persisted
credentials, and never executes a deployment SHA or fork/PR checkout. Validation
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

Official GitHub references checked during implementation:

- [Deployment status event and default-branch workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#deployment_status)
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
