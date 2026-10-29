// /init: the prompt asking the agent to survey the project and write its
// AGENTS.md. Kept in its own module so the wording has a unit test without
// pulling in the TUI.

export const INIT_PROMPT = [
  "Survey this project and write an AGENTS.md in its root for future agents.",
  "If one already exists, read it first and update it rather than starting over; keep anything that is still accurate.",
  "Also read the other standard agent-instruction files if they exist (CLAUDE.md, GEMINI.md, .cursorrules, .github/copilot-instructions.md) and fold whatever is still accurate into AGENTS.md; AGENTS.md is the only file you write.",
  "Cover: what the project does, what the main files and directories are for, how to build, run and test it, and the conventions the code follows (naming, style, error handling, anything a newcomer would get wrong).",
  "Base it on what you actually find in the code and config, not guesses; keep it concise, and skip anything obvious from file names alone.",
].join(" ");
