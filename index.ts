import type { Plugin } from "@opencode-ai/plugin";
import type { createOpencodeClient } from "@opencode-ai/sdk";
import * as path from "path";
import { Database } from "bun:sqlite";

// =============================================================================
// Types
// =============================================================================

interface MailMessage {
  from: string;
  message: string;
  timestamp: number;
  read: boolean;
}

// =============================================================================
// Database
// =============================================================================

let dbFile: string | null = null;
let db: Database | null = null;

// Track active watch intervals (in-memory only)
// recipient -> watch info with reference count (shared across sessions)
const activeWatches = new Map<
  string,
  { interval: NodeJS.Timeout; instructions: string; refCount: number }
>();
// sessionId -> Set of recipients this session is watching
const watchesBySession = new Map<string, Set<string>>();

/**
 * Reset the database connection. Called when we detect the database file
 * has been deleted or the connection has become invalid.
 */
function resetDatabaseConnection(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // Ignore errors when closing an already invalid connection
    }
    db = null;
  }
}

/**
 * Check if a database error is due to a missing or deleted database file.
 * SQLite errors when the file is deleted out from under the connection.
 */
function isDatabaseFileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  // Common SQLite errors when database file is missing/invalid
  return (
    message.includes("database disk image is malformed") ||
    message.includes("no such table") ||
    message.includes("unable to open database file") ||
    message.includes("database is locked") ||
    message.includes("disk i/o error") ||
    message.includes("no more rows available") ||
    message.includes("unable to close") ||
    message.includes("bad parameter or other api misuse")
  );
}

async function getDbFile(
  client: ReturnType<typeof createOpencodeClient>,
): Promise<string> {
  if (!dbFile) {
    const result = await client.path.get();
    dbFile = path.join(result.data!.config, "mailbox.db");
  }
  return dbFile;
}

async function getDatabase(
  client: ReturnType<typeof createOpencodeClient>,
): Promise<Database> {
  if (!db) {
    const file = await getDbFile(client);
    db = new Database(file);

    // Enable WAL mode for better concurrency
    db.run("PRAGMA journal_mode = WAL");

    // Create the messages table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient TEXT NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Create index on recipient for fast lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient)
    `);

    // Create index on read status for watch queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(recipient, read)
    `);
  }
  return db;
}

async function addMessage(
  client: ReturnType<typeof createOpencodeClient>,
  recipient: string,
  sender: string,
  message: string,
  timestamp: number,
): Promise<void> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    INSERT INTO messages (recipient, sender, message, timestamp, read)
    VALUES (?, ?, ?, ?, 0)
  `);
  stmt.run(recipient.toLowerCase(), sender.toLowerCase(), message, timestamp);
}

async function getUnreadMessages(
  client: ReturnType<typeof createOpencodeClient>,
  recipient: string,
): Promise<MailMessage[]> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    SELECT sender as "from", message, timestamp, read
    FROM messages
    WHERE recipient = ? AND read = 0
    ORDER BY timestamp ASC
  `);
  return stmt.all(recipient.toLowerCase()) as MailMessage[];
}

async function markMessageAsRead(
  client: ReturnType<typeof createOpencodeClient>,
  recipient: string,
  timestamp: number,
): Promise<void> {
  const database = await getDatabase(client);
  const stmt = database.prepare(`
    UPDATE messages
    SET read = 1
    WHERE recipient = ? AND timestamp = ?
  `);
  stmt.run(recipient.toLowerCase(), timestamp);
}

// =============================================================================
// Mail Watch System
// =============================================================================

/**
 * Start a timer to watch for unread mail for a specific recipient.
 * Polls every 5 seconds and injects new messages into the session.
 */
function startMailWatch(
  client: ReturnType<typeof createOpencodeClient>,
  recipient: string,
  sessionId: string,
  instructions: string,
): void {
  // Check if already watching this recipient
  const existingWatch = activeWatches.get(recipient);
  if (existingWatch) {
    // Increment reference count since another session is interested
    existingWatch.refCount++;

    // Track that this session owns this watch too
    const sessionWatches = watchesBySession.get(sessionId) ?? new Set();
    sessionWatches.add(recipient);
    watchesBySession.set(sessionId, sessionWatches);
    return;
  }

  const interval = setInterval(async () => {
    try {
      const watch = activeWatches.get(recipient);

      // Watch was stopped
      if (!watch) {
        return;
      }

      // Get unread messages directly from database
      const unreadMessages = await getUnreadMessages(client, recipient);

      if (unreadMessages.length === 0) {
        return;
      }

      // Mark all messages as read first to prevent double-processing
      for (const message of unreadMessages) {
        await markMessageAsRead(client, recipient, message.timestamp);
      }

      // Inject all messages at once as a single concatenated message
      await injectMailMessages(
        client,
        sessionId,
        recipient,
        unreadMessages,
        instructions,
      );
    } catch (error) {
      // Check if this is a database file error (e.g., mailbox.db was deleted)
      if (isDatabaseFileError(error)) {
        console.error(
          `[Mailbox] Database file error for ${recipient}, resetting connection...`,
        );
        resetDatabaseConnection();
        // Don't log as a persistent error - the next poll will recreate the DB
        return;
      }
      console.error(`[Mailbox] Error watching mail for ${recipient}:`, error);
    }
  }, 5000); // Poll every 5 seconds

  activeWatches.set(recipient, { interval, instructions, refCount: 1 });

  // Track that this session owns this watch
  const sessionWatches = watchesBySession.get(sessionId) ?? new Set();
  sessionWatches.add(recipient);
  watchesBySession.set(sessionId, sessionWatches);
}

/**
 * Stop watching mail for a recipient.
 */
function stopMailWatch(recipient: string): void {
  const watch = activeWatches.get(recipient);
  if (watch) {
    clearInterval(watch.interval);
    activeWatches.delete(recipient);
  }
}

/**
 * Inject mail messages into a session using client.session.prompt()
 * This mimics how pocket-universe injects messages.
 * All messages are concatenated into a single injection.
 *
 * IMPORTANT: After injecting the messages, we also need to "wake up" the session
 * so it starts processing. This is done by calling session.prompt() again
 * without noReply: true, or by using session.resume if available.
 */
async function injectMailMessages(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  recipient: string,
  messages: MailMessage[],
  instructions: string,
): Promise<void> {
  // Build concatenated message text
  let injectedText = `[MAIL BATCH] You have ${messages.length} new message(s) for ${recipient}\n\n`;
  
  for (const message of messages) {
    const timestamp = new Date(message.timestamp).toISOString();
    injectedText += `---\nFrom: ${message.from}\nTo: ${recipient}\nTime: ${timestamp}\n\n${message.message}\n\n`;
  }
  
  injectedText += `---\n[Instructions: ${instructions}]\n\nIMPORTANT: remember in order for a sender to see your response, you must send them a mail back. Respond using markdown. Your markdown front-matter can contain a property "choices" which is an array of choices for the mail sender to choose from.  These choices are optional and shouldn't alter your authentic personality in your responses.`;

  try {
    // Step 1: Inject the message with noReply: true (adds to history without waking)
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: "text" as const, text: injectedText }],
      },
    });

    // Step 2: Wake up the session so it starts processing the injected message
    // This is the key step that pocket-universe does - after injection, start the session
    try {
      // First try session.resume if available (cleaner way to wake up)
      const sessionApi = client.session as any;
      if (sessionApi.resume) {
        await sessionApi.resume({
          path: { id: sessionId },
          body: {},
        });
      } else {
        // Fallback: use session.prompt() without noReply to wake up the session
        // We send a minimal "wake up" message that the session will process
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [
              {
                type: "text" as const,
                text: "You have new mail. Please review the injected message above and respond accordingly.",
              },
            ],
          },
        });
      }
    } catch (wakeError) {
      console.warn(
        `[Mailbox] Failed to wake up session ${sessionId}:`,
        wakeError,
      );
      // Don't fail the injection if wake-up fails - the message is still in history
    }
  } catch (error) {
    console.error(`[Mailbox] Failed to inject mail:`, error);
  }
}

// =============================================================================
// Plugin Definition
// =============================================================================

const mailboxPlugin: Plugin = async (ctx) => {
  const client = ctx.client;

  // Get the tool helper and zod schema from the plugin
  const { tool } = await import("@opencode-ai/plugin");
  const z = tool.schema;

  // Create tools with access to client via closure
  const sendMailTool = tool({
    description:
      "Send a message to a recipient's mailbox. Note: The parameters 'to' and 'from' do NOT have to be an email. It can just be a name that the recipient watches for (e.g. 'samus').",
    args: {
      to: z
        .string()
        .describe(
          "Recipient name. Note, this does NOT have to be an email. It can just be a name that the recipient watches for it (e.g. 'samus').",
        ),
      from: z
        .string()
        .describe(
          "Sender name. Note, this does NOT have to be an email. It can just be a name that the sender wants to appear as (e.g. 'link').",
        ),
      message: z.string().describe("Message content to send"),
    },
    async execute(args) {
      const to = args.to.toLowerCase();
      const from = args.from.toLowerCase();
      const timestamp = Date.now();

      // Store the message in SQLite
      try {
        await addMessage(client, to, from, args.message, timestamp);
      } catch (error) {
        // Check if this is a database file error (e.g., mailbox.db was deleted)
        if (isDatabaseFileError(error)) {
          console.error(
            `[Mailbox] Database file error while sending mail, resetting connection...`,
          );
          resetDatabaseConnection();
          // Retry once after resetting the connection
          await addMessage(client, to, from, args.message, timestamp);
        } else {
          throw error;
        }
      }

      return `Mail sent to "${args.to}" from "${args.from}" at ${new Date(timestamp).toISOString()}`;
    },
  });

  const watchUnreadMailTool = tool({
    description:
      "Create a hook that auto-injects messages when they are received for a specific name and can specify what should be done with the messages. Note: The parameters 'name' does NOT have to be an email. It can just be a name that the recipient watches for (e.g. 'samus').",
    args: {
      name: z
        .string()
        .describe(
          "Name of the recipient to watch. Note: this does NOT have to be an email. It can just be a name that the sender uses (e.g. 'samus').",
        ),
      "what-to-do-with-it": z
        .string()
        .describe("Instructions on how to process received messages"),
    },
    async execute(args, toolCtx) {
      const name = args.name.toLowerCase();
      const sessionId = toolCtx.sessionID;

      // Start the timer to watch for mail (if not already watching)
      startMailWatch(client, name, sessionId, args["what-to-do-with-it"]);

      return `Watch created for "${args.name}". New messages will be auto-injected into this session with instructions: ${args["what-to-do-with-it"]}`;
    },
  });

  const stopWatchingMailTool = tool({
    description: "Stop all mail watching for this session",
    args: {},
    async execute(_args, toolCtx) {
      const sessionId = toolCtx.sessionID;
      const stoppedWatches: string[] = [];

      // Get watches belonging to this session
      const sessionWatches = watchesBySession.get(sessionId);

      if (sessionWatches) {
        // Stop each watch this session owned
        for (const recipient of sessionWatches) {
          const watch = activeWatches.get(recipient);
          if (watch) {
            watch.refCount--;
            if (watch.refCount <= 0) {
              stopMailWatch(recipient);
            }
            stoppedWatches.push(recipient);
          }
        }
        watchesBySession.delete(sessionId);
      }

      if (stoppedWatches.length === 0) {
        return "No active mail watches found for this session.";
      }

      return `Stopped watching mail for: ${stoppedWatches.join(", ")}`;
    },
  });

  const checkMailboxWatchStatusTool = tool({
    description:
      "Check the watch status for a specific agent name (recipient). Returns whether the agent is being watched and how many sessions are watching it.",
    args: {
      name: z
        .string()
        .describe(
          "Name of the agent/recipient to check watch status for. Note: this does NOT have to be an email. It can just be a name (e.g. 'samus').",
        ),
    },
    async execute(args) {
      const name = args.name.toLowerCase();
      const watch = activeWatches.get(name);

      if (!watch) {
        return `No active watch found for "${args.name}"`;
      }

      // Count how many sessions are watching this recipient
      let sessionCount = 0;
      for (const [, recipients] of watchesBySession) {
        if (recipients.has(name)) {
          sessionCount++;
        }
      }

      return `"${args.name}" is being watched by ${watch.refCount} session reference(s) (${sessionCount} unique session(s)) with instructions: ${watch.instructions}`;
    },
  });

  return {
    // Register tools
    tool: {
      send_mail: sendMailTool,
      watch_unread_mail: watchUnreadMailTool,
      stop_watching_mail: stopWatchingMailTool,
      check_mailbox_watch_status: checkMailboxWatchStatusTool,
    },

    // Hook: Add tools to primary_tools config
    config: async (input: {
      experimental?: { primary_tools?: string[]; [key: string]: unknown };
      [key: string]: unknown;
    }) => {
      input.experimental ??= {};
      input.experimental.primary_tools ??= [];
      input.experimental.primary_tools.push(
        "send_mail",
        "watch_unread_mail",
        "stop_watching_mail",
        "check_mailbox_watch_status",
      );
    },

    // Hook: Clean up watches when session ends
    hooks: {
      "session.end": async (input: { sessionID: string }) => {
        const sessionId = input.sessionID;

        // Get watches belonging to this session
        const sessionWatches = watchesBySession.get(sessionId);
        if (!sessionWatches) return;

        // For each watch this session owned, decrement ref count
        for (const recipient of sessionWatches) {
          const watch = activeWatches.get(recipient);
          if (watch) {
            watch.refCount--;
            // Only stop the watch if no other sessions are watching
            if (watch.refCount <= 0) {
              stopMailWatch(recipient);
            }
          }
        }

        watchesBySession.delete(sessionId);
      },
    },
  };
};

export default mailboxPlugin;
