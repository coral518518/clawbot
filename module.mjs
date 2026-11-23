// @ts-check
import { module } from "@prisma/composer";
import { envSecret } from "@prisma/composer-prisma-cloud";
import notifierService from "./src/service.mjs";

export default module("coral", ({ provision }) => {
  provision(notifierService, {
    input: {
      apiKey: envSecret("API_KEY"), // Authenticates calls to the gateway's send, admin and cluster APIs.
    },
  });
});
