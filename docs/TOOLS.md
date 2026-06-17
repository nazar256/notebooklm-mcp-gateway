# MCP tools

All successful tool calls return `structuredContent` matching the advertised output schema. Errors are returned as MCP tool errors (`isError: true`) with sanitized text.

The gateway intentionally does not return raw upstream NotebookLM response blobs through MCP. Stable outputs expose normalized fields only.

## Tool catalog

| Tool | Scope | Category | Safety |
| --- | --- | --- | --- |
| `list_notebooks` | `notebooklm:read` | notebooks | read-only |
| `get_notebook` | `notebooklm:read` | notebooks | read-only |
| `create_notebook` | `notebooklm:write` | notebooks | writes NotebookLM state |
| `rename_notebook` | `notebooklm:write` | notebooks | writes NotebookLM state |
| `delete_notebook` | `notebooklm:delete` | notebooks | destructive; requires `confirm: true` and exact `expectedTitle` |
| `list_sources` | `notebooklm:read` | sources | read-only |
| `add_url_source` | `notebooklm:write` | sources | writes NotebookLM state |
| `add_youtube_source` | `notebooklm:write` | sources | writes NotebookLM state |
| `add_text_source` | `notebooklm:write` | sources | writes NotebookLM state |
| `add_drive_source` | `notebooklm:write` | sources | writes NotebookLM state; requires Drive access in the pasted browser session |
| `get_source_guide` | `notebooklm:read` | sources | read-only |
| `get_source_content` | `notebooklm:read` | sources | read-only |
| `refresh_source` | `notebooklm:write` | sources | writes NotebookLM state |
| `delete_source` | `notebooklm:delete` | sources | destructive; requires `confirm: true` and optional `expectedTitle` |
| `ask_notebook` | `notebooklm:chat` | chat | may persist chat activity upstream |
| `get_last_conversation_id` | `notebooklm:read` | chat | read-only |
| `get_conversation_turns` | `notebooklm:read` | chat | read-only |
| `list_notes` | `notebooklm:read` | notes | read-only |
| `create_note` | `notebooklm:write` | notes | writes NotebookLM state |
| `update_note` | `notebooklm:write` | notes | writes NotebookLM state |
| `delete_note` | `notebooklm:delete` | notes | destructive; requires `confirm: true` and optional `expectedTitle` |
| `list_artifacts` | `notebooklm:read` | Studio artifacts | read-only |
| `generate_artifact` | `notebooklm:chat` | Studio artifacts | starts generation upstream |
| `download_artifact` | `notebooklm:read` | Studio artifacts | read-only metadata/export request; does not proxy binary bytes |
| `start_research` | `notebooklm:chat` | research | starts upstream research |
| `poll_research` | `notebooklm:read` | research | read-only |
| `import_research_sources` | `notebooklm:write` | research | writes NotebookLM state |
| `get_share_status` | `notebooklm:read` | sharing | read-only |
| `set_share_public` | `notebooklm:share` | sharing | permission-changing/destructive; requires `confirm: true` |

## Deferred or limited areas

- Browser file upload is not implemented.
- Binary/audio/video/PDF bytes are not streamed through the Worker.
- Fine-grained sharing/user-permission management is not exposed.
- OAuth/MCP scopes are capability-level only; there is no per-notebook or per-source object-level authorization in this gateway.
- Private NotebookLM RPCs can break without a source-compatible release.
