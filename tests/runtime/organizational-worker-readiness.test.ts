import { describe, expect, it } from "vitest";

import {
  cloneOrganizationalWorkerReadiness,
  normalizeOrganizationalWorkerReadiness,
  type OrganizationalWorkerReadiness,
} from "../../src/runtime/organizational-worker-readiness";

const inspectReadiness = (): OrganizationalWorkerReadiness => ({
  schemaVersion: "onlybots.organizational-worker-readiness.v1",
  configuredMode: "inspect",
  state: "INSPECTION_READY",
  capabilities: {
    federationBindings: true,
    assignmentInspection: true,
    assignmentAcceptance: false,
    execution: false,
    cancellation: false,
    recovery: false,
    outboxDelivery: false,
  },
  reasonCodes: [
    "lease_status_endpoint_unavailable",
    "capability_status_endpoint_unavailable",
  ],
});

const deliveryReadiness = (): OrganizationalWorkerReadiness => ({
  schemaVersion: "onlybots.organizational-worker-readiness.v1",
  configuredMode: "active",
  state: "DELIVERY_READY",
  capabilities: {
    federationBindings: true,
    assignmentInspection: true,
    assignmentAcceptance: true,
    execution: false,
    cancellation: true,
    recovery: true,
    outboxDelivery: true,
  },
  reasonCodes: [
    "live_execution_authority_unavailable",
    "delivery_reconciliation_unavailable",
  ],
});

const boundedExecutionReadiness = (): OrganizationalWorkerReadiness => ({
	schemaVersion: "onlybots.organizational-worker-readiness.v1",
	configuredMode: "active",
	state: "BOUNDED_EXECUTION_READY",
	capabilities: {
		federationBindings: true,
		assignmentInspection: true,
		assignmentAcceptance: true,
		execution: true,
		cancellation: true,
		recovery: true,
		outboxDelivery: true,
	},
	reasonCodes: ["delivery_reconciliation_unavailable"],
});

describe("organizational worker readiness", () => {
  it("defaults absent composition to explicitly disabled", () => {
    expect(normalizeOrganizationalWorkerReadiness(undefined, false)).toEqual({
      schemaVersion: "onlybots.organizational-worker-readiness.v1",
      configuredMode: "off",
      state: "DISABLED",
      capabilities: {
        federationBindings: false,
        assignmentInspection: false,
        assignmentAcceptance: false,
        execution: false,
        cancellation: false,
        recovery: false,
        outboxDelivery: false,
      },
      reasonCodes: ["disabled_by_config"],
    });
  });

  it("preserves implicit active readiness only for a separately branded caller", () => {
    expect(normalizeOrganizationalWorkerReadiness(undefined, true, true)).toMatchObject({
      configuredMode: "active",
      state: "ACTIVE_READY",
      capabilities: {
        federationBindings: true,
        assignmentInspection: true,
        assignmentAcceptance: true,
        execution: true,
        cancellation: true,
        recovery: true,
        outboxDelivery: true,
      },
      reasonCodes: [],
    });
  });

  it("rejects readiness claims that exceed the composed worker API or mode", () => {
    expect(() => normalizeOrganizationalWorkerReadiness(undefined, true)).toThrow(
      /requires explicit readiness/
    );
    expect(() =>
      normalizeOrganizationalWorkerReadiness(inspectReadiness(), false)
    ).toThrow(/without a worker API/);

    const overclaimed = inspectReadiness();
    overclaimed.capabilities.execution = true;
    expect(() => normalizeOrganizationalWorkerReadiness(overclaimed, true)).toThrow(
      /cannot advertise active worker capabilities/
    );

    const unexpected = {
      ...inspectReadiness(),
      workspaceRoot: "/private/operator/workspace",
      controlToken: "super-secret",
    } as OrganizationalWorkerReadiness;
    expect(() => normalizeOrganizationalWorkerReadiness(unexpected, true)).toThrow(
      /exactly the supported fields/
    );
  });

  it("represents a durable delivery loop without claiming execution authority", () => {
    expect(
      normalizeOrganizationalWorkerReadiness(deliveryReadiness(), true)
    ).toEqual(deliveryReadiness());

    const executionOverclaim = deliveryReadiness();
    executionOverclaim.capabilities.execution = true;
    expect(() =>
      normalizeOrganizationalWorkerReadiness(executionOverclaim, true)
    ).toThrow(/keep execution disabled/);

    const missingBoundary = deliveryReadiness();
    missingBoundary.reasonCodes = ["live_execution_authority_unavailable"];
    expect(() =>
      normalizeOrganizationalWorkerReadiness(missingBoundary, true)
    ).toThrow(/execution-authority and stream-reconciliation limits/);
  });

	it("represents one bounded executable path without claiming reconciliation", () => {
		expect(
			normalizeOrganizationalWorkerReadiness(
				boundedExecutionReadiness(),
				true
			)
		).toEqual(boundedExecutionReadiness());

		const missingCapability = boundedExecutionReadiness();
		missingCapability.capabilities.execution = false;
		expect(() =>
			normalizeOrganizationalWorkerReadiness(missingCapability, true)
		).toThrow(/every composed worker capability/);

		const reconciliationOverclaim = boundedExecutionReadiness();
		reconciliationOverclaim.reasonCodes = [];
		expect(() =>
			normalizeOrganizationalWorkerReadiness(reconciliationOverclaim, true)
		).toThrow(/external reconciliation limitation/);
	});

  it("returns defensive copies for status inspection", () => {
    const input = inspectReadiness();
    const normalized = normalizeOrganizationalWorkerReadiness(input, true);
    input.reasonCodes.length = 0;
    input.capabilities.assignmentInspection = false;

    const status = cloneOrganizationalWorkerReadiness(normalized);
    status.reasonCodes.length = 0;
    status.capabilities.assignmentInspection = false;

    expect(normalized.reasonCodes).toEqual([
      "lease_status_endpoint_unavailable",
      "capability_status_endpoint_unavailable",
    ]);
    expect(normalized.capabilities.assignmentInspection).toBe(true);
  });
});
