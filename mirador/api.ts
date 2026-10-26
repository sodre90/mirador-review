/**
 * Mirador's canvas plugin API, version 3, as this plugin uses it. Mirador doesn't publish these types yet, so this is a
 * copy of its shared/canvas-plugins.ts and of the `window.mirador` bridge in its shared/canvas-document.ts.
 */

/**
 * Where a plugin's item shows: among the canvas's pages, or in the tab beside the canvas that holds the agent's plan,
 * above the plan, where the newest one the user hasn't dismissed is the one shown.
 */
export type PluginItemPlacement = "page" | "tab";

/** Where an item that opens with room goes: the canvas pane full screen, over the chat, or beside it. */
export type ItemRoom = "fullscreen" | "beside";

/** A kind of item a plugin's canvas view draws. */
export interface PluginItemType<Data = unknown> {
  /** A character or two, for the canvas's list of pages and its header. */
  icon: string;
  placement: PluginItemPlacement;
  /** An item in the tab: how far along it is in a few characters, e.g. "3/5", for the tab's toggle. */
  count?(data: Data): string;
  /** What came of the item in a few words, such as a review's verdict, shown beside its title in the canvas's bar and list. */
  outcome?(data: Data): string | undefined;
  /**
   * A new item takes room and shows the canvas if it was hidden: full screen, or with `setting`, where that setting of
   * the plugin's says, whose choices are the rooms, "fullscreen" and "beside" the chat.
   */
  opensWithRoom?: boolean | { setting: string };
  /**
   * The item's data as the canvas lists it, e.g. without a run of the plugin's that Mirador's restart cut short, which
   * the plugin's host code would otherwise still show as running.
   */
  listed?(item: PluginItem<Data>): Data;
}

/** An item a plugin published in a conversation's canvas, as its host code sees it. */
export interface PluginItem<Data = unknown> {
  id: string;
  type: string;
  title: string;
  data: Data;
  createdAt: number;
  /** The user took it out of the tab. */
  dismissed: boolean;
  /** When the agent last changed it in place, from a tool; null until it does. */
  agentEditedAt: number | null;
}

/** The conversation a plugin's code runs for, and its items in the canvas there. */
export interface CanvasPluginContext<Data = unknown> {
  conversationId: string;
  /** The plugin's items in the conversation, oldest first. */
  items(): PluginItem<Data>[];
  /** Changes one of them in place. Made while a tool runs, it is the agent's change, and the tab's toggle flashes for it. */
  change(itemId: string, change: { title?: string; data?: Data }): PluginItem<Data>;
  /** What the plugin keeps across conversations and restarts, such as how its views were laid out; values are JSON. */
  storage: CanvasPluginStorage;
}

export interface CanvasPluginStorage {
  get(key: string): unknown;
  /** Undefined takes the key out. */
  set(key: string, value: unknown): void;
}

export interface CanvasActionContext<Data = unknown> extends CanvasPluginContext<Data> {
  /** Sends the agent a message, as if the user wrote it; `afterTurn` keeps it queued until the agent's turn ends. */
  prompt(text: string, options?: { afterTurn?: boolean }): Promise<void>;
}

export interface CanvasToolContext<Data = unknown> extends CanvasPluginContext<Data> {
  /** Shows a new item, of one of the plugin's types, in the canvas. */
  publish(item: { type: string; title: string; data: Data }): PluginItem<Data>;
}

/** A tool the agent calls on the canvas server, next to show, ask and the rest. */
export interface CanvasTool<Data = unknown> {
  description: string;
  /** JSON Schema of an object: the tool's arguments, which Mirador checks before calling run. */
  input: Record<string, unknown>;
  /** Resolves to the text the agent gets. What it throws reaches the agent as a tool error, so its message should say what would work. */
  run(input: unknown, context: CanvasToolContext<Data>): string | Promise<string>;
}

/** What the agent hears with the user's next message; heard() runs once that message went. */
export interface CanvasPluginNote {
  text: string;
  heard(): void;
}

/**
 * What a plugin's canvas host module exports. Mirador calls it in its own process; every call is guarded, and what a
 * call throws goes to whoever caused it, the agent or the view, as its message.
 */
export interface CanvasHost<Data = unknown> {
  /** The kinds of item the plugin's tools publish, by name. */
  items: Record<string, PluginItemType<Data>>;
  /** By name, which is the tool's name on the canvas server: lower case, digits and underscores. */
  tools: Record<string, CanvasTool<Data>>;
  /**
   * A line each, e.g. "- checklist: …", for the canvas server's instructions and for what Claude Code and pi are told
   * when Settings ask for the canvas often.
   */
  guidance?: { instructions?: string; often?: string };
  /** The user's action in an item's view, sent with `mirador.send`; resolves to what send resolves to in the view. */
  action?(item: PluginItem<Data>, action: unknown, context: CanvasActionContext<Data>): unknown;
  /** What the agent should hear of with the user's next message, such as what the user did in an item. */
  note?(context: CanvasPluginContext<Data>): CanvasPluginNote | null;
}

/** What a plugin item's view draws besides the item: how it is to look in Mirador, and what the user saw of it. */
export interface PluginItemContext {
  /** When the agent last changed the item while the user had it in view; what the agent changed since is new to them. */
  seenAgentEditAt: number | null;
  /** Settings let images from other sites load, so the view may show them rather than link to them. */
  imagesFromOtherSites: boolean;
  /** Whether the canvas fills the workspace; absent where it can't, as in the tab or on the phone. */
  fullscreen?: boolean;
  /** What Settings say text fields do as the user types. */
  typingAids?: { autocorrect: boolean; predictions: boolean };
}

/** `window.mirador` in a plugin's canvas view, as its bridge makes it. */
export interface PluginViewBridge<Data = unknown> {
  onItem(listener: (item: PluginItem<Data>, context: PluginItemContext) => void): () => void;
  send(action: unknown): Promise<unknown>;
  prompt(text: string): Promise<void>;
  setFullscreen(on: boolean): void;
}
