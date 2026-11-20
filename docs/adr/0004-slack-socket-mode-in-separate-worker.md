# Slack runs in Socket Mode inside a separate worker container

The app is self-hosted and may not have a public HTTPS URL. So Slack events arrive over Socket Mode (Bolt), in a long-running `worker` container separate from the Next.js `web` container. The same worker runs the scheduler for Reports and KPI Alerts, with jobs stored in MongoDB. We rejected the Events API over HTTP because it needs a public URL. We rejected running Slack inside Next.js because route handlers aren't long-lived processes.

## Consequences

- If the app ever moves to serverless hosting such as Vercel, Slack needs to switch to the Events API and the scheduler needs another host.
