import { defineConfig as composer } from "@prisma/composer/config";
import { nodeBuild } from "@prisma/composer/node/control";
import { prismaCloud, prismaState } from "@prisma/composer-prisma-cloud/control";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  composer: composer({
    entry: "./module.mjs",
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
  }),
  orm: ormConfig({
    contract: "./src/prisma/contract.prisma",
    db: { connection: process.env["DATABASE_URL"] },
  }),
});
