import { describe, expect, it } from "vitest";

import {
	DEFAULT_CHECKOUT_CREDIT_UNITS,
	DEFAULT_LIGHTNING_DEPOSIT_CREDIT_UNITS,
	buildRuntimeBillingRemediation,
	buildRuntimeBillingRemediationForLowCredit,
} from "../../src/runtime/billing-remediation";

describe("billing remediation defaults", () => {
	it("uses a $5-equivalent card checkout while leaving Lightning micropayments smaller", () => {
		expect(DEFAULT_CHECKOUT_CREDIT_UNITS).toBe(5000);
		expect(DEFAULT_LIGHTNING_DEPOSIT_CREDIT_UNITS).toBe(1000);
	});

	it("never recommends a card checkout below the $5-equivalent minimum", () => {
		expect(buildRuntimeBillingRemediationForLowCredit(0)).toMatchObject({
			checkoutCommand: "crosshead billing checkout --credits 5000",
			recommendedCreditUnits: 5000,
		});
		expect(
			buildRuntimeBillingRemediation({
				code: "payment_required",
				message: "credits required",
				details: { required_credits: 600 },
			}),
		).toMatchObject({
			checkoutCommand: "crosshead billing checkout --credits 6000",
			recommendedCreditUnits: 6000,
		});
	});
});
