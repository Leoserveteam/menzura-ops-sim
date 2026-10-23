/**
 * Refuses to start if the environment carries credentials for any real service
 * the mocks stand in for. The only real key the sim may ever see is the
 * Anthropic key, and only in live mode.
 */
const SUSPECT = /(STRIPE|XERO|CARTA|DOCUSIGN|ATTIO|AIRTABLE|GMAIL|GOOGLE_(APPLICATION_CREDENTIALS|CLIENT|API|OAUTH)|GCAL|GDRIVE|OAUTH_(TOKEN|SECRET)|SMTP|SENDGRID|TWILIO|RESEND|POSTMARK|MAILGUN)/i;

export function suspectEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => SUSPECT.test(k) && (env[k] ?? '').trim() !== '');
}

export function assertCleanEnv(env: NodeJS.ProcessEnv = process.env): void {
  const bad = suspectEnvVars(env);
  if (bad.length) {
    throw new Error(
      `Refusing to start: the environment holds credentials for real services (${bad.join(', ')}). ` +
        'The simulation uses local mocks only. Unset these and run again.',
    );
  }
}

/** Environment passed to the Agent SDK subprocess: no real-service credentials, no telemetry. */
export function agentSubprocessEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!SUSPECT.test(k)) out[k] = v;
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  out.DISABLE_TELEMETRY = '1';
  out.DISABLE_ERROR_REPORTING = '1';
  out.DISABLE_AUTOUPDATER = '1';
  out.CLAUDE_AGENT_SDK_CLIENT_APP = 'menzura-ops-sim/0.1.0';
  return out;
}
