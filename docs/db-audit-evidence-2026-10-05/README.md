# Isolated database audit evidence

Captured 2026-10-05 for HEAD 9b684d1 plus the existing dirty working tree.

Read [the audit report](/Users/jahonshoh/Health-AI/docs/DATABASE_AUDIT_2026-10-05.md) for scope, test adaptations and findings. All identifiers and content in these files are synthetic fixtures.

The Python files preserve the executed reproduction procedure, including its original temporary socket path `/private/tmp/health-ai-db-audit.0xe3j2` and source checkout path. They are historical evidence, not portable production tooling. The temporary PostgreSQL cluster is shut down after this audit.

To repeat, prepare a new disposable PostgreSQL 16 cluster with a Unix socket, adapt only the temporary/source paths in COPIES of these files, and execute bootstrap/replay, continue, diagnostic-tail, probes, extra-probes, final-probes in order. replay.py executes bootstrap.sql itself. The continue and diagnostic-tail scripts intentionally bypass previously recorded migration blockers only inside the disposable database. Do not run these scripts against an existing application database.

SQL probe files run inside BEGIN/ROLLBACK and depend on the synthetic fixture data from probes.py. The concurrent payment probe and setup-snapshot probe are captured in extra-probes.py. No external Telegram requests were made.

Probes 22 and 28 affected zero rows and support no security conclusion. Probe 34 replaces probe 20 for the aged in-progress job scenario.
