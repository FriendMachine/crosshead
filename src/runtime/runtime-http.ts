// HTTP dispatcher for the local runtime daemon control API. The daemon owns the
// socket lifecycle; every route delegates to a daemon method, so this module is a
// routing layer over the daemon's public surface.

import { IncomingMessage, ServerResponse } from "http";

import type { RuntimeLifecycleEventRequest } from "./lifecycle-engine";
import type { OnlyBotsLocalRuntimeDaemon, RuntimeAttachRequest, RuntimeDetachRequest } from "./local-runtime";
import { OrganizationalWorkerFederationStatusError } from "./organizational-worker-federation-protocol";
import type { OrganizationalWorkerCapability } from "./organizational-worker-readiness";
import {
	loadDaemonState,
	loadHealthState,
	loadRuntimeConfig,
	logFile,
	sanitizeLogValue,
	saveHealthState,
	tailFileLines,
	writeRuntimeLog,
	type RuntimePaths,
} from "./runtime-persistence";

const MAX_LOCAL_RUNTIME_BODY_BYTES = 2 * 1024 * 1024;

export const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
	const chunks: Buffer[] = [];
	let sizeBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		sizeBytes += buffer.length;
		if (sizeBytes > MAX_LOCAL_RUNTIME_BODY_BYTES) {
			throw new Error(`Local runtime request body exceeds ${MAX_LOCAL_RUNTIME_BODY_BYTES} bytes`);
		}
		chunks.push(buffer);
	}
	if (chunks.length === 0) {
		return {};
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

export const sendJson = (response: ServerResponse, statusCode: number, value: unknown): void => {
	response.statusCode = statusCode;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(value));
};

export const localTokenHeader = "x-onlybots-local-token";

const federationStatusRoutePattern =
	/^\/v1\/organizations\/([^/]+)\/agents\/([^/]+)\/federation-bindings\/([^/]+)\/status$/;

const rawHeaderValues = (request: IncomingMessage, name: string): string[] => {
	const expected = name.toLowerCase();
	const values: string[] = [];
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === expected) {
			values.push(request.rawHeaders[index + 1] ?? "");
		}
	}
	return values;
};

const exactHeader = (request: IncomingMessage, name: string): string | null => {
	const values = rawHeaderValues(request, name);
	return values.length === 1 ? values[0]! : null;
};

const observerBearerToken = (request: IncomingMessage): string | null => {
	const authorization = exactHeader(request, "authorization");
	const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/);
	return match?.[1] ?? null;
};

const decodeStatusRouteValue = (value: string): string => {
	try {
		return decodeURIComponent(value);
	} catch {
		return "";
	}
};

const sendFederationStatusJson = (
	response: ServerResponse,
	statusCode: number,
	value: unknown
): void => {
	response.setHeader("cache-control", "no-store");
	response.setHeader("pragma", "no-cache");
	response.setHeader("x-content-type-options", "nosniff");
	sendJson(response, statusCode, value);
};

const handleFederationStatusRequest = async (
	daemon: OnlyBotsLocalRuntimeDaemon,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	match: RegExpMatchArray
): Promise<void> => {
	if (!daemon.organizationalWorkerFederationStatusObserverAvailable()) {
		sendFederationStatusJson(response, 404, {
			error: {
				code: "federation_status_not_found",
				message: "Federation status not found",
			},
		});
		return;
	}
	try {
		const contentLengths = rawHeaderValues(request, "content-length");
		const bodyPresent =
			contentLengths.length > 1 ||
			(contentLengths.length === 1 && contentLengths[0] !== "0") ||
			rawHeaderValues(request, "transfer-encoding").length > 0;
		const observation = await daemon.observeOrganizationalWorkerFederationStatus({
			bearerToken: observerBearerToken(request),
			localControlTokenPresented:
				rawHeaderValues(request, localTokenHeader).length > 0,
			method: request.method ?? null,
			queryPresent: url.search.length > 0,
			bodyPresent,
			tenantId: exactHeader(request, "x-tenant-id"),
			siteId: exactHeader(request, "x-site-id"),
			principalId: exactHeader(request, "x-principal-id"),
			actorKind: exactHeader(request, "x-actor-kind"),
			organizationId: decodeStatusRouteValue(match[1]!),
			agentId: decodeStatusRouteValue(match[2]!),
			bindingRef: decodeStatusRouteValue(match[3]!),
			statusCheckRef: url.pathname,
		});
		sendFederationStatusJson(response, 200, observation);
	} catch (error) {
		const reasonCode =
			error instanceof OrganizationalWorkerFederationStatusError
				? error.reasonCode
				: "UNAVAILABLE";
		if (reasonCode === "UNAUTHORIZED") {
			sendFederationStatusJson(response, 401, {
				error: {
					code: "unauthorized",
					message: "Federation status observer authorization required",
				},
			});
			return;
		}
		if (reasonCode === "NOT_FOUND") {
			sendFederationStatusJson(response, 404, {
				error: {
					code: "federation_status_not_found",
					message: "Federation status not found",
				},
			});
			return;
		}
		sendFederationStatusJson(response, 503, {
			error: {
				code: "federation_status_unavailable",
				message: "Federation status is unavailable",
			},
		});
	}
};

const requireOrganizationalWorkerCapability = (
	daemon: OnlyBotsLocalRuntimeDaemon,
	response: ServerResponse,
	capability: OrganizationalWorkerCapability
): boolean => {
	if (daemon.organizationalWorkerSupports(capability)) {
		return true;
	}
	const readiness = daemon.inspectOrganizationalWorkerReadiness();
	sendJson(response, 503, {
		error: {
			code: "organizational_worker_unavailable",
			message: "The governed organizational worker capability is unavailable",
			readiness: {
				configuredMode: readiness.configuredMode,
				state: readiness.state,
				reasonCodes: [...readiness.reasonCodes],
			},
		},
	});
	return false;
};

export const handleRuntimeDaemonRequest = async (
	daemon: OnlyBotsLocalRuntimeDaemon,
	paths: RuntimePaths,
	request: IncomingMessage,
	response: ServerResponse
): Promise<void> => {
		if (!daemon.ownsRuntimeHome()) {
			sendJson(response, 503, { error: { code: "daemon_ownership_lost", message: "Daemon no longer owns this runtime home" } });
			return;
		}
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const federationStatusMatch = url.pathname.match(
			federationStatusRoutePattern
		);
		const organizationalWorkerRequest =
			url.pathname.startsWith("/v1/organizational-worker/") ||
			federationStatusMatch !== null;
		if (url.pathname === "/health") {
			const owner = loadDaemonState(paths);
			const token = request.headers[localTokenHeader] as string | undefined;
			if (request.method !== "GET" || !token || token !== owner.controlToken) {
				sendJson(response, 401, { error: { code: "unauthorized", message: "Health authentication required" } });
				return;
			}
			sendJson(response, 200, {
				ok: true,
				coreVersion: loadRuntimeConfig(paths).coreVersion,
				ownerId: owner.ownerId,
				ownerProcess: owner.ownerProcess,
			});
			return;
		}
		if (federationStatusMatch) {
			await handleFederationStatusRequest(
				daemon,
				request,
				response,
				url,
				federationStatusMatch
			);
			return;
		}

		const token = request.headers[localTokenHeader] as string | undefined;
		if (!token || token !== loadDaemonState(paths).controlToken) {
			sendJson(response, 401, {
				error: {
					code: "unauthorized",
					message: `Missing or invalid ${localTokenHeader}`,
				},
			});
			return;
		}

		try {
			if (
				request.method === "GET" &&
				url.pathname === "/v1/organizational-worker/status"
			) {
				sendJson(response, 200, daemon.inspectOrganizationalWorkerReadiness());
				return;
			}
			if (
				request.method === "GET" &&
				url.pathname === "/v1/organizational-worker/delivery"
			) {
				if (!requireOrganizationalWorkerCapability(daemon, response, "assignmentInspection")) {
					return;
				}
				sendJson(
					response,
					200,
					await daemon.inspectOrganizationalWorkerDelivery()
				);
				return;
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/organizational-worker/delivery/sync"
			) {
				if (!requireOrganizationalWorkerCapability(daemon, response, "assignmentAcceptance")) {
					return;
				}
				sendJson(
					response,
					200,
					await daemon.synchronizeOrganizationalWorkerDelivery()
				);
				return;
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/organizational-worker/federation-bindings"
			) {
				if (!requireOrganizationalWorkerCapability(daemon, response, "federationBindings")) {
					return;
				}
				sendJson(
					response,
					201,
					await daemon.issueOrganizationalWorkerFederationBinding(await readBody(request))
				);
				return;
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/organizational-worker/assignments"
			) {
				if (!requireOrganizationalWorkerCapability(daemon, response, "assignmentAcceptance")) {
					return;
				}
				const accepted = await daemon.acceptOrganizationalWorkerAssignment(await readBody(request));
				sendJson(response, accepted.accepted ? 202 : 409, accepted);
				return;
			}
			if (
				request.method === "GET" &&
				url.pathname === "/v1/organizational-worker/assignments"
			) {
				if (!requireOrganizationalWorkerCapability(daemon, response, "assignmentInspection")) {
					return;
				}
				sendJson(response, 200, {
					assignments: await daemon.listOrganizationalWorkerAssignments(),
				});
				return;
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/organizational-worker/recover"
			) {
				if (!requireOrganizationalWorkerCapability(daemon, response, "recovery")) {
					return;
				}
				sendJson(response, 200, {
					recovered: await daemon.recoverOrganizationalWorkerAssignments(),
				});
				return;
			}
			if (
				request.method === "POST" &&
				url.pathname === "/v1/organizational-worker/outbox/flush"
			) {
				if (!requireOrganizationalWorkerCapability(daemon, response, "outboxDelivery")) {
					return;
				}
				const body = await readBody(request);
				sendJson(
					response,
					200,
					await daemon.flushOrganizationalWorkerOutbox(
						typeof body.assignmentId === "string" ? body.assignmentId : undefined
					)
				);
				return;
			}
			const workerAssignmentMatch = url.pathname.match(
				/^\/v1\/organizational-worker\/assignments\/([^/]+)(?:\/(execute|cancel|resume))?$/
			);
			if (workerAssignmentMatch) {
				const assignmentId = decodeURIComponent(workerAssignmentMatch[1]!);
				const action = workerAssignmentMatch[2];
				if (request.method === "GET" && !action) {
					if (!requireOrganizationalWorkerCapability(daemon, response, "assignmentInspection")) {
						return;
					}
					const inspection = await daemon.inspectOrganizationalWorkerAssignment(assignmentId);
					if (!inspection) {
						sendJson(response, 404, {
							error: {
								code: "assignment_not_found",
								message: `Assignment ${assignmentId} is unknown`,
							},
						});
						return;
					}
					sendJson(response, 200, inspection);
					return;
				}
				if (request.method === "POST" && action === "execute") {
					if (!requireOrganizationalWorkerCapability(daemon, response, "execution")) {
						return;
					}
					sendJson(
						response,
						200,
						await daemon.executeOrganizationalWorkerAssignment(assignmentId)
					);
					return;
				}
				if (request.method === "POST" && action === "resume") {
					if (!requireOrganizationalWorkerCapability(daemon, response, "execution")) {
						return;
					}
					sendJson(
						response,
						200,
						await daemon.resumeOrganizationalWorkerAssignment(assignmentId)
					);
					return;
				}
				if (request.method === "POST" && action === "cancel") {
					if (!requireOrganizationalWorkerCapability(daemon, response, "cancellation")) {
						return;
					}
					const body = await readBody(request);
					if (body.assignmentId !== assignmentId) {
						throw new Error("cancellation assignmentId must match the route");
					}
					sendJson(
						response,
						200,
						await daemon.cancelOrganizationalWorkerAssignment(body)
					);
					return;
				}
			}
			if (request.method === "GET" && url.pathname === "/v1/status") {
				sendJson(response, 200, await daemon.status(url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/doctor") {
				sendJson(response, 200, await daemon.doctor(url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/continuity/policy") {
				sendJson(response, 200, daemon.inspectContinuityPolicy());
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/continuity/state") {
				sendJson(response, 200, daemon.inspectContinuityState());
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/continuity/patches") {
				const body = await readBody(request);
				sendJson(response, 200, daemon.applyContinuityGovernorPatch(body));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/continuity/patches/remove") {
				const body = await readBody(request);
				sendJson(response, 200, daemon.removeContinuityGovernorPatch(body));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/logs") {
				sendJson(response, 200, {
					lines: tailFileLines(logFile(paths), Number(url.searchParams.get("lines") ?? 50)),
				});
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/events") {
				const activity = await daemon.readActivity(Number(url.searchParams.get("lines") ?? 50));
				sendJson(response, 200, activity);
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/adapters/attach") {
				const body = (await readBody(request)) as RuntimeAttachRequest;
				const attach = await daemon.attachAdapter(body);
				sendJson(response, attach.accepted ? 200 : 400, attach);
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/adapters/detach") {
				const body = (await readBody(request)) as RuntimeDetachRequest;
				sendJson(response, 200, await daemon.detachAdapter(body));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/events") {
				const body = (await readBody(request)) as RuntimeLifecycleEventRequest;
				const result = await daemon.submitLifecycleEvent(body);
				sendJson(response, 200, result);
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/context/pack") {
				const body = await readBody(request);
				const result = await daemon.proxyContextPack(body);
				sendJson(response, 200, result);
				return;
			}
			if (request.method === "GET" && url.pathname.startsWith("/v1/context/packs/")) {
				const packId = decodeURIComponent(url.pathname.slice("/v1/context/packs/".length));
				sendJson(response, 200, await daemon.inspectContextPack(packId, url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/context/judgment") {
				sendJson(response, 200, await daemon.inspectContinuityJudgment(url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/context/continuity") {
				sendJson(response, 200, await daemon.inspectContinuity(url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/context/dreams") {
				sendJson(
					response,
					200,
					await daemon.inspectDreams(
						{
							runId: url.searchParams.get("runId") ?? undefined,
							status: url.searchParams.get("status") ?? undefined,
						},
						url.searchParams.get("profile") ?? undefined
					)
				);
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/context/dreams/run") {
				const body = await readBody(request);
				sendJson(response, 200, await daemon.runDreamJob(body, url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/context/dreams/review") {
				const body = await readBody(request);
				sendJson(response, 200, await daemon.reviewDreamProposal(body, url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/context/reflect") {
				const body = await readBody(request);
				const result = await daemon.proxyContextReflect(body);
				sendJson(response, 200, result);
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/memory/search") {
				const body = await readBody(request);
				const result = await daemon.proxyMemorySearch(body);
				sendJson(response, 200, result);
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/memory/hot-sync/control") {
				sendJson(response, 200, await daemon.hotSyncControl(await readBody(request)));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/memory/hot") {
				sendJson(
					response,
					200,
					await daemon.readHotMemory(
						url.searchParams.get("profile") ?? undefined,
						url.searchParams.get("scope") ?? undefined
					)
				);
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/memory/warm") {
				sendJson(
					response,
					200,
					await daemon.listWarmMemory(url.searchParams.get("profile") ?? undefined, {
						type: url.searchParams.get("type") ?? undefined,
						status: url.searchParams.get("status") ?? undefined,
						includeSystemMemory: url.searchParams.get("include_system") === "true",
					})
				);
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/memory/warm/evaluate") {
				const body = await readBody(request);
				const result = await daemon.evaluateWarmMemory(body, url.searchParams.get("profile") ?? undefined);
				sendJson(response, 200, result);
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/memory/export") {
				const body = await readBody(request);
				const result = await daemon.proxyMemoryExport(body);
				sendJson(response, 200, result);
				return;
			}
	if (request.method === "GET" && url.pathname === "/v1/public/discovery/schema") {
	  sendJson(response, 200, await daemon.readPublicDiscoverySchema(url.searchParams.get("profile") ?? undefined));
	  return;
	}
	if (request.method === "GET" && url.pathname === "/v1/public/discovery/events") {
	  const result = await daemon.inspectPublicDiscovery(
		{
		  eventType: url.searchParams.get("eventType") ?? url.searchParams.get("event_type") ?? undefined,
		  authors: url.searchParams.get("authors") ?? undefined,
		  primaryId: url.searchParams.get("primaryId") ?? url.searchParams.get("primary_id") ?? undefined,
		  eventId: url.searchParams.get("eventId") ?? url.searchParams.get("event_id") ?? undefined,
		  capabilityId:
			url.searchParams.get("capabilityId") ?? url.searchParams.get("capability_id") ?? undefined,
		  offerId: url.searchParams.get("offerId") ?? url.searchParams.get("offer_id") ?? undefined,
		  taskRef: url.searchParams.get("taskRef") ?? url.searchParams.get("task_ref") ?? undefined,
		  agentId: url.searchParams.get("agentId") ?? url.searchParams.get("agent_id") ?? undefined,
		  status: url.searchParams.get("status") ?? undefined,
		  since: url.searchParams.get("since") ?? undefined,
		  until: url.searchParams.get("until") ?? undefined,
		  latestOnly:
			url.searchParams.get("latestOnly") ?? url.searchParams.get("latest_only") ?? undefined,
		  includeRaw:
			url.searchParams.get("includeRaw") ?? url.searchParams.get("include_raw") ?? undefined,
		  limit: url.searchParams.get("limit") ?? undefined,
		},
		url.searchParams.get("profile") ?? undefined
	  );
	  sendJson(response, 200, result);
	  return;
	}
	if (request.method === "POST" && url.pathname === "/v1/public/discovery/publish") {
	  const body = await readBody(request);
	  sendJson(response, 200, await daemon.publishPublicDiscoveryEvent(body, url.searchParams.get("profile") ?? undefined));
	  return;
	}
	if (request.method === "GET" && url.pathname === "/v1/messages/inbox/state") {
	  const result = await daemon.inspectInboxState(
		{
		  statuses: url.searchParams.get("statuses") ?? undefined,
		  priorities: url.searchParams.get("priorities") ?? undefined,
		  contextId: url.searchParams.get("contextId") ?? url.searchParams.get("context_id") ?? undefined,
		  messageType: url.searchParams.get("messageType") ?? url.searchParams.get("message_type") ?? undefined,
		  unreadOnly: url.searchParams.get("unreadOnly") ?? url.searchParams.get("unread_only") ?? undefined,
		  includeTerminal:
			url.searchParams.get("includeTerminal") ?? url.searchParams.get("include_terminal") ?? undefined,
		  limit: url.searchParams.get("limit") ?? undefined,
		},
		url.searchParams.get("profile") ?? undefined
	  );
	  sendJson(response, 200, result);
	  return;
	}
	if (request.method === "POST" && url.pathname === "/v1/messages/inbox/replay") {
	  const body = await readBody(request);
	  sendJson(response, 200, await daemon.replayInboxItem(body, url.searchParams.get("profile") ?? undefined));
	  return;
	}
	if (request.method === "POST" && url.pathname === "/v1/messages/inbox/ack") {
	  const body = await readBody(request);
	  sendJson(response, 200, await daemon.acknowledgeInboxItem(body, url.searchParams.get("profile") ?? undefined));
	  return;
	}
	if (request.method === "POST" && url.pathname === "/v1/messages/inbox/resolve") {
	  const body = await readBody(request);
	  sendJson(response, 200, await daemon.resolveInboxItem(body, url.searchParams.get("profile") ?? undefined));
	  return;
	}
			if (request.method === "POST" && url.pathname === "/v1/handoffs/create") {
				const body = await readBody(request);
				sendJson(response, 200, await daemon.createHandoff(body));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/handoffs/verify") {
				const body = await readBody(request);
				sendJson(response, 200, await daemon.verifyHandoff(body));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/handoffs/inspect") {
				const body = await readBody(request);
				sendJson(response, 200, await daemon.inspectHandoff(body));
				return;
			}
			if (request.method === "GET" && url.pathname.startsWith("/v1/handoffs/")) {
				const handoffId = decodeURIComponent(url.pathname.slice("/v1/handoffs/".length));
				sendJson(response, 200, await daemon.readHandoff(handoffId, url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/handoffs/ack") {
				const body = await readBody(request);
				sendJson(response, 200, await daemon.acknowledgeHandoff(body));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/handoffs/outcome") {
				const body = await readBody(request);
				sendJson(response, 200, await daemon.recordHandoffOutcome(body));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/agents/fork") {
				const body = await readBody(request);
				sendJson(response, 200, await daemon.forkPersistentAgentIdentity(body));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/agents/current") {
				sendJson(response, 200, await daemon.inspectPersistentAgent(undefined, url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/agents/current/lineage") {
				sendJson(response, 200, await daemon.inspectPersistentAgentLineage(undefined, url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "GET" && url.pathname.startsWith("/v1/agents/") && url.pathname.endsWith("/lineage")) {
				const agentId = decodeURIComponent(
					url.pathname.slice("/v1/agents/".length, url.pathname.length - "/lineage".length)
				);
				sendJson(response, 200, await daemon.inspectPersistentAgentLineage(agentId, url.searchParams.get("profile") ?? undefined));
				return;
			}
			if (request.method === "GET" && url.pathname.startsWith("/v1/agents/")) {
				const agentId = decodeURIComponent(url.pathname.slice("/v1/agents/".length));
				sendJson(response, 200, await daemon.inspectPersistentAgent(agentId, url.searchParams.get("profile") ?? undefined));
				return;
			}
			sendJson(response, 404, {
				error: {
					code: "not_found",
					message: "Local runtime route not found",
				},
			});
		} catch (error) {
			const rawMessage = error instanceof Error ? error.message : String(error);
			const message = organizationalWorkerRequest
				? "The governed organizational worker request failed"
				: sanitizeLogValue(rawMessage);
			const health = loadHealthState(paths);
			saveHealthState(paths, {
				...health,
				lastError: message,
			});
			writeRuntimeLog(paths, "daemon.error", {
				message,
				path: organizationalWorkerRequest ? "[organizational-worker-route]" : url.pathname,
			});
			sendJson(response, 400, {
				error: {
					code: organizationalWorkerRequest
						? "organizational_worker_request_failed"
						: "bad_request",
					message,
				},
			});
		}
};
