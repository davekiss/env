# env

A Claude Code mod for `.env` files. You edit values in a pane inside Claude Code. Claude can see which keys exist and ask you for values, but it never sees a value.

## What it does

**`/env` opens a pane** with a tab for each `.env*` file in the project root.

- Values are masked (`sk_live_••••4f2a`). Each key has buttons to copy, edit, show or delete it.
- **+ add key** adds a new one. Keys that `.env.example` has but the current file doesn't are listed, so you can fill them in with one click.
- A warning shows if the file isn't in `.gitignore`.
- Comments, ordering and quoting are kept as written. Only the line you change is rewritten.

**When Claude needs a value, it asks with a card:**

```
╭──────────────────────────────────────────────────────╮
│ Claude needs a value                                 │
│                                                      │
│ CLOUDFLARE_ACCOUNT_ID → .env                         │
│ Wrangler needs it to deploy the worker               │
│                                                      │
│ 1. Open the Cloudflare dashboard                     │
│ 2. Pick any domain                                   │
│ 3. Copy Account ID from the right sidebar            │
│                                                      │
│ https://dash.cloudflare.com   copy link              │
│ Looks like: 32-character hex                         │
│                                                      │
│ Paste ▸ ________________________________   save      │
│ ✓ looks right                                        │
│ skip for now                                         │
╰──────────────────────────────────────────────────────╯
```

You paste the value and press Enter, and Claude gets one message back: `CLOUDFLARE_ACCOUNT_ID is now set in .env`. If you skip it or close the pane, Claude is told that too, so it never sits waiting.

**Tools Claude gets:**

| Tool | What it does |
| --- | --- |
| `mcp__env__list` | Lists keys and what each value looks like (kind, length, prefix), never the value itself |
| `mcp__env__request` | Shows you the card above |
| `mcp__env__generate` | Writes a random secret (auth secrets, signing keys) without returning it |
| `mcp__env__copy` | Copies a value from one env file to another without reading it |
| `mcp__env__remove` | Comments a key out, so you can restore it |

## How values stay out of the conversation

1. **The fence.** Claude's Read, Edit, Write and Grep can't open `.env*` files. Bash commands that read them (`cat .env`, `source .env`, `printenv`) are refused, and the refusal points Claude to the tools above. Template files like `.env.example` are still readable.
2. **The scrubber.** Any value in your env files that is 8 characters or longer is replaced with `[env:KEY]` in every tool result, message and prompt before it's stored or sent. This catches indirect leaks, like a script that prints `process.env`. The fence is best-effort; the scrubber is the real guarantee.

Programs that load `.env` themselves, like `npm run dev` or your tests, run normally.

## Install

Requires Claude Code v2.1.287 or later.

```
/plugin marketplace add davekiss/env
/plugin install env@davekiss
```

## Limits

- The paste field isn't masked, so a value is visible on your screen until you press Enter.
- Values shorter than 8 characters, booleans and numbers aren't scrubbed.
- Only the project root is scanned. Monorepo subfolders aren't covered yet.
- Don't paste a secret into the chat box. A value only gets scrubbed once it's saved in an env file.
- The pane draws in the terminal and the desktop app's Code tab. In the VS Code extension and `claude -p`, the fence, scrubber and tools still work, but there's no pane.

## License

MIT
