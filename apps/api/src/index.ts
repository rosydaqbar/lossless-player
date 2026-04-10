import { env } from "./config/env.js";
import { buildApp } from "./app.js";

const app = await buildApp();

app
  .listen({ port: env.API_PORT, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`API listening on http://localhost:${env.API_PORT}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
