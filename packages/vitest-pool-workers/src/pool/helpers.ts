export function isFileNotFoundError(e: unknown) {
	return (
		typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT"
	);
}
