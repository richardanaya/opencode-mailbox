# opencode-mailbox

A simple mailbox system for sending and receiving messages between sessions.

## Description

This OpenCode plugin provides a lightweight mailbox system that allows sessions to send messages to each other asynchronously. Messages are stored in a SQLite database with proper indexing for fast lookups.

**NOTE: Mail is stored in `~/.config/opencode/mailbox.db`**

## Installation

```bash
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-mailbox"
  ]
  ...
}
```

## Usage

The plugin provides three tools:

### Tools

- **send_mail** - Send a message to a recipient
- **watch_unread_mail** - Create a hook that auto-injects messages when received
- **stop_watching_mail** - Stop all mail watching for the current session

## API

### send_mail

Send a message to a recipient.

**Parameters:**
- `to` (string, required) - Recipient name or identifier
- `from` (string, required) - Sender name or identifier
- `message` (string, required) - Message content to send

### watch_unread_mail

Create a hook that automatically processes unread messages for a recipient.

**Parameters:**
- `name` (string, required) - Name of the recipient to watch
- `what-to-do-with-it` (string, required) - Instructions on how to process received messages

### stop_watching_mail

Stop all mail watching for the current session.

**Parameters:**
- None

**Returns:** List of recipients that were being watched and have now been stopped.

## Storage

Mail data is persisted in a SQLite database at `~/.config/opencode/mailbox.db`. The database includes:
- Indexed `recipient` column for fast recipient lookups
- Indexed `read` status for efficient watch queries
- WAL (Write-Ahead Logging) mode for better concurrency

## Session Management

When a session ends, all active mail watches for that session are automatically cleaned up.

## Requirements

- Peer dependency: `@opencode-ai/plugin` ^1.1.25

## License

MIT

## Repository

https://github.com/richardanaya/opencode-mailbox
