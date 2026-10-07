/**
 * Core domain types for dsh-clm.
 *
 * The core NEVER imports `@deepseek-ai/*`: bundle code cannot resolve those
 * packages at runtime, and pure logic must stay testable without the harness.
 * Everything below is a structural interface the live harness objects satisfy
 * (and the test fakes implement). Type-only imports in the integration layer
 * compile away.
 */

/** One content block of a derived message. Fields beyond `type` are optional
 *  because blocks are heterogeneous (text, tool-call, thinking, …). */
export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/** Structural shape of a derived (model-visible) message. */
export interface MessageShape {
  role?: string;
  toolCallId?: string;
  content?: ContentBlock[];
  source?: {
    kind?: string;
    sweep?: boolean;
    drop?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Structural shape of a session event (only what the core reads). */
export interface EventShape {
  type: string;
  data?: {
    turn?: number;
    step?: number;
    message?: MessageShape;
    source?: { kind?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Surface metadata attached to a replacement append. */
export interface SurfaceRef {
  surfaceOp: { op: "replace"; startSeq: number; endSeq: number };
  sourceEventSeqs: number[];
}

/** The minimal session surface the core operates on. */
export interface SessionLike {
  /** Next event's sequence number (log length). */
  readonly seq: number;
  readonly id?: string | number;
  /** Positional array of surface event seqs — NOT sorted by seq value:
   *  a replace splices a fresh (larger) seq between older ones. */
  readonly surface: { readonly nodes: readonly number[] };
  eventAt(seq: number): EventShape | undefined;
  /** Project one event to its model-visible message, or null/undefined when
   *  the event produces none (empty-content events project to nothing). */
  deriveEventMessage(event: EventShape | undefined): MessageShape | null | undefined;
  append(type: string, data: unknown, surfaceRef?: SurfaceRef): unknown;
  requestContext?(): { contextWindow?: number } | undefined;
}

/** Token meter service (optional; a char heuristic covers its absence). */
export interface MeterLike {
  measure(session: SessionLike): {
    totalTokens: number;
    nodes: ReadonlyArray<{ seq: number; tokens: number }>;
  };
}

/** One surface node: seq, event, derived message, estimated tokens. */
export interface SurfaceNode {
  index: number;
  seq: number;
  event: EventShape | undefined;
  message: MessageShape | undefined;
  tokens: number;
}

/** Pair-atomic map unit (v8): an assistant node with tool-call blocks plus ALL
 *  its tool/result nodes is ONE numbered unit. */
export interface Unit {
  unit: number;
  members: SurfaceNode[];
  calls: ContentBlock[];
  results: Map<string, SurfaceNode>;
}

/** One model-requested replacement (unit numbers, from tool arguments). */
export interface EditInput {
  from: number;
  to: number;
  content: string;
}

/** A span of node indices to collapse — a stale txn trace, a snapshot fold,
 *  or an eager planning-pair sweep. */
export interface TxnSpan {
  from: number;
  to: number;
  content?: string;
  /** Mixed-node shape: stub a single tool result, keeping the call link. */
  stubCallId?: string;
  /** Drop replacement: empty content projects to no wire message. */
  drop?: boolean;
  /** Pre-drop fold marker being migrated to a drop. */
  migrate?: boolean;
}

/** Result of {@link import('./spans.js').applySpans}. */
export interface SweepStats {
  swept: number;
  markers: number;
  drops: number;
  migrated: number;
}

export function isTextBlock(block: ContentBlock): block is ContentBlock & { type: "text"; text: string } {
  return block.type === "text" && typeof block.text === "string";
}

export function isToolCallBlock(block: ContentBlock): block is ContentBlock & { type: "tool-call"; id: string } {
  return block.type === "tool-call" && typeof block.id === "string";
}
