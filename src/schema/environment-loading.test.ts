import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const backendRoot = path.resolve(__dirname, "../..");
const loader = ts.transpileModule(
  fs.readFileSync(path.join(backendRoot, "src/config/load-environment.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText;

function runLoader(layout: "src/config" | "dist/src/config", supplied: NodeJS.ProcessEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servicehub-env-"));
  try {
    const backend = path.join(directory, "backend");
    const cwd = path.join(directory, "shell");
    const moduleDirectory = path.join(backend, layout);
    fs.mkdirSync(moduleDirectory, { recursive: true });
    fs.mkdirSync(cwd);
    const loaderPath = path.join(moduleDirectory, "load-environment.js");
    fs.writeFileSync(loaderPath, loader);
    fs.writeFileSync(path.join(backend, ".env"), "DATABASE_URL=backend-database\nJWT_ACCESS_SECRET=backend-access-secret\nJWT_REFRESH_SECRET=backend-refresh-secret\n");
    fs.writeFileSync(path.join(cwd, ".env"), "DATABASE_URL=wrong-directory\n");
    const overrideFile = path.join(directory, "override.env");
    fs.writeFileSync(overrideFile, "DATABASE_URL=explicit-database\n");
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("DOTENV_CONFIG_") || ["DATABASE_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"].includes(key)) {
        delete childEnv[key];
      }
    }
    const result = spawnSync(process.execPath, ["-e", `
      require(${JSON.stringify(loaderPath)});
      console.log(JSON.stringify({
        database: process.env.DATABASE_URL,
        access: process.env.JWT_ACCESS_SECRET,
        refresh: process.env.JWT_REFRESH_SECRET
      }));
    `], {
      cwd,
      encoding: "utf8",
      env: {
        ...childEnv,
        NODE_PATH: path.join(backendRoot, "node_modules"),
        ...supplied,
        ...(supplied.DOTENV_CONFIG_PATH ? { DOTENV_CONFIG_PATH: overrideFile } : {}),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const layout of ["src/config", "dist/src/config"] as const) {
  test(`${layout} loads the backend .env from a different working directory`, () => {
    assert.deepEqual(runLoader(layout), {
      database: "backend-database",
      access: "backend-access-secret",
      refresh: "backend-refresh-secret",
    });
  });
}

test("externally supplied environment variables take priority over .env", () => {
  assert.equal(runLoader("src/config", { DATABASE_URL: "injected-database" }).database, "injected-database");
});

test("DOTENV_CONFIG_PATH can select an explicit environment file", () => {
  assert.equal(runLoader("src/config", { DOTENV_CONFIG_PATH: "override" }).database, "explicit-database");
});
