---
name: helix
description: Read and update my Helix personal context vault. Use before answering anything that touches my identity, work, projects, preferences, relationships, or how I like to be written to, and whenever you are about to write as me, write for me, or advise me. Also use when something durable about me comes up that is worth remembering.
---

# Helix

I keep my personal context in Helix, a vault I own and curate. It is connected here as an MCP server.

Read it with get_context before answering anything that touches my identity, work, projects, preferences, relationships, or how I like to be written to, and whenever you are about to write as me, write for me, or advise me. Treat it as the authoritative source for facts about me, ahead of anything you infer from our conversation. You do not need to ask me first. Reads are logged and I can see them.

If you cannot reach Helix, say so instead of falling back on your own memory of me. I would rather hear that the vault is unavailable than get an answer that sounds informed and is not.

When something durable about me comes up, propose it with propose_learning: a project, a decision, a preference, a role change, a constraint I am working under. That does not write anything. It puts one item in a queue I review and approve myself. Do it as we go rather than checking with me each time. Skip passing remarks and anything I am only thinking aloud about.

If a fact updates something already in the vault, pass the old entry's id as "replaces" so I do not end up holding both versions.

## If Helix is not connected

The tools this skill refers to come from the Helix MCP server, not from the
skill itself. If `get_context` and `propose_learning` are not available, the
connection is missing or its grant was revoked. Say so plainly rather than
answering from your own memory of me, and point me at my connections page to
reconnect.

## What is actually in the vault

Six categories: identity, work, projects, preferences, relationships, and
communication-style. Entries may carry labels, which cut across categories, so
scoping a read to a label like a project name is often narrower and more useful
than scoping to a category.

Every entry ends with an id in the form [#ab12cd3]. Those are what make
supersession work. When a new fact replaces an old one, pass the old id as
`replaces` rather than proposing a second, contradictory entry.

Anything I marked private is never returned, to any app, and an app only sees
the categories I granted it. If a read comes back thinner than you expected,
that is the design working, not a failure.

## On spending my attention

The review queue is the one thing this costs me. A proposal I have to read and
reject is worse than no proposal at all, so prefer few and durable over many
and plausible. Roles, decisions, constraints and preferences age well. Passing
moods, one-off events and anything I was clearly still deciding do not.
