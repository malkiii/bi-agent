# BI Agent

An agent that answers business questions from an organisation's connected data: databases, Salesforce and uploaded spreadsheets. People talk to it by @mentioning it in Slack or through the web dashboard.

## Data

**Data Source**:
One configured connection the agent can query. Its kind is SQL database, MongoDB, Salesforce, or Uploads.
_Avoid_: Connection, integration, database (when you mean the configured thing)

**Dataset**:
One queryable table, collection, Salesforce object, or uploaded sheet inside a Data Source.
_Avoid_: Table (when you mean the general idea), entity, model

**Exposed Dataset**:
A Dataset an admin has made visible to the agent. Datasets that aren't exposed don't exist as far as the agent is concerned.
_Avoid_: Enabled table, allowlisted table

**Synonym**:
A business term an admin maps to a Dataset or column, e.g. "revenue" means `orders.total_amount`.
_Avoid_: Alias, mapping

**Channel Default**:
The Data Sources the agent prefers for Prompts sent in a particular Slack channel. It keeps to them while any of them can be queried.
_Avoid_: Channel binding

## Conversations

**Conversation**:
One thread of back-and-forth between a person and the agent. It has exactly one Source.
_Avoid_: Chat, session, thread (when you mean the domain concept)

**Source**:
Where a Conversation lives. It is either Slack (one Slack thread is one Conversation) or Web (started in the dashboard).
_Avoid_: Channel, origin

**Prompt**:
A message from a person asking the agent something.
_Avoid_: Question, query, request

**Answer**:
The agent's reply to one Prompt, made of one or more Result Blocks. It always names the Data Sources and Datasets it used.
_Avoid_: Response, reply, output

**Result Block**:
One piece of an Answer: Text, Table, Chart or File.
_Avoid_: Attachment, artifact

**Fork**:
A new Web Conversation that starts from the history of a Slack Conversation. The Slack Conversation stays exactly as it happened in Slack.
_Avoid_: Continue, copy, branch

**Participant**:
Someone who has sent at least one Prompt in a Conversation. Only Participants can see a Conversation in the dashboard.
_Avoid_: Member, owner

**Saved Question**:
A Prompt whose queries are pinned so it can be re-run on demand.
_Avoid_: Bookmark, favourite, pin

## Scheduled work

**Pinned Query**:
A query the agent wrote and a person approved. It is stored and re-executed as-is, without asking the LLM to write it again.
_Avoid_: Saved query, template

**Report**:
A Prompt run on a schedule. Its data comes from Pinned Queries, and the agent writes fresh commentary on each run.
_Avoid_: Scheduled report, KPI report, job

**Report Run**:
One generated, printable page of a Report. Its data is frozen at the time it was generated.
_Avoid_: Report instance, snapshot, edition

**KPI**:
A named single number defined by a Pinned Query, e.g. "Daily Orders".
_Avoid_: Metric, measure, indicator

**KPI Alert**:
A KPI plus a condition, a check frequency and a Slack destination. It fires once when the condition becomes true and re-arms when it clears.
_Avoid_: Threshold alert, notification, trigger
