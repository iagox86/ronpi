// Routes one client command to its handler. The switch is exhaustive over
// ClientCommand, so a new command type is a compile error until it is handled here.
import type * as net from "node:net";
import type { DaemonContext, Responder } from "./daemon-context.ts";
import {
  handleAdopt,
  handleAttach,
  handleDeactivate,
  handleDelete,
  handleDetach,
  handleExternalRegister,
  handlePrompt,
  handleRename,
  handleRestore,
  handleSpawn,
} from "./daemon-handlers-lifecycle.ts";
import {
  handleAbort,
  handleClear,
  handleClearQueue,
  handleCommands,
  handleCompact,
  handleModel,
  handleReload,
  handleRestoreClear,
  handleRewind,
  handleUiResponse,
} from "./daemon-handlers-ops.ts";
import type { ClientCommand } from "./shared.ts";

export async function dispatch(ctx: DaemonContext, cmd: ClientCommand, socket: net.Socket, res: Responder): Promise<void> {
  switch (cmd.type) {
    case "prompt":
      return handlePrompt(ctx, cmd, socket, res);
    case "spawn":
      return handleSpawn(ctx, cmd, socket, res);
    case "adopt":
      return handleAdopt(ctx, cmd, socket, res);
    case "attach":
      return handleAttach(ctx, cmd, socket, res);
    case "detach":
      return handleDetach(ctx, cmd, socket, res);
    case "deactivate":
      return handleDeactivate(ctx, cmd, res);
    case "delete":
      return handleDelete(ctx, cmd, res);
    case "rename":
      return handleRename(ctx, cmd, res);
    case "restore":
      return handleRestore(cmd, res);
    case "external_register":
      return handleExternalRegister(ctx, cmd, res);
    case "abort":
      return handleAbort(ctx, cmd, res);
    case "clear_queue":
      return handleClearQueue(ctx, cmd, res);
    case "commands":
      return handleCommands(ctx, cmd, res);
    case "model":
      return handleModel(ctx, cmd, res);
    case "compact":
      return handleCompact(ctx, cmd, socket, res);
    case "reload":
      return handleReload(ctx, cmd, socket, res);
    case "clear":
      return handleClear(ctx, cmd, socket, res);
    case "restore_clear":
      return handleRestoreClear(ctx, cmd, socket, res);
    case "rewind":
      return handleRewind(ctx, cmd, res);
    case "ui_response":
      return handleUiResponse(ctx, cmd, res);
    case "list":
      ctx.hub.sendSessions(socket);
      res(true);
      return;
    case "shutdown":
      res(true);
      ctx.shutdown();
      return;
  }
}
