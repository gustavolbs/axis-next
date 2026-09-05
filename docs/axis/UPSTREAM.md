# Upstream policy

Axis is a long-lived fork of [T3 Code](https://github.com/pingdotgg/t3code). The goal is not to
freeze a copy of T3; it is to keep consuming upstream reliability and product improvements while
maintaining a small, explicit Axis layer.

## Repository model

Use these remotes:

- `origin`: `https://github.com/gustavolbs/axis-next`
- `upstream`: `https://github.com/pingdotgg/t3code`

The Axis `main` branch contains upstream history plus reviewed Axis commits. Do not rewrite its
published history. Record known-good synchronization points with an annotated tag such as
`t3-baseline-YYYY-MM-DD`; the repository already uses this convention.

## Minimize divergence

- Keep upstream names and internal identifiers unless a user-visible Axis requirement needs a
  different label.
- Put Axis-only behavior in the namespaces described in
  [the architecture boundary](./ARCHITECTURE.md#placement-of-axis-specific-code).
- Do not reformat, reorder, rename, or move upstream code in the same change as Axis behavior.
- Prefer adapters, metadata, selectors, projections, and existing service boundaries over forks of
  T3 subsystems.
- Make generic T3 fixes as standalone commits that can be proposed upstream.
- Keep generated files and dependency changes out of a sync unless upstream changed them.
- Never resolve a conflict by blindly taking one side. Re-check the current T3 invariant and the
  Axis ownership decision.

## Recommended synchronization process

Synchronize upstream in a dedicated pull request, separate from Axis feature work:

1. Start from a clean, current Axis `main` and fetch both remotes and tags.
2. Review the upstream range from the latest `t3-baseline-*` tag (or recorded upstream SHA) to
   `upstream/main`. Identify contract, migration, provider, and client-runtime changes before
   merging.
3. Create a branch named `chore/sync-t3-YYYY-MM-DD` from Axis `main`.
4. Merge `upstream/main` into the branch. Do not squash or rebase upstream history; preserving it
   makes later ranges and conflict ancestry understandable.
5. Resolve conflicts by ownership:
   - preserve upstream behavior in T3-owned infrastructure unless Axis has a documented reason to
     diverge;
   - preserve Axis-owned behavior inside Axis namespaces;
   - rewrite boundary conflicts to use the newest upstream extension point instead of retaining an
     obsolete fork.
6. Run focused tests for every resolved conflict and affected package, then the normal CI matrix.
   Exercise web, desktop, mobile, provider, and local/remote paths that the upstream range actually
   affects.
7. In the sync PR, record the previous baseline, imported upstream SHA, material conflicts, and any
   remaining intentional divergence.
8. After the PR merges, create and push the new annotated `t3-baseline-YYYY-MM-DD` tag at the
   resulting Axis commit.

If a sync is too large to review safely, reduce the interval between syncs. Do not cherry-pick a
random subset of tightly coupled upstream orchestration, schema, migration, or connection changes.
Security and data-integrity fixes may be isolated when urgency requires it, but the follow-up sync
must reconcile the complete history.

## Changes that touch both products

When an Axis feature exposes a missing generic primitive in T3:

1. isolate the generic T3 change from Axis policy;
2. test it as a T3 behavior;
3. submit it upstream when practical; and
4. keep the Axis layer dependent on that narrow primitive.

If Axis cannot wait for upstream acceptance, retain the generic change as a small standalone commit
in the fork. When upstream lands an equivalent, replace the forked implementation during the next
sync rather than maintaining both.

## Conflict budget

Repeated conflicts are architectural feedback. If the same upstream file conflicts across syncs,
move Axis policy outward toward an Axis namespace or propose a stable extension point upstream. A
growing list of permanently modified core files requires an explicit architecture review; it is not
normal maintenance overhead.
