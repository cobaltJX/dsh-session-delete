[README.md](https://github.com/user-attachments/files/34537873/README.md)
# dsh-session-delete

Adds a **Delete conversation** action to every conversation in the DeepSeek Harness sidebar, next to the built-in Archive action, and permanently removes that conversation from this machine.

## What it does

- Right-click a conversation (or open its `…` menu) and choose **删除对话 / Delete conversation**.
- A confirmation dialog names the conversation and explains that the action cannot be undone.
- On confirm the Host, in order:
  1. archives the conversation with `stopActivity` (stops a running turn, jobs, subagents, and reminders) so the row leaves the sidebar immediately;
  2. deletes the conversation's stored session log directory and its derived projection cache, together with the transcripts of its subagent descendants;
  3. detaches the id from every workspace record so the row does not reappear;
  4. emits the Host-to-Client `api-session/removed` notification, so every connected page drops the conversation from its in-memory session list instead of waiting for a reload;
  5. clears the archive and pin entries, including one the user had set before deleting, so no ghost row survives in the Archived list.
- The success toast reads **对话已删除 / Conversation deleted**.

Deleting a row whose log is already gone (for example, one deleted by an earlier
version of this plugin) repairs the leftovers instead of failing: it detaches,
unarchives, unpins, and notifies Clients, then reports success.

Each deletion appends one line to `$DSH_HOME/session-delete.log` so a failed
attempt can be diagnosed after the fact.

Ordinary forks are separate conversations and are not touched. Shared attachment blobs are content-addressed and stay, because other conversations may reference them.

## Install

From the workspace checkout:

```text
plugin_manager install_bundle  target=<absolute path to this directory>
```

The bundle patch inserts one Host row (`session-delete`); the browser half is
declared through `dsh.client` and loads with the page. Reload the Harness page
once after installing so the new browser module is fetched.

## Remove

```text
plugin_manager remove_bundle  target=dsh-session-delete
```

## Notes and limits

- Deleting is permanent: there is no trash, and the session log is removed rather than archived.
- The action is user-only. It is deliberately not exposed as a model tool, so an agent can never delete conversation history on its own.
- The route is served from the Harness Web server and passes the Carrier's own Host/Origin and browser-session checks; a request without the page's authorization cookie receives 401.
- Conversation deletion becomes a first-class Harness API only if a future version ships one; this bundle resolves the operation through the workspace registry entities that the shipped version exposes.
