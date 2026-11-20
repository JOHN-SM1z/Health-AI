import { loadTestEnvironment } from "./environment";

/**
 * Tests use only .env.test (when present) or safe example defaults. Explicit
 * CI/shell values keep precedence, but every database target must be local.
 * Never load the application's .env or .env.local into destructive suites.
 */
loadTestEnvironment();
