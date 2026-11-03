// Only daemon APIs built by an organizational-worker composition count as
// constructed. The daemon checks this brand instead of trusting any object
// with the right method names. Operator builds mark their instances here; the
// public runtime never constructs one.
const constructedLocalApis = new WeakSet<object>();

export const markConstructedOrganizationalWorkerLocalApi = (value: object): void => {
  constructedLocalApis.add(value);
};

export const isConstructedOrganizationalWorkerLocalApi = (value: unknown): boolean =>
  typeof value === "object" && value !== null && constructedLocalApis.has(value);
