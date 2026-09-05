# Axis Legacy migration

Axis Legacy is a source of validated product behavior, not an architecture to reproduce. Migration
decisions are made capability by capability after comparing the legacy implementation with current
T3 contracts and code.

## Decision labels

Every legacy capability receives exactly one primary disposition:

| Label             | Use when                                                                                                                        | Result                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `KEEP`            | The behavior is Axis-specific, valuable, and already fits the new ownership boundary with little or no infrastructure coupling. | Preserve the behavior; move or adapt the smallest necessary implementation into an Axis namespace.                 |
| `PORT`            | The product behavior is valuable, but its implementation can be cleanly rebuilt on existing T3 primitives.                      | Reimplement the behavior against T3 contracts/services; do not copy legacy infrastructure.                         |
| `MERGE`           | Legacy and T3 each provide part of a coherent capability, and combining them improves the generic boundary.                     | Contribute the generic primitive to T3/core when appropriate, then keep Axis policy outside it.                    |
| `REPLACE_WITH_T3` | T3 already owns the same responsibility or now provides an acceptable user experience.                                          | Adopt T3 and migrate only data or user-facing affordances that remain necessary. Delete the competing legacy path. |
| `DELETE`          | The capability is obsolete, unused, unsafe, duplicative, or not worth its long-term cost.                                       | Remove it from the Axis roadmap and migrate no code. Document user/data consequences if any.                       |

`KEEP` does not mean copying a directory unchanged. `MERGE` does not mean combining two runtimes.
`REPLACE_WITH_T3` is the default for infrastructure.

## Required evaluation

For each legacy capability, record:

- the user problem and evidence that the behavior is still needed;
- the current legacy source of truth and stored data;
- the corresponding T3 owner, contract, service, projection, or client primitive;
- its disposition and rationale;
- data migration and rollback requirements;
- affected web, desktop, mobile, provider, and connection modes;
- security, permission, remote-execution, and offline implications; and
- the deletion condition for the legacy path.

Decide from behavior and data, not from similar class or folder names. A legacy `Thread` and a T3
Thread are not candidates for `MERGE`; the T3 Thread remains canonical and only missing Axis
metadata may be ported.

## Default mapping by responsibility

The following defaults apply unless code-level investigation proves otherwise:

| Legacy responsibility                                                           | Default                           | Target                                                                   |
| ------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| Provider processes, accounts, sessions, model catalogs, auth, API-key injection | `REPLACE_WITH_T3`                 | Provider drivers and instances                                           |
| Terminal and process execution                                                  | `REPLACE_WITH_T3`                 | T3 terminal/server runtime                                               |
| Filesystem browsing and editing                                                 | `REPLACE_WITH_T3`                 | T3 project/filesystem RPC                                                |
| Git, diffs, worktrees, checkpoints, revert                                      | `REPLACE_WITH_T3`                 | T3 Git and checkpointing                                                 |
| Project, Thread, Turn, approval, and session records                            | `REPLACE_WITH_T3`                 | T3 orchestration events and projections                                  |
| WebSocket, RPC, pairing, relay/tunnel, remote environment sync                  | `REPLACE_WITH_T3`                 | T3 contracts and client connection runtime                               |
| Personal, Company, and Workspace organization                                   | `PORT`                            | Context-scoped Axis metadata referencing environment-scoped T3 Projects  |
| Provider grouping, access, and shared agent capabilities                        | `PORT`                            | Directional grants over T3 provider instance IDs                         |
| Shared Memory                                                                   | `PORT`                            | Axis-derived memory with provenance to T3 history                        |
| Work Hub                                                                        | `PORT`                            | Context-owned MCP data projected into four aggregate views               |
| Separate Cowork/Chat conversation engines                                       | `DELETE` or `REPLACE_WITH_T3`     | Two presentations over the same T3 Thread/Turn lifecycle                 |
| Calendar, tasks, and notifications                                              | `KEEP` or `PORT` after validation | Axis capabilities integrated through existing T3 identities and commands |
| Duplicate orchestration or cross-provider runtime                               | `DELETE` or `REPLACE_WITH_T3`     | T3 orchestration; add only narrow higher-level coordination              |

These are category defaults, not implementation approval. Companies, Workspaces, Profiles, Shared
Memory, Work Hub, Calendar, tasks, notifications, and cross-agent coordination remain unimplemented
until separately designed.

## Migration rules

1. Inventory user-visible behavior and durable data before reading the old architecture as a plan.
2. Map every retained behavior to a canonical T3 or Axis owner.
3. Prefer import adapters and one-time transforms over permanent compatibility layers.
4. Preserve stable provenance from migrated Axis metadata to environment-scoped T3 IDs.
5. Never import credentials into a new Axis store. Configure provider instances through T3 and use
   its secret handling.
6. Never copy legacy provider sessions or histories unless the relevant T3 adapter explicitly
   supports their continuation format.
7. Make migrations idempotent, versioned, observable, and safe to retry. Validate counts and
   relationships before marking them complete.
8. Run old and new paths in parallel only when rollback or data validation requires it, with a named
   removal condition and no dual writes beyond that window.
9. Delete replaced infrastructure after migration. A dormant second source of truth still creates
   maintenance and security risk.

## Acceptance criteria

A migrated capability is complete when its user outcome works through T3-owned infrastructure,
Axis owns only the product-specific state, remote clients observe the same canonical result, legacy
data has been reconciled or deliberately retired, and the old implementation can be removed without
losing an active source of truth.
