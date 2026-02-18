/**
 * Human-in-the-loop feedback types.
 *
 * Defines structured request/response types for all forms of human feedback
 * an agent might need: confirmations, choices, free text, reviews, and forms.
 */

// ── Feedback request types ──────────────────────────────────────────

export type FeedbackType = "confirm" | "choice" | "text" | "review" | "form";

/**
 * Base fields shared by all feedback requests.
 */
export interface FeedbackRequestBase {
  /** Unique ID for correlating request → response. */
  id: string;
  /** What kind of feedback is needed. */
  type: FeedbackType;
  /** Human-readable prompt shown to the reviewer. */
  prompt: string;
  /** Which agent/task is asking. */
  source: {
    sessionId: string;
    taskId: string;
    iteration: number;
    toolName?: string;
  };
  /** How long to wait (ms) before timing out. 0 = no timeout. */
  timeout: number;
  /** Priority hint for routing (lower = more urgent). */
  priority: number;
  /** Arbitrary metadata plugins can attach. */
  metadata: Record<string, unknown>;
}

/** Yes / No confirmation. */
export interface ConfirmFeedbackRequest extends FeedbackRequestBase {
  type: "confirm";
  /** What exactly needs confirming (e.g. "Execute shell command: rm -rf /tmp"). */
  action: string;
  /** If true, timeout resolves as "denied" instead of "approved". */
  defaultDeny: boolean;
}

/** Pick one (or more) from a list of options. */
export interface ChoiceFeedbackRequest extends FeedbackRequestBase {
  type: "choice";
  options: Array<{ id: string; label: string; description?: string }>;
  /** Allow selecting multiple options. */
  multiple: boolean;
  /** Default selected option ID(s). */
  defaults: string[];
}

/** Open-ended text input. */
export interface TextFeedbackRequest extends FeedbackRequestBase {
  type: "text";
  /** Placeholder / hint text. */
  placeholder?: string;
  /** If true, expects multi-line input. */
  multiline: boolean;
}

/** Review & approve/reject/revise with comments. */
export interface ReviewFeedbackRequest extends FeedbackRequestBase {
  type: "review";
  /** The artifact being reviewed (plan, code, output, etc.). */
  artifact: {
    title: string;
    content: string;
    contentType: "text" | "markdown" | "code" | "json" | "diff";
    language?: string;
  };
  /** Allowed verdicts. */
  allowedVerdicts: ReviewVerdict[];
}

export type ReviewVerdict = "approve" | "reject" | "revise" | "escalate";

/** Structured form with multiple fields. */
export interface FormFeedbackRequest extends FeedbackRequestBase {
  type: "form";
  fields: FormField[];
}

export interface FormField {
  id: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  required: boolean;
  options?: Array<{ id: string; label: string }>; // for select fields
  default?: unknown;
}

/** Union of all request types. */
export type FeedbackRequest =
  | ConfirmFeedbackRequest
  | ChoiceFeedbackRequest
  | TextFeedbackRequest
  | ReviewFeedbackRequest
  | FormFeedbackRequest;

// ── Feedback response types ─────────────────────────────────────────

export type FeedbackStatus = "completed" | "timeout" | "cancelled" | "error";

export interface FeedbackResponseBase {
  /** Matches the request ID. */
  requestId: string;
  status: FeedbackStatus;
  /** Who responded (user ID, email, role, etc.). */
  respondedBy?: string;
  /** When the response was received. */
  respondedAt: string;
}

export interface ConfirmFeedbackResponse extends FeedbackResponseBase {
  approved: boolean;
  reason?: string;
}

export interface ChoiceFeedbackResponse extends FeedbackResponseBase {
  /** Selected option ID(s). */
  selected: string[];
}

export interface TextFeedbackResponse extends FeedbackResponseBase {
  text: string;
}

export interface ReviewFeedbackResponse extends FeedbackResponseBase {
  verdict: ReviewVerdict;
  comments?: string;
  /** Line-level or inline annotations on the artifact. */
  annotations?: Array<{
    line?: number;
    offset?: number;
    text: string;
  }>;
}

export interface FormFeedbackResponse extends FeedbackResponseBase {
  values: Record<string, unknown>;
}

export interface TimeoutFeedbackResponse extends FeedbackResponseBase {
  status: "timeout";
}

export interface CancelledFeedbackResponse extends FeedbackResponseBase {
  status: "cancelled";
  reason?: string;
}

export interface ErrorFeedbackResponse extends FeedbackResponseBase {
  status: "error";
  error: string;
}

/** Union of all response types. */
export type FeedbackResponse =
  | ConfirmFeedbackResponse
  | ChoiceFeedbackResponse
  | TextFeedbackResponse
  | ReviewFeedbackResponse
  | FormFeedbackResponse
  | TimeoutFeedbackResponse
  | CancelledFeedbackResponse
  | ErrorFeedbackResponse;
