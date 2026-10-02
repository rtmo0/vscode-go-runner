# Publishing

This extension is published to the Visual Studio Marketplace and Open VSX.

## Prerequisites

- A Marketplace publisher account (`vsce create-publisher <id>`).
- A personal access token with Marketplace publish scope.
- The `@vscode/vsce` CLI (already a devDependency).

## Versioning

Bump the `version` field in `package.json` and add an entry to `CHANGELOG.md`.

## Package

```bash
npm run package
```

This produces `go-target-launcher-<version>.vsix`.

## Publish

```bash
npx vsce login <publisher-id>
npx vsce publish
```

For Open VSX:

```bash
npx ovsx publish
```

> The `repository` field in `package.json` must point to a public repository before publishing.
