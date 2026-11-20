# Reports re-run pinned queries; the LLM only writes commentary

A Report is conceptually "a scheduled Prompt". Even so, we don't ask the LLM to answer the Prompt again on every run. When a Report is created, the agent answers once, a person approves the result, and its queries and layout are pinned. Each run executes the Pinned Queries and asks the LLM only for a short commentary on the new numbers. We did this so figures stay comparable between runs: a fresh LLM answer can silently redefine "revenue" or change the layout from one week to the next. It also makes runs cheaper and more reliable.

## Consequences

- A schema change in a Data Source can break a Pinned Query. The run fails visibly instead of quietly adapting.
- KPIs and Saved Questions use the same Pinned Query mechanism.
