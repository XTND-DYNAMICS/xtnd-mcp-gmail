<div align="center">

<img src="assets/icon.svg" width="120" height="120" alt="XTND MCP GMAIL icon" />

# XTND | MCP | GMAIL

**Supreme MCP Server for Gmail & Google Workspace with Dual-Mode App Password & OAuth2 Support.**

[![npm version](https://img.shields.io/npm/v/@xtnd-dynamics/mcp-gmail.svg)](https://www.npmjs.com/package/@xtnd-dynamics/mcp-gmail)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Smithery](https://img.shields.io/badge/Smithery-Registry-red.svg)](https://smithery.ai/servers/xtnd/mcp-gmail)

</div>

`@xtnd-dynamics/mcp-gmail` connects AI agents (Claude Desktop, Cursor, Codex, ChatGPT) to Gmail & Google Workspace. It provides search, thread inspection, markdown parsing, drafts, label management, and outbound email via both **Google App Passwords** (instant setup) and **Google Cloud OAuth2** (enterprise SSO).

---

## 🚀 Quick Start (Choose Your Mode)

### Mode 1: Google App Password Mode (Recommended & Instant)
No Google Cloud Console or OAuth client creation required.

1. Enable 2-Step Verification at [myaccount.google.com/signinoptions/two-step-verification](https://myaccount.google.com/signinoptions/two-step-verification).
2. Generate an App Password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "GMAIL": {
      "command": "npx",
      "args": ["-y", "@xtnd-dynamics/mcp-gmail"],
      "env": {
        "GMAIL_EMAIL": "your-email@gmail.com",
        "GMAIL_APP_PASSWORD": "your-16-char-password"
      }
    }
  }
}
```

---

### Mode 2: Google Cloud OAuth 2.0 Mode (Granular Scopes)
1. Create a Desktop OAuth Client ID in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Run setup in terminal:
```bash
npx -y @xtnd-dynamics/mcp-gmail setup --profile work
```
3. Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "GMAIL": {
      "command": "npx",
      "args": ["-y", "@xtnd-dynamics/mcp-gmail"],
      "env": {
        "MCP_GMAIL_PROFILE": "work"
      }
    }
  }
}
```

---

## 🛠️ Complete Tool Suite

| Category | Tools |
|---|---|
| **Reading & Search** | `search_emails`, `get_recent_emails`, `get_email`, `get_thread`, `get_attachment`, `get_raw_email`, `get_profile` |
| **Outbound Email** | `send_email`, `reply_email`, `forward_email` |
| **Drafts** | `create_draft`, `create_reply_draft`, `create_forward_draft`, `update_draft`, `list_drafts`, `get_draft`, `send_draft`, `delete_draft` |
| **Organization & Labels** | `list_labels`, `create_label`, `rename_label`, `delete_label`, `modify_email_labels`, `batch_modify_labels` |
| **Triage & Cleanup** | `archive_email`, `star_email`, `mark_email_read`, `move_emails`, `trash_email`, `untrash_email`, `delete_email_permanently` |

The local stdio server and the hosted Worker serve the same tools from one definition
(`src/mcp/app-password-server.ts`). On the hosted Worker each tool needs its OAuth scope
(`mail.read`, `mail.manage`, `mail.send` or `mail.delete`), and because it has no filesystem,
attachments are passed as `{ filename, contentType, dataBase64 }` objects and `saveToPath` is not available.

---

## ☁️ Hosted Cloudflare Worker Endpoint

`xtnd-mcp-gmail` is deployable as a global Streamable HTTP MCP Worker:
* **Endpoint:** `https://gmail.mcp.xgi.io` (the former `/mcp` path still works as an alias)
* **Sign-in:** OAuth 2.1 with dynamic client registration and PKCE. Add `https://gmail.mcp.xgi.io` as a custom connector in ChatGPT or Claude with authentication **OAuth**; the sign-in page asks for the Gmail address and an [App Password](https://myaccount.google.com/apppasswords), checks them with Gmail and stores them encrypted. One connector per mailbox. API keys (`Authorization: Bearer <key>`) keep working.
* **OAuth metadata:** `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
* **Discovery Card:** `https://gmail.mcp.xgi.io/.well-known/mcp/server-card.json`
* **OpenAPI 3.1:** `https://gmail.mcp.xgi.io/openapi.json`
* **Health Probe:** `https://gmail.mcp.xgi.io/health`
* **Former hosted tool names** still answer: `list_folders`, `create_folder`, `rename_folder`, `delete_folder`, `get_email_content`, `get_email_thread`, `mark_emails` and `delete_emails` are mapped onto the tools above.

---

## 📜 License
MIT © [XTND Dynamics](https://github.com/XTND-DYNAMICS)
