# Uploaded Datasets are Parquet files queried by in-memory DuckDB

Uploaded spreadsheets and CSVs are converted to one Parquet file per Dataset on a shared Docker volume. Each process (`web` and `worker`) queries those files read-only through its own in-memory DuckDB. We chose DuckDB because the agent writes SQL well and DuckDB is fast on tabular data without an extra service. We store uploads as Parquet files rather than one `.duckdb` database file because a DuckDB file allows only one writing process, and both containers need to query uploads.

## Considered Options

- **One `.duckdb` file owned by the worker, with `web` calling it over an internal API**: rejected because it adds network calls and makes the worker critical for the web chat.
- **Importing uploads into the app's MongoDB, or into a separate Postgres container**: rejected because Mongo is a poor fit for querying tables with SQL, and Postgres means another service to run.

## Consequences

- To replace a Dataset, we write a new Parquet file and swap it in atomically. Appending rewrites the file.
