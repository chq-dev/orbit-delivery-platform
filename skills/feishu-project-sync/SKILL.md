---
name: feishu-project-sync
description: Sync Feishu Project (Meego/Meegle) requirements and defects into the Orbit delivery platform from a machine that can access project.feishu.cn. Use when the platform list is empty, the backend cannot reach Feishu, or the user asks to run, schedule, diagnose, or revise the live rjcloud story/issue sync.
---

# Feishu Project Sync

Use the official `@lark-project/meegle` CLI as the Feishu access client. The
platform backend does not need to reach Feishu. The sync host pulls live
`story` and `issue` work items and writes them to
`POST /api/integrations/feishu/ingest`.

The npm package also ships the official `meegle` Agent Skill. When it is
installed, use that skill for URL decoding, Auth Guard, MQL grammar, and
work-item command discovery; this project skill only owns the platform ingest
and local sync workflow.

## Preconditions

- The sync host can reach both `project.feishu.cn` and the platform API.
- Node.js 16+ is available.
- The platform has at least one repository, or `FEISHU_DEFAULT_REPO_ID` is set.

Check the CLI and login state:

```bash
meegle --version
meegle auth status --format json
```

If the CLI is missing:

```bash
npm install -g @lark-project/meegle@1.0.27
meegle config set host project.feishu.cn
```

If `authenticated` is false, ask the user to complete the one-time device-code
login. Do not scrape cookies, browser storage, or the project HTML page:

```bash
meegle auth login --device-code
```

For unattended hosts, use `MEEGLE_USER_ACCESS_TOKEN` from the platform
administrator instead of an interactive login.

## Configuration

Run from the Orbit repository root. Required remote-platform values:

```bash
export FEISHU_PROJECT_KEY=rjcloud
export FEISHU_REQUIREMENT_TYPE_KEY=story
export FEISHU_DEFECT_TYPE_KEY=issue
export PLATFORM_BASE_URL=http://8.145.45.84:8787
export PLATFORM_SYNC_TOKEN='<same value as server FEISHU_INGEST_TOKEN>'
```

Optional:

```bash
export MEEGLE_BIN=meegle
export MEEGLE_HOST=project.feishu.cn
export FEISHU_DEFAULT_REPO_ID=repo-1
export FEISHU_SYNC_FULL=false
export FEISHU_SYNC_OVERLAP_HOURS=48
export FEISHU_SYNC_INTERVAL_MS=300000
export FEISHU_SYNC_STATE_PATH=./data/meegle-sync-state.json
```

The server must have `FEISHU_INGEST_TOKEN` set to the same value as
`PLATFORM_SYNC_TOKEN`. Without it, the ingest endpoint only accepts loopback
requests from the platform server itself.

## Run

One-shot sync, suitable for cron or a manual check:

```bash
npm run sync:feishu
```

Continuous polling:

```bash
npm run sync:feishu:watch
```

Forced full refresh:

```bash
FEISHU_SYNC_FULL=true npm run sync:feishu
```

The script queries both work-item types through MQL, paginates with
`session_id` + `group-pagination-list`, enriches descriptions with
`workitem +batch-get`, and upserts by `rjcloud:<type>:<work_item_id>`.

## Verify

After a run, verify the actual platform state rather than trusting the sync
summary alone:

```bash
curl -sS "$PLATFORM_BASE_URL/api/health"
curl -sS "$PLATFORM_BASE_URL/api/work-items"
```

Healthy external sync appears in `/api/health` as
`feishu.mode = "cli"`, `feishu.connected = true`, and a non-zero
`feishu.workItemCount`. `/api/work-items` must contain items whose
`source` is `feishu` and whose `externalId` starts with `rjcloud:`.

## Troubleshooting

- `MEEGLE_NOT_AUTHENTICATED`: run the device-code login or provide
  `MEEGLE_USER_ACCESS_TOKEN`. Do not fabricate work items.
- `MEEGLE_COMMAND_FAILED` with field errors: run
  `meegle workitem meta-fields --project-key rjcloud --work-item-type story`
  and the equivalent for `issue`, then adjust the MQL field list.
- `FEISHU_INGEST_UNAUTHORIZED`: `PLATFORM_SYNC_TOKEN` and the server
  `FEISHU_INGEST_TOKEN` must match exactly.
- `FEISHU_INGEST_TOKEN_NOT_CONFIGURED`: remote sync is refused by design.
  Configure the server token; do not weaken the check to make it pass.
- Empty result set: confirm the CLI account can see the `rjcloud` space and
  that `story` / `issue` are the real type keys. Do not fall back to seed or
  demo data.

## Safety

- Never print or commit Feishu tokens, plugin secrets, or `PLATFORM_SYNC_TOKEN`.
- Never log in through a browser page or scrape `project.feishu.cn` HTML.
- Never replace an empty result with fixed/demo records.
- Do not write to Feishu from this sync workflow; it is read-only by design.
