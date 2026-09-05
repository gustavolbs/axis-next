# Contexts and provider access

## The model

An Axis account has one Personal context and may have multiple Company contexts. A context is the
privacy, policy, memory, and product-data boundary.

```text
Axis account
├── Personal
│   ├── Codex Personal
│   ├── Claude Personal (OAuth)
│   ├── Claude Personal (API key)
│   └── OpenAI Personal (API key)
├── Company A
│   ├── Claude Enterprise (owned by Company A)
│   └── Claude Personal (granted from Personal)
└── Company B
    ├── Codex Enterprise (owned by Company B)
    └── Codex Personal (granted from Personal)
```

Every executable entry in this example is represented by a T3 provider instance. Axis does not wrap
it in another provider type. If a current T3 driver cannot configure an account type, the solution is
a generic driver or driver extension, not an Axis provider runtime. Axis records which context owns
an instance and which other context, if any, may select it.

This distinction supports a user with personal projects and multiple jobs: a Company can use an
employer-provided subscription, a personal subscription, or both. The credential source does not
decide where the work belongs.

## Four separate concerns

Keep these concepts independent:

1. **Context** — Personal or one Company; owns product data and supplies the isolation boundary.
2. **Provider instance** — a T3-configured account/runtime identity such as Claude Enterprise or
   Codex Personal.
3. **Provider access grant** — lets one target context select a provider instance owned by Personal.
4. **Capability grant** — optionally makes selected personal MCPs, skills, instructions, or
   preferences available with that provider inside the target context.

A provider access grant is not a data-sharing grant. A capability grant is not a provider
credential. Keeping them separate prevents “use my Codex subscription” from silently becoming
“expose all of Personal to this Company.”

A future Profile may make sets of capabilities and preferences easier to manage, but it should
compile to these explicit bindings. It must not become a provider, context, session store, or second
permission system.

## Isolation invariants

- Personal work cannot read Company Projects, Threads, messages, memory, connector results, or Work
  Hub records.
- Company A cannot discover or read Company B, and Company B cannot discover or read Company A.
- A Company sees only its owned provider instances and the personal instances explicitly granted to
  it. Company-owned instances are not reusable by Personal or another Company by default.
- A T3 Thread and provider session belong to the context where the work started, even when the
  selected provider instance is owned by Personal.
- Continuing a provider conversation across context boundaries is prohibited. Reusing an account
  does not reuse a Thread, session, prompt history, checkpoint, or memory.
- Queries, caches, indexes, notifications, search, and derived records include `contextId` in their
  key. Filtering only in the UI is not isolation.
- Company-specific MCPs, skills, instructions, preferences, and memory never follow a shared
  personal provider into another context.
- Cross-context joins exist only in explicitly user-owned aggregate experiences such as Work Hub.
  Those joins label every item by source and do not feed one Company's data into another Company's
  agent context.

Account-level settings may show that a grant exists and the name of its target so the user can
revoke it. That administrative visibility does not expose the target Company's work data inside
Personal.

## Effective provider binding

When a Company selects a provider, Axis resolves an effective binding for that context:

```text
T3 provider instance
+ target Company policy
+ Company-owned capabilities
+ explicitly granted portable Personal capabilities
= effective binding for one T3 Thread/session
```

The provider instance still owns credentials, executable configuration, account identity, and model
availability. The target context owns the Thread, Project association, memory, and resulting work
records. Provider-specific materialization of the effective capability set belongs at the existing
T3 driver/adapter boundary.

Current provider CLIs can load ambient MCPs, skills, instructions, or session state from their home
or config directory. The eventual implementation must prevent those ambient files from bypassing
the effective binding. Depending on the driver, that may require an isolated runtime home or a
driver-supported scoped configuration. It must not be approximated with prompt instructions.

## Personal capabilities inside a Company

Users may explicitly grant portable personal capabilities to a Company. Examples include a general
code-review skill, a personal editor preference, or an MCP that the user is authorized to use for
that job.

Capabilities need ownership and portability metadata:

- owner context;
- allowed target context IDs, or no targets;
- capability kind and provider compatibility;
- required secrets, retained in the environment's secret store;
- data-access description and revocation state; and
- whether Company policy permits it.

Granting is directional and individually revocable. Revocation prevents new sessions from receiving
the capability and removes it from resumable sessions when the provider can do so safely. It does
not rewrite T3 history.

## Management surface

Axis must provide a first-class management surface at **Settings → Axis → Agent capabilities**. It
cannot require users to edit provider files by hand as the only workflow.

The surface manages four capability kinds:

- **MCPs** — add, configure, test, enable, disable, remove, and inspect connection/permission state;
- **Skills** — install or create, inspect source and compatibility, enable, disable, update, and
  remove;
- **Instructions** — edit the instruction sets applied to an effective provider binding; and
- **Preferences** — edit reusable agent/model/tool preferences that are genuinely portable.

Users can view the catalog by owner context or by provider instance. Every entry shows its owner,
scope, compatible providers, required secrets, enabled state, grants, and health or load errors. The
same surface grants or revokes a personal capability for a specific Company and previews the
effective capability set before a new Thread starts.

Provider credentials, executable paths, account login, and raw environment variables remain under
T3 provider-instance settings. Axis capability settings reference those instances and use T3's
secret store; they do not copy credentials into an Axis database. Driver-specific writes to native
MCP or skill configuration happen through the provider adapter and must be reversible. A capability
is not shown as active until the target provider confirms it loaded successfully.

Web, desktop, and mobile must be able to inspect this state through the same RPC contracts. Mutating
controls may initially be limited by platform capability, but a remote client must never present a
different effective capability set from the server that will run the provider.

## Policy and disclosure

Using a personal provider for Company work may send Company prompts or files to an account and data
processor not managed by that Company. Axis must make that boundary visible and allow Company policy
to disable personal instances entirely or restrict which models and capabilities may be used.

The UI should identify both dimensions without inventing a new provider abstraction, for example:

```text
Codex Personal · from Personal
Claude Enterprise · managed by Company A
```

The selection is persisted as the real T3 `ProviderInstanceId`; Axis metadata records the context,
owner, and grant used for authorization and audit.

## Workspaces and T3 Projects

Every Axis Workspace belongs to exactly one context. It references one or more T3 Projects using
`(environmentId, projectId)`. Threads inherit the Workspace's context through that association and
Axis stores Thread metadata with `(contextId, environmentId, threadId)`.

Moving a Project or Thread between contexts is not a relabel. It changes an isolation boundary and
therefore requires an explicit migration that checks provider bindings, capabilities, memory,
connectors, and retained derived data. The first implementation should prefer creating the correct
association at the start rather than supporting moves prematurely.

This document defines the model only. Contexts, grants, Profiles, and capability materialization are
not implemented by the architecture-foundation change.
