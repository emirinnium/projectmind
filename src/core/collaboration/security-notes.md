# Collaboration Security Notes — Information Leak Prevention (Question 5)

## Sanitization of `pending_intents` by git branch

Private branch changes must not leak to other agents via the collaborative intent broadcast system.

Filtering rule based on `git branch --show-current`:

- **Public branches** (`main`, `master`, `develop`): intents broadcast to **all agents**.
- **Private branches** (`feature/*`, `wip/*`, and any other non-public branch): intents are **restricted to the same agent** or **excluded entirely** from `pending_intents` broadcasts to other agents.

This prevents information leak from private work (e.g., unfinished feature branches, experimental WIP) into the shared collaborative context.

Implementation: before inserting into `pending_intents`, check the current branch. If private, either skip the DB insert or set `agent_id` filtering so only the originating agent can see it.
