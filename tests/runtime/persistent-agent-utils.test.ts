import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../src/runtime/persistent-agent-utils";

describe("persistent agent canonical JSON", () => {
  it("matches JSON persistence semantics for undefined values", () => {
    expect(canonicalizeJson({ keep: 1, omit: undefined })).toBe('{"keep":1}');
    expect(canonicalizeJson([1, undefined, 2])).toBe("[1,null,2]");
    expect(canonicalizeJson(undefined)).toBe("null");
  });

  it("sorts object keys recursively", () => {
    expect(canonicalizeJson({ z: { b: 2, a: 1 }, a: true })).toBe('{"a":true,"z":{"a":1,"b":2}}');
  });
});
