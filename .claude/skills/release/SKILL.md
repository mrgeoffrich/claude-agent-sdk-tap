---
name: release
description: Bump the npm version, push to GitHub, and create a GitHub release with auto-generated notes. Use this whenever the user wants to publish a new version, cut a release, or bump the version number.
arguments:
  - name: bump
    description: "Version bump type: patch, minor, or major (optional — will ask if not provided)"
    required: false
---

# Release

You are performing an npm + GitHub release. Follow these steps exactly.

## Step 1: Determine bump type

The user may have provided the bump type as an argument: `$ARGUMENTS`

- If the argument is "patch", "minor", or "major", use it directly.
- If the argument is empty or not one of those three values, ask the user:
  "What kind of version bump? (patch / minor / major)"
  Wait for their answer before continuing.

## Step 2: Check the working tree is clean

Run `git status --porcelain`. If there are uncommitted changes, warn the user and ask if they want to continue. Uncommitted changes will be included in the version commit.

## Step 3: Bump the version

Run:
```
npm version <bump_type>
```

This updates package.json, creates a git commit, and tags it (e.g. `v0.1.1`).

Capture the new version number from the output (it prints the new version like `v0.1.1`).

## Step 4: Push the commit and tag

Run:
```
git push && git push --tags
```

## Step 5: Create the GitHub release

Run:
```
gh release create <tag> --generate-notes
```

Where `<tag>` is the version tag from step 3 (e.g. `v0.1.1`).

Capture the release URL from the output.

## Step 6: Wait for publish workflow and verify

1. Run `gh run list --workflow=publish.yml --limit 1` to find the publish run triggered by the release.
2. If the run is still in progress, wait for it: `gh run watch <run_id>`.
3. Once the run completes, verify the version is live on npm:
   ```
   npm view @mrgeoffrich/claude-agent-sdk-tap version
   ```
4. If the npm version matches the new release, confirm success. If the workflow failed, show the user the run URL so they can investigate.

## Step 7: Report back

Tell the user:
- The new version number
- The GitHub release URL
- Whether the npm publish succeeded (and the verified npm version)
