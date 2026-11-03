export const CROSSHEAD_NODE_ENGINE_RANGE = "^22.23.4 || ^24.22.1 || >=26.12.1";

type NodeVersion = {
	major: number;
	minor: number;
	patch: number;
};

const MINIMUM_SAFE_VERSIONS = new Map<number, NodeVersion>([
	[22, { major: 22, minor: 23, patch: 4 }],
	[24, { major: 24, minor: 22, patch: 1 }],
	[26, { major: 26, minor: 12, patch: 1 }],
]);

const parseNodeVersion = (value: string): NodeVersion | null => {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
};

const isAtLeast = (version: NodeVersion, minimum: NodeVersion): boolean =>
	version.major > minimum.major ||
	(version.major === minimum.major && version.minor > minimum.minor) ||
	(version.major === minimum.major && version.minor === minimum.minor && version.patch >= minimum.patch);

export const isSecureNodeRuntimeVersion = (value: string): boolean => {
	const version = parseNodeVersion(value);
	if (!version) return false;
	if (version.major > 26) return true;
	const minimum = MINIMUM_SAFE_VERSIONS.get(version.major);
	return minimum ? isAtLeast(version, minimum) : false;
};

export const assertSecureNodeRuntimeVersion = (value: string = process.versions.node): void => {
	if (isSecureNodeRuntimeVersion(value)) return;
	throw new Error(
		`Crosshead requires Node ${CROSSHEAD_NODE_ENGINE_RANGE}. ` +
			`Node ${value || "unknown"} is not supported because earlier releases contain remotely exploitable Brotli and HTTP client vulnerabilities.`
	);
};
