/**
 * Human-in-the-loop feedback system.
 *
 * Provides structured feedback types, transport adapters, a central manager,
 * and task chain orchestration for multi-step workflows with human checkpoints.
 */

export type {
  FeedbackType,
  FeedbackRequest,
  FeedbackRequestBase,
  FeedbackResponse,
  FeedbackResponseBase,
  FeedbackStatus,
  ConfirmFeedbackRequest,
  ChoiceFeedbackRequest,
  TextFeedbackRequest,
  ReviewFeedbackRequest,
  FormFeedbackRequest,
  ConfirmFeedbackResponse,
  ChoiceFeedbackResponse,
  TextFeedbackResponse,
  ReviewFeedbackResponse,
  FormFeedbackResponse,
  TimeoutFeedbackResponse,
  CancelledFeedbackResponse,
  ErrorFeedbackResponse,
  ReviewVerdict,
  FormField,
} from "./types.js";

export type { FeedbackAdapter } from "./adapter.js";
export {
  CallbackFeedbackAdapter,
  DeferredFeedbackAdapter,
  AutoApproveAdapter,
} from "./adapter.js";

export { FeedbackManager } from "./manager.js";
export type { FeedbackManagerConfig } from "./manager.js";

export { TaskChain } from "./chain.js";
export type {
  ChainContext,
  ChainResult,
  StepOutcome,
  TaskStepDef,
  GateStepDef,
  TransformStepDef,
  GateConfig,
} from "./chain.js";
