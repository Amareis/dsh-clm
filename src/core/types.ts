/**
 * Core domain types for dsh-clm.
 *
 * The core NEVER imports `@deepseek-ai/*` at runtime: bundle code cannot
 * resolve those packages. The `Session` type itself IS a type-only import —
 * it erases at compile time and gives the core compile-time coupling to the
 * real session API. Loose structural views (EventShape, MessageShape,
 * ContentBlock) describe the few fields the core reads; casts at the
 * session-api boundary bridge them to the harness's branded types.
 */
import type { Session, SessionSeq } from "@deepseek-ai/dsh-session";

export type { Session };

/** Brand a number as a SessionSeq WITHOUT the runtime brand constructor
 *  (a runtime import the bundle cannot resolve — the brand is compile-time
 *  only). Only for seqs that genuinely came from the session log. */
export function asSeq(seq: number): SessionSeq {
  return seq as SessionSeq;
}

/** One content block of a derived message. Fields beyond `type` are optional
 *  because blocks are heterogeneous (text, tool-call, thinking, …). */
export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/** Structural view of a derived (model-visible) message. */
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

/** Structural view of a session event (only what the core reads). The real
 *  SessionEvent union is assignable here; payloads differ per type
 *  (user/message carries the message directly on data, developer/assistant/
 *  tool events nest it under data.message). */
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

/** Surface metadata attached to a replacement append (loose view of the real
 *  SurfaceIntent; seqs are branded at the append call site). */
export interface SurfaceRef {
  surfaceOp: { op: "replace"; startSeq: number; endSeq: number };
  sourceEventSeqs: number[];
}

/** Token meter service (optional; a char heuristic covers its absence). */
export interface MeterLike {
  measure(session: Session): {
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
