# Codebase maintenance

Keep API source, Prisma schema and migration history, deployment configuration, operational scripts and repeatable tests in version control. A manually invoked migration or repair script is not unused merely because application code does not import it.

The October 16, 2026 cleanup removed historical build, migration and test execution logs. Logs, local audit output and browser reports are ignored generated files. Earlier tracked logs remain recoverable from Git history at `c9a9a38`.

The redundant `@types/bcryptjs` dependency was removed. The installed bcryptjs package supplies its own TypeScript definitions.

Run `npm run build` and `npm test` after cleanup. `npm run test:fresh-migrations` and the integration scripts remain available for a configured disposable test database. Keep database snapshots in the ignored `.database-backups/` directory and never delete them as ordinary test output.
