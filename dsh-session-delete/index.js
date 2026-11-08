/**
 * Host half of the session-delete bundle.
 *
 * The Harness exposes archive but no session-deletion API, so this plugin owns
 * the operation end to end: an authenticated same-origin HTTP route the Web UI
 * calls, and a delete routine that (1) stops the conversation's running work
 * through the workspace registry's archive path, (2) removes the stored session
 * log directories plus their derived projection caches, and (3) detaches the
 * ids from every workspace record so the row leaves the sidebar immediately.
 *
 * Nothing here touches the model-facing surface: deletion stays an explicit
 * user action from the conversation's menu.
 */
import { appendFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact route the browser half posts to. */
const ROUTE_PATH = '/session-delete';
/** Session ids are plugin-visible identifiers; refuse anything that could escape a path segment. */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9._-]{1,180}$/;
/** The request body is one id; anything larger is not this endpoint's caller. */
const MAX_BODY_BYTES = 4096;

/** Services this plugin needs; a composition without them keeps it inactive. */
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry'];

/**
 * Register the deletion route for the lifetime of the plugin fiber.
 * @param ctx - the owning Host context.
 */
export function apply(ctx) {
  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (request, response) => handleRequest(ctx, request, response),
  });
  ctx.effect(() => disposeRoute, 'session-delete: http route');
  // Heal rows left behind by a deletion whose record cleanup failed: an archived
  // id that names no stored and no live Session is a sidebar-only leftover.
  void sweepLeftovers(ctx);
}

/**
 * Drop archive/pin entries that name no stored and no live Session, and tell
 * connected Clients those rows are gone. Runs once per plugin activation.
 * @param ctx - the Host context.
 */
async function sweepLeftovers(ctx) {
  try {
    const registry = ctx.workspaceRegistry;
    const persistence = ctx.sessionPersistence;
    const sessions = ctx.get('sessions');
    const candidates = new Set([
      ...(Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : []),
      ...(Array.isArray(registry.pinnedSessionIds) ? registry.pinnedSessionIds : []),
    ]);
    for (const id of candidates) {
      try {
        if (sessions?.get(id) !== undefined) continue;
        if ((await persistence.stat(id)) !== undefined) continue;
        notifySessionRemoved(ctx, id);
        await unarchiveQuietly(registry, id);
        await unpinQuietly(registry, id);
        await logDeletion(ctx, { sessionId: String(id), ok: true, leftover: true });
      } catch {
        /* one unreadable entry must not stop the sweep */
      }
    }
    await logDeletion(ctx, { event: 'activated', candidates: candidates.size });
  } catch {
    /* the sweep is best-effort and must never fail plugin activation */
  }
}

/**
 * Answer the route with JSON.
 * @param response - the HTTP response to own.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/**
 * A failure the browser half can map to localized copy.
 * @param code - stable machine code.
 * @param message - diagnostic detail.
 * @returns the tagged error.
 */
function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** @param error - unknown thrown value. @returns its message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a JSON request body without letting a caller stream past the cap.
 * @param request - the incoming request.
 * @returns the parsed value.
 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw failure('INVALID_BODY', 'request body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw failure('INVALID_BODY', 'request body is not valid JSON');
  }
}

/**
 * Trust verdict for a request.
 *
 * The route is registered on the bare Web server, outside the `/api` fence, so
 * it applies the Carrier's own trust check when that service is present and a
 * loopback/same-origin check otherwise. Deletion is destructive, so an
 * unverifiable caller is refused rather than silently ignored.
 * @param ctx - the Host context reading the optional connection service.
 * @param request - the incoming request.
 * @returns 401, 403, or undefined when the caller may proceed.
 */
function rejectUntrusted(request, ctx) {
  const connection = ctx.get('connection');
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    try {
      return connection.requestRejection({ headers: request.headers });
    } catch {
      return 403;
    }
  }
  return isLoopbackRequest(request) ? undefined : 403;
}

/** @param host - a `Host` header. @returns whether it names a loopback authority. */
function isLoopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false;
  const lower = host.toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * Fallback trust check when no connection service is composed: loopback Host,
 * no cross-site fetch metadata, and a same-authority Origin when one is sent.
 * @param request - the incoming request.
 * @returns whether the request may proceed.
 */
function isLoopbackRequest(request) {
  const host = request.headers.host;
  if (host !== undefined && !isLoopbackAuthority(host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    if (url.host === host) return true;
    if (url.port === '' && typeof host === 'string' && isLoopbackAuthority(host)) {
      const hostName = host.toLowerCase().startsWith('[')
        ? host.slice(0, host.indexOf(']') + 1)
        : host.split(':')[0];
      return url.hostname === hostName;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Serve one deletion request.
 * @param ctx - the Host context owning the services.
 * @param request - the incoming request.
 * @param response - the response to own.
 */
async function handleRequest(ctx, request, response) {
  const rejection = rejectUntrusted(request, ctx);
  if (rejection !== undefined) {
    sendJson(response, rejection, {
      ok: false,
      error: rejection === 401
        ? { code: 'UNAUTHORIZED', message: 'Open the current Harness page to authorize this request.' }
        : { code: 'FORBIDDEN', message: 'This request did not come from the local Harness page.' },
    });
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' });
    response.end();
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: { code: error.code ?? 'INVALID_BODY', message: messageOf(error) },
    });
    return;
  }

  const sessionId = payload?.sessionId;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    sendJson(response, 400, {
      ok: false,
      error: { code: 'INVALID_SESSION_ID', message: 'The request did not name a valid conversation id.' },
    });
    return;
  }

  try {
    const result = await deleteConversation(ctx, sessionId);
    sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    const code = error?.code ?? 'DELETE_FAILED';
    sendJson(response, code === 'SESSION_NOT_FOUND' ? 404 : 500, {
      ok: false,
      error: { code, message: messageOf(error) },
    });
  }
}

/**
 * Permanently remove one conversation and its subagent descendants.
 *
 * Three stores hold a conversation: the session log on disk, the workspace
 * records that group it, and every connected Client's session list. All three
 * are cleared here, in an order that never lets the row flash back: stop work
 * and hide it, remove the files, detach it from the grouping, tell the Clients
 * it is gone, and only then drop the sidebar-only archive/pin entries.
 *
 * @param ctx - the Host context owning persistence, sessions, and workspaces.
 * @param requestedId - the conversation the user chose.
 * @returns what was removed.
 */
async function deleteConversation(ctx, requestedId) {
  const persistence = ctx.sessionPersistence;
  const registry = ctx.workspaceRegistry;
  const sessions = ctx.get('sessions');

  const snapshots = await persistence.list();
  const byId = new Map();
  for (const snapshot of snapshots) byId.set(String(snapshot.header.id), snapshot);

  let root = byId.get(requestedId);
  if (root === undefined) root = await persistence.stat(requestedId);
  if (root === undefined && sessions?.get(requestedId) === undefined) {
    // The log is already gone but the sidebar may still hold the row: clear
    // those leftovers instead of reporting a failure.
    const cleaned = await forgetLeftover(ctx, requestedId);
    if (!cleaned) throw failure('SESSION_NOT_FOUND', `session '${requestedId}' does not exist`);
    return { deletedSessionIds: [requestedId], removedDirectories: 0, missing: true };
  }

  // Subagent transcripts belong to the conversation that spawned them; ordinary
  // forks are separate conversations and stay untouched.
  const ids = collectSubagentIds(requestedId, snapshots);

  // Archiving first stops a running turn, jobs, subagents, and reminders, and
  // hides the row while the files are removed.
  const wasArchived = registry.archivedSessionIds.includes(requestedId);
  const archivedHere = await archiveQuietly(registry, requestedId, wasArchived);

  let removedDirectories = 0;
  try {
    for (const id of ids) {
      const snapshot = byId.get(id) ?? (id === requestedId ? root : undefined) ?? (await persistence.stat(id));
      removedDirectories += await removeStoredSession(ctx, snapshot, id);
    }
  } catch (error) {
    if (archivedHere) await unarchiveQuietly(registry, requestedId);
    await logDeletion(ctx, { sessionId: requestedId, ok: false, stage: 'files', error: messageOf(error) });
    throw failure('DELETE_FAILED', `could not remove the stored conversation: ${messageOf(error)}`);
  }

  // Grouping records go first: the row must stop being a member of any project.
  const detachFailures = await detachEverywhere(registry, ids);

  // The browser keeps its own session list in memory. `api-session/removed` is
  // the Host-to-Client notification for a Session that left the store; without
  // it the row survives until the page reloads, even with no log on disk left.
  for (const id of ids) notifySessionRemoved(ctx, id);

  // Archive and pin are sidebar-only memberships and are cleared whether this
  // call added them or the user had archived the conversation earlier. Leaving
  // them behind is what kept a deleted conversation visible in the Archived
  // list.
  for (const id of ids) {
    await unarchiveQuietly(registry, id);
    await unpinQuietly(registry, id);
  }

  await logDeletion(ctx, {
    sessionId: requestedId,
    ok: detachFailures.length === 0,
    deletedSessionIds: ids,
    removedDirectories,
    ...(detachFailures.length === 0 ? {} : { error: messageOf(detachFailures[0]) }),
  });

  if (detachFailures.length > 0) {
    throw failure(
      'CLEANUP_FAILED',
      `the stored history was removed and its row dropped, but one grouping record could not be rewritten (${messageOf(detachFailures[0])}). It disappears from the sidebar now and is pruned on the next startup.`,
    );
  }

  return { deletedSessionIds: ids, removedDirectories };
}

/**
 * Clear sidebar leftovers for a conversation whose log is already gone.
 *
 * This is the repair path for a row that outlived its files — exactly the state
 * a deletion could leave behind before this plugin learned to notify Clients.
 * @param ctx - the Host context.
 * @param id - the conversation to forget.
 * @returns whether any leftover record named it.
 */
async function forgetLeftover(ctx, id) {
  const registry = ctx.workspaceRegistry;
  let workspaces = [];
  try {
    workspaces = registry.list();
  } catch {
    return false;
  }
  const archived = Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(id);
  const pinned = Array.isArray(registry.pinnedSessionIds) && registry.pinnedSessionIds.includes(id);
  const grouped = workspaces.some((workspace) => {
    try {
      return workspace.sessionIds.includes(id);
    } catch {
      return false;
    }
  });
  if (!archived && !pinned && !grouped) return false;

  const detachFailures = await detachEverywhere(registry, [id]);
  notifySessionRemoved(ctx, id);
  await unarchiveQuietly(registry, id);
  await unpinQuietly(registry, id);
  await logDeletion(ctx, {
    sessionId: id,
    ok: detachFailures.length === 0,
    leftover: true,
    ...(detachFailures.length === 0 ? {} : { error: messageOf(detachFailures[0]) }),
  });
  if (detachFailures.length > 0) {
    throw failure('CLEANUP_FAILED', `the row could not be cleared: ${messageOf(detachFailures[0])}`);
  }
  return true;
}

/**
 * Append one compact deletion record next to the profile's data, so a failed
 * deletion can be diagnosed after the fact instead of from a browser console.
 * @param ctx - the Host context, used only for its logger on write failure.
 * @param record - what was attempted and how it ended.
 */
async function logDeletion(ctx, record) {
  const home = dshHomeOf(ctx);
  if (home === undefined) return;
  try {
    await appendFile(
      join(home, 'session-delete.log'),
      `${new Date().toISOString()} ${JSON.stringify(record)}\n`,
    );
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: could not write the deletion log: ${messageOf(error)}`);
  }
}

/**
 * Tell connected Clients that a Session is no longer part of the catalog.
 * The event is the one the API Session Controller emits on disposal; a Session
 * removed by this plugin is gone in exactly the same sense.
 * @param ctx - the Host context dispatching the forwarded event.
 * @param id - removed session id.
 */
function notifySessionRemoved(ctx, id) {
  const emitter = ctx.root ?? ctx;
  if (typeof emitter.emit !== 'function') return;
  try {
    emitter.emit('api-session/removed', id);
  } catch {
    /* the row still disappears on the next page load */
  }
}

/**
 * Remove every deleted id from every workspace record without letting one
 * failing record abort the rest.
 * @param registry - the workspace registry service.
 * @param ids - deleted session ids.
 * @returns the failures encountered.
 */
async function detachEverywhere(registry, ids) {
  const failures = [];
  let workspaces;
  try {
    workspaces = registry.list();
  } catch (error) {
    return [error];
  }
  for (const workspace of workspaces) {
    for (const id of ids) {
      try {
        if (typeof workspace.detachSession === 'function') await workspace.detachSession(id);
        else await detachByRecord(registry, workspace, id);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  return failures;
}

/**
 * Fallback detach for a registry whose entity does not expose `detachSession`:
 * rewrite the record through the registry's own domain table so the change is
 * durable and reaches the workspace feed.
 * @param registry - the workspace registry service.
 * @param workspace - the workspace entity to edit.
 * @param id - session id to remove.
 */
async function detachByRecord(registry, workspace, id) {
  const table = registry.table;
  if (table === undefined || typeof table.update !== 'function' || typeof table.get !== 'function') {
    throw new Error('the workspace registry exposes no way to detach a session');
  }
  const record = table.get(workspace.id);
  if (record === undefined || !record.sessionIds.includes(id)) return;
  await table.update(workspace.id, (current) => ({
    ...current,
    sessionIds: current.sessionIds.filter((value) => value !== id),
    updatedAt: new Date().toISOString(),
  }));
  if (typeof registry.rebuildEntities === 'function') registry.rebuildEntities();
}

/**
 * Archive a conversation, treating an already-vanished log as success.
 * @param registry - the workspace registry service.
 * @param id - conversation to archive.
 * @param wasArchived - whether the archive set already holds the id.
 * @returns whether this call added the archive entry.
 */
async function archiveQuietly(registry, id, wasArchived) {
  if (wasArchived) return false;
  try {
    await registry.archiveSession(id, { stopActivity: true });
    return true;
  } catch (error) {
    if (error?.name === 'WorkspaceUnknownSessionError') return false;
    throw error;
  }
}

/**
 * Best-effort archive removal; an already-cleared id is not an error.
 * @param registry - the workspace registry service.
 * @param id - conversation to unarchive.
 */
async function unarchiveQuietly(registry, id) {
  try {
    if (typeof registry.unarchiveSession === 'function') await registry.unarchiveSession(id);
  } catch {
    /* a surviving archive entry hides nothing once the Client row is gone */
  }
}

/**
 * Best-effort pin removal for a deleted conversation.
 * @param registry - the workspace registry service.
 * @param id - conversation to unpin.
 */
async function unpinQuietly(registry, id) {
  try {
    if (typeof registry.unpinSession === 'function') await registry.unpinSession(id);
  } catch {
    /* a surviving pin entry hides nothing once the Client row is gone */
  }
}

/**
 * Every stored subagent transcript below the chosen conversation.
 * @param rootId - the chosen conversation.
 * @param snapshots - one persistence listing.
 * @returns the root followed by matching descendants.
 */
function collectSubagentIds(rootId, snapshots) {
  const ids = [rootId];
  const seen = new Set(ids);
  for (let index = 0; index < ids.length; index += 1) {
    const parentId = ids[index];
    for (const snapshot of snapshots) {
      const childId = String(snapshot.header.id);
      if (seen.has(childId)) continue;
      if (snapshot.header.origin !== 'subagent') continue;
      if (String(snapshot.header.parentSession) !== parentId) continue;
      seen.add(childId);
      ids.push(childId);
    }
  }
  return ids;
}

/**
 * Remove one stored session's directory and derived cache.
 *
 * The directory is derived from the backend's own reported location and must be
 * named exactly after the session id, so a miscalculated path can never delete a
 * project directory or another session.
 * @param snapshot - the persistence snapshot, when the session is stored.
 * @param id - the session whose artifacts are removed.
 * @returns 1 when a log directory was removed, otherwise 0.
 */
async function removeStoredSession(ctx, snapshot, id) {
  let removed = 0;
  const location = snapshot?.location;
  const logPath = typeof location?.path === 'string' ? location.path : undefined;
  if (logPath !== undefined && logPath !== '') {
    const directory = dirname(logPath);
    if (basename(directory) !== id) {
      throw new Error(`refusing to delete '${directory}': it is not the directory of session '${id}'`);
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    removed = 1;
  }
  await removeProjectionCache(ctx, id);
  return removed;
}

/**
 * Drop the derived projection checkpoint for a session.
 *
 * The cache is a storage domain, so removing the row through the cache
 * service's own table keeps memory and disk coherent. A composition without
 * that service falls back to the JSON backend's per-session document.
 * @param ctx - the Host context owning the cache service.
 * @param id - the session whose cache entry is removed.
 */
async function removeProjectionCache(ctx, id) {
  const table = ctx.get('sessionProjectionCache')?.table;
  if (table !== undefined && typeof table.delete === 'function') {
    try {
      await table.delete(id);
      return;
    } catch {
      /* fall through to the file form */
    }
  }
  const home = dshHomeOf(ctx);
  if (home === undefined) return;
  await rm(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), { force: true });
}

/**
 * Resolve the Harness home directory this process belongs to.
 *
 * The Host is started by the Desktop shell, which does not necessarily export
 * `DSH_HOME`, so the profile URL the Loader installed on the root context is
 * the primary source: `<home>/profiles/<name>/`.
 * @param ctx - any Host context.
 * @returns the absolute home directory, when it can be determined.
 */
function dshHomeOf(ctx) {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env !== '') return env;
  const base = ctx.baseUrl;
  if (typeof base === 'string' && base.startsWith('file:')) {
    try {
      const profile = fileURLToPath(base.endsWith('/') ? base : `${base}/`);
      const parent = dirname(profile);
      if (basename(parent) === 'profiles') return dirname(parent);
    } catch {
      /* not a usable file URL */
    }
  }
  const root = ctx.sessionPersistence?.config?.root;
  if (typeof root === 'string' && basename(root) === 'sessions') return dirname(root);
  return undefined;
}
