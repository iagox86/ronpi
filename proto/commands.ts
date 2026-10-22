// Switcher command-box parsing: "/rename new name" -> {name: "rename", arg: "new name"}.
export function parseCommand(cmd: string): { name: string; arg: string } {
  const [name, ...rest] = cmd.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), arg: rest.join(" ").trim() };
}
