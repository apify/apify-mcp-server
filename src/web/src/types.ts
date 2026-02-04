export type OpenAiGlobals<
  ToolInput = UnknownObject,
  ToolOutput = UnknownObject,
  ToolResponseMetadata = UnknownObject,
  WidgetState = UnknownObject
> = {
  // visuals
  theme: Theme;

  userAgent: UserAgent;
  locale: string;

  // layout
  maxHeight: number;
  displayMode: DisplayMode;
  safeArea: SafeArea;

  // state
  toolInput: ToolInput;
  toolOutput: ToolOutput | null;
  toolResponseMetadata: ToolResponseMetadata | null;
  widgetState: WidgetState | null;
  setWidgetState: (state: WidgetState) => Promise<void>;
};

// currently copied from types.ts in chatgpt/web-sandbox.
// Will eventually use a public package.
type API = {
  callTool: CallTool;
  sendFollowUpMessage: (args: { prompt: string; }) => Promise<void>;
  openExternal(payload: { href: string; }): void;

  // Layout controls
  requestDisplayMode: RequestDisplayMode;
  requestModal: (args: { title?: string; params?: UnknownObject; }) => Promise<unknown>;
  requestClose: () => Promise<void>;
};

export type UnknownObject = Record<string, unknown>;

export type Theme = "light" | "dark";

export type SafeAreaInsets = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type SafeArea = {
  insets: SafeAreaInsets;
};

export type DeviceType = "mobile" | "tablet" | "desktop" | "unknown";

export type UserAgent = {
  device: { type: DeviceType; };
  capabilities: {
    hover: boolean;
    touch: boolean;
  };
};

/** Display mode */
export type DisplayMode = "pip" | "inline" | "fullscreen";
export type RequestDisplayMode = (args: { mode: DisplayMode; }) => Promise<{
  /**
   * The granted display mode. The host may reject the request.
   * For mobile, PiP is always coerced to fullscreen.
   */
  mode: DisplayMode;
}>;

export type CallToolResponse = {
  result: string;
  isError?: boolean;
  content?: Array<{ type: string; text?: string; }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/** Calling APIs */
export type CallTool = (
  name: string,
  args: Record<string, unknown>
) => Promise<CallToolResponse>;

/** Extra events */
export const SET_GLOBALS_EVENT_TYPE = "openai:set_globals";
export class SetGlobalsEvent extends CustomEvent<{
  globals: Partial<OpenAiGlobals>;
}> {
  readonly type = SET_GLOBALS_EVENT_TYPE;
}

/**
 * Global oai object injected by the web sandbox for communicating with chatgpt host page.
 */
declare global {
  interface Window {
    openai: API & OpenAiGlobals;
  }

  interface WindowEventMap {
    [SET_GLOBALS_EVENT_TYPE]: SetGlobalsEvent;
  }
}

// --- App Specific Types ---

export interface PricingInfo {
    pricingModel: string;
    pricePerResultUsd: number;
    monthlyChargeUsd: number;
}

export interface ActorStats {
  totalBuilds: number;
  totalRuns: number;
  totalUsers: number;
  totalBookmarks: number;
  actorReviewRating?: number;
  actorReviewCount?: number;
}

export interface ActorDetails {
  actorInfo: {
    id: string;
    name: string;
    username: string;
    title?: string;
    description: string;
    pictureUrl?: string;
    stats?: ActorStats;
    currentPricingInfo?: PricingInfo;
    userActorRuns?: {
      successRate: number | null;
    };
  };
  actorCard: string;
  readme: string;
  inputSchema?: {
    type: string;
    properties: Record<string, unknown>;
  };
}

export interface Actor {
  id: string;
  name: string;
  username: string;
  userPictureUrl?: string;
  userFullName?: string;
  fullName?: string;
  title?: string;
  description: string;
  categories?: string[];
  pictureUrl?: string;
  stats?: ActorStats;
  currentPricingInfo?: PricingInfo;
  userActorRuns?: {
    successRate: number | null;
  };
  actorReviewCount?: number;
  actorReviewRating?: number;
}
