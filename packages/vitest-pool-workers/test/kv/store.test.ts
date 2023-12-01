import {
	env,
	fetchMock,
	getDurableObjectInstance,
	runWithDurableObjectContext,
	runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import worker, { transformResponse, Counter } from "./worker";

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	fetchMock
		.get("https://example.com")
		.intercept({ path: "/" })
		.reply(200, "data");
});
afterAll(() => fetchMock.assertNoPendingInterceptors());

describe("kv", () => {
	it("user agents", () => {
		console.log({ env }); // TODO(now): logs only seem to be appearing on the first run?
		expect(navigator.userAgent).toBe("Cloudflare-Workers");
	});

	it("stores in KV", async () => {
		await env.TEST_NAMESPACE.put("key", "value");
		expect(await env.TEST_NAMESPACE.get("key")).toBe("value");
	});

	it("stores in Durable Objects", async () => {
		// TODO: switch to idFromName once we have isolated storage, or clean storage
		//  at the start of each test
		const id = env.COUNTER.newUniqueId();
		const stub = env.COUNTER.get(id);
		let response = await stub.fetch("http://x/abc");
		expect(await response.json()).toMatchObject({ value: 1 });
		response = await stub.fetch("http://x/abc");
		expect(await response.json()).toMatchObject({ value: 2 });
	});
	it("stores in Durable Object instances", async () => {
		// TODO: switch to idFromName once we have isolated storage, or clean storage
		//  at the start of each test
		const id = env.COUNTER.newUniqueId();
		const stub = env.COUNTER.get(id);

		let response = await stub.fetch("http://x");
		expect(await response.json()).toMatchObject({ value: 1 });

		const instance = await getDurableObjectInstance<Counter>(stub);
		expect(instance).toBeInstanceOf(Counter);
		response = await runWithDurableObjectContext(stub, () =>
			instance.fetch(new Request("http://x"))
		);
		expect(await response.json()).toMatchObject({ value: 2 });

		const value = await runWithDurableObjectContext(stub, () =>
			instance.state.storage.get<number>("/")
		);
		expect(value).toBe(2);

		response = await runWithDurableObjectContext(stub, () =>
			instance.fetch(new Request("http://x"))
		);
		expect(await response.json()).toMatchObject({ value: 3 });
	});

	it("calls Durable Object alarm", async () => {
		const id = env.COUNTER.idFromName("alarm-test");
		const stub = env.COUNTER.get(id);
		const instance = await getDurableObjectInstance<Counter>(stub);
		await runWithDurableObjectContext(stub, async () => {
			await instance.state.storage.setAlarm(Date.now() + 10_000);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await instance.alarmPromise).toBe(42);
		expect(await runDurableObjectAlarm(stub)).toBe(false);
	});

	it("uses other object", async () => {
		const id = env.OTHER.idFromName("other-test");
		const stub = env.OTHER.get(id);
		const response = await stub.fetch("http://x");
		expect(await response.text()).toBe("other Durable Object body");
		// Can only use Durable Object helpers for same-isolate objects
		await expect(getDurableObjectInstance(stub)).rejects.toThrow();
	});

	it("fetches", async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>(
			"http://localhost"
		);
		const ctx: ExecutionContext = {
			waitUntil(_promise) {},
			passThroughOnException() {},
		};
		const response = await worker.fetch!(request, env, ctx);
		expect(await response.text()).toBe("body:http://localhost");
	});

	it("transforms", async () => {
		const response = transformResponse(
			new Response('<a href="http://example.com"></a>')
		);
		expect(await response.text()).toBe('<a href="https://example.com"></a>');
	});

	it("sends request to self", async () => {
		const res = await env.SELF.fetch("http://localhost");
		expect(await res.text()).toMatchInlineSnapshot(`"body:http://localhost"`);
	});

	it("mocks fetch requests", async () => {
		const res = await fetch("https://example.com");
		expect(await res.text()).toMatchSnapshot("mocked-data");
	});
});
