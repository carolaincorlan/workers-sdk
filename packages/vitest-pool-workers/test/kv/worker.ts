export function transformResponse(response: Response): Response {
	return new HTMLRewriter()
		.on("a", {
			element(element) {
				const href = element.getAttribute("href");
				if (href !== null) {
					element.setAttribute("href", href.replace("http://", "https://"));
				}
			},
		})
		.transform(response);
}

export default <ExportedHandler>{
	async fetch(request, env, _ctx) {
		return new Response(`body:${request.url}`);
	},
};
