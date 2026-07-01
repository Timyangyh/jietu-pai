import { createStyleMeServer } from "./server";

const port = Number(process.env.STYLEME_LOCAL_PORT ?? 8787);
const server = createStyleMeServer({ port });

server.listen(port, "127.0.0.1", () => {
  console.log(`StyleMe local server listening on http://127.0.0.1:${port}`);
});
