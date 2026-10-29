export interface FeishuSyncInstructionInput {
  apiBase: string
  projectKey?: string
}

export function buildFeishuSyncInstruction(input: FeishuSyncInstructionInput): string {
  const apiBase = input.apiBase.replace(/\/$/, '')
  const projectKey = input.projectKey?.trim() || 'rjcloud'
  return [
    `Use $feishu-project-sync to synchronize live ${projectKey} requirements and defects from Feishu into ${apiBase}.`,
    'The platform server cannot access Feishu; this machine is the authorized sync host.',
    '',
    '0. Prefer the page-driven path: run `npm run feishu:agent`, bind the platform key from the page, and complete the page device authorization. Use the CLI fallback below only when the local agent cannot run.',
    '1. Check the official Meegle CLI with `meegle auth status --format json`.',
    '2. If it is not authenticated, ask me to complete the one-time `meegle auth login --device-code` authorization. Never read browser cookies or scrape Feishu HTML.',
    `3. Set PLATFORM_BASE_URL=${apiBase} and FEISHU_PROJECT_KEY=${projectKey}. Use the existing local agent configuration or the server FEISHU_INGEST_TOKEN as PLATFORM_SYNC_TOKEN; do not print the token and do not put the token in frontend code, logs, or Git.`,
    '4. Run `FEISHU_SYNC_FULL=true npm run sync:feishu` so deletions and updates are reconciled, not merely appended.',
    `5. Verify ${apiBase}/api/health and ${apiBase}/api/work-items with real API output. Confirm the returned source=feishu items match Feishu active items and deleted items are absent.`,
    '6. Keep the live feed current by running `npm run sync:feishu:watch` persistently, or install a user-level scheduler that runs the one-shot command every 5 minutes. Do not report completion until the recurring sync is verified.',
    '',
    'If PLATFORM_SYNC_TOKEN is missing or the remote ingest endpoint rejects this machine, stop and report the exact server configuration blocker. Do not replace live data with demos, snapshots, or fabricated records.',
  ].join('\n')
}
