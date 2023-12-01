import assert from "node:assert";
import { env as globalEnv, getSerializedOptions } from "./env";
import { importModule, mustGetResolvedMainPath } from "./import";

interface Action {
	type: "getInstance" | "runCallback" | "runAlarm";
	id: number;
}
const ACTIONS: Action["type"][] = ["getInstance", "runCallback", "runAlarm"];
function isAction(value: unknown): value is Action {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		"id" in value &&
		ACTIONS.includes(value.type as Action["type"]) &&
		typeof value.id === "number"
	);
}

const CF_KEY_ACTION = "vitestPoolWorkersDurableObjectAction";

let nextActionId = 0;
const kUseResponse = Symbol("kUseResponse");
const actionResults = new Map<number /* id */, unknown>();

// Whilst `sameIsolatedNamespaces` depends on `getSerializedOptions()`,
// `isolateDurableObjectBindings` is derived from the user Durable Object
// config. If this were to change, the Miniflare options would change too
// restarting this worker. This means we only need to compute this once, as it
// will automatically invalidate when needed.
let sameIsolatedNamespaces: DurableObjectNamespace[] | undefined;
function getSameIsolateNamespaces(): DurableObjectNamespace[] {
	if (sameIsolatedNamespaces !== undefined) return sameIsolatedNamespaces;
	const options = getSerializedOptions();
	if (options.isolateDurableObjectBindings === undefined) return [];
	sameIsolatedNamespaces = options.isolateDurableObjectBindings.map((name) => {
		const namespace = globalEnv[name];
		assert(
			typeof namespace === "object" &&
				namespace !== null &&
				"idFromString" in namespace &&
				typeof namespace.idFromString === "function",
			`Expected ${name} to be a DurableObjectNamespace binding`
		);
		return namespace as DurableObjectNamespace;
	});
	return sameIsolatedNamespaces;
}

function assertSameIsolate(stub: DurableObjectStub) {
	// Make sure our special `cf` requests get handled correctly and aren't
	// routed to user fetch handlers
	const idString = stub.id.toString();
	const namespaces = getSameIsolateNamespaces();
	// Try to recreate the stub's ID using each same-isolate namespace.
	// `idFromString()` will throw if the ID is not for that namespace.
	// If a call succeeds, we know the ID is for an object in this isolate.
	for (const namespace of namespaces) {
		try {
			namespace.idFromString(idString);
			return;
		} catch {}
	}
	// If no calls succeed, we know the ID is for an object outside this isolate,
	// and we won't be able to use the `actionResults` map to share data.
	throw new Error(
		"Durable Object test helpers can only be used with stubs pointing to objects defined within the same worker."
	);
}

async function runAction<T>(stub: DurableObjectStub, act: Action): Promise<T> {
	const response = await stub.fetch("http://x", {
		cf: { [CF_KEY_ACTION]: act },
	});
	// `result` may be `undefined`
	assert(actionResults.has(act.id), `Expected action result for ${act.id}`);
	const result = actionResults.get(act.id);
	actionResults.delete(act.id);
	if (result === kUseResponse) {
		return response as T;
	} else if (response.ok) {
		return result as T;
	} else {
		throw result;
	}
}

export async function getDurableObjectInstance<T extends DurableObject>(
	stub: DurableObjectStub
): Promise<T> {
	assertSameIsolate(stub);
	const id = nextActionId++;
	const act: Action = { type: "getInstance", id };
	return runAction(stub, act);
}

export function runWithDurableObjectContext<T>(
	stub: DurableObjectStub,
	callback: () => T | Promise<T>
): Promise<T> {
	assertSameIsolate(stub);
	const id = nextActionId++;
	actionResults.set(id, callback);
	const act: Action = { type: "runCallback", id };
	return runAction(stub, act);
}

export function runDurableObjectAlarm(
	stub: DurableObjectStub
): Promise<boolean /* ran */> {
	assertSameIsolate(stub);
	const id = nextActionId++;
	const act: Action = { type: "runAlarm", id };
	return runAction(stub, act);
}

type DurableObjectConstructor = {
	new (state: DurableObjectState, env: Env): DurableObject;
};
type DurableObjectParameters<K extends keyof DurableObject> = Parameters<
	NonNullable<DurableObject[K]>
>;

// Wrapper for user Durable Object classes defined in this worker,
// intercepts and handles action requests
class DurableObjectWrapper implements DurableObject {
	instanceConstructor?: DurableObjectConstructor;
	instance?: DurableObject;

	constructor(
		readonly state: DurableObjectState,
		readonly env: Env,
		readonly className: string
	) {}

	async ensureInstance(): Promise<DurableObject> {
		const mainPath = mustGetResolvedMainPath("Durable Object");
		// `ensureInstance()` may be called multiple times concurrently.
		// We're assuming `importModule()` will only import the module once.
		const mainModule = await importModule(this.env, mainPath);
		const constructor = mainModule[this.className];
		if (typeof constructor !== "function") {
			throw new Error(
				`${mainPath} does not export a ${this.className} Durable Object`
			);
		}
		this.instanceConstructor ??= constructor as DurableObjectConstructor;
		if (this.instanceConstructor !== constructor) {
			// TODO(soon): unlikely to hit this case if we abort all Durable Objects
			//  at the end (or start?) of each test
			await this.state.blockConcurrencyWhile<never>(() => {
				// Throw inside `blockConcurrencyWhile()` to abort this object
				throw new Error(
					`${mainPath} changed, invalidating this Durable Object. ` +
						"Please retry the `DurableObjectStub#fetch()` call."
				);
			});
			assert.fail("Unreachable");
		}
		if (this.instance === undefined) {
			this.instance = new this.instanceConstructor(this.state, this.env);
			// Wait for any `blockConcurrencyWhile()`s in the constructor to complete
			await this.state.blockConcurrencyWhile(async () => {});
		}
		return this.instance;
	}

	async fetch(request: Request): Promise<Response> {
		// Make sure we've initialised user code
		const instance = await this.ensureInstance();

		// If this is an internal Durable Object action, handle it...
		const act = request.cf?.[CF_KEY_ACTION];
		if (isAction(act)) {
			const { type, id } = act;
			try {
				if (type === "getInstance") {
					actionResults.set(id, instance);
				} else if (type === "runCallback") {
					const callback = actionResults.get(id);
					assert(typeof callback === "function", `Expected callback for ${id}`);
					const result = await callback();
					// If the callback returns a `Response`, we can't pass it back to the
					// caller through `actionResults`. If we did that, we'd get a `Cannot
					// perform I/O on behalf of a different Durable Object` error if we
					// tried to use it. Instead, we set a flag in `actionResults` that
					// instructs the caller to use the `Response` returned by
					// `DurableObjectStub#fetch()` directly.
					if (result instanceof Response) {
						actionResults.set(id, kUseResponse);
						return result;
					} else {
						actionResults.set(id, result);
					}
				} else if (type === "runAlarm") {
					const alarm = await this.state.storage.getAlarm();
					await this.state.storage.deleteAlarm();
					if (alarm === null) {
						actionResults.set(id, false);
					} else {
						await instance.alarm?.();
						actionResults.set(id, true);
					}
				} else {
					const _exhaustive: never = type;
				}
				return new Response(null, { status: 204 });
			} catch (e) {
				actionResults.set(id, e);
				return new Response(null, { status: 500 });
			}
		}

		// Otherwise, pass through to the user code
		if (instance.fetch === undefined) {
			throw new Error("Handler does not export a fetch() function.");
		}
		return instance.fetch(request);
	}

	async alarm(...args: DurableObjectParameters<"alarm">) {
		const instance = await this.ensureInstance();
		return instance.alarm?.(...args);
	}
	async webSocketMessage(...args: DurableObjectParameters<"webSocketMessage">) {
		const instance = await this.ensureInstance();
		return instance.webSocketMessage?.(...args);
	}
	async webSocketClose(...args: DurableObjectParameters<"webSocketClose">) {
		const instance = await this.ensureInstance();
		return instance.webSocketClose?.(...args);
	}
	async webSocketError(...args: DurableObjectParameters<"webSocketError">) {
		const instance = await this.ensureInstance();
		return instance.webSocketError?.(...args);
	}
}

export function createDurableObjectWrapper(
	className: string
): DurableObjectConstructor {
	return class extends DurableObjectWrapper {
		constructor(state: DurableObjectState, env: Env) {
			super(state, env, className);
		}
	};
}
