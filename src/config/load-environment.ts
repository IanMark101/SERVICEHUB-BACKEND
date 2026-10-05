import { config } from "dotenv";
import { basename, resolve } from "node:path";

// Source modules live in src/config; compiled modules live in dist/src/config.
// Resolve .env from the backend directory, independently of the shell's cwd.
const moduleRoot = resolve(__dirname, "../..");
const backendRoot = basename(moduleRoot) === "dist" ? resolve(moduleRoot, "..") : moduleRoot;

export const environmentFile = process.env.DOTENV_CONFIG_PATH || resolve(backendRoot, ".env");

// Environment variables supplied by Docker or the hosting platform take priority.
config({ path: environmentFile, quiet: true });
