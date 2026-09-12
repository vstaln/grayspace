# Terminal attachments review

Scope: image and MP3 drop/paste into TerminalWidget on Code and Canvas. Both surfaces use the same attachment handler. Dropping onto the empty canvas intentionally creates a media widget, rather than targeting an arbitrary terminal.

## Findings and changes

- Fixed universal Ctrl+V dispatch: Windows Claude, Kimi, Grok Build, CommandCode and Pi use Alt+V; Codex, OpenCode and Cursor use Ctrl+V. Other platforms use Ctrl+V. CLI keybinding overrides are not detected.
- Fixed Canvas/Code mismatch: image routing now depends on the CLI, not the surface or attachment-mode flag.
- Fixed clipboard-event mismatch: actual event files are staged, rather than assuming the system clipboard contains the same image.
- Fixed MP3 and other virtual files without Electron paths: save their original bytes with the original extension, then paste their path. Audio is never labeled IMAGE.
- Fixed unsupported image decoding: fall back to the original/saved file path instead of silently dropping the file.
- Fixed multi-image clipboard overwrite within a drop: batches use distinct durable file paths. Native image tokens for such paths depend on the receiving CLI.
- Fixed input focus and unmount handling: focus the target terminal, serialize its drop operations, and stop delivery when it is disposed.
- Fixed CLI identification being overwritten by ordinary prompt text; recognize known executable names, full paths and queued custom launch commands.
- Path input uses xterm paste rather than raw terminal writes; rejects control characters and does not submit the prompt.
- Internal session drag/drop remains separate from file handling.

## Support and limits

| CLI | Single image on Windows | MP3 / multiple files |
| --- | --- | --- |
| Claude Code | Stage image + Alt+V | Paste file paths |
| Codex | Stage image + Ctrl+V | Paste file paths |
| Kimi Code | Stage image + Alt+V | Paste file paths |
| Grok Build | Stage image + Alt+V | Paste file paths |
| CommandCode | Stage image + Alt+V | Paste file paths |
| Pi | Stage image + Alt+V | Paste file paths |
| Cursor Agent | Stage image + Ctrl+V | Paste file paths |
| OpenCode | Stage image + Ctrl+V | Paste file paths |
| Antigravity / agy | Stage image + Ctrl+V (restored previous behavior) | Paste file paths |
| Unknown CLI | Paste saved image path | Paste file paths |

The CLI owns image recognition, model capability checks, and the displayed token. Writing literal `[Image #1]` would not attach data. MP3 delivery is file-path delivery, not confirmed native audio input. No speech transcription or audio-to-image conversion is performed.

Remaining limitations: no end-to-end confirmation across authenticated CLI versions; customized bindings, SSH/WSL path and clipboard bridging, and rapid separate clipboard drops across terminals require further validation. Staging success is not a CLI acknowledgement; external clipboard changes before a CLI reads it remain possible. Unsupported clipboard decoders use paths. Unknown launch wrappers/aliases may require explicit CLI selection. No universal native attachment guarantee is made.

## Validation

- `node --test src/main/terminalAttachments.test.ts`: 13 passed, covering native image staging, Antigravity regression, platform routing, paste shortcuts, batch preservation, MP3, fallback, failed reads, disposal, size limits and path control characters.
- Alt+V, Ctrl+V, Ctrl+Shift+V and Shift+Insert route through the shared paste handler; Cmd+V works on macOS. Win+V is left to Windows and the resulting paste event uses the same handler. Windows clipboard-history integration has not been exercised live.
- `npm run typecheck`: node and renderer passed.
- No live model prompts submitted. These checks verify OrcSpace routing, not provider acceptance.

## References

- Claude: https://code.claude.com/docs/en/interactive-mode
- Kimi: https://www.kimi.com/code/docs/en/kimi-code-cli/guides/interaction.html
- Grok Build: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md
- CommandCode: https://commandcode.ai/docs/interactive-mode
- Pi: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md
- Cursor CLI image paste changelog: https://prod.cursor.com/changelog/page/8
- OpenCode keybindings: https://opencode.ai/docs/keybinds/
