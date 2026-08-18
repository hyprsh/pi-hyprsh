/**
 * HTTP primitives shared by web_search and web_fetch.
 *
 * Two entry points, deliberately different:
 *
 * - `apiFetch` talks to a fixed, credentialed endpoint. It never follows a
 *   redirect, so an API key can never be replayed to another host.
 * - `safeFetch` follows a bounded redirect chain to arbitrary user-supplied
 *   URLs and sends no credentials. Every hop is re-validated against DNS and
 *   private address space before the request is made.
 *
 * Both cap the response body and the wall clock.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

export class NetworkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NetworkError";
	}
}

export class BlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlockedError";
	}
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Only transport hiccups and explicit back-pressure are retried. */
export function isTransient(error: unknown): boolean {
	if (error instanceof HttpError) return RETRYABLE_STATUS.has(error.status);
	return error instanceof NetworkError;
}

/** Bounded retries with exponential backoff and jitter. */
export async function withRetry<T>(
	operation: () => Promise<T>,
	options: { retries: number; signal?: AbortSignal; baseDelayMs?: number },
): Promise<T> {
	const base = options.baseDelayMs ?? 400;
	let lastError: unknown;
	for (let attempt = 0; attempt <= options.retries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (options.signal?.aborted || !isTransient(error) || attempt === options.retries) throw error;
			lastError = error;
			const delay = base * 2 ** attempt * (0.5 + Math.random() / 2);
			await sleep(delay, options.signal);
		}
	}
	throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function combineSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function asNetworkError(error: unknown, url: string): never {
	if (error instanceof HttpError || error instanceof BlockedError) throw error;
	if (error instanceof DOMException && error.name === "TimeoutError") {
		throw new NetworkError(`Timed out fetching ${url}`);
	}
	if (error instanceof DOMException && error.name === "AbortError") throw error;
	throw new NetworkError(`Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Read a body with a hard byte cap, cancelling the stream once exceeded. */
async function readLimited(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new HttpError(response.status, `Response from ${url} exceeds ${maxBytes} bytes`);
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);

	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new HttpError(response.status, `Response from ${url} exceeds ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export interface ApiFetchOptions {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
	maxBytes?: number;
	signal?: AbortSignal;
	/** Label used in errors; never include credentials. */
	label: string;
}

/** Request a fixed API endpoint. Redirects are refused while credentials are attached. */
export async function apiFetch(url: string, options: ApiFetchOptions): Promise<string> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			redirect: "error",
			signal: combineSignal(options.timeoutMs, options.signal),
		});
	} catch (error) {
		asNetworkError(error, options.label);
	}
	const text = new TextDecoder().decode(
		await readLimited(response, options.maxBytes ?? 4 * 1024 * 1024, options.label),
	);
	if (!response.ok) {
		throw new HttpError(
			response.status,
			`${options.label} returned HTTP ${response.status}: ${text.slice(0, 300)}`,
		);
	}
	return text;
}

export interface SafeFetchResult {
	response: Response;
	body: Uint8Array;
	finalUrl: string;
}

export interface SafeFetchOptions {
	headers?: Record<string, string>;
	timeoutMs: number;
	maxBytes: number;
	maxRedirects: number;
	signal?: AbortSignal;
}

/**
 * Fetch an arbitrary URL with SSRF protection on every hop.
 *
 * The address a hostname resolves to is checked before each request. Node's
 * fetch resolves DNS again itself, so a rebinding attack that changes the
 * answer between the check and the connection is out of scope here; blocking it
 * would require a custom dispatcher and is not worth the dependency yet.
 */
export async function safeFetch(target: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
	let current = await assertPublicUrl(target);

	for (let hop = 0; hop <= options.maxRedirects; hop++) {
		let response: Response;
		try {
			response = await fetch(current, {
				headers: options.headers,
				redirect: "manual",
				signal: combineSignal(options.timeoutMs, options.signal),
			});
		} catch (error) {
			asNetworkError(error, current.toString());
		}

		if (!REDIRECT_STATUS.has(response.status)) {
			const body = await readLimited(response, options.maxBytes, current.toString());
			return { response, body, finalUrl: current.toString() };
		}

		const location = response.headers.get("location");
		if (!location) {
			const body = await readLimited(response, options.maxBytes, current.toString());
			return { response, body, finalUrl: current.toString() };
		}
		if (hop === options.maxRedirects) break;
		await response.body?.cancel();
		current = await assertPublicUrl(new URL(location, current).toString());
	}

	throw new HttpError(310, `Too many redirects fetching ${target}`);
}

/** Validate scheme, shape and resolved addresses of a URL before it is requested. */
export async function assertPublicUrl(target: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		throw new BlockedError(`Not a valid URL: ${target}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new BlockedError(`Only http and https URLs are supported: ${url.protocol.replace(":", "")}`);
	}
	if (url.username || url.password) throw new BlockedError("URLs with embedded credentials are refused");

	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (!hostname) throw new BlockedError(`Missing hostname: ${target}`);

	if (isIP(hostname)) {
		assertPublicAddress(hostname, hostname);
		return url;
	}

	let addresses: { address: string }[];
	try {
		addresses = await lookup(hostname, { all: true });
	} catch (error) {
		throw new NetworkError(`Failed to resolve ${hostname}: ${(error as Error).message}`);
	}
	if (addresses.length === 0) throw new NetworkError(`Failed to resolve ${hostname}`);
	for (const { address } of addresses) assertPublicAddress(address, hostname);
	return url;
}

function assertPublicAddress(address: string, hostname: string): void {
	const version = isIP(address);
	if (version === 4 ? isPrivateIPv4(address) : version === 6 ? isPrivateIPv6(address) : true) {
		throw new BlockedError(`Blocked non-public address for ${hostname}: ${address}`);
	}
}

/** Loopback, link-local, CGNAT, RFC1918, multicast and reserved space. */
function isPrivateIPv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
		return true;
	const [a = 0, b = 0] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

/** Unspecified, loopback, unique-local, link-local and IPv4-mapped private space. */
function isPrivateIPv6(address: string): boolean {
	const groups = parseIPv6(address);
	if (!groups) return true;
	const [first = 0] = groups;
	if (groups.every((group) => group === 0)) return true;
	if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
	if ((first & 0xfe00) === 0xfc00) return true;
	if ((first & 0xffc0) === 0xfe80) return true;
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
		const mapped = [
			(groups[6] ?? 0) >> 8,
			(groups[6] ?? 0) & 0xff,
			(groups[7] ?? 0) >> 8,
			(groups[7] ?? 0) & 0xff,
		].join(".");
		return isPrivateIPv4(mapped);
	}
	return false;
}

function parseIPv6(address: string): number[] | null {
	let text = address;
	if (text.includes(".")) {
		const lastColon = text.lastIndexOf(":");
		const ipv4 = text.slice(lastColon + 1);
		if (isIP(ipv4) !== 4) return null;
		const octets = ipv4.split(".").map(Number);
		const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
		const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
		text = `${text.slice(0, lastColon)}:${high}:${low}`;
	}

	const pieces = text.split("::");
	if (pieces.length > 2) return null;
	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (pieces.length === 1 && missing !== 0) return null;
	if (pieces.length === 2 && missing < 0) return null;

	const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
		/^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : -1,
	);
	return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}
