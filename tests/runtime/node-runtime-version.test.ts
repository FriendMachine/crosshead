import { describe, expect, it } from "vitest";

import {
	assertSecureNodeRuntimeVersion,
	isSecureNodeRuntimeVersion,
} from "../../src/runtime/node-runtime-version";

describe("secure Node runtime version", () => {
	it.each([
		"22.23.4",
		"v22.24.0",
		"24.22.1",
		"24.22.2",
		"26.12.1",
		"26.13.0",
		"27.0.0",
	])("accepts %s", (version) => {
		expect(isSecureNodeRuntimeVersion(version)).toBe(true);
		expect(() => assertSecureNodeRuntimeVersion(version)).not.toThrow();
	});

	it.each([
		"",
		"not-a-version",
		"22.23.3",
		"23.99.99",
		"24.22.0",
		"25.99.99",
		"26.12.0",
	])("rejects %s", (version) => {
		expect(isSecureNodeRuntimeVersion(version)).toBe(false);
		expect(() => assertSecureNodeRuntimeVersion(version)).toThrow("remotely exploitable Brotli");
	});
});
