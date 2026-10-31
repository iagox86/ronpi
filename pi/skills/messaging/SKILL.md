---
name: messaging
description: Send a message to another toriel session with the toriel_message tool. Use only when the user asks you to tell, ask or notify another session (for example "tell the session called Mealie about the new schema").
---

# Messaging other sessions

The `toriel_message` tool delivers text to another session running under toriel.

- Only use it when the user asks. Never message another session on your own initiative, and never to ask it for help the user did not mention.
- Address the session by its id when you have it (a UUID; the first 8 characters are enough). A name works if it is exact; if several sessions share it, the tool says so and you need the id.
- The other session sees only your text, labelled `[from <your name> (<your id>)]`. Write it so it makes sense alone: what you want it to know or do, and any paths or names it needs.
- The tool returns when the message is delivered, not when the other session has answered. A reply arrives later as a message to you; do not wait for it or poll.
- To let the other session reply, your id is in the label it sees; it can answer with the same tool.
- Report back to the user what you sent and where.
