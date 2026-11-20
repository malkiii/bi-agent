# Every signed-in user can use every Data Source

The app is self-hosted for a single organisation, and sign-in is limited to that organisation's Slack workspace. Every signed-in user can therefore query every Data Source and open every Report Run. We considered per-Data-Source allowlists of users and Slack channels, which would stop restricted Answers appearing in shared channels, and rejected them for v1 as unnecessary for our use case. What the agent can see is controlled in two places only: the read-only credentials an admin supplies, and which Datasets are exposed.

## Consequences

- Never connect a Data Source that holds data some workspace members must not see. Expose a restricted view or a read-only database user instead.
- Adding access control later means changing the agent's tool selection, Report Run URLs and channel delivery, so it is not a small change.
