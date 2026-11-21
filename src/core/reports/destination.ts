/** Where scheduled work (Report Runs, KPI Alerts) is posted in Slack, and how a form's choice is checked. */
import type { SlackGateway } from '../ports';

export type ReportDestination = { kind: 'channel'; channel: string } | { kind: 'dm'; slackUserId: string };

/** Destination as a form gives it: a channel id, or a DM to the person saving. */
export type ReportDestinationInput = { kind: 'channel'; channel: string } | { kind: 'dm' };

/**
 * The destination to store, or the `destination` field error: the bot must be in a channel.
 * A DM goes to `dmTo`.
 */
export async function resolveDestination(
  slack: SlackGateway,
  dmTo: string,
  input: ReportDestinationInput,
): Promise<{ ok: true; destination: ReportDestination } | { ok: false; error: string }> {
  if (input.kind === 'dm') return { ok: true, destination: { kind: 'dm', slackUserId: dmTo } };
  const channel = input.channel.trim();
  if (!channel) return { ok: false, error: 'Choose a channel.' };
  if (!(await slack.isBotInChannel(channel))) {
    return { ok: false, error: 'Botley is not in that channel. Invite it with /invite @Botley, then save again.' };
  }
  return { ok: true, destination: { kind: 'channel', channel } };
}

/** The Slack channel id to post to: the channel, or the DM recipient's user id. */
export function destinationChannel(destination: ReportDestination): string {
  return destination.kind === 'channel' ? destination.channel : destination.slackUserId;
}
