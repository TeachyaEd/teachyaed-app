# TeachyaED — PHASE 2.1 dependency baseline review

Performed before any Schedule feature code, per the explicit instruction
that this is the cheapest point to make justified major-version upgrades
in a foundation that has no production users yet. Every current-stable
version below was read live from the npm registry (`registry.npmjs.org`),
not from memory or training-data assumptions — see the peerDependencies/
engines fields quoted for each blocker.

## React

CURRENT: 18.3.1
TARGET: 19.3.0
BREAKING CHANGES RELEVANT TO THIS APP: `ReactDOM.render`/`hydrate` removed
(this app already uses `createRoot` in `main.tsx`, so no change needed);
legacy `defaultProps` on function components and old `propTypes` warnings
removed (not used anywhere in this codebase); `forwardRef` still works but
is no longer required (not used yet — no migration needed); `act()` moved
out of `react-dom/test-utils` into `react` itself, handled internally by
`@testing-library/react` 16.x. StrictMode continues double-invoking
effects/render in development, which is directly relevant to and motivates
the AuthProvider stale-async hardening in this same phase.
COMPATIBILITY: react-router-dom 7's peerDependencies accept `react: >=18`;
`@testing-library/react` 16.3.3's peerDependencies accept
`react: ^18.0.0 || ^19.0.0`; `@types/react` 19.3.0 pairs with it.
DECISION: UPGRADE to 19.3.0.

## React DOM

CURRENT: 18.3.1 → TARGET: 19.3.0 (paired with react, same reasoning).
DECISION: UPGRADE to 19.3.0.

## react-router-dom

CURRENT: 6.26.2
TARGET: 7.18.4
BREAKING CHANGES RELEVANT TO THIS APP: v7 merges what was Remix's
framework-mode routing, but `react-router-dom`'s classic/"declarative
mode" exports (`HashRouter`, `Routes`, `Route`, `useNavigate`, etc. —
everything this app's `src/app/router/index.tsx` uses) are preserved and
designed by the React Router team as a low-effort v6→v7 upgrade for
apps not using data routers/loaders, which this app does not use.
COMPATIBILITY: peerDependencies `react: >=18`, `react-dom: >=18` —
satisfied by the React 19 upgrade above. engines: `node >=20.0.0`.
DECISION: UPGRADE to 7.18.4.

## Vite

CURRENT: 5.4.5
TARGET: 8.3.0
BREAKING CHANGES RELEVANT TO THIS APP: Vite 6 introduced an opt-in
Environment API (not used here, no impact); Vite 7 raised the minimum
Node.js version and dropped the deprecated CommonJS Node API
(`require('vite')`) — this app's `vite.config.ts` already uses
`import { defineConfig } from 'vite'` (ESM), so unaffected; Vite 7 also
removed `splitVendorChunkPlugin`, which this app's minimal config never
used. Vite 8 continues on that same baseline.
COMPATIBILITY: engines `node: ^20.19.0 || >=22.12.0`. Satisfied by
pinning the CI runner to Node 24 (see below).
DECISION: UPGRADE to 8.3.0.

## @vitejs/plugin-react

CURRENT: 4.3.1 → TARGET: 6.1.1.
COMPATIBILITY: peerDependencies require `vite: ^8.0.0` — matches the
Vite decision above exactly (this is the version pairing Vite's own
plugin ecosystem expects for Vite 8).
DECISION: UPGRADE to 6.1.1.

## TypeScript

CURRENT: 5.5.4
LATEST OVERALL: 7.0.2 (the "TypeScript 7" native/Go-rewritten compiler,
very recently released — `typescript@next` is already 7.1.0-dev).
LATEST WITHIN 5.x: 5.9.3.
BREAKING CHANGES / COMPATIBILITY BLOCKER: `typescript-eslint@8.70.0`
(the current stable typescript-eslint, needed for the ESLint 10 upgrade
below) declares `peerDependencies: { "typescript": ">=4.8.4 <6.1.0" }`.
TypeScript 7.0.2 falls **outside** that range. Installing TypeScript 7
today would break linting (typescript-eslint would refuse to resolve, or
silently run in an unsupported/unverified mode) — a concrete,
registry-verified compatibility blocker, not a guess.
DECISION: RETAIN the 5.x line, UPGRADE within it to 5.9.3 (latest 5.x).
Do NOT adopt TypeScript 7 yet. Revisit once typescript-eslint publishes
a release with TypeScript 7 in its supported peer range.

## Vitest

CURRENT: 2.0.5
TARGET: 5.0.1
BREAKING CHANGES RELEVANT TO THIS APP: across vitest 3/4/5, the
`workspace` config file/option was replaced by a `projects` field, some
coverage-provider defaults changed, and snapshot serialization was
refined. This app's vitest config (inside `vite.config.ts`: `environment`,
`setupFiles`, `include`, `css: false`) uses none of the renamed/removed
options, so no config migration is needed — confirmed empirically by the
real CI run for this commit, not assumed.
COMPATIBILITY: peerDependencies require `vite: ^6.4.0 || ^7.0.0 || ^8.0.0`
— satisfied by the Vite 8 decision above. engines: `node: ^22.12.0 ||
^24.0.0 || >=26.0.0`.
DECISION: UPGRADE to 5.0.1.

## @testing-library/react

CURRENT: 16.0.1 → TARGET: 16.3.3 (same major line, not a major-version
decision). peerDependencies accept React 18 or 19 and matching @types.
DECISION: UPGRADE to 16.3.3.

## @testing-library/jest-dom

CURRENT: 6.5.0 → TARGET: 7.0.1.
COMPATIBILITY: peerDependencies `vitest: >=0.32`, `@testing-library/dom:
>=10 <11`; engines `node: >=22` — satisfied by the Node 24 CI pin.
DECISION: UPGRADE to 7.0.1.

## @supabase/supabase-js

CURRENT: 2.45.4 → TARGET: 2.116.0. Same major (2.x) — not a
major-version decision, just staying current within the major line
already in use for the Supabase browser client. engines: `node: >=22.0.0`,
satisfied by the Node 24 CI pin.
DECISION: UPGRADE to 2.116.0.

## ESLint

CURRENT: 9.10.0
TARGET: 10.10.0
BREAKING CHANGES RELEVANT TO THIS APP: flat config (`eslint.config.js`,
already in use) has been the default since ESLint 9, so no config-format
migration is needed for ESLint 10.
COMPATIBILITY: engines `node: ^20.19.0 || ^22.13.0 || >=24` — satisfied
by Node 24. `typescript-eslint@8.70.0` peerDependencies accept
`eslint: ^8.57.0 || ^9.0.0 || ^10.0.0`; `eslint-plugin-react-hooks@7.1.1`
peerDependencies accept eslint up through `^10.0.0`;
`eslint-plugin-react-refresh@0.5.7` peerDependencies accept
`eslint: ^9 || ^10`. All three plugins this app uses explicitly support
ESLint 10.
DECISION: UPGRADE to 10.10.0.

## typescript-eslint / @typescript-eslint/eslint-plugin / @typescript-eslint/parser

CURRENT: 8.5.0 (added in the PHASE 2 CI-fix commits) → TARGET: 8.70.0.
Same major (8.x) — latest patch/minor within the major already adopted
to fix the original ESLint 9 peer-dep conflict.
COMPATIBILITY: peerDependencies `typescript: >=4.8.4 <6.1.0` — satisfied
by the TypeScript 5.9.3 decision above (this is, again, the reason
TypeScript 7 was rejected this phase).
DECISION: UPGRADE to 8.70.0.

## eslint-plugin-react-hooks

CURRENT: 5.0.0 (from the PHASE 2 CI-fix commit) → TARGET: 7.1.1.
COMPATIBILITY: peerDependencies accept eslint through `^10.0.0`.
DECISION: UPGRADE to 7.1.1.

## eslint-plugin-react-refresh

CURRENT: 0.4.11 → TARGET: 0.5.7. peerDependencies accept
`eslint: ^9 || ^10`.
DECISION: UPGRADE to 0.5.7.

## jsdom

CURRENT: 25.0.0 → TARGET: 30.1.0. Test-environment-only dependency;
vitest 5's peerDependencies accept any jsdom version (`"*"`).
DECISION: UPGRADE to 30.1.0.

## @types/react, @types/react-dom

CURRENT: 18.3.5 / 18.3.0 → TARGET: 19.3.0 / 19.3.0, paired with the
React 19 runtime upgrade.
DECISION: UPGRADE to 19.3.0 / 19.3.0.

## @types/node

CURRENT: 22.5.4 (added in the PHASE 2 CI-fix commit for `vite.config.ts`'s
`node:path`/`__dirname` usage) → TARGET: 24.13.5, aligned with the CI
runner's Node 24 pin (DefinitelyTyped's own `ts5.9` compatibility tag for
this package points at a newer 26.x release, but 24.13.5 is the version
that actually matches the Node major this project runs on, which is what
matters for ambient global/API typings here).
DECISION: UPGRADE to 24.13.5.

## Node.js version used in CI

Unifying the above engines constraints (vitest `^22.12.0 || ^24.0.0 ||
>=26.0.0`, eslint `^20.19.0 || ^22.13.0 || >=24`, vite `^20.19.0 ||
>=22.12.0`, @testing-library/jest-dom `>=22`, @supabase/supabase-js
`>=22`), **Node 24** is the smallest single version that satisfies all
of them simultaneously. `.github/workflows/ci-react.yml`'s
`actions/setup-node` steps are pinned to `node-version: 24` accordingly
(previously 20).

## Summary

No dependency was upgraded blindly. Every major-version jump above was
checked against the real npm registry's `peerDependencies`/`engines`
fields for actual incompatibilities before deciding, and exactly one
blocker was found and acted on: TypeScript is deliberately held at 5.9.3
rather than jumping to the newly-released TypeScript 7, because
typescript-eslint (needed for linting) does not yet support it.
