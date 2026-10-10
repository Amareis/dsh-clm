/**
 * Context viewer tab — Client module (TypeScript port of the original
 * client.js; behavior-preserving). Served raw by the host clientModules
 * service through `window.__ModuleLoader__`, so this file is compiled as a
 * SCRIPT (module: none) with no imports — ambient declarations below stand
 * in for the loader's `require` and the injected services.
 *
 * Spec: docs/context-viewer-tab.md.
 */

// ---------------------------------------------------------------------
// Ambient loader / React declarations
// ---------------------------------------------------------------------

interface ClientPluginModule {
  inject: string[];
  apply(ctx: ClientPluginContext): void;
}

interface ModuleLoaderApi {
  load(def: { id: string; factory(require: (name: string) => any): ClientPluginModule }): void;
}

interface Window {
  __ModuleLoader__: ModuleLoaderApi;
}

declare function require(name: string): any;

interface ReactModule {
  createElement: (...args: unknown[]) => unknown;
  memo<P>(component: (props: P) => unknown): (props: P) => unknown;
  useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  useRef<T>(initial: T): { current: T };
  useMemo<T>(factory: () => T, deps: unknown[]): T;
  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: unknown[]): T;
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T;
}

// ---------------------------------------------------------------------
// Wire shapes (loose — the session log is schema-heterogeneous by design)
// ---------------------------------------------------------------------

type ContentBlock = Record<string, unknown>;

interface WireMessage {
  role?: string;
  content?: ContentBlock[];
  isError?: boolean;
  toolCallId?: string;
}

type SurfaceOp = "append" | { op: "replace"; startSeq: number; endSeq: number } | { startSeq: number; endSeq: number };

interface SessionEventData {
  message?: WireMessage;
  source?: { kind?: string } | string | null;
  error?: unknown;
  name?: string;
  arguments?: string;
  callId?: string;
  toolCallId?: string;
  [key: string]: unknown;
}

interface SessionEvent {
  seq: number;
  time: number;
  type: string;
  data?: SessionEventData;
  surfaceOp?: SurfaceOp;
}

// ---------------------------------------------------------------------
// Fold domain model
// ---------------------------------------------------------------------

interface FoldNode {
  seq: number;
  kind: string;
  role: string | null;
  content: ContentBlock[] | null;
  isError: boolean;
  replaced?: { startSeq: number; endSeq: number };
  boundary?: boolean;
}

interface EditBoundary {
  kind: "edit";
  seq: number;
  time: number;
  receipt: string;
  callSeq: number;
  callText: string;
  resultText: string;
}

interface RewriteBoundary {
  kind: "compaction" | "rewrite";
  seq: number;
  time: number;
  receipt: string;
}

type Boundary = EditBoundary | RewriteBoundary;

interface Version {
  id: string;
  openedBy: Boundary | null;
  closedBy: Boundary | null;
  nodes: FoldNode[];
}

interface PendingEdit {
  callId: string;
  seq: number;
  time: number;
  name: string;
  arguments: string;
  nodes: FoldNode[];
}

interface FoldState {
  seq: number;
  time: number;
  uncertain: boolean;
  nodes: FoldNode[];
  versions: Version[];
  pending: PendingEdit | null;
  compactionHint: boolean;
  open: Boundary | null;
}

interface FoldSnapshot {
  state: FoldState | null;
}

// Versions sidebar rows: a real Version, or the synthetic "current" segment.
interface CurrentVersionRow {
  kind: "current";
  seq: number;
  nodes: FoldNode[];
  receipt: string;
  openedBy: Boundary | null;
}
type DisplayVersion = Version | CurrentVersionRow;

function isCurrentRow(v: DisplayVersion): v is CurrentVersionRow {
  return (v as CurrentVersionRow).kind === "current";
}

// ---------------------------------------------------------------------
// Injected client services (structural minimum)
// ---------------------------------------------------------------------

interface ExternalStoreSource<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

interface ConversationTarget extends ExternalStoreSource<FoldSnapshot | null> {}

interface ConversationBinding {
  target(name: string): ConversationTarget;
}

interface SessionSnapshotInfo {
  hasMore?: boolean;
  loadingOlder?: boolean;
  openState?: unknown;
}

interface ClientSession {
  getSnapshot?(): SessionSnapshotInfo | null;
  loadOlder(): Promise<void>;
  loadThrough(seq: number): Promise<void>;
}

interface SessionBinding {
  session?: ClientSession | null;
}

interface EventContext {
  key: string;
  id: string;
  state?: FoldState;
}

interface EventMatch {
  event: SessionEvent;
}

interface EventReader {
  previous(kind: string): { state?: FoldState } | null;
}

interface ViewNode {
  key: string;
  kind: string;
  id: string;
  target: string;
  data: FoldState;
}

interface UiConversationService {
  views: {
    register(def: { target: string; create(): unknown }): void;
  };
  events: {
    register(def: {
      kind: string;
      target: string;
      match(event: SessionEvent): { id: string; role: string } | null;
      start(context: EventContext | undefined, match: EventMatch, reader: EventReader): FoldState;
      update(context: EventContext): FoldState | undefined;
      buildViewNode(context: EventContext): ViewNode | null;
    }): void;
  };
  binding(sessionId: string): ConversationBinding;
}

interface ViewProps {
  source?: ExternalStoreSource<FoldSnapshot>;
  loadOlder?(): Promise<void>;
  hasMore?(): boolean;
}

interface SlotsService {
  inject(name: string, callback: () => void): void;
  register(
    def: {
      name: string;
      id: string;
      order: number;
      label: string;
      inject(sessionId: string): ViewProps;
    },
    component: (props: ViewProps) => unknown,
  ): void;
}

interface SessionsService {
  binding(sessionId: string): SessionBinding;
}

interface ClientPluginContext {
  slots: SlotsService;
  sessions: SessionsService;
  uiConversation: UiConversationService;
}

// ---------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------

window.__ModuleLoader__.load({
  id: "@local/clm-context-viewer",
  factory(require) {
    const React = require("react") as ReactModule;
    const h = React.createElement;

    // ------------------------------------------------------------------
    // Pure surface fold (hand-rolled port of dsh-session/surface +
    // token-meter/surface-fold semantics; client bundles stay dep-free).
    // ------------------------------------------------------------------

    const KIND = "clm-context-surface";
    const TARGET = "clm-context";

    const SURFACE_TYPES = new Set([
      "system/message", "developer/message", "user/message", "assistant/message", "tool/result",
    ]);
    const COMPACTION_HINT_TYPES = new Set([
      "compaction/start", "compaction/summary", "compaction/prune",
    ]);

    function isInteresting(event: SessionEvent): boolean {
      return SURFACE_TYPES.has(event.type)
        || event.type === "tool/call"
        || COMPACTION_HINT_TYPES.has(event.type)
        || event.type === "compaction/end";
    }

    const EMPTY_STATE: FoldState = {
      seq: -1,
      time: 0,
      uncertain: false,
      nodes: [],
      versions: [],
      pending: null,
      compactionHint: false,
      open: null,
    };

    /** deriveEventMessage port: null when the event produces no wire message. */
    function messageOf(event: SessionEvent): WireMessage | null {
      const data = event.data;
      if (!data || typeof data !== "object") return null;
      switch (event.type) {
        case "user/message": return data as unknown as WireMessage;
        case "system/message":
        case "developer/message":
        case "assistant/message": {
          const message = data.message;
          if (!message || !Array.isArray(message.content) || message.content.length === 0) return null;
          return message;
        }
        case "tool/result": return data.message || null;
        default: return null;
      }
    }

    // Event objects are stable across engine rematerialization, so caching
    // nodes per event keeps React.memo effective even after history prepends
    // (the fold replays from the window start and would otherwise rebuild
    // every node object).
    const nodeCache = new WeakMap<SessionEvent, FoldNode>();

    function makeNode(event: SessionEvent): FoldNode {
      const cached = nodeCache.get(event);
      if (cached !== undefined) return cached;
      const message = messageOf(event);
      const data: SessionEventData = event.data || {};
      // user/message data.source.kind distinguishes injected messages:
      // runtime-context, skill-catalog, agent-instructions, agent-message…
      const source = typeof data.source === "object" ? data.source : null;
      const sourceKind = source !== null && typeof source.kind === "string" ? source.kind : null;
      const node: FoldNode = {
        seq: event.seq,
        kind: event.type,
        role: sourceKind && sourceKind !== "user"
          ? sourceKind
          : message && typeof message.role === "string" ? message.role : null,
        content: message && Array.isArray(message.content) ? message.content : null,
        isError: event.type === "tool/result"
          && (data.error !== undefined || (message != null && message.isError === true)),
        replaced: event.surfaceOp !== undefined && event.surfaceOp !== "append"
          ? { startSeq: event.surfaceOp.startSeq, endSeq: event.surfaceOp.endSeq }
          : undefined,
      };
      nodeCache.set(event, node);
      return node;
    }

    /** Synthetic boundary rows appended to a version closed by an edit. */
    function makeBoundaryNode(seq: number, kind: string, text: string, isError: boolean): FoldNode {
      return {
        seq, kind, role: "tool", boundary: true, isError: isError === true,
        content: [{ type: "text", text }],
        replaced: undefined,
      };
    }

    function textOf(message: WireMessage | null): string {
      if (!message || !Array.isArray(message.content)) return "";
      const parts: string[] = [];
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string") parts.push(block.text);
        else if (typeof block.thinking === "string") parts.push(block.thinking);
      }
      return parts.join("\n");
    }

    function formatCall(name: string, argumentsText: string): string {
      let pretty = argumentsText;
      try { pretty = JSON.stringify(JSON.parse(argumentsText), null, 2); } catch { /* keep raw */ }
      return name + " " + pretty;
    }

    /** One fold step; returns `prev` unchanged when the event is irrelevant. */
    function foldStep(prev: FoldState, event: SessionEvent): FoldState {
      let state = prev;
      const isSurface = SURFACE_TYPES.has(event.type) && event.surfaceOp !== undefined;
      const isReplace = isSurface && event.surfaceOp !== "append";
      const nodesBefore = state.nodes;

      // 1. surface fold
      if (isSurface) {
        const node = makeNode(event);
        if (!isReplace) {
          state = { ...state, nodes: [...state.nodes, node] };
        } else {
          const op = event.surfaceOp as { startSeq: number; endSeq: number };
          const startIdx = state.nodes.findIndex((n) => n.seq === op.startSeq);
          const endIdx = state.nodes.findIndex((n) => n.seq === op.endSeq);
          if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
            state = { ...state, uncertain: true };
          } else {
            const nodes = state.nodes.slice();
            nodes.splice(startIdx, endIdx - startIdx + 1, node);
            state = { ...state, nodes };
          }
        }
      }

      // 2. compaction attribution
      if (COMPACTION_HINT_TYPES.has(event.type)) {
        state = { ...state, compactionHint: true };
      } else if (event.type === "compaction/end") {
        state = { ...state, compactionHint: false };
      }

      // 3. version slicing: a boundary CLOSES the current segment (its nodes
      // are the surface in force at the boundary's start, plus the closing
      // call/result for edits) and OPENS the next one with its metadata.
      if (event.type === "tool/call" && event.data && event.data.name === "context_edit") {
        let parsed: { op?: string; edits?: unknown } | null = null;
        try { parsed = JSON.parse(event.data.arguments as string); } catch { /* ignore */ }
        const isEdit = parsed !== null
          && (parsed.op === "edit" || (parsed.op === undefined && Array.isArray(parsed.edits)));
        if (isEdit) {
          state = {
            ...state,
            pending: {
              callId: event.data.callId as string, seq: event.seq, time: event.time,
              name: event.data.name, arguments: event.data.arguments as string,
              nodes: nodesBefore,
            },
          };
        }
      } else if (event.type === "tool/result" && state.pending !== null) {
        const pending = state.pending;
        const data: SessionEventData = event.data || {};
        const message = data.message;
        const matchesCall = (message != null && message.toolCallId === pending.callId)
          || data.toolCallId === pending.callId;
        if (matchesCall) {
          const failed = data.error !== undefined || (message != null && message.isError === true);
          if (failed) {
            state = { ...state, pending: null };
          } else {
            const resultText = textOf(message ?? null);
            const callText = formatCall(pending.name, pending.arguments);
            const boundary: EditBoundary = {
              kind: "edit", seq: event.seq, time: event.time,
              receipt: resultText.split("\n")[0].slice(0, 160),
              // Full call/result payloads so the NEXT segment can render the
              // same boundary rows at its start (display layer only).
              callSeq: pending.seq, callText, resultText,
            };
            const version: Version = {
              id: (state.open ? String(state.open.seq) : "start") + ":" + event.seq,
              openedBy: state.open,
              closedBy: boundary,
              nodes: [
                ...pending.nodes,
                makeBoundaryNode(pending.seq, "tool/call", callText, false),
                makeBoundaryNode(event.seq, "tool/result", resultText, false),
              ],
            };
            state = {
              ...state, pending: null, open: boundary,
              versions: [...state.versions, version],
            };
          }
        }
      } else if (isReplace && state.pending === null) {
        const boundary: RewriteBoundary = {
          kind: state.compactionHint ? "compaction" : "rewrite",
          seq: event.seq, time: event.time, receipt: "",
        };
        const version: Version = {
          id: (state.open ? String(state.open.seq) : "start") + ":" + event.seq,
          openedBy: state.open,
          closedBy: boundary,
          nodes: nodesBefore,
        };
        state = {
          ...state, compactionHint: false, open: boundary,
          versions: [...state.versions, version],
        };
      }

      if (state === prev) return prev;
      return { ...state, seq: event.seq, time: event.time };
    }

    // ------------------------------------------------------------------
    // Conversation target builder: snapshot = the single context's state.
    // ------------------------------------------------------------------

    const EMPTY_SNAPSHOT: FoldSnapshot = { state: null };

    interface BuilderInput {
      nodes: { data: FoldState }[];
      upserts: { data: FoldState }[];
    }

    class ClmContextBuilder {
      readonly empty = EMPTY_SNAPSHOT;
      latestSeq = -1;
      current: FoldSnapshot = EMPTY_SNAPSHOT;

      replace(input: BuilderInput): FoldSnapshot {
        this.latestSeq = -1;
        for (const node of input.nodes) this.track(node);
        console.info("[clm-context] builder.replace: nodes=" + input.nodes.length
          + " latestSeq=" + this.latestSeq);
        return this.current;
      }

      apply(input: BuilderInput): FoldSnapshot {
        const before = this.current;
        for (const node of input.upserts) this.track(node);
        console.info("[clm-context] builder.apply: upserts=" + input.upserts.length
          + " latestSeq=" + this.latestSeq
          + " snapshotChanged=" + (this.current !== before));
        return this.current;
      }

      track(node: { data: FoldState } | null | undefined): void {
        const state = node && node.data;
        if (!state || typeof state.seq !== "number") return;
        // A prepend replays contexts: the latest context comes back with the
        // SAME seq but a NEW state object (older events folded in). Returning
        // the identical snapshot makes useSyncExternalStore bail out, so a
        // same-seq state with a different identity must still win.
        if (state.seq > this.latestSeq
          || (state.seq === this.latestSeq && state !== this.current.state)) {
          this.latestSeq = state.seq;
          this.current = { state };
        }
      }
    }

    // ------------------------------------------------------------------
    // Rendering.
    // ------------------------------------------------------------------

    const ROLE_COLORS: Record<string, string> = {
      system: "var(--dsw-alias-label-tertiary)",
      developer: "#a371f7",
      user: "#58a6ff",
      assistant: "#3fb950",
      tool: "#d29922",
      "runtime-context": "#39c5cf",
      "skill-catalog": "#39c5cf",
      "agent-instructions": "#39c5cf",
      "agent-message": "#bc8cff",
      "subagent-settled": "#bc8cff",
    };

    // Compact row labels for long injected-message roles.
    const ROLE_LABELS: Record<string, string> = {
      "runtime-context": "runtime",
      "skill-catalog": "skills",
      "agent-instructions": "instr",
      "agent-message": "agent",
      "subagent-settled": "subagent",
    };

    function roleOf(node: FoldNode): string {
      if (node.role) return node.role;
      if (node.kind === "tool/result" || node.kind === "tool/call") return "tool";
      return node.kind.split("/")[0];
    }

    function blockText(block: ContentBlock): string {
      if (!block || typeof block !== "object") return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.thinking === "string") return "💭 " + block.thinking;
      if (block.type === "tool-call" || block.type === "tool_call" || block.type === "toolCall") {
        const name = (block.name as string) || "?";
        let args = typeof block.arguments === "string" ? block.arguments : "";
        try { args = JSON.stringify(JSON.parse(args), null, 2); } catch { /* keep raw */ }
        return "🔧 " + name + (args ? "\n" + args : "");
      }
      if (block.type === "image") return "[image]";
      if (block.type === "file") return "[file] " + (((block.attachment as { name?: string }) || {}).name || "");
      return "[" + ((block.type as string) || "block") + "]";
    }

    function nodeText(node: FoldNode): string {
      if (!node.content) return "(empty — surface position retained)";
      return node.content.map(blockText).filter(Boolean).join("\n");
    }

    function previewText(node: FoldNode): string {
      const text = nodeText(node).replace(/\s+/g, " ").trim();
      return text.length > 140 ? text.slice(0, 140) + "…" : text;
    }

    function useSource<T>(source: ExternalStoreSource<T>): T {
      return React.useSyncExternalStore(
        (listener) => source.subscribe(listener),
        () => source.getSnapshot(),
      );
    }

    type Style = Record<string, string | number>;

    const styles: Record<string, Style> = {
      root: {
        display: "flex", flexDirection: "column",
        height: "100%", minHeight: 0, width: "100%", overflow: "hidden",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        font: "var(--dsw-font-xxs-12)",
      },
      header: {
        flex: "none", display: "flex", gap: 12, alignItems: "center",
        padding: "8px 12px",
        borderBottom: "0.5px solid var(--dsw-alias-border-l1)",
        color: "var(--dsw-alias-label-secondary)",
        font: "var(--dsw-font-xs-13)",
      },
      body: { flex: 1, display: "flex", minHeight: 0, minWidth: 0, overflow: "hidden" },
      // The composer overlays the view (data-conversation-composer-overlay), so
      // every own scroller reserves clearance under it — same as the trajectory
      // ledger does via --dsh-trajectory-bottom-clearance.
      sidebar: {
        flex: "none", width: 250, overflowY: "auto", minHeight: 0,
        borderRight: "0.5px solid var(--dsw-alias-border-l1)",
        paddingBottom: "calc(var(--dsh-composer-height, 152px) + 16px)",
      },
      list: {
        flex: 1, overflowY: "auto", minWidth: 0, minHeight: 0,
        paddingBottom: "calc(var(--dsh-composer-height, 152px) + 16px)",
      },
      detail: {
        flex: "none", width: 420, overflowY: "auto", minHeight: 0,
        borderLeft: "0.5px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))",
        paddingBottom: "calc(var(--dsh-composer-height, 152px) + 16px)",
      },
      badge: {
        flex: "none", padding: "1px 6px", borderRadius: 4,
        background: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.15))",
        font: "var(--dsw-font-xxxs-11)",
      },
      button: {
        flex: "none", padding: "2px 10px", borderRadius: 4, cursor: "pointer",
        border: "0.5px solid var(--dsw-alias-border-l1)",
        background: "transparent", color: "var(--dsw-alias-label-secondary)",
        font: "var(--dsw-font-xxxs-11)",
      },
    };

    interface VersionRowProps {
      version: DisplayVersion;
      versionKey: string;
      selected: boolean;
      onSelect(key: string): void;
    }

    const VersionRow = React.memo(function VersionRow(props: VersionRowProps) {
      const v = props.version;
      const isCurrent = isCurrentRow(v);
      const label = isCurrent ? "current" : v.id;
      const sub = isCurrent
        ? "seq " + v.seq + " · " + v.nodes.length + " nodes"
        : (v.openedBy ? v.openedBy.kind : "initial")
          + " → " + (v.closedBy ? v.closedBy.kind : "?")
          + " · " + v.nodes.length;
      const receipt = isCurrent ? v.receipt : (v.closedBy ? v.closedBy.receipt : "") || "";
      return h("div", {
        onClick: () => props.onSelect(props.versionKey),
        style: {
          padding: "6px 10px", cursor: "pointer",
          borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
          background: props.selected ? "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.18))" : "transparent",
        },
      },
        h("div", {
          style: {
            display: "flex", gap: 6, alignItems: "baseline",
            color: "var(--dsw-alias-label-primary)",
            font: "var(--dsw-font-xxs-12)",
          },
        },
          h("span", { style: { fontWeight: 600 } }, label),
          h("span", {
            style: { color: "var(--dsw-alias-label-tertiary)", font: "var(--dsw-font-xxxs-11)" },
          }, sub)),
        receipt
          ? h("div", {
              style: {
                marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: "var(--dsw-alias-label-tertiary)", font: "var(--dsw-font-xxxs-11)",
              },
            }, receipt)
          : null);
    });

    interface NodeRowProps {
      node: FoldNode;
      selected: boolean;
      collapsed: boolean;
      onSelectNode(seq: number): void;
    }

    const NodeRow = React.memo(function NodeRow(props: NodeRowProps) {
      const node = props.node;
      const role = roleOf(node);
      const color = ROLE_COLORS[role] || "var(--dsw-alias-label-secondary)";
      return h("div", {
        onClick: () => props.onSelectNode(node.seq),
        style: {
          display: "flex", gap: 8, alignItems: "baseline",
          padding: "3px 10px", cursor: "pointer",
          borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
          opacity: props.collapsed ? 0.45 : 1,
          background: props.selected
            ? "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.18))"
            : node.boundary ? "rgba(210,153,34,0.08)" : "transparent",
        },
      },
        h("span", {
          style: {
            flex: "none", width: 64, fontWeight: 600, color,
            font: "var(--dsw-font-xxxs-11)",
          },
        }, ROLE_LABELS[role] || role),
        h("span", {
          style: { flex: "none", width: 44, color: "var(--dsw-alias-label-tertiary)", font: "var(--dsw-font-xxxs-11)" },
        }, String(node.seq)),
        node.boundary
          ? h("span", { style: { ...styles.badge, color: "#d29922" } }, "boundary")
          : null,
        props.collapsed
          ? h("span", { style: { ...styles.badge, color: "#f85149" } }, "collapsed")
          : null,
        node.isError
          ? h("span", { style: { ...styles.badge, color: "#f85149" } }, "error")
          : null,
        node.replaced
          ? h("span", { style: { ...styles.badge, color: "#d29922" } },
              "replaces " + node.replaced.startSeq + "–" + node.replaced.endSeq)
          : null,
        h("span", {
          style: {
            flex: 1, minWidth: 0, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
            textDecoration: props.collapsed ? "line-through" : "none",
            color: "var(--dsw-alias-label-primary)",
          },
        }, previewText(node)));
    });

    // One wire message carries an ARRAY of content blocks (thinking, text,
    // tool-call…); the detail panel renders each block as its own section,
    // like the trajectory does, instead of concatenating them.
    function BlockView(props: { block: ContentBlock }) {
      const block = props.block;
      if (!block || typeof block !== "object") return null;
      if (typeof block.text === "string") {
        return h("div", {
          style: {
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            font: "var(--dsw-font-xxs-12)", lineHeight: 1.5,
            color: "var(--dsw-alias-label-primary)",
          },
        }, block.text);
      }
      if (typeof block.thinking === "string") {
        return h("div", {
          style: {
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            font: "var(--dsw-font-xxs-12)", lineHeight: 1.5,
            color: "var(--dsw-alias-label-secondary)",
            borderLeft: "2px solid var(--dsw-alias-border-l1)",
            paddingLeft: 8,
          },
        }, "💭 " + block.thinking);
      }
      if (block.type === "tool-call" || block.type === "tool_call" || block.type === "toolCall") {
        let args = typeof block.arguments === "string" ? block.arguments : "";
        try { args = JSON.stringify(JSON.parse(args), null, 2); } catch { /* keep raw */ }
        return h("div", {
          style: {
            border: "0.5px solid var(--dsw-alias-border-l1)", borderRadius: 4,
            padding: "6px 8px", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))",
          },
        },
          h("div", {
            style: {
              fontWeight: 600, marginBottom: args ? 4 : 0,
              color: "#d29922", font: "var(--dsw-font-xxxs-11)",
            },
          }, "🔧 tool-call · " + ((block.name as string) || "?")),
          args
            ? h("pre", {
                style: {
                  margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
                  font: "11px/1.5 var(--ds-font-family-code, monospace)",
                  color: "var(--dsw-alias-label-secondary)",
                },
              }, args)
            : null);
      }
      return h("div", { style: { color: "var(--dsw-alias-label-tertiary)", font: "var(--dsw-font-xxxs-11)" } },
        blockText(block));
    }

    function NodeDetail(props: { node: FoldNode; collapsed: boolean }) {
      const node = props.node;
      const role = roleOf(node);
      const color = ROLE_COLORS[role] || "var(--dsw-alias-label-secondary)";
      const blocks = Array.isArray(node.content) ? node.content : [];
      return h("div", { style: { padding: "8px 12px" } },
        h("div", {
          style: {
            display: "flex", gap: 8, alignItems: "baseline", marginBottom: 6,
            borderBottom: "0.5px solid var(--dsw-alias-border-l2)", paddingBottom: 4,
          },
        },
          h("span", { style: { fontWeight: 600, color } }, role),
          h("span", {
            style: { color: "var(--dsw-alias-label-tertiary)", font: "var(--dsw-font-xxxs-11)" },
          }, node.kind + " · seq " + node.seq),
          props.collapsed
            ? h("span", { style: { ...styles.badge, color: "#f85149" } },
                "collapsed — removed from the live surface by the closing edit")
            : null,
          node.replaced
            ? h("span", { style: { ...styles.badge, color: "#d29922" } },
                "replaces " + node.replaced.startSeq + "–" + node.replaced.endSeq)
            : null),
        blocks.length > 0
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              blocks.map((block, i) => h(BlockView, { key: (block && block.id) || i, block })))
          : h("div", {
              style: { color: "var(--dsw-alias-label-tertiary)", font: "var(--dsw-font-xxs-12)" },
            }, "(empty — surface position retained)"));
    }

    function VersionDetail(props: { version: DisplayVersion }) {
      const v = props.version;
      if (isCurrentRow(v)) {
        return h("div", { style: { padding: "8px 12px", color: "var(--dsw-alias-label-tertiary)" } },
          h("div", { style: { fontWeight: 600, marginBottom: 4, color: "var(--dsw-alias-label-primary)" } },
            "Current segment"),
          v.openedBy
            ? "Opened by " + v.openedBy.kind + " @ seq " + v.openedBy.seq + ". Live fold — click any row for full content."
            : "Initial segment. Live fold — click any row for full content.");
      }
      return h("div", { style: { padding: "8px 12px", color: "var(--dsw-alias-label-tertiary)" } },
        h("div", { style: { fontWeight: 600, marginBottom: 4, color: "var(--dsw-alias-label-primary)" } },
          "Version " + v.id),
        h("div", null, v.openedBy
          ? "Opened by " + v.openedBy.kind + " @ seq " + v.openedBy.seq
          : "Initial segment"),
        h("div", null, v.closedBy
          ? "Closed by " + v.closedBy.kind + " @ seq " + v.closedBy.seq
          : "Still open"),
        v.closedBy && v.closedBy.receipt
          ? h("div", { style: { marginTop: 6, whiteSpace: "pre-wrap" } }, v.closedBy.receipt)
          : null,
        h("div", { style: { marginTop: 6 } }, "Click any row for full content."));
    }

    const FALLBACK_SOURCE: ExternalStoreSource<FoldSnapshot> = {
      getSnapshot: () => EMPTY_SNAPSHOT,
      subscribe: () => () => {},
    };

    function ContextView(props: ViewProps) {
      const snapshot = useSource(props.source || FALLBACK_SOURCE);
      const state = snapshot && snapshot.state;
      const [selection, setSelection] = React.useState("current");
      const [selectedSeq, setSelectedSeq] = React.useState<number | null>(null);
      const listRef = React.useRef<HTMLDivElement | null>(null);
      const followRef = React.useRef(true);
      const autoRef = React.useRef<{ idle: number; firstSeq: number | null }>({ idle: 0, firstSeq: null });

      // Auto-load: while the sidebar shows fewer than 5 versions and history
      // remains, fire the batched loadOlder. Each batch usually adds versions
      // (or at least extends the window — tracked via firstSeq), which re-runs
      // this effect; idle attempts are capped so a broken/not-yet-open session
      // is retried a few times and then left alone.
      React.useEffect(() => {
        if (!state || !props.loadOlder) return;
        if (state.versions.length >= 5) return;
        if (props.hasMore && props.hasMore() === false) return;
        const a = autoRef.current;
        const firstSeq = state.nodes.length > 0 ? state.nodes[0].seq : null;
        if (firstSeq !== a.firstSeq) { a.firstSeq = firstSeq; a.idle = 0; }
        if (a.idle >= 10) return;
        a.idle += 1;
        const timer = setTimeout(() => { void props.loadOlder!(); }, a.idle === 1 ? 0 : 1500);
        return () => clearTimeout(timer);
      });

      const versions = state ? state.versions : [];
      const isCurrent = selection === "current";
      const chosen: DisplayVersion | null = state === null
        ? null
        : isCurrent
          ? {
            kind: "current", seq: state.seq, nodes: state.nodes, receipt: "",
            openedBy: state.open,
          }
          : versions.find((v) => v.id === selection) || null;
      const nodes = chosen ? chosen.nodes : [];

      // A segment opened by an edit renders the same boundary rows the closed
      // predecessor ended with: the rich call/result pair replaces the raw
      // surface tool/result node (or is prepended when that node lies outside
      // the loaded window).
      const openedBy = chosen ? chosen.openedBy : null;
      const displayNodes = React.useMemo(() => {
        if (!openedBy || openedBy.kind !== "edit" || !openedBy.resultText) return nodes;
        const callB = makeBoundaryNode(openedBy.callSeq, "tool/call", openedBy.callText, false);
        const resB = makeBoundaryNode(openedBy.seq, "tool/result", openedBy.resultText, false);
        let swapped = false;
        const out: FoldNode[] = [];
        for (const n of nodes) {
          if (!swapped && n.kind === "tool/result" && n.seq === openedBy.seq) {
            out.push(callB, resB);
            swapped = true;
          } else {
            out.push(n);
          }
        }
        if (!swapped) out.unshift(callB, resB);
        return out;
      }, [nodes, openedBy]);

      // Nodes of a CLOSED version that no successor surface still carries were
      // collapsed/removed by the edit (or rewrite) that closed it — mark them.
      const collapsedSeqs = React.useMemo(() => {
        if (!state || !chosen || isCurrentRow(chosen)) return null;
        const idx = versions.findIndex((v) => v.id === (chosen as Version).id);
        const successor = idx >= 0 && idx + 1 < versions.length
          ? versions[idx + 1].nodes
          : state.nodes;
        const surviving = new Set(successor.map((n) => n.seq));
        const gone = new Set<number>();
        for (const n of chosen.nodes) {
          if (!surviving.has(n.seq)) gone.add(n.seq);
        }
        return gone;
      }, [state, chosen, versions]);

      const rows = React.useMemo(
        () => displayNodes.map((node, i) => h(NodeRow, {
          key: node.kind + ":" + node.seq + ":" + i, node,
          selected: node.seq === selectedSeq,
          collapsed: collapsedSeqs !== null && !node.boundary && collapsedSeqs.has(node.seq),
          onSelectNode: setSelectedSeq,
        })),
        [displayNodes, selectedSeq, collapsedSeqs],
      );

      // Auto-scroll: stick to the bottom while follow is on (user near the
      // bottom); jump to the bottom whenever the selected version changes.
      React.useEffect(() => {
        followRef.current = true;
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [selection]);
      React.useEffect(() => {
        const el = listRef.current;
        if (el && followRef.current) el.scrollTop = el.scrollHeight;
      }, [rows]);

      const onListScroll = React.useCallback((event: { currentTarget: HTMLDivElement }) => {
        const el = event.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }, []);

      const onSelectVersion = React.useCallback((key: string) => {
        setSelection(key);
        setSelectedSeq(null);
      }, []);

      if (!state) {
        return h("div", { style: { ...styles.root, padding: 16, color: "var(--dsw-alias-label-tertiary)" } },
          "No fold state yet — the surface builder sees no events in the loaded window.");
      }

      const selectedNode = selectedSeq === null
        ? null
        : displayNodes.find((n) => n.seq === selectedSeq) || null;

      const header = h("div", { style: styles.header },
        h("span", null, "Model context — " + state.nodes.length + " nodes"),
        h("span", { style: styles.badge }, versions.length + " versions"),
        state.pending
          ? h("span", { style: { ...styles.badge, color: "#d29922" } }, "edit txn in flight")
          : null,
        state.uncertain
          ? h("span", { style: { ...styles.badge, color: "#f85149" } },
              "partial window — load older for an exact fold")
          : null,
        h("span", { style: { flex: 1 } }));

      const sidebarRows = [h(VersionRow, {
        key: "current",
        versionKey: "current",
        version: {
          kind: "current", seq: state.seq, nodes: state.nodes,
          receipt: state.pending
            ? "edit txn in flight"
            : state.open ? "opened by " + state.open.kind + " @ " + state.open.seq : "",
          openedBy: state.open,
        } as CurrentVersionRow,
        selected: isCurrent,
        onSelect: onSelectVersion,
      })];
      for (let i = versions.length - 1; i >= 0; i--) {
        const v = versions[i];
        sidebarRows.push(h(VersionRow, {
          key: "v" + v.id, versionKey: v.id, version: v,
          selected: selection === v.id,
          onSelect: onSelectVersion,
        }));
      }
      const canLoadOlder = props.loadOlder
        && (!props.hasMore || props.hasMore() !== false);

      return h("div", { style: styles.root, "data-conversation-composer-overlay": "" },
        header,
        h("div", { style: styles.body },
          h("div", { style: styles.sidebar },
            sidebarRows,
            canLoadOlder
              ? h("button", {
                  style: { ...styles.button, margin: 8, padding: "6px 10px" },
                  onClick: () => { void props.loadOlder!(); },
                }, "Load older")
              : null),
          h("div", { style: styles.list, ref: listRef, onScroll: onListScroll },
            rows.length > 0
              ? rows
              : h("div", { style: { padding: 16, color: "var(--dsw-alias-label-tertiary)" } }, "No surface nodes.")),
          h("div", { style: styles.detail },
            selectedNode
              ? h(NodeDetail, {
                  node: selectedNode,
                  collapsed: collapsedSeqs !== null && !selectedNode.boundary
                    && collapsedSeqs.has(selectedNode.seq),
                })
              : h(VersionDetail, { version: chosen || { kind: "current", seq: state.seq, nodes: state.nodes, receipt: "", openedBy: state.open } }))));
    }

    // ------------------------------------------------------------------
    // Plugin body: one context PER EVENT, chained through reader.previous.
    // A single long-lived context cannot absorb history prepends (older
    // pages arrive strictly before its start and are never delivered as
    // updates), while per-event contexts let the engine re-chain the fold
    // when loadOlder extends the window backwards.
    // ------------------------------------------------------------------

    return {
      inject: ["slots", "sessions", "uiConversation"],
      apply(ctx: ClientPluginContext) {
        ctx.uiConversation.views.register({
          target: TARGET,
          create: () => new ClmContextBuilder(),
        });
        ctx.uiConversation.events.register({
          kind: KIND,
          target: TARGET,
          match: (event) => isInteresting(event) ? { id: String(event.seq), role: "start" } : null,
          start: (_context, match, reader) => {
            const prior = reader.previous(KIND);
            return foldStep((prior && prior.state) || EMPTY_STATE, match.event);
          },
          update: (context) => context.state,
          buildViewNode: (context) => context.state === undefined
            ? null
            : { key: context.key, kind: KIND, id: context.id, target: TARGET, data: context.state },
        });
        ctx.slots.inject("conversation.view", () => ctx.slots.register({
          name: "conversation.view", id: "clm-context", order: 20, label: "Context",
          inject: (sessionId: string): ViewProps => {
            const target = ctx.uiConversation.binding(sessionId).target(TARGET);
            // Resolve the session lazily at call time: after a page refresh
            // this inject can run before the binding's session exists, and a
            // captured `undefined` would disable loading for good.
            const resolveSession = (): ClientSession | null => {
              const b = ctx.sessions.binding(sessionId);
              return (b && b.session) || null;
            };
            const snapInfo = (): string => {
              try {
                const session = resolveSession();
                const s = session && typeof session.getSnapshot === "function"
                  ? session.getSnapshot() : null;
                if (!s) return "snapshot=<none>";
                return "hasMore=" + s.hasMore
                  + " loadingOlder=" + s.loadingOlder
                  + " openState=" + JSON.stringify(s.openState);
              } catch (error) {
                return "snapshot read failed: " + String(error);
              }
            };
            console.info("[clm-context] inject " + sessionId + ": session="
              + (resolveSession() ? "present" : "not-yet") + " " + snapInfo());
            return {
              source: {
                getSnapshot: () => target.getSnapshot() || EMPTY_SNAPSHOT,
                subscribe: (listener) => target.subscribe(listener),
              },
              hasMore: () => {
                const session = resolveSession();
                const s = session && session.getSnapshot && session.getSnapshot();
                return s ? s.hasMore !== false : true;
              },
              loadOlder: async () => {
                const session = resolveSession();
                if (!session) {
                  console.info("[clm-context] loadOlder: skip — session not bound yet");
                  return;
                }
                // Batch mode: loadThrough pages backwards (200-message minimum
                // per page, published together at completion) until the window
                // covers firstSeq - BATCH, instead of one small loadOlder page.
                // The session snapshot has no firstSeq, so the window start is
                // approximated by our own fold state's first surface node.
                const BATCH = 2000;
                const snap = session.getSnapshot && session.getSnapshot();
                const foldState = (target.getSnapshot() || EMPTY_SNAPSHOT).state;
                const firstSeq = foldState && foldState.nodes.length > 0
                  ? foldState.nodes[0].seq : null;
                if (snap && snap.hasMore === false) {
                  console.info("[clm-context] loadOlder: skip — hasMore=false");
                  return;
                }
                console.info("[clm-context] loadOlder: start — " + snapInfo()
                  + " foldFirstSeq=" + firstSeq);
                const started = Date.now();
                try {
                  if (firstSeq !== null && firstSeq > 1) {
                    await session.loadThrough(Math.max(1, firstSeq - BATCH));
                  } else {
                    await session.loadOlder();
                  }
                  console.info("[clm-context] loadOlder: done in " + (Date.now() - started)
                    + "ms — " + snapInfo());
                } catch (error) {
                  console.error("[clm-context] loadOlder: failed in " + (Date.now() - started)
                    + "ms", error);
                }
              },
            };
          },
        }, ContextView));
      },
    };
  },
});
