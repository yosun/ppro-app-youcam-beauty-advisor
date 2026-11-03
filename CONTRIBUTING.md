# Contributing

Thanks for helping. Small, focused changes are the easiest to review.

## Set up

Node 22.12 or newer.

```sh
npm install
npm run dev          # API on :8787, web app on :5173
```

Press **Start a demo consultation** in the browser. Without a `YOUCAM_API_KEY` the app runs in simulated mode, and nothing you do here is billed. Tests never call YouCam either: `tests/helpers.ts` removes `YOUCAM_API_KEY` from the environment, and tests run the app in simulated mode or stub `fetch`.

## Before you open a pull request

```sh
npm run check        # typecheck, lint, format check, unit tests, spec drift check
npm run build
npm run test:e2e     # browser tests; first run `npx playwright install chromium`
```

`PW_CHANNEL=chrome npm run test:e2e` uses your installed Chrome instead. `npm run format` fixes formatting.

CI runs the checks and the build on Node 22 and 24, the browser tests, and a job that builds the Docker image and starts it.

## Conventions

- TypeScript in strict mode, ES modules, relative imports with the `.ts` extension. `any` is allowed in tests only.
- Each directory under `src` may import only the layers listed for it in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#layers), and `protocol`, `client` and `web` stay free of Node-only modules. `tests/meta.test.ts` checks both.
- Messages that a model or a client will read (tool descriptions, refusals, errors) are written for that reader: plain, specific, and saying what to do next.
- A change that alters behavior comes with a test. Prefer testing through the HTTP surface (`tests/harness.ts`) over testing internals.
- Never commit a secret. `.env` is ignored; put new settings in `.env.example` with a blank or placeholder value and a comment.

## Changing the API

The code is the source of truth. The files in `spec/` are generated from it and must not be edited by hand.

1. **A route**: add it to the `ROUTES` table in `src/protocol/openapi.ts` and implement it in `src/server/app.ts`. Request bodies are Zod schemas in `src/protocol/schemas.ts`.
2. **An event**: add its type and payload in `src/protocol/types.ts` and describe it in `src/protocol/events-doc.ts` (the compiler requires both). Events belong to the protocol; an app adds tools, not event types.
3. **A tool**: write it with `defineTool` in `src/advisor/tools.ts`. Its schema, description and cost appear in the manifest and in the generated JSON Schemas automatically.
4. Run `npm run spec:build` and commit the result.
5. Update [docs/PPRO-APP-API.md](docs/PPRO-APP-API.md) and, if an agent's behavior changes, [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md).

New optional fields, events, tools and error codes are compatible. A change that would break an existing agent or host needs a new protocol number and API prefix (`ppro-app/2`, `/ppro/v2`) instead of an edit to `ppro-app/1`. See section 16 of the standard.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
