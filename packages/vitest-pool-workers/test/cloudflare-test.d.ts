// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface CloudflareTestEnv {}

declare module "cloudflare:test" {
	export const env: CloudflareTestEnv;

	export function getDurableObjectInstance<T extends DurableObject>(
		stub: DurableObjectStub
	): Promise<T>;
	export function runWithDurableObjectContext<T>(
		stub: DurableObjectStub,
		callback: () => T | Promise<T>
	): Promise<T>;
	export function runDurableObjectAlarm(
		stub: DurableObjectStub
	): Promise<boolean /* ran */>;
}
