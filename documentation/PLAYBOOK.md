# Hackathon playbook — brainstorm → running repo in 15 min

## 0. Before (done Thu)
- This repo is a GitHub **template**: generic boilerplate only (≈ `create-next-app` + FastAPI hello world), no challenge code.
- Rules check (baselhack.ch, 29 Oct): nothing published on open source, pre-existing code, AI tools or judging. IP stays with the team.
  Hacking starts Fri 20:30, hands off Sun 12:00, pitches Sun 13:00.
  From experience (previous BaselHack): repos were public, and boilerplate was fine as long as the team repo's first commit happens on site. `bootstrap.sh` does exactly that. Still confirm at the opening or on Discord.

## 1. Friday 19:45–20:30 — team + scope (no laptops)
1. Names, strengths, GitHub handles. Assign roles **by strength, not by layer**.
2. Agree on the one-liner and the **3-step demo**. Everything else is faked.
3. Sketch the data shapes on paper → that becomes `shared/schema.json`.

## 2. Friday 20:30 — one command (integrator)
```bash
cd ~/Workspace/repos/gordonkoehn
./baselHack26/scripts/bootstrap.sh <team-repo-name> handle1 handle2 handle3
```
It creates the repo from the template, invites the team, sets up a CI-gated main (no human reviews, Copilot advisory), labels, a pinned **🎯 Scope & demo** issue, and two Vercel projects with auto-deploy.
Collect GitHub handles at the team table (a sticky note will do). The script invites them; **they must accept** (GitHub email/notification, or `github.com/<you>/<repo>/invitations`).
Teammates: accept the invite → `git clone` → `make setup && make dev`.
Team chat is **Discord**: `#general`, `#ci`, `#random`. Share the invite at the table and pin the deployed URL.
For the `#ci` feed: channel settings → Integrations → Webhooks → copy URL, then run bootstrap with `DISCORD_WEBHOOK=<url> ./baselHack26/scripts/bootstrap.sh …` (the URL is a secret, don't commit it).

## 3. First hour
- Integrator: replace the `Item` example with the real contract (schema + both mirrors), merge it **first**. Everyone builds against it.
- Fill in the pinned 🎯 issue. Split it into **Task issues**: one owner, < 2h, "done when" = visible in the demo.
- Walking skeleton by ~22:30: the 3 demo steps click through on the deployed URL with fake data.

## 4. Coordination — the rhythm
**The board is the issue list, the clock is fixed check-ins, and main is the truth.**

| | |
|---|---|
| Check-ins | 5 min, standing, at fixed times: **Fri 22:30 · Sat 09:30 · 13:00 · 17:00 · 21:00 · Sun 09:00 · 11:00**. Not hourly, it kills flow. |
| Check-in format | Open the **deployed** URL and click the demo. Then each person: done / next issue / blocked. Re-cut scope there, not in between. |
| Between check-ins | Async in Discord + issues. `blocked` label = ping the integrator now, don't wait. |
| Issues | One issue = one owner. Assign yourself before starting, so nobody doubles up. Labels: frontend/backend/contract/blocked/demo/stretch. |
| PRs | Many small PRs per issue are better than one big one (aim for < 200 lines). Stacking is fine: branch B on branch A, and B's PR base = A. When A merges, GitHub retargets B to main; if squash conflicts, `git rebase --onto main A B`. Keep stacks ≤ 3 deep. The last PR says `Closes #n`. |
| Merging | PR → CI green → squash-merge yourself (or `gh pr merge --auto --squash`). Copilot comments are advisory. Merge within the hour. |
| Contract changes | Only via a `contract`-labelled PR touching schema + both mirrors. Announce in chat. |

**Milestones:** core flow E2E on the deployed URL by **Sat 13:00** → only polish + pitch after **Sat 21:00** → code freeze **Sun 11:00** (organisers: hands off 12:00).

## 5. Agents (Claude / Copilot / Cursor) without chaos
- **The issue is the prompt.** Write Goal + Done-when well enough that an agent can execute it: `claude "work on issue #12"`, or assign the issue to Copilot coding agent.
- Each person drives their own agents on **their** issue and branch only. Two agents never touch the same files → split work into vertical slices, not shared files.
- Agents read `CLAUDE.md`. If an agent keeps making the same mistake, add one line there (via PR).
- Agents open PRs, CI judges, a human merges. No agent pushes to main.
- The integrator doesn't take the hardest issue. They watch main, unblock, merge, and keep the demo running.

## 6. Pitch
- One owner from Saturday afternoon. A recorded backup video of the demo by Sun 10:00.

## AI test users challenge (Sprintbox AI) — notes
Must-haves: persona data → rendered avatar you can **talk to by voice**, ready in ≤ 10–15 min, a coherent 20–30 min conversation, immersion ≥ 5/10 from 3 testers.
Excluded: text-only, Custom GPT wrappers, canned responses. The sandbox provides persona data and voice references.
Natural split: persona pipeline (backend) · realtime voice loop · avatar rendering (frontend) · immersion testing + pitch.
