---
name: omp-fork-update
description: Update Mr.Sklk's oh-my-pi fork from the latest stable upstream release, preserve fork patches, verify and push the merge, publish the patched macOS Apple Silicon binary, update shaheermirzacs/homebrew-tap, and upgrade and verify the Homebrew installation. Use for /omp-fork-update or requests to sync, release, or upgrade Mr.Sklk's OMP fork end to end.
---

# Update and release Mr.Sklk's OMP fork

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER and AVOID mean MUST NOT and SHOULD NOT respectively.
</system-conventions>

<critical>
- MUST preserve fork patches, user work, and upstream merge ancestry.
- MUST honor active commit-tool and external-action approval policies.
- NEVER force-push, overwrite published assets, or move published tags.
- NEVER use chezmoi, publish npm packages, or run the upstream release command.
- MUST distinguish source synchronization from binary publication and installation.
</critical>

## Scope and authorization

An execution request covers the complete pipeline below unless Mr.Sklk narrows it. Creating or editing this skill alone authorizes no release, push, or installation. MUST respect any required point-of-risk confirmation. MUST report the exact repository, upstream release, patched tag, and platform before publishing.

Targets:
- Source checkout: `~/dev/oh-my-pi`; fork: `shaheermirzacs/oh-my-pi`, branch `main`.
- Upstream: `can1357/oh-my-pi`; select its latest stable release, not unreleased `main`.
- Tap: `shaheermirzacs/homebrew-tap`, file `Formula/omp.rb`.
- Formula: `shaheermirzacs/tap/omp`.
- Artifact: `omp-darwin-arm64`; Apple Silicon macOS only, ad-hoc signed, not notarized.

MUST inspect existing state and resume unfinished phases. An already-synced source checkout does not mean the binary, tap, or installation is current.

## 1. Inspect and select the release

1. MUST read applicable repository instructions and inspect both repositories' remotes, branches, working trees, and staged changes. MUST confirm the targets above before writing.
2. MUST fetch `origin`, `upstream`, and upstream tags without overwriting tags. MUST fast-forward local `main` from the fork when possible. Divergence or unrelated local work? MUST preserve it; use a clean worktree or ask only when its disposition requires a decision. NEVER stash, reset, or discard it automatically.
3. MUST obtain the current stable upstream tag from GitHub, unless Mr.Sklk supplied a version:
   ```sh
   gh api repos/can1357/oh-my-pi/releases/latest --jq .tag_name
   ```
4. MUST inspect the fork's latest published release, assets, and the tap formula. MUST record the installed version and the exact source commit already shipped.
5. MUST identify the fork-only behavior against its previous upstream release. Known patches currently include Ctrl+O replay of expanded tool output in terminal scrollback and assistant code blocks without literal fence delimiters. MUST derive the current patch inventory from history, not assume these remain the only patches.
6. MUST locate Bun satisfying the checked-in engine requirement, Rust, macOS signing tools, GitHub authentication, and tap write access. Bun missing? MAY use an isolated npm-provided compatible Bun; NEVER replace repository build scripts.

## 2. Merge upstream and preserve differences

1. MUST skip the merge when the selected release is already an ancestor. Otherwise, set `upstream_tag` to the selected fetched tag and run `git merge --no-ff --no-edit "$upstream_tag"`. Git MUST record the clean merge itself, preserving both histories and clean filters. NEVER use `--no-commit`.
2. Conflicts? MUST resolve them semantically: preserve fork behavior while adopting upstream API and layout changes. NEVER choose all of `ours` or `theirs` globally. MUST remove a fork patch only when upstream demonstrably provides the same behavior; otherwise ask about a genuinely incompatible design choice. MUST stage only resolved paths through the approved mechanism and complete the pending merge with `git merge --continue` when permitted by active policy. No approved merge-aware completion path? MUST stop and report the blocker before pushing or publishing.
3. MUST reserve the selective commit helper for ordinary authored changes, not pending merges. NEVER silently squash, handcraft commit objects, bypass commit policy, or replace Git's merge result with a working-tree snapshot.
4. MUST retain the Git-normalized merge result. Windows `*.cmd` fixtures use `text eol=crlf`: repository blobs remain LF even when checked-out files use CRLF. MUST preserve LFS pointers and other clean/smudge filters where configured.
5. MUST establish merge ancestry and the intended fork-only delta before pushing. Unexpected fixture, generated-file, or binary changes MUST be resolved, not dismissed as formatting. NEVER relabel a one-parent snapshot as a merge.

## 3. Build and verify the exact source

MUST read the selected release's build scripts before using these commands; adapt only when their documented interface changed. Run from the source checkout with a compatible Bun on PATH:

```sh
bun install --frozen-lockfile
bun run build:native
CROSS_TARGET=darwin-arm64 bun --cwd=packages/coding-agent run build
```

Current output: `packages/coding-agent/dist/omp-darwin-arm64`. The build script embeds native bindings, generates required assets, resets generated placeholders, and ad-hoc signs macOS output. MUST use it rather than an improvised `bun build --compile` command.

MUST verify:
- Native bindings match the checkout version; stale native warnings invalidate the smoke proof.
- Focused existing tests cover each retained fork patch and conflict resolution. Current test locations include `packages/coding-agent/test/modes/controllers/input-controller-tool-expansion.test.ts`, `packages/coding-agent/test/input-controller-keybindings.test.ts`, and `packages/tui/test/assistant-message-prose-color.test.ts`; MUST locate moved equivalents rather than weakening coverage.
- The compiled artifact, not merely the source CLI, passes `--version`, `--help`, `stats --help`, and `--smoke-test`.
- `codesign --verify --strict` succeeds for the compiled artifact.
- For a model-support update, the compiled artifact completes `models refresh` and lists the requested IDs under the intended provider. For GPT-6.2, inspect `models openai-codex`; availability under `openai` alone proves nothing about Codex OAuth. MUST report missing account access without inventing a fallback or changing providers.

MUST keep the verified artifact tied to the final source commit. Source changed after building? MUST rebuild and repeat affected verification. MUST stop publication on a failing required check; report the failure without hiding it.

## 4. Push and publish the patched binary

1. MUST commit only intentional authored changes through the approved commit mechanism, then push the verified source to the fork's `main`. MUST use an ordinary push; a race requires fetching and reconciling, not forcing.
2. MUST derive the base version from `packages/coding-agent/package.json`. Initial patched tag: `v<version>-patched`. Existing tag and asset match the intended commit and checksum? MUST reuse them and resume the tap phase. Different contents? MUST retain the old release and allocate an unused suffix such as `v<version>-patched.2`.
3. MUST create the new tag at the exact verified source commit and push only that tag. MUST NOT push all local tags.
4. MUST publish the artifact using `gh release create` with `--repo shaheermirzacs/oh-my-pi`, `--verify-tag`, `--latest`, and the explicit patched tag. MUST upload it with the asset name `omp-darwin-arm64`; GitHub CLI's `path#label` changes the label, not the asset name. The current build output already has the correct basename.
5. MUST write factual release notes: upstream version, retained fork behavior, source commit, macOS arm64 scope, ad-hoc signing/notarization status, and checks actually run. MUST NOT auto-generate misleading upstream-only notes.
6. MUST read back the release target and uploaded asset. MUST download that exact published asset into temporary storage, compare its SHA-256 with the tested local artifact, and run its `--version` and `--smoke-test`. A mismatched download blocks the tap update.

## 5. Update and push the Homebrew tap

1. MUST locate the tap using `brew --repo shaheermirzacs/tap`; clone the exact tap repository only when needed. MUST inspect and preserve its local changes and fast-forward from its remote before editing.
2. MUST change only `Formula/omp.rb` fields required for this release: published download URL, upstream package `version`, SHA-256 of the verified published artifact, and `revision` when needed. MUST preserve the architecture, installation, completion, and test behavior.
3. New upstream version? MUST reset/remove an old Homebrew revision. New patched binary at the same upstream version? MUST increment Homebrew `revision`, or Homebrew will still consider the installed package current.
4. MUST run `ruby -c` on the formula and confirm Homebrew parses the intended version, URL, and checksum before pushing.
5. MUST commit through the approved mechanism scoped to the tap repository, then push its actual default branch. NEVER change the upstream project's formula or substitute the official binary for the patched fork artifact.

## 6. Upgrade and verify the installed command

```sh
brew update
brew upgrade shaheermirzacs/tap/omp
brew test shaheermirzacs/tap/omp
```

MUST inspect `brew info --json=v2 shaheermirzacs/tap/omp`, `command -v omp`, the executable's resolved path, and `omp --version`. MUST confirm the shell resolves to the updated Homebrew installation rather than a stale source link or another binary. A same-version patch MUST show the new Homebrew revision even though `omp --version` stays unchanged.

MUST run the installed executable's `--smoke-test`. For model-support updates, MUST refresh and verify the installed executable's intended provider catalog too. `brew reinstall` of an unchanged old formula is not an upgrade.

MUST remove only temporary files created by this run. MUST finish with the upstream version, source commit, release URL, tap commit, installed version/revision, and verification results. MUST explicitly identify any incomplete phase; source pushed alone is not completion.

<critical>
Done = fork updated + tested binary published + tap pushed + installed command verified. NEVER claim an unperformed phase succeeded. NEVER replace published releases or force-push to conceal a failed update.
</critical>
