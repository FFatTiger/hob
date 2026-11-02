#!/usr/bin/env node
// npm 包的 `hob` 命令：用 tsx 直接跑 TypeScript 源码，和 `npm start` 是同一个入口。
import { register } from "tsx/esm/api";

register();
const { boot } = await import("../server/src/boot.ts");
boot();
