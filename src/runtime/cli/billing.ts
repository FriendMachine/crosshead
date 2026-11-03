import {
	DEFAULT_CHECKOUT_CREDIT_UNITS,
	DEFAULT_LIGHTNING_DEPOSIT_CREDIT_UNITS,
	DEFAULT_LOW_CREDIT_THRESHOLD,
	RuntimeBillingRemediation,
	buildRuntimeBillingRemediationForLowCredit,
	formatRuntimeBillingRemediation,
} from "../billing-remediation";
import { OnlyBotsLocalRuntimeDaemon, parseArgs } from "../local-runtime";

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

const parsePositiveIntegerFlag = (
	flags: Record<string, string | boolean>,
	keys: string[],
	defaultValue: number
): number => {
	for (const key of keys) {
		const value = flags[key];
		if (typeof value !== "string") {
			continue;
		}
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed > 0) {
			return parsed;
		}
		throw new Error(`${key} must be a positive integer`);
	}
	return defaultValue;
};

const parseOptionalPositiveIntegerFlag = (
	flags: Record<string, string | boolean>,
	keys: string[]
): number | undefined => {
	for (const key of keys) {
		const value = flags[key];
		if (typeof value !== "string") {
			continue;
		}
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed > 0) {
			return parsed;
		}
		throw new Error(`${key} must be a positive integer`);
	}
	return undefined;
};

const summarizeBillingAccount = (account: Record<string, unknown>, lowCreditThreshold: number): Record<string, unknown> => {
	const balance = isRecord(account.balance) ? account.balance : null;
	const availableCredits = numberField(balance, "available_credits") ?? numberField(balance, "available_sats") ?? 0;
	const pendingCredits = numberField(balance, "pending_credits") ?? numberField(balance, "pending_sats") ?? 0;
	const remediation = buildRuntimeBillingRemediationForLowCredit(availableCredits, lowCreditThreshold);
	return {
		...account,
		low_credit: remediation !== null,
		low_credit_threshold_credits: lowCreditThreshold,
		available_credits: availableCredits,
		pending_credits: pendingCredits,
		remediation,
	};
};

const formatBillingAccount = (summary: Record<string, unknown>): string => {
	const spendPolicy = isRecord(summary.spend_policy) ? summary.spend_policy : null;
	const stripe = isRecord(summary.stripe) ? summary.stripe : null;
	const lines = [
		`billing: available=${summary.available_credits} service_credits pending=${summary.pending_credits}`,
		`spend_policy: ${stringField(spendPolicy, "status") ?? "unknown"}`,
		`stripe: ${
			stripe
				? `customer=${stringField(stripe, "customer_id") ?? "unknown"} payment_method=${stringField(stripe, "payment_method_status") ?? "unknown"}`
				: "not connected"
		}`,
	];
	const remediation = isRecord(summary.remediation) ? summary.remediation : null;
	if (remediation) {
		lines.push(formatRuntimeBillingRemediation(remediation as RuntimeBillingRemediation));
	}
	return lines.join("\n");
};

const formatCheckout = (checkout: Record<string, unknown>): string => {
	const amountCents = numberField(checkout, "amount_cents");
	const dollars = amountCents === null ? null : (amountCents / 100).toFixed(2);
	return [
		"Created hosted Stripe Checkout link.",
		`credits: ${numberField(checkout, "credit_units") ?? "unknown"}`,
		dollars ? `amount: $${dollars} ${stringField(checkout, "currency") ?? "usd"}` : null,
		`url: ${stringField(checkout, "url") ?? "unavailable"}`,
		"Payment boundary: agents may show this link, but a human must open it and submit payment.",
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");
};

const formatDepositInvoice = (invoice: Record<string, unknown>): string =>
	[
		"Created Lightning deposit invoice.",
		`invoice_id: ${stringField(invoice, "invoice_id") ?? "unknown"}`,
		`payment_hash: ${stringField(invoice, "payment_hash") ?? "unknown"}`,
		`amount_credits: ${numberField(invoice, "amount_credits") ?? numberField(invoice, "amount_sats") ?? "unknown"}`,
		`expires_at: ${stringField(invoice, "expires_at") ?? "unknown"}`,
		`bolt11: ${stringField(invoice, "bolt11") ?? "unavailable"}`,
		"Payment boundary: agents may show this invoice, but a human must submit payment.",
	].join("\n");

const formatInvoice = (input: Record<string, unknown>): string => {
	const invoice = isRecord(input.invoice) ? input.invoice : input;
	return [
		`invoice_id: ${stringField(invoice, "invoice_id") ?? "unknown"}`,
		`status: ${stringField(invoice, "status") ?? "unknown"}`,
		`amount_credits: ${numberField(invoice, "amount_credits") ?? numberField(invoice, "amount_sats") ?? "unknown"}`,
		`payment_hash: ${stringField(invoice, "payment_hash") ?? "unknown"}`,
		`created_at: ${stringField(invoice, "created_at") ?? "unknown"}`,
		`paid_at: ${stringField(invoice, "paid_at") ?? "not paid"}`,
		`expires_at: ${stringField(invoice, "expires_at") ?? "unknown"}`,
	].join("\n");
};

const formatInvoiceList = (result: Record<string, unknown>): string => {
	const invoices = Array.isArray(result.invoices)
		? result.invoices.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		: [];
	if (invoices.length === 0) {
		return "billing_invoices: none";
	}
	return ["billing_invoices:", ...invoices.map((invoice) => `- ${formatInvoice(invoice).replace(/\n/g, " ")}`)].join("\n");
};

export const billingFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0] ?? "status";
	const profileName = typeof flags.profile === "string" ? flags.profile : undefined;
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);

	if (subcommand === "status" || subcommand === "account") {
		const lowCreditThreshold = parsePositiveIntegerFlag(
			flags,
			["low-credit-threshold", "lowCreditThreshold"],
			DEFAULT_LOW_CREDIT_THRESHOLD
		);
		const account = await daemon.inspectBillingAccount(profileName);
		const summary = summarizeBillingAccount(account, lowCreditThreshold);
		return flags.json ? JSON.stringify(summary, null, 2) : formatBillingAccount(summary);
	}

	if (subcommand === "checkout" || subcommand === "link" || subcommand === "payment-link") {
		const creditUnits = parsePositiveIntegerFlag(flags, ["credits", "credit-units", "creditUnits"], DEFAULT_CHECKOUT_CREDIT_UNITS);
		const checkout = await daemon.createBillingCheckout(
			{
				credit_units: creditUnits,
				...(typeof flags["success-url"] === "string" ? { success_url: flags["success-url"] } : {}),
				...(typeof flags.successUrl === "string" ? { success_url: flags.successUrl } : {}),
				...(typeof flags["cancel-url"] === "string" ? { cancel_url: flags["cancel-url"] } : {}),
				...(typeof flags.cancelUrl === "string" ? { cancel_url: flags.cancelUrl } : {}),
			},
			profileName
		);
		const result = {
			...checkout,
			agent_payment_boundary:
				"Agents may create and show this hosted payment link, but a human must open it and submit payment.",
		};
		return flags.json ? JSON.stringify(result, null, 2) : formatCheckout(result);
	}

	if (subcommand === "deposit" || subcommand === "invoice-create") {
		const amountSats = parsePositiveIntegerFlag(
			flags,
			["amount-sats", "amountSats", "credits"],
			DEFAULT_LIGHTNING_DEPOSIT_CREDIT_UNITS,
		);
		const invoice = await daemon.createBillingDepositInvoice(
			{
				amount_sats: amountSats,
			},
			profileName
		);
		const result = {
			...invoice,
			agent_payment_boundary: "Agents may create and show this invoice, but a human must submit payment.",
		};
		return flags.json ? JSON.stringify(result, null, 2) : formatDepositInvoice(result);
	}

	if (subcommand === "invoices" || subcommand === "list-invoices") {
		const limit = parseOptionalPositiveIntegerFlag(flags, ["limit"]);
		const invoices = await daemon.listBillingInvoices(
			{
				...(typeof flags.status === "string" ? { status: flags.status } : {}),
				...(typeof flags["created-after"] === "string" ? { created_after: flags["created-after"] } : {}),
				...(typeof flags.createdAfter === "string" ? { created_after: flags.createdAfter } : {}),
				...(typeof flags["created-before"] === "string" ? { created_before: flags["created-before"] } : {}),
				...(typeof flags.createdBefore === "string" ? { created_before: flags.createdBefore } : {}),
				...(typeof flags["paid-after"] === "string" ? { paid_after: flags["paid-after"] } : {}),
				...(typeof flags.paidAfter === "string" ? { paid_after: flags.paidAfter } : {}),
				...(typeof flags["paid-before"] === "string" ? { paid_before: flags["paid-before"] } : {}),
				...(typeof flags.paidBefore === "string" ? { paid_before: flags.paidBefore } : {}),
				...(limit ? { limit } : {}),
			},
			profileName
		);
		return flags.json ? JSON.stringify(invoices, null, 2) : formatInvoiceList(invoices);
	}

	if (subcommand === "invoice" || subcommand === "show-invoice") {
		const invoiceId =
			typeof flags["invoice-id"] === "string"
				? flags["invoice-id"]
				: typeof flags.invoiceId === "string"
					? flags.invoiceId
					: typeof positionals[1] === "string"
						? positionals[1]
						: "";
		const paymentHash =
			typeof flags["payment-hash"] === "string"
				? flags["payment-hash"]
				: typeof flags.paymentHash === "string"
					? flags.paymentHash
					: "";
		if (!invoiceId && !paymentHash) {
			throw new Error("billing invoice requires --invoice-id <id> or --payment-hash <hash>");
		}
		const invoice = await daemon.inspectBillingInvoice(
			{
				...(invoiceId ? { invoice_id: invoiceId } : {}),
				...(paymentHash ? { payment_hash: paymentHash } : {}),
			},
			profileName
		);
		return flags.json ? JSON.stringify(invoice, null, 2) : formatInvoice(invoice);
	}

	throw new Error("billing requires one of: status, checkout, invoices, invoice, deposit");
};
