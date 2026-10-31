#!/usr/bin/env node
// toriel: the controller. `node toriel.ts` (auto-starts the daemon), `node toriel.ts kill-server`.
import "./src/migrate-on-start.ts";
import "./src/controller.ts";
