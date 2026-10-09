# DDC CLI

TypeScript/Node reference CLI for DDC. The command set and its use are described in
the repository README.

## Requirements
- Node.js 24.x (see `.nvmrc`). ESM, strict TypeScript.
- npm 11.x.

## Setup
    cd cli
    npm ci

## Build / test
    npm run build      # compile TypeScript -> dist/
    npm run typecheck  # type-check only, no emit
    npm test           # build, then run the Node built-in test runner
    npm start          # run the compiled entry point
