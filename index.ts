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
const activeWatches = new Map<string, { interval: NodeJS.Timeout; instructions: string }>();

async function getDbFile(client: ReturnType<typeof createOpencodeClient>): Promise<string> {
  if (!dbFile) {
    const result = await client.path.get();
    dbFile = path.join(result.data!.config, "mailbox.db");
  }
  return dbFile;
}

async function getDatabase(client: ReturnType<typeof createOpencodeClient>): Promise<Database> {
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
  timestamp: number
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
  recipient: string
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
  timestamp: number
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
  instructions: string
): void {
  // Don't start multiple watches for the same recipient
  if (activeWatches.has(recipient)) {
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

      // Process each unread message
      for (const message of unreadMessages) {
        // Mark as read immediately to prevent double-processing
        await markMessageAsRead(client, recipient, message.timestamp);

        // Inject the message into the session
        await injectMailMessage(
          client,
          sessionId,
          recipient,
          message,
          instructions
        );
      }
    } catch (error) {
      console.error(`[Mailbox] Error watching mail for ${recipient}:`, error);
    }
  }, 5000); // Poll every 5 seconds

  activeWatches.set(recipient, { interval, instructions });
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
 * Inject a mail message into a session using client.session.prompt()
 * This mimics how pocket-universe injects messages.
 * 
 * IMPORTANT: After injecting the message, we also need to "wake up" the session
 * so it starts processing. This is done by calling session.prompt() again
 * without noReply: true, or by using session.resume if available.
 */
async function injectMailMessage(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  recipient: string,
  message: MailMessage,
  instructions: string
): Promise<void> {
  const timestamp = new Date(message.timestamp).toISOString();
  
  // Format the injected message
  const injectedText = `[MAIL] From: ${message.from}\nTo: ${recipient}\nTime: ${timestamp}\n\n${message.message}\n\n[Instructions: ${instructions}]`;

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
            parts: [{ type: "text" as const, text: "You have new mail. Please review the injected message above and respond accordingly." }],
          },
        });
      }
    } catch (wakeError) {
      console.warn(`[Mailbox] Failed to wake up session ${sessionId}:`, wakeError);
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
    description: "Send a message to a recipient's mailbox",
    args: {
      to: z.string().describe("Recipient name. Note, this does NOT have to be an email. It can just be a name that the recipient watches for it (e.g. 'samus')."),
      from: z.string().describe("Sender name. Note, this does NOT have to be an email. It can just be a name that the sender wants to appear as (e.g. 'link')."),
      message: z.string().describe("Message content to send"),
    },
    async execute(args) {
      const to = args.to.toLowerCase();
      const from = args.from.toLowerCase();
      const timestamp = Date.now();
      
      // Store the message in SQLite
      await addMessage(client, to, from, args.message, timestamp);
      
      return `Mail sent to "${args.to}" from "${args.from}" at ${new Date(timestamp).toISOString()}`;
    },
  });

  const watchUnreadMailTool = tool({
    description: "Create a hook that auto-injects messages when they are received for a specific name and can specify what should be done with the messages",
    args: {
      name: z.string().describe("Name of the recipient to watch. Note: this does NOT have to be an email. It can just be a name that the sender uses (e.g. 'samus')."),
      "what-to-do-with-it": z.string().describe("Instructions on how to process received messages"),
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
    description: "Stop all mail watching",
    args: {},
    async execute() {
      const stoppedWatches: string[] = [];
      
      // Stop all active watches
      for (const recipient of activeWatches.keys()) {
        stopMailWatch(recipient);
        stoppedWatches.push(recipient);
      }
      
      if (stoppedWatches.length === 0) {
        return "No active mail watches found.";
      }
      
      return `Stopped watching mail for: ${stoppedWatches.join(", ")}`;
    },
  });

  return {
    // Register tools
    tool: {
      send_mail: sendMailTool,
      watch_unread_mail: watchUnreadMailTool,
      stop_watching_mail: stopWatchingMailTool,
    },

    // Hook: Add tools to primary_tools config
    config: async (input: { experimental?: { primary_tools?: string[]; [key: string]: unknown }; [key: string]: unknown }) => {
      input.experimental ??= {};
      input.experimental.primary_tools ??= [];
      input.experimental.primary_tools.push("send_mail", "watch_unread_mail", "stop_watching_mail");
    },

    // Hook: Clean up all watches when session ends
    hooks: {
      "session.end": async () => {
        // Stop all watches for this session
        for (const recipient of activeWatches.keys()) {
          stopMailWatch(recipient);
        }
      },
    },
  };
};

export default mailboxPlugin;
