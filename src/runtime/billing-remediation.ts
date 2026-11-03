import { HostedOnlyBotsRequestError } from "./hosted-client";

export const DEFAULT_CHECKOUT_CREDIT_UNITS = 1000;
export const DEFAULT_LOW_CREDIT_THRESHOLD = 100;

type ErrorLike = {
	status?: number | null;
	code?: string | null;
	message: string;
	details?: unknown;
};

export type RuntimeBillingRemediation = {
	needed: boolean;
	reason: string;
	statusCommand: string;
	checkoutCommand: string;
	recommendedCreditUnits: number;
	paymentBoundary: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const numberField = (record: Record<string, unknown> | null, key: string): number | null => {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

export const isBillingBlockedErrorCode = (code: string | null | undefined): boolean =>
	code === "payment_required" || code === "payment_provider_unavailable" || code === "billing_policy_denied";

export const isBillingBlockedError = (error: unknown): error is HostedOnlyBotsRequestError =>
	error instanceof HostedOnlyBotsRequestError && isBillingBlockedErrorCode(error.code);

export const buildRuntimeBillingRemediation = (input: ErrorLike): RuntimeBillingRemediation | null => {
	if (!isBillingBlockedErrorCode(input.code)) {
		return null;
	}
	const details = isRecord(input.details) ? input.details : null;
	const balance = isRecord(details?.balance) ? details.balance : null;
	const required = numberField(details, "required_credits") ?? numberField(details, "required_sats") ?? 0;
	const available = numberField(balance, "available_credits") ?? numberField(balance, "available_sats") ?? null;
	const recommendedCreditUnits = Math.max(DEFAULT_CHECKOUT_CREDIT_UNITS, required > 0 ? required * 10 : 0);
	const operation = stringField(details, "operation") ?? "paid_operation";
	const denial = isRecord(details?.spend_policy_denial) ? details.spend_policy_denial : null;
	const denialReason = stringField(denial, "reason");
	const reason =
		input.code === "billing_policy_denied"
			? `billing spend policy blocked ${operation}${denialReason ? ` (${denialReason})` : ""}`
			: input.code === "payment_provider_unavailable"
				? `funding is required for ${operation}, but automatic Lightning invoice creation is unavailable`
				: `service credits are required for ${operation}${available !== null ? `; available balance is ${available}` : ""}`;
	return {
		needed: true,
		reason,
		statusCommand: "crosshead billing status --json",
		checkoutCommand: `crosshead billing checkout --credits ${recommendedCreditUnits}`,
		recommendedCreditUnits,
		paymentBoundary: "Agents may create and show the hosted payment link, but a human must open it and submit payment.",
	};
};

export const buildRuntimeBillingRemediationForLowCredit = (
	availableCreditUnits: number,
	thresholdCreditUnits: number = DEFAULT_LOW_CREDIT_THRESHOLD
): RuntimeBillingRemediation | null => {
	if (availableCreditUnits >= thresholdCreditUnits) {
		return null;
	}
	return {
		needed: true,
		reason: `available balance is ${availableCreditUnits} service credits, below the ${thresholdCreditUnits} credit reminder threshold`,
		statusCommand: "crosshead billing status --json",
		checkoutCommand: `crosshead billing checkout --credits ${DEFAULT_CHECKOUT_CREDIT_UNITS}`,
		recommendedCreditUnits: DEFAULT_CHECKOUT_CREDIT_UNITS,
		paymentBoundary: "Agents may create and show the hosted payment link, but a human must open it and submit payment.",
	};
};

export const formatRuntimeBillingRemediation = (remediation: RuntimeBillingRemediation): string =>
	[
		`Billing remediation: ${remediation.reason}.`,
		`Run \`${remediation.statusCommand}\` to inspect the account.`,
		`Run \`${remediation.checkoutCommand}\` to create a hosted payment link.`,
		remediation.paymentBoundary,
	].join(" ");

